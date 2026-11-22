"""
Binance USDT-M Perpetual Futures Execution & Market Data Engine.
Supports both Binance Futures Testnet (USE_BINANCE_TESTNET=True) and Live Mainnet.
Implements:
  - Dynamic MIN_NOTIONAL + stepSize + tickSize filter extraction for all 560+ USDT perpetuals
  - Account Leverage configuration (/fapi/v1/leverage)
  - Risk-First Position Sizing strictly capped at <= 80% of capital margin (Prop Firm & Personal $50-$300 USDT)
  - Pure Single-Order SMC Entry + Server-Side Conditional STOP_MARKET SL & TAKE_PROFIT_MARKET TP (/fapi/v1/algoOrder)
  - One-Time Fee-Aware Risk-Free Breakeven SL modification (+0.12% buffer)
  - Live Position & UserTrades realized PnL sync to PostgreSQL
"""
import os
import hmac
import hashlib
import time
import math
import requests
import pandas as pd
from datetime import datetime, timezone
from urllib.parse import urlencode
from dotenv import load_dotenv
from decimal import Decimal, ROUND_DOWN, ROUND_UP, ROUND_HALF_UP

import database as db

ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
load_dotenv(ENV_PATH, override=True)

API_KEY = os.getenv("BINANCE_API_KEY", "").strip()
API_SECRET = os.getenv("BINANCE_API_SECRET", "").strip()
USE_TESTNET = os.getenv("USE_BINANCE_TESTNET", "False").strip().lower() in ("true", "1", "yes")

BASE_URL = "https://testnet.binancefuture.com" if USE_TESTNET else "https://fapi.binance.com"

_EXCHANGE_INFO_CACHE = {"ts": 0.0, "data": {}, "symbols": set()}
_TIME_OFFSET_MS = 0
_TIME_SYNCED = False
_LEVERAGE_CACHE = {}


def sync_binance_time():
    global _TIME_OFFSET_MS, _TIME_SYNCED
    try:
        resp = requests.get(f"{BASE_URL}/fapi/v1/time", timeout=5)
        if resp.status_code == 200:
            srv_time = int(resp.json().get("serverTime", 0))
            if srv_time > 0:
                local_time = int(time.time() * 1000)
                _TIME_OFFSET_MS = srv_time - local_time
                _TIME_SYNCED = True
    except Exception:
        pass


def _refresh_exchange_info(force: bool = False):
    now = time.time()
    if not force and _EXCHANGE_INFO_CACHE["data"] and (now - _EXCHANGE_INFO_CACHE["ts"]) < 900:
        return
    try:
        resp = requests.get(f"{BASE_URL}/fapi/v1/exchangeInfo", timeout=10)
        if resp.status_code == 200:
            sym_map = {}
            valid_syms = set()
            for item in resp.json().get("symbols", []):
                sym = item.get("symbol", "")
                if item.get("quoteAsset") == "USDT" and item.get("status") == "TRADING":
                    valid_syms.add(sym)
                sym_map[sym] = item
            _EXCHANGE_INFO_CACHE["data"] = sym_map
            _EXCHANGE_INFO_CACHE["symbols"] = valid_syms
            _EXCHANGE_INFO_CACHE["ts"] = now
    except Exception:
        pass


def get_all_binance_usdt_symbols() -> list:
    _refresh_exchange_info()
    return sorted(_EXCHANGE_INFO_CACHE["symbols"])


def resolve_binance_symbol(symbol: str) -> str:
    """Resolves any crypto ticker or pair string into a valid Binance USDT-M symbol (incl. 1000-prefixed coins)."""
    if not symbol:
        return "BTCUSDT"
    s = symbol.upper().split("/")[0].replace("-", "").replace("_", "").strip()
    if s.endswith("USD") and not s.endswith("USDT") and len(s) <= 8:
        s = s + "T"
    if not s.endswith("USDT"):
        s = s + "USDT"
    _refresh_exchange_info()
    valid = _EXCHANGE_INFO_CACHE.get("symbols") or set()
    if valid and s not in valid and f"1000{s}" in valid:
        return f"1000{s}"
    return s


