"""
Pure 9-Condition Institutional SMC Trading Bot for Binance USDT-M Perpetual Futures.
Supports both:
  - PROP_FIRM Mode (Blue Guardian Crypto/Futures Rules: 4% Daily / 8% Static / 2% Shield / >=140s Hold / <=80% Margin)
  - PERSONAL Mode ($50 / $100 / $300+ USDT Personal Binance Account: Configurable Leverage & Risk / <=80% Margin / MIN_NOTIONAL Guard)

Zero Z-score, Zero Kalman Filter, Zero Forex/Metals, Zero 3-part TP splits, Zero Trailing Stop.
"""
import os
import sys
import time
import json
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"), override=True)

import database as db
import binance_execution as be
import risk_safeguards as risk
import smc_strategy_engine as smc_engine

PKT_TZ = timezone(timedelta(hours=5))

TOP_10_CRYPTO_SYMBOLS = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "SUIUSDT",
]

_BE_LOCKED_SYMBOLS = {}
_LAST_COOLDOWN = {}
_LAST_SIGNAL_ALERT_TS = {}
_LAST_SCAN_TS = 0.0
_SHARED_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shared_config.json")


def send_discord_crypto_smc_signal(
    action: str,
    symbol: str,
    entry_p: float,
    sl_p: float,
    tp_p: float,
    rrr: float,
    qty: float,
    leverage: int,
    account_mode: str,
    size_info: dict,
    max_margin_pct: float,
    ticket_id: int = 0,
    is_signal_only: bool = False,
):
    """Formats Crypto USDT-M Futures SMC alerts identically to the Forex terminal Discord signals."""
    act_u = str(action).upper()
    is_long = act_u == "BUY"
    act_str = "MARKET LONG (BUY) 🟢" if is_long else "MARKET SHORT (SELL) 🔴"
    sl_pct = (abs(entry_p - sl_p) / entry_p * 100.0) if entry_p > 0 else 0.0
    now_str = db.format_pkt_time_str()
    mode_header = (
        "📢 **[ NEW PURE SMC CRYPTO SIGNAL ]** 📢\n*(Signals Only Mode — Auto-Execution OFF)*"
        if is_signal_only
        else f"🚀 **[ NEW CRYPTO FUTURES POSITION OPENED ]** 🚀 *(Ticket `#{ticket_id}`)*"
    )
    msg = (
        f"@everyone\n"
        f"📢 **PURE SMC / ICT 9-CONDITION CRYPTO FUTURES ENGINE** 📢\n"
        f"{mode_header}\n\n"
        f"{'🟢' if is_long else '🔴'} **ACTION:** `{act_str}` (**{symbol}** · {leverage}x)\n"
        f"⏱ **TIME:** `{now_str}`\n"
        f"📊 **STRATEGY:** `Pure SMC Structure (9-Step Verified) 🟢`\n"
        f"💼 **ACCOUNT MODE:** `{account_mode}`\n\n"
        f"📥 **ENTRY PRICE:** `${db._fmt_price_str(entry_p)}`\n"
        f"⛔ **STOP LOSS (SL):** `${db._fmt_price_str(sl_p)}` *({sl_pct:.2f}% | Sweep {'-' if is_long else '+'} 0.08% Buffer)*\n"
        f"🎯 **TAKE PROFIT (TP):** `${db._fmt_price_str(tp_p)}` *({rrr:.2f}R Opposing M15 Liquidity Target)*\n"
        f"📦 **POSITION SIZE:** `{qty} units` | Risk: `${size_info.get('risk_usdt', 0)} USDT` | Margin: `{size_info.get('margin_pct', 0)}%` *(Cap ≤ {max_margin_pct:.0f}%)*\n"
    )
    db.send_discord_message(msg)


def _pkt_hour_decimal() -> float:
    now_pkt = datetime.now(PKT_TZ)
    return now_pkt.hour + now_pkt.minute / 60.0


def _in_pkt_window(val: float, start_h: float, end_h: float) -> bool:
    if abs(start_h - end_h) < 1e-6:
        return True
    if start_h < end_h:
        return start_h <= val < end_h
    return val >= start_h or val < end_h


