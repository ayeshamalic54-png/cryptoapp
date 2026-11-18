"""
Pure 9-Condition Rule-Based Institutional SMC Strategy Engine for Crypto USDT-M Futures.
Zero Z-score, Zero Kalman filter, Zero lagging RSI/EMA, Zero 3-part split.
Supports both LONG (BUY) and SHORT (SELL) Futures setups symmetrically across ANY Binance coin.
"""
import json
from datetime import datetime, timezone, timedelta
import numpy as np
import pandas as pd

import smc_indicators as smc

PKT_TZ = timezone(timedelta(hours=5))


def _format_pkt_hhmm(raw_ts) -> str:
    try:
        if isinstance(raw_ts, pd.Timestamp):
            dt = raw_ts.to_pydatetime()
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(PKT_TZ).strftime("%H:%M")
        if isinstance(raw_ts, (int, float)):
            sec = raw_ts / 1000.0 if raw_ts > 1e11 else float(raw_ts)
            return datetime.fromtimestamp(sec, tz=timezone.utc).astimezone(PKT_TZ).strftime("%H:%M")
        dt = pd.to_datetime(raw_ts, utc=True).to_pydatetime()
        return dt.astimezone(PKT_TZ).strftime("%H:%M")
    except Exception:
        return ""


def _compute_m15_opposing_target(
    direction: str,
    df_m15: pd.DataFrame,
    entry_price: float,
    sl_dist: float,
    min_target_rrr: float = 1.85,
):
    """
    Step 9: Locates the nearest M15 structural opposing liquidity target (Swing High/Low, OB, Breaker),
    front-run by percentage safety buffer so TP fills cleanly before opposing liquidity sweeps.
    """
    scale = smc._calc_crypto_scale(df_m15)
    m15_target_min_amp = scale["m15_target_min_amp"]
    front_run_buf = scale["front_run_buf"]
    min_move = scale["target_min_move"]

    sh_3, sl_3 = smc.get_swing_points(df_m15, n_left=3, n_right=3, min_amplitude=0.0)
    sh_2, sl_2 = smc.get_swing_points(df_m15, n_left=2, n_right=2, min_amplitude=m15_target_min_amp)
    if direction == "BUY" and not sh_2:
        sh_2, _ = smc.get_swing_points(df_m15, n_left=2, n_right=2, min_amplitude=0.0)
    if direction == "SELL" and not sl_2:
        _, sl_2 = smc.get_swing_points(df_m15, n_left=2, n_right=2, min_amplitude=0.0)

    m15_zones = smc.detect_smc_zones(df_m15)

    if direction == "BUY":
        raw_cands = (
            [p[0] for p in sh_3]
            + [p[0] for p in sh_2]
            + [z[0] for z in m15_zones.get("bearish_ob", [])]
            + [z[0] for z in m15_zones.get("bearish_breaker", [])]
        )
        valid = sorted([float(p) for p in raw_cands if float(p) > entry_price + min_move])
        for lvl in valid:
            front_run_tp = lvl - front_run_buf
            cand_rrr = (front_run_tp - entry_price) / sl_dist if sl_dist > 0 else 0.0
            if cand_rrr >= min_target_rrr:
                if cand_rrr > 3.0:
                    return (entry_price + 3.0 * sl_dist, 3.0, f"M15 Liquidity @ {lvl:g} (Capped 3.0R)")
                return (front_run_tp, round(cand_rrr, 2), f"M15 Structural Target @ {lvl:g}")
        return (entry_price + 2.2 * sl_dist, 2.2, "M15 Impulse Projection (2.2R)")

    raw_cands = (
        [p[0] for p in sl_3]
        + [p[0] for p in sl_2]
        + [z[1] for z in m15_zones.get("bullish_ob", [])]
        + [z[1] for z in m15_zones.get("bullish_breaker", [])]
    )
    valid = sorted([float(p) for p in raw_cands if float(p) < entry_price - min_move], reverse=True)
    for lvl in valid:
        front_run_tp = lvl + front_run_buf
        cand_rrr = (entry_price - front_run_tp) / sl_dist if sl_dist > 0 else 0.0
        if cand_rrr >= min_target_rrr:
            if cand_rrr > 3.0:
                return (entry_price - 3.0 * sl_dist, 3.0, f"M15 Liquidity @ {lvl:g} (Capped 3.0R)")
            return (front_run_tp, round(cand_rrr, 2), f"M15 Structural Target @ {lvl:g}")
    return (entry_price - 2.2 * sl_dist, 2.2, "M15 Impulse Projection (2.2R)")