def get_symbol_filters_ext(symbol: str) -> dict:
    """Returns full Binance Futures filters: step_size, tick_size, min_qty, min_notional."""
    _refresh_exchange_info()
    bin_sym = resolve_binance_symbol(symbol)
    item = _EXCHANGE_INFO_CACHE["data"].get(bin_sym)
    step_size = 0.001
    tick_size = 0.01
    min_qty = 0.001
    min_notional = 5.0

    if item:
        for f in item.get("filters", []):
            ftype = f.get("filterType")
            if ftype == "LOT_SIZE":
                step_size = float(f.get("stepSize", step_size))
                min_qty = float(f.get("minQty", min_qty))
            elif ftype == "PRICE_FILTER":
                tick_size = float(f.get("tickSize", tick_size))
            elif ftype == "MIN_NOTIONAL":
                raw_not = f.get("notional") or f.get("minNotional") or 5.0
                min_notional = float(raw_not)
    return {
        "symbol": bin_sym,
        "step_size": step_size,
        "tick_size": tick_size,
        "min_qty": min_qty,
        "min_notional": min_notional,
    }


def get_symbol_filters(symbol: str):
    ext = get_symbol_filters_ext(symbol)
    return ext["step_size"], ext["tick_size"], ext["min_qty"]


def send_signed_request(method: str, endpoint: str, params: dict = None):
    if not _TIME_SYNCED:
        sync_binance_time()
    p = dict(params or {})
    p["timestamp"] = int(time.time() * 1000) + _TIME_OFFSET_MS
    p["recvWindow"] = 10000
    qs = urlencode(p)
    sig = hmac.new(API_SECRET.encode("utf-8"), qs.encode("utf-8"), hashlib.sha256).hexdigest()
    headers = {"X-MBX-APIKEY": API_KEY}
    url = f"{BASE_URL}{endpoint}?{qs}&signature={sig}"

    resp = requests.request(method.upper(), url, headers=headers, timeout=12)
    if resp.status_code == 400 and '"code":-1021' in resp.text:
        sync_binance_time()
        p["timestamp"] = int(time.time() * 1000) + _TIME_OFFSET_MS
        qs = urlencode(p)
        sig = hmac.new(API_SECRET.encode("utf-8"), qs.encode("utf-8"), hashlib.sha256).hexdigest()
        url = f"{BASE_URL}{endpoint}?{qs}&signature={sig}"
        resp = requests.request(method.upper(), url, headers=headers, timeout=12)
    return resp


def set_binance_leverage(symbol: str, leverage: int = 5) -> int:
    """Configures Binance Futures symbol leverage safely, stepping down if symbol max is lower."""
    bin_sym = resolve_binance_symbol(symbol)
    target_lev = max(1, min(50, int(leverage or 5)))
    if _LEVERAGE_CACHE.get(bin_sym) == target_lev:
        return target_lev

    for lev in [target_lev, min(target_lev, 20), min(target_lev, 10), min(target_lev, 5), 1]:
        try:
            r = send_signed_request("POST", "/fapi/v1/leverage", {"symbol": bin_sym, "leverage": int(lev)})
            if r.status_code == 200:
                actual = int(r.json().get("leverage", lev))
                _LEVERAGE_CACHE[bin_sym] = actual
                return actual
        except Exception:
            pass
    return target_lev


def round_to_tick_size(price: float, tick_size: float, precision: int = None) -> float:
    if tick_size <= 0:
        return round(float(price), 6)
    d_price = Decimal(str(float(price)))
    d_tick = Decimal(str(tick_size)).normalize()
    q = d_price.quantize(d_tick, rounding=ROUND_HALF_UP)
    return float(q)


def round_to_step_size(qty: float, step_size: float, up: bool = False) -> float:
    if qty <= 0:
        return 0.0
    if step_size <= 0:
        return float(qty)
    d_qty = Decimal(str(float(qty)))
    d_step = Decimal(str(step_size)).normalize()
    mode = ROUND_UP if up else ROUND_DOWN
    return float(d_qty.quantize(d_step, rounding=mode))


STABLECOIN_ASSETS = {"USDT", "USDC", "FDUSD", "BUSD", "TUSD", "USDP"}


