import os
import time
import hmac
import hashlib
import requests
import urllib.parse
import logging
import datetime
from database import log_trade_entry, log_trade_exit, get_connection

logger = logging.getLogger("SMC_Forex_Bot")
USE_TESTNET = os.getenv("USE_BINANCE_TESTNET", "False").lower() in ("true", "1", "yes")
if USE_TESTNET:
    BASE_URL = "https://testnet.binancefuture.com"
    logger.info("Using Binance Futures TESTNET API endpoint: https://testnet.binancefuture.com")
else:
    BASE_URL = "https://fapi.binance.com"
    logger.info("Using Binance Futures PRODUCTION API endpoint: https://fapi.binance.com")
MAGIC_NUMBER = 992026

TIME_OFFSET = 0

def sync_binance_time():
    global TIME_OFFSET
    try:
        r = requests.get(f"{BASE_URL}/fapi/v1/time", timeout=5)
        if r.status_code == 200:
            server_time = r.json()["serverTime"]
            local_time = int(time.time() * 1000)
            TIME_OFFSET = server_time - local_time
            logger.info(f"Synchronized Binance server time offset: {TIME_OFFSET} ms")
    except Exception as e:
        logger.error(f"Failed to sync Binance time offset: {e}")

sync_binance_time()

def resolve_binance_symbol(symbol: str) -> str:
    """Maps standard coin symbols to Binance Futures contract names (e.g. PEPEUSDT -> 1000PEPEUSDT)."""
    s = str(symbol).upper().strip()
    mapping = {
        "PEPEUSDT": "1000PEPEUSDT",
        "SHIBUSDT": "1000SHIBUSDT",
        "FLOKIUSDT": "1000FLOKIUSDT",
        "BONKUSDT": "1000BONKUSDT",
        "LUNCUSDT": "1000LUNCUSDT",
    }
    return mapping.get(s, s)

# Cache for Binance symbol precision and filter details
exchange_info_cache = {}

def get_symbol_filters(symbol):
    """Fetches precision and step filters for a symbol from Binance Futures exchangeInfo."""
    global exchange_info_cache
    s_upper = resolve_binance_symbol(symbol)
    if s_upper in exchange_info_cache:
        return exchange_info_cache[s_upper]
    try:
        r = requests.get(f"{BASE_URL}/fapi/v1/exchangeInfo", timeout=10)
        if r.status_code == 200:
            data = r.json()
            for s in data.get("symbols", []):
                sym_name = s["symbol"]
                lot_size_filter = [f for f in s["filters"] if f["filterType"] == "LOT_SIZE"]
                price_filter = [f for f in s["filters"] if f["filterType"] == "PRICE_FILTER"]
                
                step_size = float(lot_size_filter[0]["stepSize"]) if lot_size_filter else 0.001
                max_qty = float(lot_size_filter[0]["maxQty"]) if lot_size_filter else 1000000.0
                min_qty = float(lot_size_filter[0]["minQty"]) if lot_size_filter else step_size
                tick_size = float(price_filter[0]["tickSize"]) if price_filter else 0.01
                
                exchange_info_cache[sym_name] = {
                    "quantityPrecision": int(s["quantityPrecision"]),
                    "pricePrecision": int(s["pricePrecision"]),
                    "stepSize": step_size,
                    "maxQty": max_qty,
                    "minQty": min_qty,
                    "tickSize": tick_size
                }
            return exchange_info_cache.get(s_upper)
    except Exception as e:
        logger.error(f"Error fetching Binance exchangeInfo: {e}")
    return None