def is_session_guard_allowing_entry(settings: dict) -> tuple:
    """Checks optional PKT Dual Killzone windows (default OFF = 24/7 crypto trading)."""
    if not settings.get("session_guard_enabled", False):
        return True, "24/7 Active"
    now_h = _pkt_hour_decimal()
    w1 = _in_pkt_window(now_h, float(settings.get("session_start_hour", 12.0)), float(settings.get("session_end_hour", 16.0)))
    w2 = bool(settings.get("session2_enabled", True)) and _in_pkt_window(
        now_h, float(settings.get("session2_start_hour", 18.0)), float(settings.get("session2_end_hour", 22.0))
    )
    if w1 or w2:
        return True, f"PKT Window Open ({now_h:.1f}h)"
    return False, f"Outside PKT Session Windows ({now_h:.1f}h PKT)"


def save_shared_config(active_pair: str):
    try:
        with open(_SHARED_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump({"active_pair": active_pair}, f)
    except Exception:
        pass


def get_open_trade_db_metadata(symbol: str) -> dict:
    """Reads ticket, entry_time, sl, tp for an active OPEN trade from Neon Postgres."""
    conn = None
    try:
        conn = db.get_connection()
        cur = conn.cursor()
        cur.execute(
            """
            SELECT ticket, entry_time, entry_price, COALESCE(sl, 0), COALESCE(tp, 0), order_type, lots
            FROM trades
            WHERE status = 'OPEN' AND UPPER(symbol) = %s
            ORDER BY entry_time DESC
            LIMIT 1
            """,
            (symbol.upper(),),
        )
        row = cur.fetchone()
        cur.close()
        if not row:
            return {}
        return {
            "ticket": int(row[0]),
            "entry_time": row[1],
            "entry_price": float(row[2] or 0),
            "sl": float(row[3] or 0),
            "tp": float(row[4] or 0),
            "order_type": str(row[5] or "BUY").upper(),
            "lots": float(row[6] or 0),
        }
    except Exception:
        return {}
    finally:
        if conn:
            conn.close()


def manage_open_futures_positions(positions: list, equity: float, settings: dict):
    """
    24/7 Position Safeguards & One-Time Risk-Free Breakeven Manager:
      1. Guardian Shield Floating Protection (Prop Firm: 1.8% buffer below 2.0% limit).
      2. One-Time Fee-Aware Breakeven at >= +1.0R floating gain (after >=140s min hold in Prop mode).
      3. 60-minute Stagnation Fee-Aware Breakeven if floating gain >= +0.15% notional.
      Zero trailing stop! TP stays strictly fixed at opposing M15 structural liquidity target.
    """
    if not positions:
        return

    account_mode = str(settings.get("account_mode", "PROP_FIRM")).upper()
    shield_pct = float(settings.get("guardian_shield_pct", 1.8))
    risk_enabled = bool(settings.get("risk_limits_enabled", True))
    now_utc = datetime.now(timezone.utc)

    for pos in positions:
        sym = pos["symbol"]
        is_long = pos["side"] == "BUY"
        entry_p = float(pos["entry_price"])
        mark_p = float(pos["mark_price"] or entry_p)
        upnl = float(pos["unrealized_pnl"] or 0.0)
        notional = abs(float(pos["qty"]) * entry_p)

        # 1. Guardian Shield floating drawdown protection (Prop Firm mode)
        if account_mode == "PROP_FIRM" and risk_enabled and equity > 0 and upnl < 0:
            float_loss_pct = (-upnl / equity) * 100.0
            if float_loss_pct >= shield_pct:
                print(f"[GUARDIAN SHIELD] {sym} floating loss {float_loss_pct:.2f}% >= {shield_pct:.2f}% -> Emergency Close!")
                be.close_all_binance_positions(sym)
                db.send_discord_message(f"🛡️ **GUARDIAN SHIELD TRIGGERED**: Closed `{sym}` at -{float_loss_pct:.2f}% floating drawdown.")
                continue

        meta = get_open_trade_db_metadata(sym)
        if not meta:
            continue

        ticket = meta["ticket"]
        sl_p = float(meta["sl"] or 0)
        tp_p = float(meta["tp"] or 0)
        entry_time = meta.get("entry_time")
        if entry_time and entry_time.tzinfo is None:
            entry_time = entry_time.replace(tzinfo=timezone.utc)
        age_sec = (now_utc - entry_time).total_seconds() if entry_time else 999.0

        # Respect Blue Guardian >=120s (140s safe) minimum hold before discretionary BE modification
        if account_mode == "PROP_FIRM" and age_sec < risk.MIN_PROP_HOLD_SECONDS:
            continue

        if _BE_LOCKED_SYMBOLS.get(ticket):
            continue

        # Already at or better than breakeven?
        already_be = (sl_p >= entry_p * 1.0005) if (is_long and sl_p > 0) else (sl_p > 0 and sl_p <= entry_p * 0.9995)
        if already_be:
            _BE_LOCKED_SYMBOLS[ticket] = True
            continue

        sl_dist = abs(entry_p - sl_p) if sl_p > 0 else (entry_p * 0.01)
        favorable_move = (mark_p - entry_p) if is_long else (entry_p - mark_p)
        curr_r = (favorable_move / sl_dist) if sl_dist > 0 else 0.0
        stagnation_be = (age_sec >= 3600.0) and (notional > 0) and (upnl / notional >= 0.0015)

        if curr_r >= 1.0 or stagnation_be:
            tag = "+1.0R Milestone" if curr_r >= 1.0 else "60m Stagnation"
            ok, res_val = be.modify_binance_sl_to_breakeven(sym, is_long, entry_p, tp_p, ticket=ticket)
            if ok:
                _BE_LOCKED_SYMBOLS[ticket] = True
                print(f"[BREAKEVEN LOCKED] {sym} #{ticket} ({tag}) -> Fee-Safe SL @ {res_val} | TP Fixed @ {tp_p}")
                db.send_discord_message(
                    f"🛡️ **ONE-TIME BREAKEVEN ({tag})**\nSymbol: `{sym}` | Ticket: `#{ticket}`\n"
                    f"SL moved to fee-safe BE `{res_val}` | TP remains untouched @ `{tp_p}`"
                )


def poll_manual_commands(settings: dict):
    """Polls and executes manual BUY / SELL / CLOSE commands queued from dashboard UI."""
    conn = None
    try:
        conn = db.get_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT id, symbol, direction, lots, sl_pips, tp_pips, comment FROM trade_commands WHERE status = 'PENDING' ORDER BY id ASC LIMIT 5"
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        conn = None

        if not rows:
            return

        leverage = int(settings.get("leverage", 5))
        for cmd_id, raw_sym, direction, lots, sl_pct, tp_pct, comment in rows:
            status = "EXECUTED"
            err_msg = None
            try:
                dir_u = str(direction).upper().strip()
                if dir_u == "CLOSE":
                    be.close_all_binance_positions(raw_sym)
                elif dir_u in ("BUY", "SELL"):
                    bin_sym = be.resolve_binance_symbol(raw_sym)
                    tick = be.get_binance_live_tick(bin_sym)
                    if not tick:
                        raise RuntimeError(f"Could not fetch live quote for {bin_sym}")
                    entry_p = tick[2]
                    sl_frac = float(sl_pct or 1.2) / 100.0
                    tp_frac = float(tp_pct or 2.4) / 100.0
                    is_long = dir_u == "BUY"
                    sl_p = entry_p * (1.0 - sl_frac) if is_long else entry_p * (1.0 + sl_frac)
                    tp_p = entry_p * (1.0 + tp_frac) if is_long else entry_p * (1.0 - tp_frac)
                    ok, detail = be.execute_single_smc_binance_trade(
                        symbol=bin_sym,
                        is_long=is_long,
                        entry_price=entry_p,
                        sl_price=sl_p,
                        total_qty=float(lots),
                        tp_price=tp_p,
                        leverage=leverage,
                        comment=str(comment or "MANUAL_FUTURES"),
                    )
                    if not ok:
                        status = "FAILED"
                        err_msg = str(detail)
                else:
                    status = "FAILED"
                    err_msg = f"Unsupported direction {dir_u}"
            except Exception as ex:
                status = "FAILED"
                err_msg = str(ex)

            c2 = db.get_connection()
            cur2 = c2.cursor()
            cur2.execute(
                "UPDATE trade_commands SET status = %s, executed_at = NOW(), error_msg = %s WHERE id = %s",
                (status, err_msg, int(cmd_id)),
            )
            c2.commit()
            cur2.close()
            c2.close()
            print(f"[Manual CMD #{cmd_id}] {raw_sym} {direction} lots={lots} -> {status} ({err_msg or 'OK'})")
    except Exception as e:
        print(f"[Manual Command Error]: {e}")
    finally:
        if conn:
            conn.close()


def run_smc_scan_and_trade(equity: float, avail_bal: float, open_positions: list, settings: dict, force_scan: bool = False):
    """
    Scans Top 10 Crypto Futures Coins (+ custom searched active coin) through the Pure 9-Condition SMC Pipeline.
    Enforces:
      - Single Trade Lock (1 open Futures position max)
      - Optional PKT Session Guard (default OFF = 24/7 active)
      - Max 80% capital margin cap & MIN_NOTIONAL safety check
      - Risk-First sizing for Prop Firm (Blue Guardian) OR Personal Binance Fund ($50-$300+)
    """
    global _LAST_SCAN_TS
    now_ts = time.time()
    if not force_scan and (now_ts - _LAST_SCAN_TS) < 12.0:
        return
    _LAST_SCAN_TS = now_ts

    active_sym = be.resolve_binance_symbol(settings.get("active_pair", "BTCUSDT"))
    save_shared_config(active_sym)

    scan_list = list(TOP_10_CRYPTO_SYMBOLS)
    if active_sym and active_sym not in scan_list:
        scan_list.append(active_sym)

    db.cleanup_stale_scanned_assets(scan_list)

    max_sl_pct = float(settings.get("max_sl_pct", 1.20))
    leverage = int(settings.get("leverage", 5))
    risk_pct = float(settings.get("risk_percent", 1.0))
    max_margin_pct = min(80.0, float(settings.get("max_margin_pct", 80.0)))
    account_mode = str(settings.get("account_mode", "PROP_FIRM")).upper()
    auto_exec = bool(settings.get("auto_execute", True))
    max_trades = int(settings.get("max_trades", 10))
    trades_today = risk.get_trades_count_today()

    best_candidate = None
    best_score = -1.0

    for sym in scan_list:
        try:
            df_m5 = be.get_binance_rates_df(sym, timeframe_minutes=5, count=120)
            df_m15 = be.get_binance_rates_df(sym, timeframe_minutes=15, count=90)
            if df_m5.empty or df_m15.empty:
                continue

            eval_res = smc_engine.evaluate_smc_strategy_signal(
                symbol=sym,
                df_m5=df_m5,
                df_m15=df_m15,
                max_sl_pct=max_sl_pct,
                leverage=leverage,
                min_target_rrr=1.85,
            )

            tel = eval_res.get("telemetry", {})
            db.update_smc_telemetry(sym, tel)
            db.log_smc_zones_full(sym, eval_res.get("zones", {}))

            live_price = float(df_m5["close"].iloc[-1])
            step_progress = 0
            try:
                step_progress = int(json.loads(eval_res.get("fvg_bounds_json", "{}")).get("step_progress", 0))
            except Exception:
                step_progress = 0

            action_label = eval_res["action"] if eval_res["action"] in ("BUY", "SELL") else (
                "BULL_BIAS" if "BULLISH" in eval_res["m15_bias"] else ("BEAR_BIAS" if "BEARISH" in eval_res["m15_bias"] else "NEUTRAL")
            )
            # Show SMC progress & R:R cleanly in scanned_assets (z_score stores projected R:R, win_rate stores step completeness %)
            db.update_scanned_asset(
                symbol_pair=sym,
                price_a=live_price,
                price_b=eval_res["tp"] if eval_res["tp"] > 0 else live_price,
                win_rate=round((step_progress / 9.0) * 100.0, 2),
                z_score=float(eval_res.get("rrr", 0.0) or 0.0),
                action=action_label,
            )

            if eval_res["action"] in ("BUY", "SELL"):
                cand_score = float(eval_res["rrr"]) + (2.0 if sym == active_sym else 0.0)
                if cand_score > best_score:
                    best_score = cand_score
                    best_candidate = eval_res
        except Exception as e:
            print(f"[Scan Error] {sym}: {e}")

    # Only execute if all guards permit AND candidate passes all 9 SMC steps
    if not best_candidate:
        return

    sym = best_candidate["symbol"]
    action = best_candidate["action"]
    entry_p = float(best_candidate["entry"])
    sl_p = float(best_candidate["sl"])
    tp_p = float(best_candidate["tp"])
    rrr = float(best_candidate["rrr"])

    if not settings.get("is_bot_running", True):
        print(f"[SMC Candidate] {sym} {action} ({rrr:.2f}R) skipped — Bot paused")
        return

    if len(open_positions) >= 1:
        print(f"[SMC Lock] {sym} {action} ({rrr:.2f}R) skipped — Single Trade Lock (1 position already open)")
        return

    if not auto_exec:
        print(f"[SMC Signal Only] {sym} {action} @ {entry_p} | SL {sl_p} | TP {tp_p} ({rrr:.2f}R) — auto_execute=False")
        if (now_ts - _LAST_SIGNAL_ALERT_TS.get(sym, 0.0)) >= 300.0:
            qty_est, sinfo_est = be.calculate_crypto_smc_quantity(
                symbol=sym, entry_price=entry_p, sl_price=sl_p, usdt_equity=equity,
                risk_pct=risk_pct, leverage=leverage, max_margin_pct=max_margin_pct, account_mode=account_mode,
            )
            send_discord_crypto_smc_signal(
                action=action, symbol=sym, entry_p=entry_p, sl_p=sl_p, tp_p=tp_p, rrr=rrr,
                qty=qty_est, leverage=leverage, account_mode=account_mode, size_info=sinfo_est,
                max_margin_pct=max_margin_pct, is_signal_only=True,
            )
            _LAST_SIGNAL_ALERT_TS[sym] = now_ts
        return

    allowed_sess, sess_msg = is_session_guard_allowing_entry(settings)
    if not allowed_sess:
        print(f"[Session Guard] {sym} {action} skipped — {sess_msg}")
        return

    if settings.get("risk_limits_enabled", True) and trades_today >= max_trades:
        print(f"[Daily Cap] {sym} {action} skipped — {trades_today}/{max_trades} trades today")
        return

    last_cd = _LAST_COOLDOWN.get(sym, 0.0)
    if (now_ts - last_cd) < 180.0:
        return

    spread_ok, spread_pct = risk.is_spread_valid(sym, max_spread_pct=0.20)
    if not spread_ok:
        print(f"[Spread Filter] {sym} spread {spread_pct:.3f}% > 0.20% -> Skipped")
        return

    qty, size_info = be.calculate_crypto_smc_quantity(
        symbol=sym,
        entry_price=entry_p,
        sl_price=sl_p,
        usdt_equity=equity,
        risk_pct=risk_pct,
        leverage=leverage,
        max_margin_pct=max_margin_pct,
        account_mode=account_mode,
    )
    if qty <= 0:
        print(f"[Sizing Skip] {sym} {action}: {size_info.get('error', 'Insufficient size')}")
        return

    is_long = action == "BUY"
    sig_id = None
    try:
        sig_id = db.log_signal(
            symbol_a=sym,
            symbol_b=f"{rrr:.2f}R",
            price_a=entry_p,
            price_b=tp_p,
            beta=sl_p,
            alpha=float(leverage),
            z_score=float(rrr),
            obi=float(size_info.get("margin_pct", 0.0)),
            action=action,
        )
    except Exception:
        pass

    ok, exec_res = be.execute_single_smc_binance_trade(
        symbol=sym,
        is_long=is_long,
        entry_price=entry_p,
        sl_price=sl_p,
        total_qty=qty,
        tp_price=tp_p,
        leverage=leverage,
        signal_id=sig_id,
        comment=f"SMC_9STEP_{account_mode}",
    )
    if ok:
        _LAST_COOLDOWN[sym] = now_ts
        risk.increment_trades_count()
        print(
            f"[EXECUTED SMC FUTURES] {action} {qty} {sym} @ {exec_res['entry_price']} | "
            f"SL={exec_res['sl']} | TP={exec_res['tp']} ({rrr:.2f}R) | "
            f"Margin={size_info['margin_used']} USDT ({size_info['margin_pct']}%) @ {leverage}x [{account_mode}]"
        )
        send_discord_crypto_smc_signal(
            action=action,
            symbol=sym,
            entry_p=float(exec_res["entry_price"]),
            sl_p=float(exec_res["sl"]),
            tp_p=float(exec_res["tp"]),
            rrr=rrr,
            qty=qty,
            leverage=leverage,
            account_mode=account_mode,
            size_info=size_info,
            max_margin_pct=max_margin_pct,
            ticket_id=int(exec_res.get("order_id", 0)),
            is_signal_only=False,
        )
    else:
        print(f"[EXEC FAILED] {sym} {action}: {exec_res}")


def main():
    print("=" * 72)
    print(f"CRYPTO FUTURES PURE 9-CONDITION SMC ENGINE STARTING | {'TESTNET' if be.USE_TESTNET else 'MAINNET'}")
    print(f"Scanning Top 10 Volatile Perpetuals + Dynamic Custom Search Coins (PKT Sync)")
    print("=" * 72)

    be.sync_binance_time()
    db.initialize_database()
    db.cleanup_stale_scanned_assets(TOP_10_CRYPTO_SYMBOLS)

    peak_equity = 0.0
    cycle_num = 0

    while True:
        try:
            settings = db.get_crypto_bot_settings() or {}
            equity, avail_bal = be.get_binance_usdt_balance()
            open_positions = be.get_binance_open_positions_detailed()
            floating_pnl = sum(float(p.get("unrealized_pnl", 0.0)) for p in open_positions)

            if equity > 0:
                init_bal = float(settings.get("initial_balance", equity) or equity)
                if init_bal <= 0:
                    init_bal = equity
                peak_equity = max(peak_equity, float(settings.get("max_equity_peak", equity) or equity), equity)
            else:
                init_bal = float(settings.get("initial_balance", 10000.0) or 10000.0)

            be.sync_all_binance_open_positions_to_db()
            poll_manual_commands(settings)

            if open_positions:
                manage_open_futures_positions(open_positions, equity, settings)

            is_halted, daily_dd_pct, halt_reason = risk.check_drawdown_limit(equity, settings, floating_pnl)
            is_running = bool(settings.get("is_bot_running", True))

            if not is_running:
                sys_status = "PAUSED (User Control)"
            elif is_halted:
                sys_status = halt_reason
            else:
                sess_ok, _ = is_session_guard_allowing_entry(settings)
                sys_status = "RUNNING (Active SMC)" if sess_ok else "PAUSED (Session Guard)"

            trades_today = risk.get_trades_count_today()
            active_sym = be.resolve_binance_symbol(settings.get("active_pair", "BTCUSDT"))
            start_eq = risk.get_or_create_daily_start_equity(equity)

            db.update_bot_state(
                active_pair=active_sym,
                system_status=sys_status,
                equity=equity,
                drawdown_percent=daily_dd_pct,
                floating_profit=floating_pnl,
                z_score=0.0,
                hedge_ratio=float(settings.get("leverage", 5)),
                obi_a=0.0,
                obi_b=0.0,
                trades_today=trades_today,
                sl_pips=float(settings.get("max_sl_pct", 1.2)),
            )
            db.update_daily_metrics(
                date_obj=risk.get_broker_today_date(),
                start_equity=start_eq,
                current_equity=equity,
                max_dd=daily_dd_pct,
                trades_count=trades_today,
                login_id=0,
            )

            if not is_halted:
                run_smc_scan_and_trade(equity, avail_bal, open_positions, settings, force_scan=(cycle_num == 0))

            cycle_num += 1
        except KeyboardInterrupt:
            print("\nCrypto SMC Bot interrupted by user. Stopping cleanly.")
            break
        except Exception as e:
            print(f"[Main Loop Error]: {e}")

        time.sleep(3.0)


if __name__ == "__main__":
    main()