def get_binance_usdt_balance():
    """Returns (stablecoin_equity_usd, available_balance_usd) excluding volatile BTC/BNB collateral."""
    try:
        r = send_signed_request("GET", "/fapi/v2/account", {})
        if r.status_code == 200:
            data = r.json()
            assets = data.get("assets") or []
            stable_assets = [a for a in assets if str(a.get("asset", "")).upper() in STABLECOIN_ASSETS]
            stable_wallet = sum(float(a.get("walletBalance", 0.0) or 0.0) for a in stable_assets)
            unreal = float(data.get("totalUnrealizedProfit", 0.0) or 0.0)
            if stable_assets and stable_wallet > 0:
                eq = stable_wallet + unreal
                raw_avail = float(data.get("availableBalance", eq) or eq)
                return round(eq, 4), round(min(raw_avail, max(0.0, eq)), 4)

            wallet = float(data.get("totalWalletBalance", 0.0) or 0.0)
            margin_bal = float(data.get("totalMarginBalance", wallet + unreal) or (wallet + unreal))
            avail = float(data.get("availableBalance", wallet) or wallet)
            return round(margin_bal, 4), round(avail, 4)
    except Exception as e:
        print(f"[Binance] Balance fetch failed: {e}")
    return 0.0, 0.0


def get_binance_open_positions_detailed() -> list:
    """Returns currently open USDT-M positions directly from /fapi/v2/positionRisk."""
    out = []
    try:
        r = send_signed_request("GET", "/fapi/v2/positionRisk", {})
        if r.status_code == 200:
            for p in r.json():
                amt = float(p.get("positionAmt", 0) or 0)
                if abs(amt) > 0:
                    entry = float(p.get("entryPrice", 0) or 0)
                    mark = float(p.get("markPrice", entry) or entry)
                    upnl = float(p.get("unRealizedProfit", 0) or 0)
                    lev = int(float(p.get("leverage", 5) or 5))
                    init_margin = float(p.get("initialMargin", 0) or (abs(amt) * entry / max(1, lev)))
                    out.append({
                        "symbol": p.get("symbol", ""),
                        "side": "BUY" if amt > 0 else "SELL",
                        "qty": abs(amt),
                        "entry_price": entry,
                        "mark_price": mark,
                        "unrealized_pnl": upnl,
                        "leverage": lev,
                        "initial_margin": init_margin,
                        "liquidation_price": float(p.get("liquidationPrice", 0) or 0),
                    })
    except Exception as e:
        print(f"[Binance] positionRisk error: {e}")
    return out