def evaluate_smc_strategy_signal(
    symbol: str,
    df_m5: pd.DataFrame,
    df_m15: pd.DataFrame,
    max_sl_pct: float = 1.20,
    leverage: int = 5,
    min_target_rrr: float = 1.85,
):
    """
    Evaluates ALL 9 Institutional SMC Conditions on Binance USDT-M Futures M15 + M5 data:
      S1: M15 Structural Bias (BULLISH -> LONG / BEARISH -> SHORT)
      S2: M5 Liquidity Sweep on closed M5 candles
      S3: M5 CHoCH / BOS close break (<= 18 bars ago)
      S4: 3-Candle Displacement FVG inside sweep leg
      S5: Closed-Candle FVG Retest (iloc[-2] raw / iloc[-1] closed)
      S6: Closed Rejection Candle (Bullish bar or Hammer / Bearish bar or Shooting Star)
      S7: Closed-Candle Confirmation & Anti-Chase Guard
      S8: Structural SL behind Sweep extreme + 0.08% buffer + Max SL % & Futures Liq-Safe Cap
      S9: Opposing M15 Structural Liquidity Target >= 1.85R
    """
    res = {
        "symbol": symbol.upper(),
        "action": "NONE",
        "entry": 0.0,
        "sl": 0.0,
        "tp": 0.0,
        "rrr": 0.0,
        "m15_bias": "NEUTRAL ⚪",
        "sweep_status": "FAIL ⚪",
        "sweep_price": 0.0,
        "choch_status": "FAIL ⚪",
        "choch_price": 0.0,
        "fvg_status": "FAIL ⚪",
        "retest_status": "FAIL ⚪",
        "s6_status": "FAIL ⚪",
        "s7_status": "FAIL ⚪",
        "s8_status": "",
        "s9_status": "",
        "fvg_bounds_json": "{}",
        "zones": {},
        "reason": "Initializing SMC data",
        "telemetry": {},
    }

    if df_m5 is None or len(df_m5) < 25 or df_m15 is None or len(df_m15) < 15:
        res["reason"] = "Insufficient M15/M5 klines"
        return res

    # Closed M5 candles for zero-lookahead evaluation
    df_closed = df_m5.iloc[:-1].copy() if len(df_m5) > 20 else df_m5.copy()
    live_price = float(df_m5["close"].iloc[-1])
    scale = smc._calc_crypto_scale(df_closed)

    # All chart zones on closed + latest view for UI visibility (FVG, iFVG, OB, BREAKER)
    all_zones = smc.detect_smc_zones(df_m5, symbol=symbol)
    res["zones"] = all_zones

    # Step 1: M15 Structural Bias
    m15_bias = smc.detect_market_structure(df_m15)
    if m15_bias == "BULLISH":
        res["m15_bias"] = "BULLISH 🟢"
    elif m15_bias == "BEARISH":
        res["m15_bias"] = "BEARISH 🔴"
    else:
        res["m15_bias"] = "NEUTRAL ⚪"

    # Build candlestick snapshot (last 45 M5 bars in PKT)
    recent_slice = df_m5.iloc[-45:].copy()
    offset_start = len(df_m5) - len(recent_slice)

    # Step 2: M5 Liquidity Sweep on closed bars
    sweeps = smc.detect_liquidity_sweep(df_closed)
    sell_sw, sell_ext, sell_lvl, sell_idx = sweeps["sell_sweep"]
    buy_sw, buy_ext, buy_lvl, buy_idx = sweeps["buy_sweep"]

    is_bullish = False
    has_sweep = False
    sweep_ext = 0.0
    sweep_lvl = 0.0
    sweep_idx = -1

    if m15_bias == "BULLISH" and sell_sw:
        is_bullish = True
        has_sweep = True
        sweep_ext, sweep_lvl, sweep_idx = sell_ext, sell_lvl, sell_idx
        res["sweep_status"] = f"PASS 🟢 (Swept Low)"
        res["sweep_price"] = round(sweep_ext, 8)
    elif m15_bias == "BEARISH" and buy_sw:
        is_bullish = False
        has_sweep = True
        sweep_ext, sweep_lvl, sweep_idx = buy_ext, buy_lvl, buy_idx
        res["sweep_status"] = f"PASS 🟢 (Swept High)"
        res["sweep_price"] = round(sweep_ext, 8)
    else:
        # Expose non-aligned sweep only as FAIL info
        res["sweep_status"] = "FAIL ⚪ (No M15-aligned sweep)"

    choch_ok = False
    choch_lvl = 0.0
    choch_idx = -1
    fvg_zones_leg = []
    fvg_ok = False
    retest_ok = False
    matched_fvg = None
    s6_ok = False
    s7_ok = False
    s8_ok = False
    s9_ok = False
    opposing_tp = 0.0

    closed_idx = len(df_closed) - 1
    closed_bar = df_closed.iloc[-1]
    c_open = float(closed_bar["open"])
    c_high = float(closed_bar["high"])
    c_low = float(closed_bar["low"])
    c_close = float(closed_bar["close"])

    if has_sweep and m15_bias in ("BULLISH", "BEARISH"):
        # Step 3: M5 CHoCH / BOS
        c_ok, c_lvl, c_idx = smc.detect_choch_bos(df_closed, sweep_idx, is_bullish=is_bullish)
        reclaim_intact = (c_close >= sweep_ext) if is_bullish else (c_close <= sweep_ext)
        if c_ok and (closed_idx - c_idx) <= 18 and reclaim_intact:
            choch_ok = True
            choch_lvl = c_lvl
            choch_idx = c_idx
            res["choch_status"] = f"PASS 🟢 (Close {'Above' if is_bullish else 'Below'} Pivot)"
            res["choch_price"] = round(choch_lvl, 8)

            # Step 4: 3-Candle Displacement FVG inside sweep leg
            leg_zones = smc.detect_smc_zones(
                df_closed,
                symbol=symbol,
                min_idx=sweep_idx,
                sweep_low=sweep_ext if is_bullish else None,
                sweep_high=None if is_bullish else sweep_ext,
            )
            fvg_zones_leg = leg_zones["bullish_fvg"] if is_bullish else leg_zones["bearish_fvg"]
            if fvg_zones_leg:
                fvg_ok = True
                res["fvg_status"] = f"PASS 🟢 ({len(fvg_zones_leg)} FVG)"

                # Step 5: Closed-Candle FVG Retest
                r_ok, r_box = smc.check_fvg_retest(
                    df_closed, fvg_zones_leg, is_bullish=is_bullish, symbol=symbol, check_closed_candle=False
                )
                if r_ok and r_box is not None:
                    retest_ok = True
                    matched_fvg = r_box
                    res["retest_status"] = "PASS 🟢 (Closed Retest)"

                    # Step 6: Rejection Candle (iloc[-1] of df_closed == iloc[-2] of df_m5)
                    c_range = max(scale["ref_price"] * 1e-5, c_high - c_low)
                    if is_bullish:
                        lower_wick = min(c_open, c_close) - c_low
                        is_pin = (lower_wick / c_range >= 0.45) and ((c_open - c_close) <= 0.25 * c_range)
                        s6_ok = (c_close > c_open) or is_pin
                    else:
                        upper_wick = c_high - max(c_open, c_close)
                        is_pin = (upper_wick / c_range >= 0.45) and ((c_close - c_open) <= 0.25 * c_range)
                        s6_ok = (c_close < c_open) or is_pin

                    if s6_ok:
                        res["s6_status"] = "PASS 🟢 (Rejection)"
                        f_low, f_high = float(matched_fvg[0]), float(matched_fvg[1])
                        max_chase = scale["max_chase_dist"]

                        # Step 7: Closed Confirmation & Anti-Chase Guard
                        if is_bullish:
                            s7_ok = (c_close >= f_low) and (live_price <= f_high + max_chase)
                        else:
                            s7_ok = (c_close <= f_high) and (live_price >= f_low - max_chase)

                        if s7_ok:
                            res["s7_status"] = "PASS 🟢 (Confirmed)"

                            # Step 8: Structural SL behind sweep extreme + 0.08% buffer + Max SL % & Futures Liq Guard
                            sl_buf = scale["sl_buf"]
                            raw_sl = (sweep_ext - sl_buf) if is_bullish else (sweep_ext + sl_buf)
                            sl_dist = abs(live_price - raw_sl)
                            sl_pct = (sl_dist / live_price) * 100.0 if live_price > 0 else 99.0
                            # Ensure SL always fires way before Futures liquidation (~60% of 1/leverage distance)
                            liq_safe_sl_pct = min(float(max_sl_pct), 60.0 / max(1, int(leverage)))

                            if sl_dist > 0 and sl_pct <= liq_safe_sl_pct:
                                s8_ok = True
                                res["s8_status"] = f"PASS 🟢 (SL {sl_pct:.2f}% / Max {liq_safe_sl_pct:.2f}%)"

                                # Step 9: Opposing M15 Structural Liquidity Target (>= 1.85R)
                                tp_price, cand_rrr, tp_reason = _compute_m15_opposing_target(
                                    "BUY" if is_bullish else "SELL",
                                    df_m15,
                                    live_price,
                                    sl_dist,
                                    min_target_rrr=min_target_rrr,
                                )
                                opposing_tp = tp_price
                                if cand_rrr >= min_target_rrr:
                                    s9_ok = True
                                    res["s9_status"] = f"PASS 🟢 ({cand_rrr:.2f}R M15 Target)"
                                    res["action"] = "BUY" if is_bullish else "SELL"
                                    res["entry"] = live_price
                                    res["sl"] = raw_sl
                                    res["tp"] = tp_price
                                    res["rrr"] = float(cand_rrr)
                                    res["reason"] = f"ALL 9 PURE SMC VERIFIED ({res['action']} @ {cand_rrr:.2f}R | {tp_reason})"
                                else:
                                    res["s9_status"] = f"FAIL 🔴 ({cand_rrr:.2f}R < {min_target_rrr:.2f}R)"
                                    res["reason"] = f"S9 Blocked: M15 Target R:R {cand_rrr:.2f} < {min_target_rrr:.2f}"
                            else:
                                res["s8_status"] = f"FAIL 🔴 (SL {sl_pct:.2f}% > {liq_safe_sl_pct:.2f}%)"
                                res["reason"] = f"S8 Blocked: Structural SL {sl_pct:.2f}% exceeds {liq_safe_sl_pct:.2f}% cap"
                        else:
                            res["s7_status"] = "FAIL ⚪ (Chasing / unconfirmed close)"
                            res["reason"] = "S7 Pending: Closed confirmation / anti-chase guard"
                    else:
                        res["s6_status"] = "FAIL ⚪ (Awaiting Rejection)"
                        res["reason"] = "S6 Pending: Awaiting FVG rejection candle"
                else:
                    res["retest_status"] = "FAIL ⚪ (Awaiting Retest)"
                    res["reason"] = "S5 Pending: Awaiting closed-candle FVG retest"
            else:
                res["fvg_status"] = "FAIL ⚪ (No Leg FVG)"
                res["reason"] = "S4 Pending: Waiting for displacement FVG"
        else:
            res["choch_status"] = "FAIL ⚪ (Awaiting CHoCH)"
            res["reason"] = "S3 Pending: Waiting for CHoCH/BOS close"
    elif m15_bias == "NEUTRAL":
        res["reason"] = "S1 Pending: M15 Market Structure NEUTRAL"
    else:
        res["reason"] = f"S2 Pending: {m15_bias} M15 bias active; awaiting M5 Sweep"

    # Populate chart candle array with explicit milestone flags for SmcChartOverlay
    candles_out = []
    times_col = df_m5["time"].values if "time" in df_m5.columns else df_m5.index.values
    for rel_i in range(len(recent_slice)):
        abs_i = offset_start + rel_i
        row = recent_slice.iloc[rel_i]
        candles_out.append({
            "time": _format_pkt_hhmm(times_col[abs_i]),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row["tick_volume"]) if "tick_volume" in recent_slice.columns else float(row.get("volume", 100.0)),
            "isSweep": bool(has_sweep and abs_i == sweep_idx),
            "isChoch": bool(choch_ok and abs_i == choch_idx),
            "isRetest": bool(retest_ok and abs_i == closed_idx),
            "isRejection": bool(s6_ok and abs_i == closed_idx),
        })

    # If S9 wasn't evaluated yet (or blocked before S8), still project indicative opposing TP for chart preview
    if opposing_tp <= 0 and m15_bias in ("BULLISH", "BEARISH"):
        est_sl_dist = abs(live_price - sweep_ext) + scale["sl_buf"] if has_sweep else live_price * 0.005
        if est_sl_dist > 0:
            est_tp, est_rrr, _ = _compute_m15_opposing_target(
                "BUY" if m15_bias == "BULLISH" else "SELL",
                df_m15,
                live_price,
                est_sl_dist,
                min_target_rrr=min_target_rrr,
            )
            opposing_tp = est_tp
            if not res["rrr"]:
                res["rrr"] = est_rrr

    # Combine Displacement FVGs with active FVG zones for chart fallback
    bull_fvg_boxes = [[float(z[0]), float(z[1])] for z in (fvg_zones_leg if (fvg_ok and is_bullish) else all_zones["bullish_fvg"])]
    bear_fvg_boxes = [[float(z[0]), float(z[1])] for z in (fvg_zones_leg if (fvg_ok and not is_bullish) else all_zones["bearish_fvg"])]

    fvg_payload = {
        "bullish_fvg": bull_fvg_boxes,
        "bearish_fvg": bear_fvg_boxes,
        "opposing_tp": float(opposing_tp) if opposing_tp > 0 else 0.0,
        "sl_price": float(res["sl"]) if res["sl"] > 0 else 0.0,
        "candles": candles_out,
        "step_progress": sum([
            m15_bias in ("BULLISH", "BEARISH"),
            has_sweep,
            choch_ok,
            fvg_ok,
            retest_ok,
            s6_ok,
            s7_ok,
            s8_ok,
            s9_ok,
        ]),
    }
    res["fvg_bounds_json"] = json.dumps(fvg_payload)
    res["telemetry"] = {
        "symbol": symbol.upper(),
        "m15_bias": res["m15_bias"],
        "sweep_status": res["sweep_status"],
        "sweep_price": res["sweep_price"],
        "choch_status": res["choch_status"],
        "choch_price": res["choch_price"],
        "fvg_status": res["fvg_status"],
        "fvg_bounds_json": res["fvg_bounds_json"],
        "retest_status": res["retest_status"],
        "s6_status": res["s6_status"],
        "s7_status": res["s7_status"],
        "s8_status": res["s8_status"],
        "s9_status": res["s9_status"],
        "action": res["action"],
    }
    return res