def send_signed_request(method, endpoint, params=None):
    """Sends a signed HMAC-SHA256 request to the Binance Futures API."""
    if params is None:
        params = {}
    
    api_key = os.getenv("BINANCE_API_KEY")
    secret_key = os.getenv("BINANCE_API_SECRET")
    if not api_key or not secret_key:
        logger.error("Binance API credentials not set in environment.")
        return None
        
    # Standard security protocol parameters
    params["timestamp"] = int(time.time() * 1000) + TIME_OFFSET
    params["recvWindow"] = 60000
    
    query_string = urllib.parse.urlencode(params)
    signature = hmac.new(
        secret_key.encode("utf-8"),
        query_string.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    
    headers = {
        "X-MBX-APIKEY": api_key
    }
    
    url = f"{BASE_URL}{endpoint}?{query_string}&signature={signature}"
    
    try:
        if method.upper() == "GET":
            r = requests.get(url, headers=headers, timeout=10)
        elif method.upper() == "POST":
            r = requests.post(url, headers=headers, timeout=10)
        elif method.upper() == "DELETE":
            r = requests.delete(url, headers=headers, timeout=10)
        else:
            return None
        return r
    except Exception as e:
        logger.error(f"Binance connection error on {endpoint}: {e}")
        return None

def get_binance_usdt_balance():
    """Fetches total margin balance and available balance on Binance Futures (supporting Multi-Asset Mode)."""
    res = send_signed_request("GET", "/fapi/v2/account")
    if res is not None and res.status_code == 200:
        data = res.json()
        total_margin = float(data.get("totalMarginBalance", 0.0))
        max_withdraw = float(data.get("maxWithdrawAmount", total_margin))
        
        # In Multi-Asset Mode, totalMarginBalance represents total account equity across USDT & USDC
        real_balance = total_margin if total_margin > 0 else max_withdraw
        available_balance = max_withdraw if max_withdraw > 0 else real_balance
        return real_balance, available_balance
    else:
        err_msg = res.text if res is not None else "No response"
        if res is not None and ("-2015" in err_msg or res.status_code == 401):
            logger.warning("Binance API Key notice: Testnet/Live API key mismatch or IP permission required. Using paper trading balance for market scanning.")
        else:
            logger.error(f"Failed to fetch Binance Futures account info: {err_msg}")
    return 0.0, 0.0

def calculate_binance_quantity(symbol, sl_distance_price, usdt_balance, risk_pct=1.0):
    """Calculates risk-based lot sizing for Binance Futures trading safely clamped to exchangeInfo LOT_SIZE rules."""
    if sl_distance_price <= 0:
        return 0.0
        
    filters = get_symbol_filters(symbol)
    if not filters:
        logger.warning(f"Could not load filters for {symbol}, defaulting to standard rounding.")
        return round((usdt_balance * (risk_pct / 100.0)) / sl_distance_price, 3)
        
    risk_amount = usdt_balance * (risk_pct / 100.0)
    raw_qty = risk_amount / sl_distance_price
    
    step_size = filters.get("stepSize", 0.001)
    max_qty = filters.get("maxQty", 1000000.0)
    min_qty = filters.get("minQty", step_size)
    qty_prec = filters.get("quantityPrecision", 3)
    
    rounded_qty = round(round(raw_qty / step_size) * step_size, qty_prec)
    
    # Safety check: clamp quantity between min_qty and max_qty allowed by Binance Futures
    if rounded_qty > max_qty:
        logger.warning(f"Calculated quantity {rounded_qty:.3f} for {symbol} exceeded Binance maxQty {max_qty:.3f}. Capping to maxQty.")
        rounded_qty = max_qty
    if rounded_qty < min_qty:
        rounded_qty = min_qty
        
    return rounded_qty

def round_to_tick_size(price: float, tick_size: float, precision: int) -> float:
    """Rounds price to an exact multiple of tick_size to avoid Binance error -4014."""
    if tick_size and tick_size > 0:
        inv_tick = 1.0 / tick_size
        return round(round(price * inv_tick) / inv_tick, precision)
    return round(price, precision)

def execute_three_part_binance_trade(symbol, is_long, entry_price, sl_price, total_qty, tp1, tp2, tp3, signal_id=None):
    """
    Executes a Binance Futures trade split into 3 parts (TP1, TP2, TP3) with SL protection.
    """
    side = "BUY" if is_long else "SELL"
    reverse_side = "SELL" if is_long else "BUY"
    
    filters = get_symbol_filters(symbol)
    price_prec = filters["pricePrecision"] if filters else 2
    qty_prec = filters["quantityPrecision"] if filters else 3
    tick_size = filters["tickSize"] if filters else 0.01
    step_size = filters["stepSize"] if filters else 0.001
    
    max_qty = filters.get("maxQty", 1000000.0) if filters else 1000000.0
    safe_total_qty = min(round(total_qty, qty_prec), max_qty)

    # 1. Market Entry Order
    params = {
        "symbol": symbol,
        "side": side,
        "type": "MARKET",
        "quantity": safe_total_qty
    }
    
    logger.info(f"Sending Market Entry order to Binance Futures: {side} {total_qty} {symbol}")
    res = send_signed_request("POST", "/fapi/v1/order", params)
    
    if res is None or res.status_code != 200:
        err_msg = res.text if res is not None else "No response"
        logger.error(f"Binance Market order failed: {err_msg}")
        return False
        
    order_data = res.json()
    entry_order_id = order_data["orderId"]
    avg_price = float(order_data.get("avgPrice") or entry_price)
    
    logger.info(f"Binance Market entry filled at {avg_price:.5f}. Order ID: {entry_order_id}")
    time.sleep(0.3)
    
    # 2. Place Stop Loss Order via Binance Futures Algo Order API (/fapi/v1/algoOrder)
    sl_price_rounded = round_to_tick_size(sl_price, tick_size, price_prec)
    sl_params = {
        "algoType": "CONDITIONAL",
        "symbol": symbol,
        "side": reverse_side,
        "type": "STOP_MARKET",
        "triggerPrice": sl_price_rounded,
        "quantity": round(total_qty, qty_prec),
        "reduceOnly": "true"
    }
    sl_res = send_signed_request("POST", "/fapi/v1/algoOrder", sl_params)
    
    if sl_res is not None and sl_res.status_code == 200:
        logger.info(f"Binance Stop Loss placed via Algo API at trigger price: {sl_price_rounded:.5f}")
    else:
        # Fallback 1: Standard STOP_MARKET on /fapi/v1/order
        fallback_params = {
            "symbol": symbol,
            "side": reverse_side,
            "type": "STOP_MARKET",
            "stopPrice": sl_price_rounded,
            "quantity": round(total_qty, qty_prec),
            "reduceOnly": "true"
        }
        sl_res2 = send_signed_request("POST", "/fapi/v1/order", fallback_params)
        if sl_res2 is not None and sl_res2.status_code == 200:
            logger.info(f"Binance Stop Loss placed via standard endpoint at stop price: {sl_price_rounded:.5f}")
        else:
            err_msg = sl_res.text if sl_res is not None else "No response"
            logger.error(f"Binance Stop Loss placement failed: {err_msg}")
    
    # 3. Scale out Take Profit LIMIT orders
    part_qty = round(total_qty / 3.0, qty_prec)
    if part_qty < step_size:
        part_qty = step_size
        
    parts = [("TP1", tp1), ("TP2", tp2), ("TP3", tp3)]
    for part_name, tp_val in parts:
        raw_tp = max(tick_size, float(tp_val))
        tp_price_rounded = round_to_tick_size(raw_tp, tick_size, price_prec)
        if tp_price_rounded <= 0:
            tp_price_rounded = tick_size
            
        tp_params = {
            "symbol": symbol,
            "side": reverse_side,
            "type": "LIMIT",
            "quantity": part_qty,
            "price": tp_price_rounded,
            "timeInForce": "GTC",
            "reduceOnly": "true"
        }
        tp_res = send_signed_request("POST", "/fapi/v1/order", tp_params)
        if tp_res is not None and tp_res.status_code == 200:
            tp_order_id = tp_res.json()["orderId"]
            logger.info(f"Binance {part_name} Limit order placed at {tp_price_rounded:.5f}. ID: {tp_order_id}")
            
            # Log each part as a separate open position in database to match MT5 logs
            log_trade_entry(
                ticket=tp_order_id,
                symbol=symbol,
                order_type="BUY" if is_long else "SELL",
                lots=part_qty,
                entry_price=avg_price,
                entry_time=datetime.datetime.now(),
                comment=f"Binance {part_name}",
                signal_id=signal_id
            )
        else:
            err_msg = tp_res.text if tp_res is not None else "No response"
            logger.error(f"Binance {part_name} placement failed: {err_msg}")
            
    return True

def close_all_binance_positions(symbol):
    """Closes any active position for the symbol by checking active positions and placing market counter-orders."""
    # 1. Fetch current position risk
    res = send_signed_request("GET", "/fapi/v2/positionRisk", {"symbol": symbol})
    if res is None or res.status_code != 200:
        logger.error("Could not fetch Binance position details.")
        return True
        
    positions = res.json()
    for pos in positions:
        pos_amt = float(pos.get("positionAmt", 0.0))
        if pos_amt != 0.0:
            side = "SELL" if pos_amt > 0.0 else "BUY"
            qty = abs(pos_amt)
            
            # Place market order to close position
            params = {
                "symbol": symbol,
                "side": side,
                "type": "MARKET",
                "quantity": qty,
                "reduceOnly": "true"
            }
            logger.info(f"Binance Exit: Closing position of {pos_amt} {symbol}")
            close_res = send_signed_request("POST", "/fapi/v1/order", params)
            if close_res is not None and close_res.status_code == 200:
                logger.info(f"Successfully closed position for {symbol}")
            else:
                logger.error(f"Failed to close position: {close_res.text if close_res is not None else 'No response'}")
                
    # 2. Cancel all open orders for symbol
    send_signed_request("DELETE", "/fapi/v1/allOpenOrders", {"symbol": symbol})
    logger.info(f"Cancelled all open orders for {symbol}")
    return True

def check_closed_binance_trades(symbol):
    """
    Checks if active trades in database have been closed on Binance.
    If position amt is 0, we close all database trades and cancel outstanding TP/SL orders.
    If position is still open, we check if individual TP orders have been filled.
    """
    conn = None
    open_trades = []
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT ticket, entry_price, lots, order_type FROM trades WHERE status = 'OPEN' AND symbol = %s", (symbol,))
        open_trades = cur.fetchall()
        cur.close()
    except Exception as e:
        logger.error(f"Database error checking open tickets: {e}")
    finally:
        if conn:
            conn.close()
            
    if not open_trades:
        return
        
    # Check current position size from Binance
    res = send_signed_request("GET", "/fapi/v2/positionRisk", {"symbol": symbol})
    if res is not None and res.status_code == 200:
        data = res.json()
        pos_amt = 0.0
        for pos in data:
            if pos.get("symbol") == symbol:
                pos_amt = float(pos.get("positionAmt", 0.0))
                break
            
        if pos_amt == 0.0:
            logger.info(f"Binance position for {symbol} is closed. Syncing database records...")
            # Position is closed. Fetch recent user trade history to find exit price/profit
            history_res = send_signed_request("GET", "/fapi/v1/userTrades", {"symbol": symbol, "limit": 10})
            close_price = 0.0
            profit = 0.0
            close_time = datetime.datetime.now()
            
            if history_res is not None and history_res.status_code == 200:
                trades_history = history_res.json()
                if trades_history:
                    # Find exit price and sum total realized profit
                    close_price = float(trades_history[0].get("price", 0.0))
                    profit = sum(float(t.get("realizedProfit", 0.0)) for t in trades_history)
                    close_time = datetime.datetime.fromtimestamp(int(trades_history[0].get("time")) / 1000.0)
                    
            if close_price == 0.0:
                try:
                    tick_res = requests.get(f"{BASE_URL}/fapi/v1/ticker/price?symbol={symbol}", timeout=5)
                    if tick_res.status_code == 200:
                        close_price = float(tick_res.json().get("price", 0.0))
                except Exception:
                    pass

            # Mark all open tickets in database as CLOSED
            for ticket, entry_price, lots, order_type in open_trades:
                part_profit = profit / len(open_trades) if profit != 0.0 else 0.0
                if part_profit == 0.0 and close_price != 0.0:
                    mult = 1.0 if order_type.upper() == "BUY" else -1.0
                    part_profit = (close_price - float(entry_price)) * float(lots) * mult
                log_trade_exit(ticket, close_price, part_profit, close_time)
                
            # Cancel all remaining limit TP orders
            send_signed_request("DELETE", "/fapi/v1/allOpenOrders", {"symbol": symbol})
            logger.info(f"Successfully closed database records and cleaned up open orders for {symbol}")
        else:
            # Position is still active. Check if any TP limit orders have filled.
            open_orders_res = send_signed_request("GET", "/fapi/v1/openOrders", {"symbol": symbol})
            if open_orders_res is not None and open_orders_res.status_code == 200:
                open_orders = open_orders_res.json()
                open_order_ids = {order["orderId"] for order in open_orders}
                
                for ticket, entry_price, lots, order_type in open_trades:
                    # The ticket is the tp_order_id. If it's no longer in open orders, check if it was FILLED.
                    if ticket not in open_order_ids:
                        order_res = send_signed_request("GET", "/fapi/v1/order", {"symbol": symbol, "orderId": ticket})
                        if order_res is not None and order_res.status_code == 200:
                            order_info = order_res.json()
                            status = order_info.get("status")
                            if status == "FILLED":
                                close_price = float(order_info.get("avgPrice") or order_info.get("price"))
                                close_time = datetime.datetime.fromtimestamp(int(order_info.get("updateTime")) / 1000.0)
                                mult = 1.0 if order_type.upper() == "BUY" else -1.0
                                part_profit = (close_price - float(entry_price)) * float(lots) * mult
                                log_trade_exit(ticket, close_price, part_profit, close_time)
                                logger.info(f"Binance TP order {ticket} filled. Logged trade exit. Close Price: {close_price}, Profit: {part_profit}")
                            elif status in ["CANCELED", "EXPIRED", "REJECTED"]:
                                close_time = datetime.datetime.fromtimestamp(int(order_info.get("updateTime")) / 1000.0)
                                log_trade_exit(ticket, entry_price, 0.0, close_time)
                                logger.info(f"Binance TP order {ticket} was {status}. Closed in DB.")

BINANCE_TICKS_CACHE = {}
BINANCE_TICKS_TIME = 0.0

def get_all_binance_ticks():
    """Fetches live ticks (bid, ask) for ALL Binance Futures symbols in a single 50ms batch call."""
    global BINANCE_TICKS_CACHE, BINANCE_TICKS_TIME
    now = time.time()
    if (now - BINANCE_TICKS_TIME) < 1.0 and BINANCE_TICKS_CACHE:
        return BINANCE_TICKS_CACHE

    try:
        r = requests.get(f"{BASE_URL}/fapi/v1/ticker/bookTicker", timeout=3)
        if r.status_code == 200:
            data = r.json()
            cache = {}
            for item in data:
                sym = item.get("symbol")
                if sym:
                    class BinanceTick:
                        def __init__(self, bid, ask):
                            self.bid = bid
                            self.ask = ask
                            self.time = int(now)
                    cache[sym] = BinanceTick(float(item.get("bidPrice", 0)), float(item.get("askPrice", 0)))
            BINANCE_TICKS_CACHE = cache
            BINANCE_TICKS_TIME = now
            return cache
    except Exception as e:
        logger.error(f"Error fetching batch Binance ticks: {e}")
    return BINANCE_TICKS_CACHE

def get_binance_live_tick(symbol):
    """Fetches the latest tick (bid, ask) for a symbol from Binance Futures using 50ms batch lookup."""
    sym_upper = resolve_binance_symbol(symbol)
    all_ticks = get_all_binance_ticks()
    if sym_upper in all_ticks:
        return all_ticks[sym_upper]

    try:
        r = requests.get(f"{BASE_URL}/fapi/v1/ticker/bookTicker", params={"symbol": sym_upper}, timeout=5)
        if r.status_code == 200:
            data = r.json()
            class BinanceTick:
                def __init__(self, bid, ask):
                    self.bid = bid
                    self.ask = ask
            return BinanceTick(float(data["bidPrice"]), float(data["askPrice"]))
    except Exception as e:
        logger.error(f"Error fetching Binance tick for {symbol}: {e}")
    return None

def get_binance_market_book(symbol):
    """Fetches order book depth (bids, asks) for a symbol from Binance Futures."""
    try:
        r = requests.get(f"{BASE_URL}/fapi/v1/depth", params={"symbol": symbol.upper(), "limit": 5}, timeout=5)
        if r.status_code == 200:
            data = r.json()
            bids = [(float(b[0]), float(b[1])) for b in data.get("bids", [])]
            asks = [(float(a[0]), float(a[1])) for a in data.get("asks", [])]
            return bids, asks
    except Exception as e:
        logger.error(f"Error fetching Binance depth for {symbol}: {e}")
    return [], []

def get_binance_rates_df(symbol, timeframe_minutes=5, count=100):
    """Fetches historical price candles from Binance Futures and returns a pandas DataFrame."""
    interval_map = {
        1: "1m",
        3: "3m",
        5: "5m",
        15: "15m",
        30: "30m",
        60: "1h",
        240: "4h",
        1440: "1d"
    }
    interval = interval_map.get(timeframe_minutes, "5m")
    
    try:
        params = {
            "symbol": resolve_binance_symbol(symbol),
            "interval": interval,
            "limit": count
        }
        r = requests.get(f"{BASE_URL}/fapi/v1/klines", params=params, timeout=5)
        if r.status_code == 200:
            klines = r.json()
            import pandas as pd
            data = []
            for k in klines:
                data.append({
                    "time": datetime.datetime.fromtimestamp(int(k[0]) / 1000.0),
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                    "tick_volume": int(float(k[5])),
                    "spread": 0,
                    "real_volume": 0
                })
            df = pd.DataFrame(data)
            return df
    except Exception as e:
        logger.error(f"Error fetching Binance klines for {symbol}: {e}")
    return None

def close_binance_partial(symbol, qty, is_long):
    """Closes a partial quantity of a Binance position."""
    side = "SELL" if is_long else "BUY"
    
    filters = get_symbol_filters(symbol)
    qty_prec = filters["quantityPrecision"] if filters else 3
    rounded_qty = round(qty, qty_prec)
    
    params = {
        "symbol": symbol,
        "side": side,
        "type": "MARKET",
        "quantity": rounded_qty,
        "reduceOnly": "true"
    }
    
    logger.info(f"Binance Partial Close: {side} {rounded_qty} {symbol}")
    res = send_signed_request("POST", "/fapi/v1/order", params)
    if res and res.status_code == 200:
        logger.info(f"Successfully placed Binance close order for {symbol}")
        return True
    else:
        err_msg = res.text if res else "No response"
        logger.error(f"Binance close order failed: {err_msg}")
        return False

def sync_all_binance_open_positions_to_db():
    """
    Fetches all active position risks directly from Binance Futures API (/fapi/v2/positionRisk)
    and syncs them to the database trades table. Automatically marks any DB trade as CLOSED if position is 0 on Binance.
    """
    try:
        res = send_signed_request("GET", "/fapi/v2/positionRisk")
        if res is None or res.status_code != 200:
            return
            
        positions = res.json()
        active_binance_positions = {}
        
        for pos in positions:
            sym = pos.get("symbol")
            amt = float(pos.get("positionAmt", 0.0))
            if sym:
                active_binance_positions[sym] = pos

        conn = get_connection()
        cur = conn.cursor()
        
        # Fetch all symbols currently marked as OPEN in DB
        cur.execute("SELECT DISTINCT symbol FROM trades WHERE status = 'OPEN'")
        open_db_symbols = [r[0] for r in cur.fetchall()]
        
        for sym in open_db_symbols:
            pos_info = active_binance_positions.get(sym)
            amt = float(pos_info.get("positionAmt", 0.0)) if pos_info else 0.0
            
            if amt == 0.0:
                # Position is confirmed closed on Binance: fetch trade history and close DB trades
                logger.info(f"🔄 [AUTO-SYNC] Position for {sym} is 0 on Binance. Marking DB trades as CLOSED...")
                history_res = send_signed_request("GET", "/fapi/v1/userTrades", {"symbol": sym, "limit": 10})
                close_price = 0.0
                profit = 0.0
                if history_res is not None and history_res.status_code == 200:
                    trades_history = history_res.json()
                    if trades_history:
                        close_price = float(trades_history[0].get("price", 0.0))
                        profit = sum(float(t.get("realizedProfit", 0.0)) for t in trades_history)
                        
                cur.execute("SELECT ticket, entry_price, lots, order_type FROM trades WHERE status = 'OPEN' AND symbol = %s", (sym,))
                tickets = cur.fetchall()
                for ticket, entry_p, lots, otype in tickets:
                    part_profit = profit / len(tickets) if profit != 0.0 else 0.0
                    if part_profit == 0.0 and close_price > 0.0:
                        mult = 1.0 if str(otype).upper() in ("BUY", "LONG") else -1.0
                        part_profit = (close_price - float(entry_p)) * float(lots) * mult
                    log_trade_exit(ticket, close_price, part_profit, datetime.datetime.now())
            else:
                mark_p = float(pos_info.get("markPrice", 0.0))
                pnl = float(pos_info.get("unRealizedProfit", 0.0))
                cur.execute(
                    "UPDATE trades SET close_price = %s, profit = %s WHERE status = 'OPEN' AND symbol = %s",
                    (mark_p, pnl, sym)
                )

        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"Error syncing Binance open positions to DB: {e}")