def calculate_crypto_smc_quantity(
    symbol: str,
    entry_price: float,
    sl_price: float,
    usdt_equity: float,
    risk_pct: float = 1.0,
    leverage: int = 5,
    max_margin_pct: float = 80.0,
    account_mode: str = "PROP_FIRM",
):
    """
    Risk-First Crypto Futures Position Sizing with Strict <= 80% Capital Margin Cap & MIN_NOTIONAL Guard:
      1. Risk budget = equity * (risk_pct / 100), capped inside 1.75% in PROP_FIRM (Blue Guardian 2% shield safe)
      2. qty_by_risk = risk_usdt / abs(entry_price - sl_price)
      3. qty_by_margin = (equity * min(80%, max_margin_pct) * leverage) / entry_price
      4. Final qty = min(qty_by_risk, qty_by_margin) quantized to stepSize
      5. Verified against Binance MIN_NOTIONAL (bumps cleanly ONLY if within <=80% margin & risk cap; else safely skips)
    """
    if entry_price <= 0 or usdt_equity <= 0:
        return 0.0, {"error": "Invalid entry price or zero equity"}

    filters = get_symbol_filters_ext(symbol)
    step_size = filters["step_size"]
    min_qty = filters["min_qty"]
    min_notional = filters["min_notional"]

    eff_max_margin_pct = min(80.0, max(5.0, float(max_margin_pct or 80.0)))
    eff_lev = max(1, min(50, int(leverage or 5)))
    mode = str(account_mode or "PROP_FIRM").upper()

    sl_dist = abs(float(entry_price) - float(sl_price))
    if sl_dist <= 0:
        return 0.0, {"error": "Zero SL distance"}

    eff_risk_pct = float(risk_pct or 1.0)
    if mode == "PROP_FIRM":
        # Never risk >= 2% Guardian Shield floating cut on a single SMC setup
        eff_risk_pct = min(eff_risk_pct, 1.75)

    risk_usdt = usdt_equity * (eff_risk_pct / 100.0)
    raw_qty_risk = risk_usdt / sl_dist

    max_notional_allowed = usdt_equity * (eff_max_margin_pct / 100.0) * eff_lev
    max_qty_margin = max_notional_allowed / entry_price

    qty = round_to_step_size(min(raw_qty_risk, max_qty_margin), step_size, up=False)
    notional = qty * entry_price

    if notional < min_notional or qty < min_qty:
        req_notional = max(min_notional * 1.02, min_qty * entry_price)
        min_req_qty = round_to_step_size(req_notional / entry_price, step_size, up=True)
        min_req_notional = min_req_qty * entry_price
        min_req_risk_pct = ((min_req_qty * sl_dist) / usdt_equity) * 100.0
        max_safe_bump_risk = 1.90 if mode == "PROP_FIRM" else 8.0

        if min_req_notional <= max_notional_allowed and min_req_risk_pct <= max_safe_bump_risk:
            qty = min_req_qty
            notional = min_req_notional
        else:
            return 0.0, {
                "error": (
                    f"{filters['symbol']} minNotional=${min_notional:.2f} needs notional=${min_req_notional:.2f} "
                    f"(max_allowed=${max_notional_allowed:.2f} @ {eff_max_margin_pct:.0f}% margin x {eff_lev}x, "
                    f"risk={min_req_risk_pct:.2f}% > {max_safe_bump_risk:.2f}%)"
                )
            }

    margin_used = notional / eff_lev
    margin_pct = (margin_used / usdt_equity) * 100.0 if usdt_equity > 0 else 0.0
    if margin_pct > eff_max_margin_pct + 0.05:
        return 0.0, {"error": f"Margin {margin_pct:.1f}% exceeds {eff_max_margin_pct:.1f}% cap"}

    actual_risk_usdt = qty * sl_dist
    return qty, {
        "qty": qty,
        "notional": round(notional, 2),
        "margin_used": round(margin_used, 2),
        "margin_pct": round(margin_pct, 2),
        "risk_usdt": round(actual_risk_usdt, 2),
        "min_notional": min_notional,
        "leverage": eff_lev,
    }


def calculate_binance_full_equity_quantity(symbol, entry_price, usdt_equity, max_margin_pct=80.0):
    sl_est = entry_price * 0.99
    qty, _ = calculate_crypto_smc_quantity(symbol, entry_price, sl_est, usdt_equity, 1.0, 5, min(80.0, float(max_margin_pct)), "PERSONAL")
    return qty


def calculate_binance_quantity(symbol, sl_distance_price, usdt_balance, risk_pct=1.0):
    tick = get_binance_live_tick(symbol)
    entry = tick[2] if tick else 100.0
    qty, _ = calculate_crypto_smc_quantity(symbol, entry, max(entry * 0.5, entry - sl_distance_price), usdt_balance, risk_pct, 5, 80.0, "PROP_FIRM")
    return qty


def _cancel_all_symbol_orders(bin_sym: str):
    """Cancels both standard open orders and Futures conditional algo orders (SL/TP)."""
    for ep in ("/fapi/v1/allOpenOrders", "/fapi/v1/algoOpenOrders"):
        try:
            send_signed_request("DELETE", ep, {"symbol": bin_sym})
        except Exception:
            pass


def _place_conditional_close_order(bin_sym: str, side: str, order_type: str, trigger_price: float, qty: float):
    """
    Places server-side SL (STOP_MARKET) or TP (TAKE_PROFIT_MARKET) via Binance Futures /fapi/v1/algoOrder
    with fallback to /fapi/v1/order if needed.
    """
    params = {
        "algoType": "CONDITIONAL",
        "symbol": bin_sym,
        "side": side,
        "type": order_type,
        "triggerPrice": f"{trigger_price}",
        "closePosition": "true",
        "workingType": "MARK_PRICE",
        "priceProtect": "TRUE",
    }
    r = send_signed_request("POST", "/fapi/v1/algoOrder", params)
    if r.status_code == 200:
        return True, r.json()

    # Fallback to standard /fapi/v1/order conditional endpoint
    fallback_params = {
        "symbol": bin_sym,
        "side": side,
        "type": order_type,
        "stopPrice": f"{trigger_price}",
        "closePosition": "true",
        "workingType": "MARK_PRICE",
    }
    r2 = send_signed_request("POST", "/fapi/v1/order", fallback_params)
    if r2.status_code == 200:
        return True, r2.json()
    return False, f"algoOrder={r.status_code}:{r.text} | order={r2.status_code}:{r2.text}"


def execute_single_smc_binance_trade(
    symbol: str,
    is_long: bool,
    entry_price: float,
    sl_price: float,
    total_qty: float,
    tp_price: float,
    leverage: int = 5,
    signal_id=None,
    comment: str = "SMC_9STEP",
    mt5_login: int = 0,
):
    """
    Executes a SINGLE Direct Crypto Futures Market Order + Single SL (behind sweep) + Single M15 Target TP.
    Zero 3-part TP splits! Preserves original strategy structure identically to Forex terminal.
    """
    filters = get_symbol_filters_ext(symbol)
    bin_sym = filters["symbol"]
    step_size = filters["step_size"]
    tick_size = filters["tick_size"]

    qty = round_to_step_size(total_qty, step_size, up=False)
    if qty <= 0 or qty < filters["min_qty"]:
        return False, f"Invalid rounded qty {qty} < min_qty {filters['min_qty']}"

    set_binance_leverage(bin_sym, leverage)

    side = "BUY" if is_long else "SELL"
    exit_side = "SELL" if is_long else "BUY"

    r_entry = send_signed_request("POST", "/fapi/v1/order", {
        "symbol": bin_sym,
        "side": side,
        "type": "MARKET",
        "quantity": f"{qty}",
        "newOrderRespType": "RESULT",
    })
    if r_entry.status_code != 200:
        return False, f"Binance Market Order Failed ({r_entry.status_code}): {r_entry.text}"

    order_json = r_entry.json()
    order_id = int(order_json.get("orderId", int(time.time() * 1000)))
    fill_price = float(order_json.get("avgPrice", 0) or 0)
    exec_qty = float(order_json.get("executedQty", qty) or qty)

    if fill_price <= 0:
        time.sleep(0.25)
        for p in get_binance_open_positions_detailed():
            if p["symbol"] == bin_sym:
                fill_price = float(p["entry_price"] or entry_price)
                exec_qty = float(p["qty"] or exec_qty)
                break
    if fill_price <= 0:
        fill_price = float(entry_price)

    # Guarantee SL & TP preserve minimum tick separation around true fill price
    sl_round = round_to_tick_size(sl_price, tick_size)
    tp_round = round_to_tick_size(tp_price, tick_size)
    if is_long:
        if sl_round >= fill_price:
            sl_round = round_to_tick_size(fill_price * 0.992, tick_size)
        if tp_round <= fill_price:
            tp_round = round_to_tick_size(fill_price * 1.015, tick_size)
    else:
        if sl_round <= fill_price:
            sl_round = round_to_tick_size(fill_price * 1.008, tick_size)
        if tp_round >= fill_price:
            tp_round = round_to_tick_size(fill_price * 0.985, tick_size)

    _cancel_all_symbol_orders(bin_sym)

    sl_ok, sl_res = _place_conditional_close_order(bin_sym, exit_side, "STOP_MARKET", sl_round, exec_qty)
    tp_ok, tp_res = _place_conditional_close_order(bin_sym, exit_side, "TAKE_PROFIT_MARKET", tp_round, exec_qty)

    if not sl_ok or not tp_ok:
        print(f"[Binance Warning] Conditional protection notice for {bin_sym}: sl_ok={sl_ok} ({sl_res}) tp_ok={tp_ok} ({tp_res})")

    try:
        db.log_trade_entry(
            ticket=order_id,
            symbol=bin_sym,
            order_type=side,
            lots=exec_qty,
            entry_price=fill_price,
            entry_time=datetime.now(timezone.utc),
            comment=comment,
            signal_id=signal_id,
        )
        db.save_trade_sl_tp(order_id, sl=sl_round, tp=tp_round, mt5_login=mt5_login)
    except Exception as e:
        print(f"[DB Warning] log_trade_entry failed: {e}")

    return True, {
        "order_id": order_id,
        "symbol": bin_sym,
        "side": side,
        "qty": exec_qty,
        "entry_price": fill_price,
        "sl": sl_round,
        "tp": tp_round,
        "sl_ok": sl_ok,
        "tp_ok": tp_ok,
    }


def execute_three_part_binance_trade(symbol, is_long, entry_price, sl_price, total_qty, tp1, tp2, tp3, signal_id=None):
    """Legacy wrapper redirected to Pure Single-Order SMC execution."""
    return execute_single_smc_binance_trade(symbol, is_long, entry_price, sl_price, total_qty, tp2, leverage=5, signal_id=signal_id)


def modify_binance_sl_to_breakeven(symbol: str, is_long: bool, entry_price: float, tp_price: float, ticket: int = 0) -> tuple:
    """
    One-Time Fee-Aware Risk-Free Breakeven modification:
      Moves SL to entry +/- 0.12% (covering ~0.10% Binance taker roundtrip fees).
      Preserves TAKE_PROFIT_MARKET untouched! Zero trailing stop.
    """
    filters = get_symbol_filters_ext(symbol)
    bin_sym = filters["symbol"]
    tick_size = filters["tick_size"]

    fee_buf = 0.0012  # 0.12% covers taker entry + exit fee + small net gain
    raw_be = entry_price * (1.0 + fee_buf) if is_long else entry_price * (1.0 - fee_buf)
    be_sl = round_to_tick_size(raw_be, tick_size)
    tp_round = round_to_tick_size(tp_price, tick_size)
    exit_side = "SELL" if is_long else "BUY"

    _cancel_all_symbol_orders(bin_sym)
    sl_ok, sl_res = _place_conditional_close_order(bin_sym, exit_side, "STOP_MARKET", be_sl, 0)
    if tp_round > 0:
        _place_conditional_close_order(bin_sym, exit_side, "TAKE_PROFIT_MARKET", tp_round, 0)

    if sl_ok and ticket:
        try:
            db.save_trade_sl_tp(ticket, sl=be_sl, tp=tp_round)
        except Exception:
            pass
    return sl_ok, be_sl if sl_ok else sl_res


def close_all_binance_positions(symbol: str = None):
    """Closes specific or ALL open Binance Futures positions at market and syncs realized P&L to DB."""
    target = resolve_binance_symbol(symbol) if symbol and symbol.upper() != "ALL" else None
    positions = get_binance_open_positions_detailed()
    closed_any = False

    for pos in positions:
        sym = pos["symbol"]
        if target and sym != target:
            continue
        _cancel_all_symbol_orders(sym)
        exit_side = "SELL" if pos["side"] == "BUY" else "BUY"
        r = send_signed_request("POST", "/fapi/v1/order", {
            "symbol": sym,
            "side": exit_side,
            "type": "MARKET",
            "quantity": f"{pos['qty']}",
            "reduceOnly": "true",
            "newOrderRespType": "RESULT",
        })
        if r.status_code == 200:
            closed_any = True
            exit_p = float(r.json().get("avgPrice", 0) or pos["mark_price"] or pos["entry_price"])
            pnl = float(pos.get("unrealized_pnl", 0.0))
            _close_open_db_rows_for_symbol(sym, exit_p, pnl)

    # Also cancel dangling algo/open orders if symbol provided even when position already closed
    if target and not closed_any:
        _cancel_all_symbol_orders(target)
    return closed_any


def close_binance_partial(symbol: str, qty: float, is_long: bool):
    """Direct single close of a specific Futures position leg."""
    filters = get_symbol_filters_ext(symbol)
    bin_sym = filters["symbol"]
    q = round_to_step_size(qty, filters["step_size"], up=False)
    if q <= 0:
        return False
    _cancel_all_symbol_orders(bin_sym)
    exit_side = "SELL" if is_long else "BUY"
    r = send_signed_request("POST", "/fapi/v1/order", {
        "symbol": bin_sym,
        "side": exit_side,
        "type": "MARKET",
        "quantity": f"{q}",
        "reduceOnly": "true",
        "newOrderRespType": "RESULT",
    })
    return r.status_code == 200


def _close_open_db_rows_for_symbol(bin_sym: str, fallback_close_price: float = 0.0, fallback_pnl: float = 0.0):
    """Reconciles DB OPEN rows for a symbol with latest /fapi/v1/userTrades realizedPnl when available."""
    conn = None
    try:
        conn = db.get_connection()
        cur = conn.cursor()
        cur.execute("SELECT ticket, entry_time, entry_price, order_type, lots FROM trades WHERE status='OPEN' AND UPPER(symbol)=%s", (bin_sym.upper(),))
        rows = cur.fetchall()
        cur.close()
        conn.close()
        conn = None
        if not rows:
            return

        # Try fetching recent userTrades to compute exact realizedPnl & commission
        fills = []
        try:
            r = send_signed_request("GET", "/fapi/v1/userTrades", {"symbol": bin_sym, "limit": 25})
            if r.status_code == 200:
                fills = r.json()
        except Exception:
            pass

        for ticket, entry_time, entry_price, order_type, lots in rows:
            entry_ms = int(entry_time.timestamp() * 1000) if entry_time else 0
            realized_sum = 0.0
            fee_sum = 0.0
            last_fill_price = float(fallback_close_price or entry_price or 0.0)
            matched = False
            for f in fills:
                t_ms = int(f.get("time", 0) or 0)
                if t_ms >= entry_ms - 5000:
                    rpnl = float(f.get("realizedPnl", 0) or 0)
                    comm = float(f.get("commission", 0) or 0) if str(f.get("commissionAsset", "")).upper() == "USDT" else 0.0
                    if abs(rpnl) > 0:
                        realized_sum += rpnl
                        last_fill_price = float(f.get("price", last_fill_price) or last_fill_price)
                        matched = True
                    fee_sum += comm

            net_pnl = round(realized_sum - fee_sum, 2) if matched else round(float(fallback_pnl or 0.0), 2)
            db.log_trade_exit(ticket=int(ticket), close_price=last_fill_price, profit=net_pnl, close_time=datetime.now(timezone.utc))
    except Exception as e:
        print(f"[DB Reconcile Error] {bin_sym}: {e}")
    finally:
        if conn:
            conn.close()


def check_closed_binance_trades(symbol: str = None):
    """Checks DB OPEN trades against live Binance Futures positions; reconciles any closed by server SL/TP."""
    open_positions = get_binance_open_positions_detailed()
    live_syms = {p["symbol"] for p in open_positions}
    conn = None
    try:
        conn = db.get_connection()
        cur = conn.cursor()
        if symbol:
            cur.execute("SELECT DISTINCT UPPER(symbol) FROM trades WHERE status='OPEN' AND UPPER(symbol)=%s", (resolve_binance_symbol(symbol),))
        else:
            cur.execute("SELECT DISTINCT UPPER(symbol) FROM trades WHERE status='OPEN'")
        db_syms = [r[0] for r in cur.fetchall()]
        cur.close()
        conn.close()
        conn = None

        for sym in db_syms:
            if sym not in live_syms:
                _cancel_all_symbol_orders(sym)
                _close_open_db_rows_for_symbol(sym)
    except Exception as e:
        print(f"[Binance check_closed error]: {e}")
    finally:
        if conn:
            conn.close()


def sync_all_binance_open_positions_to_db():
    """Updates floating mark price & unrealized PnL on DB OPEN rows and reconciles closed trades."""
    check_closed_binance_trades()
    positions = get_binance_open_positions_detailed()
    conn = None
    try:
        conn = db.get_connection()
        cur = conn.cursor()
        for p in positions:
            cur.execute(
                """
                UPDATE trades
                SET close_price = %s, profit = %s
                WHERE status = 'OPEN' AND UPPER(symbol) = %s
                """,
                (float(p["mark_price"]), round(float(p["unrealized_pnl"]), 2), p["symbol"].upper()),
            )
            # If user manually opened a trade on Binance UI, mirror it cleanly into trades table
            cur.execute("SELECT 1 FROM trades WHERE status='OPEN' AND UPPER(symbol)=%s LIMIT 1", (p["symbol"].upper(),))
            if not cur.fetchone():
                cur.execute(
                    """
                    INSERT INTO trades (ticket, symbol, order_type, lots, entry_price, close_price, profit, entry_time, status, comment)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, NOW(), 'OPEN', 'BINANCE_SYNC')
                    ON CONFLICT (ticket) DO NOTHING
                    """,
                    (
                        int(time.time() * 1000) % 2147483647,
                        p["symbol"],
                        p["side"],
                        p["qty"],
                        p["entry_price"],
                        p["mark_price"],
                        round(p["unrealized_pnl"], 2),
                    ),
                )
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"[Binance sync error]: {e}")
    finally:
        if conn:
            conn.close()


def get_all_binance_ticks(symbols_list=None) -> dict:
    """Fetches fast bookTicker snapshots {SYMBOL: (bid, ask, mid)}."""
    res = {}
    try:
        r = requests.get(f"{BASE_URL}/fapi/v1/ticker/bookTicker", timeout=6)
        if r.status_code == 200:
            wanted = {resolve_binance_symbol(s) for s in symbols_list} if symbols_list else None
            for item in r.json():
                sym = item.get("symbol", "")
                if wanted and sym not in wanted:
                    continue
                bid = float(item.get("bidPrice", 0) or 0)
                ask = float(item.get("askPrice", 0) or 0)
                if bid > 0 and ask > 0:
                    res[sym] = (bid, ask, (bid + ask) * 0.5)
    except Exception:
        pass
    return res


def get_binance_live_tick(symbol: str):
    bin_sym = resolve_binance_symbol(symbol)
    try:
        r = requests.get(f"{BASE_URL}/fapi/v1/ticker/bookTicker", params={"symbol": bin_sym}, timeout=5)
        if r.status_code == 200:
            d = r.json()
            bid = float(d.get("bidPrice", 0) or 0)
            ask = float(d.get("askPrice", 0) or 0)
            if bid > 0 and ask > 0:
                return (bid, ask, (bid + ask) * 0.5)
    except Exception:
        pass
    return None


def get_binance_market_book(symbol: str, depth: int = 20):
    """Returns order-book bid/ask pressure (only used for telemetry if needed)."""
    bin_sym = resolve_binance_symbol(symbol)
    try:
        r = requests.get(f"{BASE_URL}/fapi/v1/depth", params={"symbol": bin_sym, "limit": depth}, timeout=5)
        if r.status_code == 200:
            d = r.json()
            bids = sum(float(x[1]) for x in d.get("bids", []))
            asks = sum(float(x[1]) for x in d.get("asks", []))
            total = bids + asks
            obi = ((bids - asks) / total) if total > 0 else 0.0
            return {"bids": bids, "asks": asks, "obi": obi}
    except Exception:
        pass
    return {"bids": 0.0, "asks": 0.0, "obi": 0.0}


def get_binance_rates_df(symbol: str, timeframe_minutes: int = 5, count: int = 150) -> pd.DataFrame:
    """Fetches Binance Futures OHLCV klines and converts to standardized DataFrame."""
    bin_sym = resolve_binance_symbol(symbol)
    tf_map = {1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 240: "4h", 1440: "1d"}
    interval = tf_map.get(int(timeframe_minutes), "5m")
    try:
        r = requests.get(
            f"{BASE_URL}/fapi/v1/klines",
            params={"symbol": bin_sym, "interval": interval, "limit": min(1500, int(count))},
            timeout=8,
        )
        if r.status_code != 200:
            return pd.DataFrame()
        raw = r.json()
        if not raw:
            return pd.DataFrame()
        df = pd.DataFrame(raw, columns=[
            "open_time", "open", "high", "low", "close", "volume",
            "close_time", "quote_vol", "trades", "taker_base", "taker_quote", "ignore"
        ])
        for col in ["open", "high", "low", "close", "volume"]:
            df[col] = df[col].astype(float)
        df["time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
        df["tick_volume"] = df["volume"]
        return df[["time", "open", "high", "low", "close", "volume", "tick_volume"]].reset_index(drop=True)
    except Exception as e:
        print(f"[Binance klines error] {bin_sym} {interval}: {e}")
        return pd.DataFrame()
