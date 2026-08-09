import warnings
try:
    from sklearn.exceptions import InconsistentVersionWarning
    warnings.filterwarnings("ignore", category=InconsistentVersionWarning)
except ImportError:
    pass

import os
from database import load_env
load_env()

USE_BINANCE_TESTNET = os.getenv("USE_BINANCE_TESTNET", "False").lower() in ("true", "1", "yes")
BINANCE_BASE_URL = "https://testnet.binancefuture.com" if USE_BINANCE_TESTNET else "https://fapi.binance.com"

import sys
from types import ModuleType

# Mock MetaTrader5 module to prevent ImportError on VPS and redirect account queries to Binance
class DummyAccount:
    def __init__(self, login, balance, equity):
        self.login = login
        self.balance = balance
        self.equity = equity
        self.trade_mode = 0  # Demo

class MockMT5(ModuleType):
    TIMEFRAME_M1 = 1
    TIMEFRAME_M3 = 3
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 60
    TIMEFRAME_H4 = 240
    TIMEFRAME_D1 = 1440
    
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    TRADE_RETCODE_DONE = 10009

mock_mt5 = MockMT5("MetaTrader5")
mock_mt5.initialize = lambda *args, **kwargs: True
mock_mt5.shutdown = lambda: None
mock_mt5.last_error = lambda: (0, "No error")

def _get_mock_account():
    try:
        from binance_execution import get_binance_usdt_balance
        balance, available = get_binance_usdt_balance()
        if balance > 0:
            return DummyAccount("Binance-Live", balance, balance)
    except Exception:
        pass
    try:
        from database import get_connection
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT equity FROM bot_state WHERE id = 1")
        row = cur.fetchone()
        cur.close()
        conn.close()
        saved_eq = float(row[0]) if (row and row[0]) else 5000.0
        return DummyAccount("Binance-Live", saved_eq, saved_eq)
    except Exception:
        return DummyAccount("Binance-Live", 5000.0, 5000.0)

mock_mt5.account_info = _get_mock_account
sys.modules["MetaTrader5"] = mock_mt5
import MetaTrader5 as mt5
import time
import datetime
import logging
import json
import threading
import requests
import joblib

from math_models import KalmanFilterRegression, calculate_obi, test_cointegration
from data_ingestion import initialize_mt5, check_and_subscribe_symbol, get_live_ticks, get_market_book, shutdown_mt5, get_rates_df, resolve_broker_symbol
from risk_safeguards import check_drawdown_limit, calculate_lots, is_spread_valid, get_trades_count_today, MAX_DAILY_TRADES, invalidate_trades_cache, round_volume
from execution_bot import execute_three_part_trade, close_all_positions, modify_sl_for_trade, check_closed_trades, MAGIC_NUMBER, send_order, close_position_by_ticket
from smc_indicators import detect_smc_zones, is_price_in_zones
from database import log_signal, get_connection, update_bot_state, update_daily_metrics, log_fvg_zones, get_auto_execute, initialize_database, log_trade_entry, get_open_trades_count, log_trade_exit, update_scanned_asset
from binance_execution import (
    get_binance_usdt_balance,
    calculate_binance_quantity,
    execute_three_part_binance_trade,
    close_all_binance_positions,
    check_closed_binance_trades,
    send_signed_request,
    get_binance_live_tick,
    get_binance_market_book,
    get_binance_rates_df,
    close_binance_partial,
    get_symbol_filters
)

# Setup Logging
logger = logging.getLogger("SMC_Forex_Bot")
logger.setLevel(logging.INFO)
if not logger.handlers:
    ch = logging.StreamHandler()
    ch.setLevel(logging.INFO)
    formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    ch.setFormatter(formatter)
    logger.addHandler(ch)

# ==============================================================================
# GLOBAL STATE & PERSISTENCE
# ==============================================================================
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shared_config.json")

# GLOBAL CONFIG DEFAULT FOR DEDICATED CRYPTO APP
GLOBAL_CONFIG = {
    "SYMBOL_A": "BTCUSDT",
    "SYMBOL_B": "ETHUSDT"
}

# Cooldown dictionary to prevent continuous entries on stopped-out signals
COOLDOWN_DIRECTIONS = {}

KF_CACHE = {}
WIN_RATE_CACHE = {}

# Dashboard API base URL — update to your Replit URL when deployed
DASHBOARD_API_URL = os.environ.get("DASHBOARD_API_URL", "http://localhost:80/api")

def load_config():
    global GLOBAL_CONFIG
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
                active_pair = data.get("active_pair", "BTCUSDT/ETHUSDT")
                parts = active_pair.split('/')
                if len(parts) == 2 and parts[0].strip() != parts[1].strip():
                    GLOBAL_CONFIG["SYMBOL_A"] = parts[0].strip()
                    GLOBAL_CONFIG["SYMBOL_B"] = parts[1].strip()
                    logger.info(f"Loaded config: Leg A={GLOBAL_CONFIG['SYMBOL_A']} | Leg B={GLOBAL_CONFIG['SYMBOL_B']}")
                else:
                    logger.warning(f"shared_config.json has identical or invalid symbols — defaulting to BTCUSDT/ETHUSDT")
                    GLOBAL_CONFIG["SYMBOL_A"] = "BTCUSDT"
                    GLOBAL_CONFIG["SYMBOL_B"] = "ETHUSDT"
                    save_config("BTCUSDT/ETHUSDT")
        except Exception as e:
            logger.error(f"Error loading config: {e}")

def save_config(pair_str):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump({"active_pair": pair_str}, f)
        logger.info(f"Saved config: {pair_str} | Z-Entry: {Z_ENTRY_THRESHOLD}")
    except Exception as e:
        logger.error(f"Error saving config: {e}")

KNIFE_PROTECTION_ENABLED = True
OBI_ENABLED = True
VOLATILITY_FILTER_ENABLED = True

def fetch_db_config():
    """
    Reads active_pair, sl_pips, tp_pips, smc_enabled, auto_execute, etc. directly from the postgres database
    to avoid HTTP dependency and connection issues.
    """
    query = """
        SELECT active_pair, sl_pips, tp_pips, smc_enabled, auto_execute,
               crypto_enabled, metals_enabled, forex_enabled, indices_enabled,
               risk_limits_enabled, z_entry_threshold, default_lots, max_trades,
               knife_protection_enabled, obi_enabled, volatility_filter_enabled
        FROM bot_state
        WHERE id = 1
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(query)
        row = cur.fetchone()
        if row:
            active_pair = row[0] or "BTCUSDT/ETHUSDT"
            parts = active_pair.split('/')
            is_crypto = False
            if len(parts) == 2:
                p0, p1 = parts[0].upper(), parts[1].upper()
                if p0.endswith("USDT") or p1.endswith("USDT") or any(x in p0 or x in p1 for x in ["BTC", "ETH", "SOL", "BNB", "AVAX", "XRP", "ADA", "DOGE", "MATIC", "LTC", "LINK", "DOT", "UNI", "SHIB"]):
                    is_crypto = True
            
            # Since this is a dedicated Crypto Bot, if the database pair is NOT crypto, override it to BTCUSDT/ETHUSDT immediately
            if not is_crypto:
                logger.info("Overriding database non-crypto active_pair config to BTCUSDT/ETHUSDT")
                active_pair = "BTCUSDT/ETHUSDT"
                cur.execute("UPDATE bot_state SET active_pair = %s, crypto_enabled = true, forex_enabled = false, metals_enabled = false, indices_enabled = false WHERE id = 1", (active_pair,))
                conn.commit()
                
            cur.close()
            conn.close()
            return (
                active_pair,
                float(row[1] or 10.0),
                float(row[2] or 20.0),
                bool(row[3] if row[3] is not None else True),
                bool(row[4] if row[4] is not None else True),
                True,  # crypto_enabled = True for dedicated Crypto App
                False, # metals_enabled = False for dedicated Crypto App
                False, # forex_enabled = False for dedicated Crypto App
                False, # indices_enabled = False for dedicated Crypto App
                bool(row[9] if row[9] is not None else True),
                float(row[10] or 2.0),
                float(row[11] or 0.00),
                int(row[12] or 3),
                bool(row[13] if row[13] is not None else True),
                bool(row[14] if row[14] is not None else True),
                bool(row[15] if row[15] is not None else True),
            )
        else:
            cur.close()
            conn.close()
    except Exception as e:
        logger.warning(f"Could not fetch DB config directly: {e}")
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass
    return None


def poll_manual_commands(tick_a, tick_b, sl_pips: float):
    """
    Checks for pending manual trade commands directly from the database table trade_commands
    and executes them via MT5/Binance. Acks each command back directly via SQL update.
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT id, symbol, direction, lots, sl_pips, tp_pips, comment 
            FROM trade_commands 
            WHERE status = 'PENDING'
            ORDER BY id ASC
        """)
        commands = cur.fetchall()
        
        for row in commands:
            cmd_id, symbol, direction, lots_val, cmd_sl, cmd_tp, comment = row
            lots = float(lots_val or 0.01)
            cmd_sl = float(cmd_sl) if cmd_sl is not None else sl_pips
            cmd_tp = float(cmd_tp) if cmd_tp is not None else cmd_sl * 2
            comment = comment or f"MANUAL_{direction}"

            try:
                cat = get_symbol_category(symbol)
                is_long = (direction == "BUY")
                
                if direction == "CLOSE":
                    ticket_val = int(comment.split("_")[1]) if "_" in comment else 0
                    if ticket_val > 0:
                        ok = close_single_trade(symbol, ticket_val, lots, "SELL")
                    else:
                        close_all_js_positions(symbol)
                        ok = True
                    err_msg = None if ok else "Failed to execute close command"
                elif cat == "crypto":
                    tick = get_binance_live_tick(symbol)
                    if tick is None:
                        raise RuntimeError(f"No tick data for crypto {symbol}")
                    price = tick.ask if is_long else tick.bid
                    # Stop Loss and Take Profit in % for Crypto
                    sl_pct = cmd_sl if cmd_sl < 50.0 else (cmd_sl / 100.0)
                    tp_pct = cmd_tp if cmd_tp < 100.0 else (cmd_tp / 100.0)
                    
                    sl_dist = float(price * (sl_pct / 100.0)) if sl_pct < 1.0 else float(price * (sl_pct / 100.0))
                    tp_dist = float(price * (tp_pct / 100.0))
                    
                    if is_long:
                        sl_price = price - sl_dist
                        tp1 = price + sl_dist
                        tp2 = price + tp_dist
                        tp3 = price + sl_dist * 3.5
                    else:
                        sl_price = price + sl_dist
                        tp1 = price - sl_dist
                        tp2 = price - tp_dist
                        tp3 = price - sl_dist * 3.5
                        
                    # Calculate quantity based on USDT position value (Default $50 USDT for strong profits)
                    if lots >= 1.0:
                        usdt_amount = lots
                    else:
                        usdt_bal, _ = get_binance_usdt_balance()
                        usdt_amount = max(50.0, usdt_bal * (lots * 100.0 / 100.0) if usdt_bal > 0 else 50.0)
                        
                    part_qty = float(usdt_amount / price)
                    filters = get_symbol_filters(symbol)
                    qty_prec = filters["quantityPrecision"] if filters else 3
                    step_size = filters["stepSize"] if filters else 0.001
                    
                    part_qty = round(part_qty, qty_prec)
                    if part_qty < step_size:
                        part_qty = step_size
                        
                    if "JS_HEDGE_MANUAL_LEGB" in comment:
                        side_b = "BUY" if is_long else "SELL"
                        hedge_qty = round(part_qty * 3.0, qty_prec)
                        if hedge_qty < step_size:
                            hedge_qty = step_size
                            
                        params_b = {"symbol": symbol, "side": side_b, "type": "MARKET", "quantity": hedge_qty}
                        h_res = send_signed_request("POST", "/fapi/v1/order", params_b)
                        ok = (h_res is not None and h_res.status_code == 200)
                        if ok:
                            order_id_b = h_res.json().get("orderId", int(time.time()))
                            log_trade_entry(order_id_b, symbol, side_b, hedge_qty, price, datetime.datetime.now(), comment, None)
                            logger.info(f"Successfully executed Manual Leg B Binance Hedge order ({symbol} {side_b} {hedge_qty:.4f} qty)")
                        else:
                            err_reason = h_res.text if h_res is not None else "No response"
                            logger.error(f"Failed to execute Manual Leg B Binance Hedge order ({symbol} {side_b} {hedge_qty:.4f} qty): {err_reason}")
                    else:
                        total_qty = round(part_qty * 3.0, qty_prec)
                        ok = execute_three_part_binance_trade(
                            symbol=symbol,
                            is_long=is_long,
                            entry_price=price,
                            sl_price=sl_price,
                            total_qty=total_qty,
                            tp1=tp1,
                            tp2=tp2,
                            tp3=tp3,
                            signal_id=None
                        )
                    err_msg = None if ok else "Binance order rejected"
                else:
                    check_and_subscribe_symbol(symbol)
                    tick = mt5.symbol_info_tick(symbol)
                    if tick is None:
                        raise RuntimeError(f"No tick data for {symbol}")
                        
                    price = tick.ask if is_long else tick.bid
                    sl_dist = cmd_sl * get_pip_size(symbol)
                    tp_dist = cmd_tp * get_pip_size(symbol)
                    
                    if is_long:
                        sl_price = price - sl_dist
                        tp1 = price + sl_dist
                        tp2 = price + tp_dist
                        tp3 = price + sl_dist * 3.5
                    else:
                        sl_price = price + sl_dist
                        tp1 = price - sl_dist
                        tp2 = price - tp_dist
                        tp3 = price - sl_dist * 3.5
                        
                    ok = execute_three_part_trade(
                        symbol=symbol,
                        is_long=is_long,
                        entry_price=price,
                        sl_price=sl_price,
                        total_lots=lots,
                        tp1=tp1,
                        tp2=tp2,
                        tp3=tp3,
                        signal_id=None
                    )
                    err_msg = None if ok else "MT5 order rejected"
                    
                status = "EXECUTED" if ok else "FAILED"

            except Exception as e:
                status = "FAILED"
                err_msg = str(e)
                logger.error(f"Manual trade error [{cmd_id}]: {e}")

            # Update status in db directly
            cur.execute("""
                UPDATE trade_commands 
                SET status = %s, error_msg = %s, executed_at = CURRENT_TIMESTAMP 
                WHERE id = %s
            """, (status, err_msg, cmd_id))
            conn.commit()
            logger.info(f"Command {cmd_id} ({direction} {symbol} {lots}lots) status set to: {status}")

        cur.close()
        conn.close()
    except Exception as e:
        logger.warning(f"poll_manual_commands error: {e}")
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


Z_ENTRY_THRESHOLD = 0.70
ML_MODEL = None
DEFAULT_LOTS = 0.01
Z_EXIT_MEAN = 0.0
REQUIRE_SMC_CONFLUENCE = True
AUTO_EXECUTE = True          # toggled from dashboard via DB
CRYPTO_ENABLED = os.getenv("OVERRIDE_CRYPTO_ENABLED", "True").lower() in ("true", "1", "yes")
METALS_ENABLED = os.getenv("OVERRIDE_METALS_ENABLED", "False").lower() in ("true", "1", "yes")
FOREX_ENABLED = os.getenv("OVERRIDE_FOREX_ENABLED", "False").lower() in ("true", "1", "yes")
INDICES_ENABLED = os.getenv("OVERRIDE_INDICES_ENABLED", "False").lower() in ("true", "1", "yes")
RISK_LIMITS_ENABLED = True
SMC_TIMEFRAME = mt5.TIMEFRAME_M5
LOOP_INTERVAL = 2

DYNAMIC_CRYPTO_PAIRS = []
current_pair_context = "BTCUSDT/ETHUSDT"

CANDIDATE_PAIRS = {
    "forex": [
        ("EURUSD", "GBPUSD"),
        ("EURUSD", "USDJPY"),
        ("GBPUSD", "USDJPY"),
        ("AUDUSD", "NZDUSD"),
        ("EURUSD", "USDCHF"),
        ("GBPUSD", "USDCHF"),
    ],
    "metals": [
        ("XAUUSD", "XAGUSD"),
    ],
    "crypto": [
        ("BTCUSDT", "ETHUSDT"),
        ("SOLUSDT", "AVAXUSDT"),
        ("ADAUSDT", "XRPUSDT"),
        ("DOGEUSDT", "SHIBUSDT"),
        ("LINKUSDT", "DOTUSDT"),
        ("UNIUSDT", "AAVEUSDT"),
        ("LTCUSDT", "BCHUSDT"),
        ("ARBUSDT", "OPUSDT"),
        ("APTUSDT", "SUIUSDT"),
        ("NEARUSDT", "BTCUSDT"),
        ("FETUSDT", "RENDERUSDT"),
        ("TRXUSDT", "XRPUSDT")
    ],
    "indices": [
        ("AAPL", "MSFT"),
        ("MSFT", "GOOGL"),
        ("NVDA", "AMD"),
        ("US500", "NAS100"),
    ]
}

EXPECTED_BETA_SIGN = {
    "EURUSD/GBPUSD": 1,
    "EURUSD/USDJPY": -1,
    "GBPUSD/USDJPY": -1,
    "AUDUSD/NZDUSD": 1,
    "EURUSD/USDCHF": -1,
    "GBPUSD/USDCHF": -1,
    "BTCUSDT/ETHUSDT": 1,
    "SOLUSDT/BTCUSDT": 1,
    "ETHUSDT/SOLUSDT": 1
}

DEFAULT_LOT_SIZES = {
    "crypto": 0.06
}

def get_blue_guardian_lots(symbol: str, category: str) -> float:
    """
    Returns exact standard lot/contract size for Crypto App:
    - Crypto (BTCUSDT/ETHUSDT): 0.06 Total Contract Lots (3 x 0.02 lots | Hedge: 0.06 lots)
    """
    return DEFAULT_LOT_SIZES.get(category, 0.06)

def simulate_win_rate_for_pair(symbol_a: str, symbol_b: str, z_entry=2.0, z_exit=0.0, z_sl=4.2) -> float:
    """
    Runs a historical Kalman filter spread simulation on the last 150 bars
    to calculate the win rate of mean-reversion trades.
    """
    try:
        cat_a = get_symbol_category(symbol_a)
        cat_b = get_symbol_category(symbol_b)
        
        # Fetch rates
        if cat_a == "crypto":
            df_a = get_binance_rates_df(symbol_a, timeframe_minutes=5, count=150)
        else:
            if not mt5.initialize():
                return 50.0
            check_and_subscribe_symbol(symbol_a)
            df_a = get_rates_df(symbol_a, mt5.TIMEFRAME_M5, count=150)
            
        if cat_b == "crypto":
            df_b = get_binance_rates_df(symbol_b, timeframe_minutes=5, count=150)
        else:
            if not mt5.initialize():
                return 50.0
            check_and_subscribe_symbol(symbol_b)
            df_b = get_rates_df(symbol_b, mt5.TIMEFRAME_M5, count=150)
            
        if df_a is None or df_b is None or df_a.empty or df_b.empty:
            return 50.0
            
        min_len = min(len(df_a), len(df_b))
        if min_len < 30:
            return 50.0
            
        close_a = df_a['close'].iloc[-min_len:].values
        close_b = df_b['close'].iloc[-min_len:].values
        
        # Run Kalman
        q_cov, r_cov = get_kf_parameters(symbol_a)
        from math_models import KalmanFilterRegression
        kf = KalmanFilterRegression(transition_covariance=q_cov, observation_covariance=r_cov)
        
        z_scores = []
        for i in range(min_len):
            _, _, _, z = kf.update(close_b[i], close_a[i])
            z_scores.append(z)
            
        # Sim trades
        in_trade = False
        trade_dir = 0
        total_trades = 0
        win_trades = 0
        
        for i in range(15, min_len):
            z = z_scores[i]
            if not in_trade:
                if z < -z_entry:
                    in_trade = True
                    trade_dir = 1
                elif z > z_entry:
                    in_trade = True
                    trade_dir = -1
            else:
                if trade_dir == 1:
                    if z >= z_exit:
                        total_trades += 1
                        win_trades += 1
                        in_trade = False
                    elif z <= -z_sl:
                        total_trades += 1
                        in_trade = False
                elif trade_dir == -1:
                    if z <= -z_exit:
                        total_trades += 1
                        win_trades += 1
                        in_trade = False
                    elif z >= z_sl:
                        total_trades += 1
                        in_trade = False
                        
        if total_trades == 0:
            return 50.0
        return float(round((win_trades / total_trades) * 100.0, 1))
    except Exception as e:
        logger.warning(f"Error simulating win rate for {symbol_a}/{symbol_b}: {e}")
        return 50.0

def cleanup_disabled_scanned_assets(crypto_on, metals_on, forex_on, indices_on):
    try:
        conn = get_connection()
        cur = conn.cursor()
        if not crypto_on:
            cur.execute("DELETE FROM scanned_assets WHERE symbol_pair LIKE '%USDT%'")
        if not metals_on:
            for s_a, s_b in CANDIDATE_PAIRS["metals"]:
                cur.execute("DELETE FROM scanned_assets WHERE symbol_pair = %s", (f"{s_a}/{s_b}",))
        if not forex_on:
            for s_a, s_b in CANDIDATE_PAIRS["forex"]:
                cur.execute("DELETE FROM scanned_assets WHERE symbol_pair = %s", (f"{s_a}/{s_b}",))
        if not indices_on:
            for s_a, s_b in CANDIDATE_PAIRS["indices"]:
                cur.execute("DELETE FROM scanned_assets WHERE symbol_pair = %s", (f"{s_a}/{s_b}",))
        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"Error cleaning up disabled scanned assets: {e}")

def get_kf_for_pair(symbol_a, symbol_b):
    pair_key = f"{symbol_a}/{symbol_b}"
    if pair_key not in KF_CACHE:
        q_cov, r_cov = get_kf_parameters(symbol_a)
        from math_models import KalmanFilterRegression
        init_beta_val = EXPECTED_BETA_SIGN.get(f"{symbol_a}/{symbol_b}", EXPECTED_BETA_SIGN.get(f"{symbol_b}/{symbol_a}", 1))
        kf = KalmanFilterRegression(transition_covariance=q_cov, observation_covariance=r_cov, initial_beta=init_beta_val)
        
        # Warm up the filter with historical data
        try:
            cat_a = get_symbol_category(symbol_a)
            cat_b = get_symbol_category(symbol_b)
            if cat_a == "crypto":
                df_a = get_binance_rates_df(symbol_a, timeframe_minutes=5, count=150)
            else:
                df_a = get_rates_df(symbol_a, mt5.TIMEFRAME_M5, count=150)
                
            if cat_b == "crypto":
                df_b = get_binance_rates_df(symbol_b, timeframe_minutes=5, count=150)
            else:
                df_b = get_rates_df(symbol_b, mt5.TIMEFRAME_M5, count=150)
                
            if df_a is not None and df_b is not None and not df_a.empty and not df_b.empty:
                min_len = min(len(df_a), len(df_b))
                close_a = df_a['close'].iloc[-min_len:].tolist()
                close_b = df_b['close'].iloc[-min_len:].tolist()
                for idx in range(min_len):
                    kf.update(close_b[idx], close_a[idx])
        except Exception as e:
            logger.warning(f"Error warming up Kalman Filter for {pair_key}: {e}")
            
        KF_CACHE[pair_key] = kf
    return KF_CACHE[pair_key]

# BUG FIX 2: Fixed SL in pips instead of 3x bid-ask spread
SL_PIPS = 10.0
SL_PIPS_JPY = 0.10
TP_PIPS = 20.0

def get_pip_size(symbol: str) -> float:
    s = symbol.upper()
    if "JPY" in s:
        return 0.01
    if "XAU" in s:
        return 1.0
    if "XAG" in s:
        return 0.1
    if "BTC" in s:
        return 1.0
    if "ETH" in s:
        return 0.1
    if any(x in s for x in ["SOL", "BNB", "AVAX"]):
        return 0.01
    if any(x in s for x in ["XRP", "ADA", "DOGE", "MATIC"]):
        return 0.0001
    # Handle Indices & Stocks
    if any(x in s for x in ["US500", "US30", "NAS100", "GER30", "UK100", "SPX", "DJI", "NDX"]):
        return 1.0
    if any(x in s for x in ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "AMD", "META", "AMZN"]):
        return 0.1
    return 0.0001

def get_atr(symbol: str, timeframe, count=30) -> float:
    cat = get_symbol_category(symbol)
    if cat == "crypto":
        df = get_binance_rates_df(symbol, timeframe_minutes=5, count=count)
    else:
        df = get_rates_df(symbol, timeframe, count=count)
        
    if df is not None and len(df) >= 15:
        import pandas as pd
        high_low = df['high'] - df['low']
        high_cp = (df['high'] - df['close'].shift()).abs()
        low_cp = (df['low'] - df['close'].shift()).abs()
        df_temp = pd.concat([high_low, high_cp, low_cp], axis=1)
        true_range = df_temp.max(axis=1)
        atr = true_range.rolling(window=14).mean().iloc[-1]
        return float(atr)
    return None


def get_kf_parameters(symbol: str):
    # Normalized prices use standard optimal scale-independent parameters
    return 1e-10, 1e-7


def get_sl_distance(symbol: str, price: float, sl_pips_override: float = None) -> float:
    """
    Returns SL distance in price units. Uses dashboard-configured sl_pips value.
    Guarantees that the Stop Loss is at least 1.5 * ATR (from 5-minute candles)
    to protect against market noise.
    """
    pips = sl_pips_override if sl_pips_override else SL_PIPS
    base_sl = pips * get_pip_size(symbol)
        
    # Safeguard: Fetch M5 ATR and ensure SL is at least 1.5 * ATR
    try:
        atr = get_atr(symbol, mt5.TIMEFRAME_M5, count=30)
        if atr is not None and atr > 0:
            min_sl = atr * 1.5
            if base_sl < min_sl:
                logger.info(f"SL of {base_sl:.5f} is too tight for {symbol} (noise boundary: {min_sl:.5f}). Automatically adjusted to 1.5 * ATR: {min_sl:.5f}")
                return min_sl
    except Exception as e:
        logger.warning(f"Failed to calculate ATR safeguard for {symbol}: {e}")
        
    return base_sl

def get_tp_distance(symbol: str, price: float, tp_pips_override: float = None) -> float:
    """
    Returns TP distance in price units. Uses dashboard-configured tp_pips value.
    """
    pips = tp_pips_override if tp_pips_override else TP_PIPS
    return pips * get_pip_size(symbol)
def is_pair_in_cooldown(symbol_a: str, symbol_b: str) -> bool:
    """
    Returns True if a trade for this symbol pair was closed in the last 30 minutes.
    This acts as a restart-proof database-backed cooldown safeguard.
    """
    try:
        conn = get_connection()
        cur = conn.cursor()
        # Look for trades closed in the last 30 minutes
        thirty_mins_ago = datetime.datetime.now() - datetime.timedelta(minutes=30)
        cur.execute(
            """
            SELECT COUNT(*) FROM trades 
            WHERE (symbol = %s OR symbol = %s) 
              AND (entry_time >= %s OR close_time >= %s)
            """,
            (symbol_a, symbol_b, thirty_mins_ago, thirty_mins_ago)
        )
        count = cur.fetchone()[0]
        cur.close()
        conn.close()
        return count > 0
    except Exception as e:
        logger.error(f"Error checking db cooldown: {e}")
        return False

def get_strategy_parameters(symbol: str):
    cat = get_symbol_category(symbol)
    if cat == "metals":
        return 2.4, 0.0, 4.2, 5.0  # z_entry, z_exit, z_sl, sl_atr_mult
    elif cat == "indices":
        return 2.4, 0.0, 4.2, 5.0
    elif cat == "crypto":
        return 2.3, 0.0, 6.5, 6.0
    else: # forex/default
        return 2.3, 0.0, 4.2, 6.0

def close_single_trade(symbol, ticket, volume, order_type):
    cat = get_symbol_category(symbol)
    if cat == "crypto":
        is_long = (order_type.upper() == "BUY")
        ok = close_binance_partial(symbol, volume, is_long)
        if ok:
            log_trade_exit(ticket, 0.0, 0.0, datetime.datetime.now())
        return ok
    else:
        return close_position_by_ticket(symbol, ticket, volume)

def close_all_js_positions(symbol):
    cat = get_symbol_category(symbol)
    if cat == "crypto":
        close_all_binance_positions(symbol)
    else:
        close_all_positions(symbol)

def manage_spread_positions(symbol_a, symbol_b, z_score, kf=None):
    """
    Monitors active positions for symbol_a and symbol_b.
    1. Handles dynamic Z-score exits (mean reversion and Z-score SL).
    2. Handles Ornstein-Uhlenbeck statistical half-life time-based exits.
    3. Synchronizes Leg B (hedge) when Leg A parts are closed by the broker.
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT ticket, symbol, order_type, lots, comment, signal_id, entry_time FROM trades WHERE status = 'OPEN' AND symbol IN (%s, %s)",
            (symbol_a, symbol_b)
        )
        open_trades = cur.fetchall()
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"Error fetching open trades in manage_spread_positions: {e}")
        return

    if not open_trades:
        return

    # Group trades by signal_id
    signal_groups = {}
    for ticket, symbol, order_type, lots, comment, signal_id, entry_time in open_trades:
        if signal_id is None:
            continue
        if signal_id not in signal_groups:
            signal_groups[signal_id] = []
        signal_groups[signal_id].append({
            "ticket": ticket,
            "symbol": symbol,
            "order_type": order_type,
            "lots": float(lots),
            "comment": comment,
            "entry_time": entry_time
        })

    z_ent_val, z_ex_val, z_sl_val, sl_atr_m = get_strategy_parameters(symbol_a)

    # Compute Ornstein-Uhlenbeck statistical half-life limit
    half_life_bars = 45.0
    if kf is not None:
        from math_models import calculate_half_life
        half_life_bars = calculate_half_life(kf.spread_history)
    max_holding_seconds = half_life_bars * 300.0 * 2.5  # M5 bars * 300s/bar * 2.5 multiplier

    for sig_id, trades in signal_groups.items():
        leg_a_trades = [t for t in trades if t["symbol"].upper() == symbol_a.upper()]
        leg_b_trades = [t for t in trades if t["symbol"].upper() == symbol_b.upper()]

        # 1. Cleanup check: If Leg A is fully closed but Leg B is still open, close Leg B immediately
        if not leg_a_trades and leg_b_trades:
            logger.info(f"Cleanup: Leg A is fully closed for signal_id {sig_id}. Closing remaining Leg B trades.")
            for t_b in leg_b_trades:
                close_single_trade(t_b["symbol"], t_b["ticket"], t_b["lots"], t_b["order_type"])
            continue

        if not leg_a_trades:
            continue

        is_buy_spread = (leg_a_trades[0]["order_type"] == "BUY")
        exit_triggered = False
        exit_reason = ""

        # Check statistical half-life time exit first
        for t in trades:
            entry_t = t["entry_time"]
            if entry_t is not None:
                elapsed = (datetime.datetime.now() - entry_t).total_seconds()
                if elapsed > max_holding_seconds:
                    exit_triggered = True
                    exit_reason = f"OU_HALF_LIFE_EXPIRATION (elapsed {elapsed/60:.1f}m > {max_holding_seconds/60:.1f}m)"
                    break

        # Check Staggered Scaling Exit & Partial Reversal Protection
        if not exit_triggered:
            open_leg_a_trades = [t for t in leg_a_trades if t["symbol"].upper() == symbol_a.upper()]
            
            # STAGE 1: Early Lock-in at Z = 0.0 (Reversion)
            if (is_buy_spread and z_score >= 0.0) or (not is_buy_spread and z_score <= 0.0):
                if len(open_leg_a_trades) == 3:
                    # Satisfy 140s minimum hold safeguard before closing Part 1
                    part1_hold_ok = True
                    for t in trades:
                        entry_t = t["entry_time"]
                        if entry_t is not None:
                            elapsed = (datetime.datetime.now() - entry_t).total_seconds()
                            if elapsed < 140.0:
                                part1_hold_ok = False
                                break
                    if part1_hold_ok:
                        p1_trade = open_leg_a_trades[0]
                        logger.info(f"💰 STAGGERED EXIT: Z-score reached 0.0 ({z_score:.2f}). Locking early profit on Part 1 ({p1_trade['ticket']}). Parts 2 & 3 remain open!")
                        close_single_trade(p1_trade["symbol"], p1_trade["ticket"], p1_trade["lots"], p1_trade["order_type"])
                        
            # STAGE 2: Extended Run Exit for Parts 2 & 3 (Z >= +0.50 or Z <= -0.50)
            if is_buy_spread:
                if z_score >= 0.50:
                    exit_triggered = True
                    exit_reason = f"Z_EXTENDED_TP_REVERSION (z={z_score:.2f} >= +0.50)"
                elif z_score <= -z_sl_val:
                    exit_triggered = True
                    exit_reason = f"Z_STOP_LOSS (z={z_score:.2f} <= {-z_sl_val})"
            else:
                if z_score <= -0.50:
                    exit_triggered = True
                    exit_reason = f"Z_EXTENDED_TP_REVERSION (z={z_score:.2f} <= -0.50)"
                elif z_score >= z_sl_val:
                    exit_triggered = True
                    exit_reason = f"Z_STOP_LOSS (z={z_score:.2f} >= {z_sl_val})"

            # PARTIAL REVERSAL PROTECTION: If Part 1 was closed and Z turns back against position past +/-0.20
            if not exit_triggered and len(open_leg_a_trades) < 3:
                if is_buy_spread and z_score < -0.20:
                    exit_triggered = True
                    exit_reason = f"PARTIAL_REVERSAL_PROTECTION (z={z_score:.2f} < -0.20 after Part 1 profit lock)"
                elif not is_buy_spread and z_score > 0.20:
                    exit_triggered = True
                    exit_reason = f"PARTIAL_REVERSAL_PROTECTION (z={z_score:.2f} > +0.20 after Part 1 profit lock)"

        # Minimum hold safeguard: Enforce 140 seconds holding time before full exit
        min_hold_ok = True
        for t in trades:
            entry_t = t["entry_time"]
            if entry_t is not None:
                elapsed = (datetime.datetime.now() - entry_t).total_seconds()
                if elapsed < 140.0:
                    min_hold_ok = False
                    break

        if exit_triggered and not min_hold_ok:
            exit_triggered = False
            logger.info(f"Exit deferred for signal_id {sig_id} to satisfy 140s minimum hold time.")

        if exit_triggered:
            logger.info(f"Dynamic exit triggered for signal_id {sig_id}. Reason: {exit_reason}. Closing all remaining positions.")
            # Close all Leg A parts
            for t_a in leg_a_trades:
                close_single_trade(t_a["symbol"], t_a["ticket"], t_a["lots"], t_a["order_type"])
            # Close all Leg B parts
            for t_b in leg_b_trades:
                close_single_trade(t_b["symbol"], t_b["ticket"], t_b["lots"], t_b["order_type"])
            continue

        # 2. Hedge scale-out sync:
        try:
            conn = get_connection()
            cur = conn.cursor()
            cur.execute(
                "SELECT ticket, symbol, status, lots, comment, order_type FROM trades WHERE signal_id = %s",
                (int(sig_id),)
            )
            all_db_trades = cur.fetchall()
            cur.close()
            conn.close()
        except Exception as e:
            logger.error(f"Error querying all trades for signal_id {sig_id}: {e}")
            continue

        db_leg_a = [t for t in all_db_trades if t[1].upper() == symbol_a.upper()]
        db_leg_b = [t for t in all_db_trades if t[1].upper() == symbol_b.upper()]

        total_a_parts = len(db_leg_a)
        closed_a_parts = len([t for t in db_leg_a if t[2] == 'CLOSED'])

        if total_a_parts > 0 and closed_a_parts > 0:
            total_b_vol = sum(float(t[3]) for t in db_leg_b)
            target_closed_b_vol = total_b_vol * (closed_a_parts / total_a_parts)
            already_closed_b_vol = sum(float(t[3]) for t in db_leg_b if t[2] == 'CLOSED')

            remaining_to_close_b = target_closed_b_vol - already_closed_b_vol
            if remaining_to_close_b > 0.005:
                open_b_trades = [t for t in db_leg_b if t[2] == 'OPEN']
                if open_b_trades:
                    t_b_to_close = open_b_trades[0]
                    t_b_ticket = t_b_to_close[0]
                    t_b_lots = float(t_b_to_close[3])
                    t_b_order_type = t_b_to_close[5]

                    close_vol = min(remaining_to_close_b, t_b_lots)
                    logger.info(f"Syncing Hedge: {closed_a_parts}/{total_a_parts} Leg A closed. Partially closing Leg B {t_b_ticket} by {close_vol:.3f} lots.")
                    close_single_trade(symbol_b, t_b_ticket, close_vol, t_b_order_type)

def get_symbol_category(symbol: str) -> str:
    s = symbol.upper()
    if "USDT" in s or "BUSD" in s:
        return "crypto"
    if any(x in s for x in ["XAU", "XAG"]):
        return "metals"
    if any(x in s for x in ["AAPL", "MSFT", "GOOGL", "TSLA", "NVDA", "AMD", "META", "AMZN", "US500", "US30", "NAS100", "GER30", "UK100"]):
        return "indices"
    return "forex"

def get_hedge_execution_parameters(action_spread: str, beta: float, tick_b) -> tuple:
    """
    Returns (order_type, side, price, sl_sign) for Leg B order
    taking into account spread action and correlation (sign of beta).
    """
    is_buy_spread = (action_spread == "BUY_SPREAD")
    # For positive correlation (beta >= 0), Leg B is traded in opposite direction of Leg A
    # For negative correlation (beta < 0), Leg B is traded in same direction as Leg A
    if beta >= 0:
        if is_buy_spread:
            return 1, "SELL", float(tick_b.bid), 1.0  # mt5.ORDER_TYPE_SELL = 1
        else:
            return 0, "BUY", float(tick_b.ask), -1.0  # mt5.ORDER_TYPE_BUY = 0
    else:
        if is_buy_spread:
            return 0, "BUY", float(tick_b.ask), -1.0  # mt5.ORDER_TYPE_BUY = 0
        else:
            return 1, "SELL", float(tick_b.bid), 1.0  # mt5.ORDER_TYPE_SELL = 1

def get_hedge_quantity(symbol_a: str, symbol_b: str, qty_a: float, beta: float, cat_a: str, cat_b: str) -> float:
    """
    Calculates the correct hedge quantity for Leg B based on Leg A quantity, beta,
    and the relative contract sizes of symbol_a and symbol_b.
    """
    if cat_b == "crypto":
        if cat_a == "crypto":
            contract_ratio = 1.0
        else:
            info_a = mt5.symbol_info(symbol_a)
            contract_ratio = info_a.trade_contract_size if info_a else 1.0
            
        filters_b = get_symbol_filters(symbol_b)
        qty_prec_b = filters_b["quantityPrecision"] if filters_b else 3
        return round(qty_a * abs(beta) * contract_ratio, qty_prec_b)
    else:
        if cat_a == "crypto":
            contract_size_a = 1.0
        else:
            info_a = mt5.symbol_info(symbol_a)
            contract_size_a = info_a.trade_contract_size if info_a else 1.0
            
        info_b = mt5.symbol_info(symbol_b)
        contract_size_b = info_b.trade_contract_size if info_b else 1.0
        
        raw_qty = qty_a * abs(beta) * (contract_size_a / contract_size_b)
        return round_volume(symbol_b, raw_qty)


# ==============================================================================
# MAIN TRADING ENGINE RUN LOOP
# ==============================================================================
def main():
    print("=========================================")
    print("   JANE STREET QUANT BOT INITIALIZING    ")
    print("=========================================\n")

    global REQUIRE_SMC_CONFLUENCE, SL_PIPS, TP_PIPS, AUTO_EXECUTE, Z_ENTRY_THRESHOLD, DEFAULT_LOTS, RISK_LIMITS_ENABLED, ML_MODEL
    global CRYPTO_ENABLED, METALS_ENABLED, FOREX_ENABLED, INDICES_ENABLED
    global KNIFE_PROTECTION_ENABLED, OBI_ENABLED, VOLATILITY_FILTER_ENABLED, current_pair_context

    load_config()

    # Load local ML model if it exists
    ML_MODEL = None
    if os.path.exists("ml_model.joblib"):
        try:
            ML_MODEL = joblib.load("ml_model.joblib")
            logger.info("Successfully loaded local Machine Learning model: ml_model.joblib")
        except Exception as e:
            logger.error(f"Failed to load ML model: {e}")

    # ── BUG FIX 3: Create all DB tables before anything tries to write to them ──
    logger.info("Initializing database tables...")
    initialize_database()
    logger.info("Database ready.")

    # Start background heartbeat thread to keep dashboard online during long loops
    def heartbeat_worker():
        import threading
        while True:
            try:
                conn = get_connection()
                cur = conn.cursor()
                cur.execute("UPDATE bot_state SET last_heartbeat = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = 1")
                conn.commit()
                cur.close()
                conn.close()
            except Exception:
                pass
            time.sleep(10)

    import threading
    h_thread = threading.Thread(target=heartbeat_worker, daemon=True)
    h_thread.start()
    logger.info("Background heartbeat thread started.")
    
    # Clean up any stale disabled categories on startup
    cleanup_disabled_scanned_assets(CRYPTO_ENABLED, METALS_ENABLED, FOREX_ENABLED, INDICES_ENABLED)

    global DYNAMIC_CRYPTO_PAIRS
    DYNAMIC_CRYPTO_PAIRS = []
    if CRYPTO_ENABLED:
        try:
            logger.info("Fetching all active Binance Futures symbols to build dynamic pairs list...")
            res = requests.get(f"{BINANCE_BASE_URL}/fapi/v1/exchangeInfo", timeout=10)
            if res.status_code == 200:
                symbols_info = res.json().get("symbols", [])
                active_alts = []
                for s in symbols_info:
                    sym_name = s.get("symbol", "")
                    if s.get("status") == "TRADING" and sym_name.endswith("USDT"):
                        if sym_name not in ["BTCUSDT", "ETHUSDT"]:
                            active_alts.append(sym_name)
                
                # Build pairs
                DYNAMIC_CRYPTO_PAIRS.append(("BTCUSDT", "ETHUSDT"))
                for alt in active_alts:
                    DYNAMIC_CRYPTO_PAIRS.append((alt, "BTCUSDT"))
                    # Also pair top coins against ETHUSDT for diversity
                    if alt in ["SOLUSDT", "BNBUSDT", "AVAXUSDT", "XRPUSDT", "ADAUSDT", "NEARUSDT", "DOTUSDT", "LINKUSDT", "LTCUSDT", "BCHUSDT"]:
                        DYNAMIC_CRYPTO_PAIRS.append((alt, "ETHUSDT"))
                logger.info(f"Successfully loaded {len(DYNAMIC_CRYPTO_PAIRS)} dynamic crypto pairs for scanning!")
            else:
                logger.warning("Failed to fetch Binance exchangeInfo. Falling back to hardcoded crypto pairs list.")
        except Exception as e:
            logger.warning(f"Error fetching dynamic crypto symbols: {e}. Falling back to hardcoded list.")

    try:
        acc_info = initialize_mt5()
    except Exception:
        acc_info = None
    q_cov, r_cov = get_kf_parameters(GLOBAL_CONFIG["SYMBOL_A"])
    kf = KalmanFilterRegression(transition_covariance=q_cov, observation_covariance=r_cov)

    is_halted = False
    smc_update_counter = 0
    active_zones = None
    last_processed_pair = ""
    daily_start_equity = None
    db_config_counter = 0
    low_correlation_warning = False
    correlation_check_counter = 0

    db_init_cfg = fetch_db_config()
    if db_init_cfg:
        SL_PIPS = db_init_cfg[1]
        TP_PIPS = db_init_cfg[2]

    logger.info("Quantitative core pipeline active.")
    logger.info(f"[ACTIVE SYSTEM CONFIG] SL Pips: {SL_PIPS} | TP Pips: {TP_PIPS} | Crypto Lots: {DEFAULT_LOTS}")
    win_rate_loop_counter = 0
    SMC_ZONES_CACHE = {}
    smc_counter_cache = {}

    active_login_id = None
    peak_floating_profit = 0.0
    loop_log_counter = 0
    try:
        from database import get_connection
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT mt5_login FROM bot_state WHERE id = 1")
        row = cur.fetchone()
        if row and row[0]:
            active_login_id = int(row[0])
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"Error loading initial wallet login from database: {e}")

    try:
        from database import get_connection
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT default_lots FROM bot_state WHERE id = 1")
        db_lots_row = cur.fetchone()
        if db_lots_row:
            DEFAULT_LOTS = float(db_lots_row[0])
        cur.close()
        conn.close()
    except Exception:
        pass
    logger.info(f"Successfully loaded initial configuration! Default Lots / USDT Margin size: {DEFAULT_LOTS}")

    while True:
        try:
            # Prioritize live Binance Futures USDT balance for Crypto Bot
            usdt_bal, _ = get_binance_usdt_balance()
            if usdt_bal > 0.0:
                class BinanceAccountInfo:
                    login = 888888
                    equity = usdt_bal
                    balance = usdt_bal
                    profit = 0.0
                    margin = 0.0
                    trade_mode = 0
                acc_info = BinanceAccountInfo()
            else:
                try:
                    from database import get_connection
                    conn_eq = get_connection()
                    cur_eq = conn_eq.cursor()
                    cur_eq.execute("SELECT equity FROM bot_state WHERE id = 1")
                    row_eq = cur_eq.fetchone()
                    db_eq = float(row_eq[0]) if (row_eq and row_eq[0]) else 10713.16
                    cur_eq.close()
                    conn_eq.close()
                except Exception:
                    db_eq = 10713.16

                class BinanceAccountInfo:
                    login = 888888
                    equity = db_eq
                    balance = db_eq
                    profit = 0.0
                    margin = 0.0
                    trade_mode = 0
                acc_info = BinanceAccountInfo()

            current_login = int(acc_info.login)
            
            # Check if there is an account switch OR a startup mismatch on 0 trades today
            from database import get_connection
            startup_mismatch = False
            try:
                conn = get_connection()
                cur = conn.cursor()
                cur.execute("SELECT initial_balance FROM bot_state WHERE id = 1")
                state_row = cur.fetchone()
                db_initial = float(state_row[0]) if (state_row and state_row[0] is not None) else 0.0
                
                # Check trades count today
                import datetime
                today_date = datetime.date.today()
                cur.execute("SELECT trades_today FROM daily_metrics WHERE trading_date = %s", (today_date,))
                metrics_row = cur.fetchone()
                trades_today_val = metrics_row[0] if metrics_row else 0
                
                # Check active positions count
                cur.execute("SELECT COUNT(*) FROM trades WHERE status = 'OPEN'")
                open_trades_count = cur.fetchone()[0] or 0
                
                cur.close()
                conn.close()
                
                # If 0 trades today and 0 open positions, and balance has mismatch > $5.00:
                if trades_today_val == 0 and open_trades_count == 0 and abs(db_initial - float(acc_info.equity)) > 5.00:
                    startup_mismatch = True
            except Exception as e:
                logger.error(f"Error checking startup metrics sync: {e}")
                
            wallet_changed = (active_login_id is not None and active_login_id != current_login)
            
            if wallet_changed or startup_mismatch:
                logger.info(f"Syncing metrics (wallet_changed={wallet_changed}, startup_mismatch={startup_mismatch}). Resetting metrics to {acc_info.equity:.2f}")
                from database import reset_database_metrics_for_new_account
                reset_database_metrics_for_new_account(current_login, acc_info.equity)
                
                # Reset local daily start equity in memory to the exchange wallet's equity
                daily_start_equity = float(acc_info.equity)
                
                # Update safeguards cache here to prevent circular imports
                try:
                    import risk_safeguards
                    import datetime
                    risk_safeguards._cached_start_equity = float(acc_info.equity)
                    risk_safeguards._cached_start_equity_date = datetime.date.today()
                    risk_safeguards._cached_last_login = int(current_login)
                except Exception as ex:
                    logger.error(f"Error updating risk_safeguards cache in main loop: {ex}")
                
            active_login_id = current_login

            # ── DB CONFIG SYNC (every ~10s) ─────────────────────────────────
            if db_config_counter % 5 == 0:
                db_cfg = fetch_db_config()
                if db_cfg:
                    new_pair, new_sl, new_tp, new_smc, new_auto_exec, new_crypto, new_metals, new_forex, new_indices, new_risk_limits, new_z_entry, new_def_lots, new_max_trades, new_knife, new_obi, new_vol = db_cfg
                    parts = new_pair.split("/")
                    if len(parts) == 2 and parts[0] != parts[1]:
                        if GLOBAL_CONFIG["SYMBOL_A"] != parts[0] or GLOBAL_CONFIG["SYMBOL_B"] != parts[1]:
                            logger.info(f"DB config update — switching to {new_pair}")
                            GLOBAL_CONFIG["SYMBOL_A"] = parts[0]
                            GLOBAL_CONFIG["SYMBOL_B"] = parts[1]
                            save_config(new_pair)
                    if SL_PIPS != new_sl:
                        logger.info(f"[CONFIG UPDATE] SL Pips updated: {SL_PIPS} -> {new_sl}")
                        SL_PIPS = new_sl
                    if TP_PIPS != new_tp:
                        logger.info(f"[CONFIG UPDATE] TP Pips updated: {TP_PIPS} -> {new_tp}")
                        TP_PIPS = new_tp
                    if REQUIRE_SMC_CONFLUENCE != new_smc:
                        logger.info(f"[CONFIG UPDATE] SMC Confluence updated: {REQUIRE_SMC_CONFLUENCE} -> {new_smc}")
                        REQUIRE_SMC_CONFLUENCE = new_smc
                    if AUTO_EXECUTE != new_auto_exec:
                        logger.info(f"[CONFIG UPDATE] Auto Execute updated: {AUTO_EXECUTE} -> {new_auto_exec}")
                        AUTO_EXECUTE = new_auto_exec
                    if os.getenv("OVERRIDE_CRYPTO_ENABLED") is not None:
                        CRYPTO_ENABLED = os.getenv("OVERRIDE_CRYPTO_ENABLED", "True").lower() in ("true", "1", "yes")
                    elif CRYPTO_ENABLED != new_crypto:
                        logger.info(f"[CONFIG UPDATE] Crypto Enabled updated: {CRYPTO_ENABLED} -> {new_crypto}")
                        CRYPTO_ENABLED = new_crypto
                        
                    if os.getenv("OVERRIDE_METALS_ENABLED") is not None:
                        METALS_ENABLED = os.getenv("OVERRIDE_METALS_ENABLED", "False").lower() in ("true", "1", "yes")
                    elif METALS_ENABLED != new_metals:
                        logger.info(f"[CONFIG UPDATE] Metals Enabled updated: {METALS_ENABLED} -> {new_metals}")
                        METALS_ENABLED = new_metals
                        
                    if os.getenv("OVERRIDE_FOREX_ENABLED") is not None:
                        FOREX_ENABLED = os.getenv("OVERRIDE_FOREX_ENABLED", "False").lower() in ("true", "1", "yes")
                    elif FOREX_ENABLED != new_forex:
                        logger.info(f"[CONFIG UPDATE] Forex Enabled updated: {FOREX_ENABLED} -> {new_forex}")
                        FOREX_ENABLED = new_forex
                        
                    if os.getenv("OVERRIDE_INDICES_ENABLED") is not None:
                        INDICES_ENABLED = os.getenv("OVERRIDE_INDICES_ENABLED", "False").lower() in ("true", "1", "yes")
                    elif INDICES_ENABLED != new_indices:
                        logger.info(f"[CONFIG UPDATE] Indices Enabled updated: {INDICES_ENABLED} -> {new_indices}")
                        INDICES_ENABLED = new_indices
                    if RISK_LIMITS_ENABLED != new_risk_limits:
                        logger.info(f"[CONFIG UPDATE] Risk Limits updated: {RISK_LIMITS_ENABLED} -> {new_risk_limits}")
                        RISK_LIMITS_ENABLED = new_risk_limits
                    if Z_ENTRY_THRESHOLD != new_z_entry:
                        logger.info(f"[CONFIG UPDATE] Z-Entry Threshold updated: {Z_ENTRY_THRESHOLD} -> {new_z_entry}")
                        Z_ENTRY_THRESHOLD = new_z_entry
                    if DEFAULT_LOTS != new_def_lots:
                        logger.info(f"[CONFIG UPDATE] Default Lots updated: {DEFAULT_LOTS} -> {new_def_lots}")
                        DEFAULT_LOTS = new_def_lots
                    if KNIFE_PROTECTION_ENABLED != new_knife:
                        logger.info(f"[CONFIG UPDATE] Knife Protection updated: {KNIFE_PROTECTION_ENABLED} -> {new_knife}")
                        KNIFE_PROTECTION_ENABLED = new_knife
                    if OBI_ENABLED != new_obi:
                        logger.info(f"[CONFIG UPDATE] OBI Filter updated: {OBI_ENABLED} -> {new_obi}")
                        OBI_ENABLED = new_obi
                    if VOLATILITY_FILTER_ENABLED != new_vol:
                        logger.info(f"[CONFIG UPDATE] Volatility Filter updated: {VOLATILITY_FILTER_ENABLED} -> {new_vol}")
                        VOLATILITY_FILTER_ENABLED = new_vol
                    import risk_safeguards
                    if risk_safeguards.MAX_DAILY_TRADES != new_max_trades:
                        logger.info(f"[CONFIG UPDATE] Max Daily Trades updated: {risk_safeguards.MAX_DAILY_TRADES} -> {new_max_trades}")
                        risk_safeguards.MAX_DAILY_TRADES = new_max_trades
                    
                    # Clean up disabled categories in the database immediately
                    cleanup_disabled_scanned_assets(CRYPTO_ENABLED, METALS_ENABLED, FOREX_ENABLED, INDICES_ENABLED)
            db_config_counter += 1

            S_A = GLOBAL_CONFIG["SYMBOL_A"]
            S_B = GLOBAL_CONFIG["SYMBOL_B"]
            current_pair_context = f"{S_A}/{S_B}"

            cat_a = get_symbol_category(S_A)
            cat_b = get_symbol_category(S_B)

            # Resolve broker aliases for active pair
            S_A_resolved = resolve_broker_symbol(S_A) if cat_a != "crypto" else S_A
            S_B_resolved = resolve_broker_symbol(S_B) if cat_b != "crypto" else S_B

            # News Guard check
            import news_guard
            is_news_halted, news_msg = news_guard.get_news_halt_status([S_A_resolved, S_B_resolved])

            # Determine equity based on asset class
            if cat_a == "crypto":
                try:
                    usdt_bal, _ = get_binance_usdt_balance()
                    if usdt_bal > 0.0:
                        current_equity = usdt_bal
                    else:
                        conn_eq = get_connection()
                        cur_eq = conn_eq.cursor()
                        cur_eq.execute("SELECT equity FROM bot_state WHERE id = 1")
                        row_eq = cur_eq.fetchone()
                        current_equity = float(row_eq[0]) if (row_eq and row_eq[0]) else 5000.0
                        cur_eq.close()
                        conn_eq.close()
                except Exception:
                    current_equity = 5000.0
            else:
                current_equity = acc_info.equity if acc_info else 0.0

            # Calculate daily drawdown using the correct equity (only if equity > 0.0)
            if current_equity > 0.0:
                is_limit_breached, daily_loss_p = check_drawdown_limit(current_equity)
            else:
                is_limit_breached, daily_loss_p = False, 0.0

            # Detect if it's a demo or contest account
            is_demo = getattr(acc_info, "trade_mode", 0) in (0, 1)  # 0 is DEMO, 1 is CONTEST

            if is_limit_breached:
                if not RISK_LIMITS_ENABLED:
                    logger.info(f"Daily drawdown limit breached ({daily_loss_p:.2f}%), but bypassing because Risk Limits are disabled.")
                    is_halted = False
                else:
                    is_halted = True
            else:
                is_halted = False

            if daily_start_equity is None and current_equity > 0.0:
                daily_start_equity = current_equity

            if is_halted:
                close_all_js_positions(S_A_resolved)
                close_all_js_positions(S_B_resolved)
                update_bot_state(
                    active_pair=current_pair_context,
                    system_status="HALTED (Max Loss)",
                    equity=acc_info.equity,
                    drawdown_percent=daily_loss_p,
                    floating_profit=0.0,
                    z_score=0.0,
                    hedge_ratio=0.0,
                    obi_a=0.0,
                    obi_b=0.0,
                    trades_today=get_trades_count_today(),
                    sl_pips=SL_PIPS,
                )
                time.sleep(10)
                continue

            # ── 1. COMPILE CANDIDATE PAIRS ──
            scanned_assets_z_cache = {}
            pairs_to_scan = []
            if FOREX_ENABLED:
                pairs_to_scan.extend(CANDIDATE_PAIRS["forex"])
            if METALS_ENABLED:
                pairs_to_scan.extend(CANDIDATE_PAIRS["metals"])
            if CRYPTO_ENABLED:
                if DYNAMIC_CRYPTO_PAIRS:
                    pairs_to_scan.extend(DYNAMIC_CRYPTO_PAIRS)
                else:
                    pairs_to_scan.extend(CANDIDATE_PAIRS["crypto"])
            if INDICES_ENABLED:
                pairs_to_scan.extend(CANDIDATE_PAIRS["indices"])

            # Include custom pair if set and not already in pool
            if current_pair_context not in [f"{p[0]}/{p[1]}" for p in pairs_to_scan]:
                parts = current_pair_context.split('/')
                if len(parts) == 2 and parts[0] != parts[1]:
                    pairs_to_scan.append((parts[0], parts[1]))

            candidate_signals = []

            # Periodically update win rates
            if win_rate_loop_counter == 0:
                # Pre-populate active pair win rate only, so startup is instant
                try:
                    parts = current_pair_context.split('/')
                    if len(parts) == 2:
                        WIN_RATE_CACHE[current_pair_context] = simulate_win_rate_for_pair(parts[0], parts[1], z_entry=Z_ENTRY_THRESHOLD)
                except Exception:
                    pass
            win_rate_loop_counter += 1

            # Check closed trades for all currently open symbols in the database
            try:
                conn_closed = get_connection()
                cur_closed = conn_closed.cursor()
                cur_closed.execute("SELECT DISTINCT symbol FROM trades WHERE status = 'OPEN'")
                open_symbols = [row[0] for row in cur_closed.fetchall()]
                cur_closed.close()
                conn_closed.close()
                
                # Always ensure S_A and S_B are in the list to be checked
                if S_A_resolved not in open_symbols:
                    open_symbols.append(S_A_resolved)
                if S_B_resolved not in open_symbols:
                    open_symbols.append(S_B_resolved)
                    
                for sym in open_symbols:
                    cat = get_symbol_category(sym)
                    if cat == "crypto":
                        check_closed_binance_trades(sym)
                    else:
                        check_closed_trades(sym)
            except Exception as e:
                logger.error(f"Error checking closed trades for open symbols: {e}")

            # ── Sync all active Binance Futures positions to DB first so floating PnL matches Binance 100% ──
            try:
                from binance_execution import sync_all_binance_open_positions_to_db
                sync_all_binance_open_positions_to_db()
            except Exception as sync_ex:
                logger.error(f"Error calling sync_all_binance_open_positions_to_db: {sync_ex}")

            # Fetch active positions in DB
            has_positions = False
            floating_profit = 0.0
            try:
                has_positions = get_open_trades_count() > 0
                conn = get_connection()
                cur = conn.cursor()
                cur.execute("SELECT COALESCE(SUM(profit), 0) FROM trades WHERE status = 'OPEN'")
                floating_profit = float(cur.fetchone()[0] or 0.0)
                cur.close()
                conn.close()
            except Exception as e:
                logger.error(f"Error checking active positions in main: {e}")

            # ── Multi-Tier Equity Trailing Stop Safeguard (Dual Tier Profit Protection) ──
            if has_positions:
                if floating_profit > peak_floating_profit:
                    peak_floating_profit = floating_profit

                should_close_trail = False
                trail_close_reason = ""

                # Tier 1 (Safety Floor at +$75.00 Peak -> Locks +$69.00 Cash Profit):
                # If peak profit reached $75-$99 and reverses below +$69.00, lock +$69.00 profit!
                if peak_floating_profit >= 75.0 and peak_floating_profit < 100.0:
                    tier1_floor = 69.0
                    if floating_profit <= tier1_floor:
                        should_close_trail = True
                        trail_close_reason = f"[PROFIT GUARD TIER 1] Peak reached ${peak_floating_profit:.2f} and reversed to ${floating_profit:.2f} (Floor: ${tier1_floor:.2f}). Auto-closing to lock +$69.00 profit."

                # Tier 2 (Full Trailing Stop at +$100.00+ / 1.0% Account Gain):
                # When peak profit reaches $100.00+, lock 91% of peak earnings ($91.00 to $900+)
                elif peak_floating_profit >= 100.0:
                    trail_stop_level = max(91.0, peak_floating_profit * 0.91)
                    if floating_profit <= trail_stop_level:
                        should_close_trail = True
                        trail_close_reason = f"[PROFIT GUARD TIER 2] Peak reached ${peak_floating_profit:.2f} and reversed to ${floating_profit:.2f} (Floor: ${trail_stop_level:.2f}). Auto-closing to lock 91% profit."

                if should_close_trail:
                    logger.info(trail_close_reason)
                    
                    try:
                        from database import get_connection
                        conn_exit = get_connection()
                        cur_exit = conn_exit.cursor()
                        cur_exit.execute("SELECT DISTINCT symbol FROM trades WHERE status = 'OPEN'")
                        open_symbols = [row[0] for row in cur_exit.fetchall()]
                        cur_exit.close()
                        conn_exit.close()
                        
                        all_success = True
                        for sym in open_symbols:
                            cat = get_symbol_category(sym)
                            if cat == "crypto":
                                # Close all positions on Binance
                                close_all_binance_positions(sym)
                                
                                # Verify that the position is indeed closed on Binance
                                check_res = send_signed_request("GET", "/fapi/v2/positionRisk", {"symbol": sym})
                                if check_res and check_res.status_code == 200:
                                    pos_risk = check_res.json()
                                    for pos in pos_risk:
                                        if float(pos.get("positionAmt", 0.0)) != 0.0:
                                            all_success = False
                                            break
                            else:
                                close_all_positions(sym)
                        
                        if all_success:
                            peak_floating_profit = 0.0
                            has_positions = False
                    except Exception as e:
                        logger.error(f"Error during equity trail emergency close: {e}")

            # Sync open trades live prices and profit/loss in DB
            try:
                conn = get_connection()
                cur = conn.cursor()

                cur.execute("SELECT ticket, symbol, order_type, lots, entry_price FROM trades WHERE status = 'OPEN'")
                open_trades = cur.fetchall()
                for ticket, symbol, order_type, lots, entry_price in open_trades:
                    cat = get_symbol_category(symbol)
                    if cat == "crypto":
                        tick = get_binance_live_tick(symbol)
                        if tick:
                            price_val = (tick.bid + tick.ask) / 2.0
                            mult = 1.0 if order_type.upper() == "BUY" else -1.0
                            profit_val = (price_val - float(entry_price)) * float(lots) * mult
                            cur.execute(
                                "UPDATE trades SET close_price = %s, profit = %s WHERE ticket = %s",
                                (float(price_val), float(profit_val), int(ticket))
                            )
                conn.commit()
                cur.close()
                conn.close()
            except Exception as e:
                logger.error(f"Error syncing open trades telemetry to DB: {e}")

            # ── 2. SCANNING LOOP FOR ALL PAIRS ──
            active_pair_z_score = 0.0
            active_pair_beta = 0.0
            active_pair_obi_a = 0.0
            active_pair_obi_b = 0.0
            active_pair_velocity = 0.0

            # Bulk fetch bookTickers to optimize rate limits
            bulk_ticks = {}
            if CRYPTO_ENABLED:
                try:
                    bulk_res = requests.get(f"{BINANCE_BASE_URL}/fapi/v1/ticker/bookTicker", timeout=5)
                    if bulk_res.status_code == 200:
                        for t in bulk_res.json():
                            sym = t.get("symbol", "").upper()
                            class BinanceTick:
                                def __init__(self, bid, ask):
                                    self.bid = bid
                                    self.ask = ask
                            bulk_ticks[sym] = BinanceTick(float(t.get("bidPrice", 0)), float(t.get("askPrice", 0)))
                except Exception as e:
                    logger.warning(f"Error fetching bulk book tickers: {e}")

            for s_a, s_b in pairs_to_scan:
                pk = f"{s_a}/{s_b}"
                cat_a = get_symbol_category(s_a)
                cat_b = get_symbol_category(s_b)

                # Resolve broker aliases for MT5 symbols
                s_a_resolved = resolve_broker_symbol(s_a) if cat_a != "crypto" else s_a
                s_b_resolved = resolve_broker_symbol(s_b) if cat_b != "crypto" else s_b

                # Fetch ticks
                tick_a_scan, tick_b_scan = None, None
                bids_a_scan, asks_a_scan = [], []
                bids_b_scan, asks_b_scan = [], []

                try:
                    if cat_a == "crypto":
                        if s_a_resolved in bulk_ticks:
                            tick_a_scan = bulk_ticks[s_a_resolved]
                        else:
                            check_and_subscribe_symbol(s_a_resolved)
                            tick_a_scan = get_binance_live_tick(s_a_resolved)
                    else:
                        check_and_subscribe_symbol(s_a_resolved)
                        tick_a_scan = mt5.symbol_info_tick(s_a_resolved)

                    if cat_b == "crypto":
                        if s_b_resolved in bulk_ticks:
                            tick_b_scan = bulk_ticks[s_b_resolved]
                        else:
                            check_and_subscribe_symbol(s_b_resolved)
                            tick_b_scan = get_binance_live_tick(s_b_resolved)
                    else:
                        check_and_subscribe_symbol(s_b_resolved)
                        tick_b_scan = mt5.symbol_info_tick(s_b_resolved)
                except Exception:
                    continue

                if tick_a_scan is None or tick_b_scan is None:
                    continue

                p_a = (tick_a_scan.bid + tick_a_scan.ask) / 2.0
                p_b = (tick_b_scan.bid + tick_b_scan.ask) / 2.0

                if p_a <= 0.0 or p_b <= 0.0:
                    continue

                # Kalman update
                kf_pair = get_kf_for_pair(s_a_resolved, s_b_resolved)
                beta, alpha, spread, z = kf_pair.update(p_b, p_a)

                # Re-anchor Kalman Filter if Z-score is an unanchored outlier anomaly (> 10.0)
                if abs(z) > 10.0:
                    import numpy as np
                    kf_pair.ref_x = float(p_b)
                    kf_pair.ref_y = float(p_a)
                    kf_pair.state_mean = np.array([1.0, 0.0])
                    kf_pair.state_covariance = np.identity(2) * 1.0
                    beta, alpha, spread, z = kf_pair.update(p_b, p_a)

                # SMC update (Only run if SMC Confluence is enabled on Dashboard)
                if REQUIRE_SMC_CONFLUENCE:
                    if s_a_resolved not in SMC_ZONES_CACHE or smc_counter_cache.get(s_a_resolved, 0) >= 15:
                        try:
                            if cat_a == "crypto":
                                r_df = get_binance_rates_df(s_a_resolved, timeframe_minutes=5, count=100)
                            else:
                                r_df = get_rates_df(s_a_resolved, SMC_TIMEFRAME, count=100)
                            if r_df is not None and not r_df.empty:
                                SMC_ZONES_CACHE[s_a_resolved] = detect_smc_zones(r_df)
                                log_fvg_zones(s_a_resolved, SMC_ZONES_CACHE[s_a_resolved])
                            smc_counter_cache[s_a_resolved] = 0
                        except Exception as e:
                            logger.error(f"SMC scan error for {s_a_resolved}: {e}")
                    else:
                        smc_counter_cache[s_a_resolved] = smc_counter_cache.get(s_a_resolved, 0) + 1

                # OBI calculation
                bids_a_scan, asks_a_scan = [], []
                bids_b_scan, asks_b_scan = [], []
                if OBI_ENABLED:
                    try:
                        if cat_a == "crypto":
                            bids_a_scan, asks_a_scan = get_binance_market_book(s_a_resolved)
                        else:
                            bids_a_scan, asks_a_scan = get_market_book(s_a_resolved)

                        if cat_b == "crypto":
                            bids_b_scan, asks_b_scan = get_binance_market_book(s_b_resolved)
                        else:
                            bids_b_scan, asks_b_scan = get_market_book(s_b_resolved)
                    except Exception as e:
                        logger.warning(f"Error fetching market book for OBI: {e}")

                obi_a = calculate_obi(bids_a_scan, asks_a_scan, depth=5)
                obi_b = calculate_obi(bids_b_scan, asks_b_scan, depth=5)
                net_obi = obi_a - obi_b
                bids_a_supported = len(bids_a_scan) > 0
                bids_b_supported = len(bids_b_scan) > 0
                obi_buy_pass = (net_obi > 0.15) if (bids_a_supported and bids_b_supported) else True
                obi_sell_pass = (net_obi < -0.15) if (bids_a_supported and bids_b_supported) else True

                in_bullish_zone = True
                in_bearish_zone = True
                if REQUIRE_SMC_CONFLUENCE and s_a_resolved in SMC_ZONES_CACHE:
                    in_bullish_zone = any(
                        is_price_in_zones(p_a, SMC_ZONES_CACHE[s_a_resolved].get(k, []))
                        for k in ['bullish_ob', 'bullish_breaker', 'bullish_fvg', 'bullish_ifvg']
                    )
                    in_bearish_zone = any(
                        is_price_in_zones(p_a, SMC_ZONES_CACHE[s_a_resolved].get(k, []))
                        for k in ['bearish_ob', 'bearish_breaker', 'bearish_fvg', 'bearish_ifvg']
                    )

                z_velocity = kf_pair.get_velocity(k=3)
                dynamic_z_entry = kf_pair.get_dynamic_z_entry(Z_ENTRY_THRESHOLD)

                if cat_a == "forex":
                    z_vel_lim = 0.02
                elif cat_a == "metals":
                    z_vel_lim = 0.08
                else:
                    z_vel_lim = 0.05

                action = "NONE"
                if Z_ENTRY_THRESHOLD <= 0.5:
                    # Raw Test Mode: Bypass all safety filters for instant verification
                    if z < -Z_ENTRY_THRESHOLD:
                        action = "BUY_SPREAD"
                    elif z > Z_ENTRY_THRESHOLD:
                        action = "SELL_SPREAD"
                else:
                    # Safe Mode: Apply protections based on Dashboard toggle switches
                    pass_z_buy = (z < -dynamic_z_entry) if VOLATILITY_FILTER_ENABLED else (z < -Z_ENTRY_THRESHOLD)
                    pass_z_sell = (z > dynamic_z_entry) if VOLATILITY_FILTER_ENABLED else (z > Z_ENTRY_THRESHOLD)
                    
                    pass_vel_buy = (z_velocity > -z_vel_lim) if KNIFE_PROTECTION_ENABLED else True
                    pass_vel_sell = (z_velocity < z_vel_lim) if KNIFE_PROTECTION_ENABLED else True
                    
                    pass_obi_buy = obi_buy_pass if OBI_ENABLED else True
                    pass_obi_sell = obi_sell_pass if OBI_ENABLED else True
                    
                    pass_smc_buy = in_bullish_zone if REQUIRE_SMC_CONFLUENCE else True
                    pass_smc_sell = in_bearish_zone if REQUIRE_SMC_CONFLUENCE else True

                    if pass_z_buy and pass_vel_buy and pass_obi_buy and pass_smc_buy:
                        action = "BUY_SPREAD"
                    elif pass_z_sell and pass_vel_sell and pass_obi_sell and pass_smc_sell:
                        action = "SELL_SPREAD"

                # Validate beta sign and magnitude to prevent same-side hedge order anomalies
                if action != "NONE":
                    expected_sign = EXPECTED_BETA_SIGN.get(pk, 1)
                    beta_sign = 1 if beta >= 0 else -1
                    if beta_sign != expected_sign:
                        if cat_a == "crypto" and abs(beta) < 0.05:
                            pass
                        else:
                            logger.warning(f"Correlation anomaly for {pk}: estimated beta {beta:.4f} has wrong sign (expected {expected_sign}). Skipping signal.")
                            action = "NONE"
                    elif cat_a != "crypto" and abs(beta) < 0.05:
                        logger.warning(f"Hedge ratio too low for {pk}: beta {beta:.4f}. Skipping signal.")
                        action = "NONE"

                # Debug log why signal was skipped if base Z threshold was crossed but action is NONE
                base_z_triggered = (z < -Z_ENTRY_THRESHOLD) or (z > Z_ENTRY_THRESHOLD)
                if base_z_triggered and action == "NONE":
                    reasons = []
                    if z < -Z_ENTRY_THRESHOLD:
                        if VOLATILITY_FILTER_ENABLED and not (z < -dynamic_z_entry):
                            reasons.append(f"Z-score {z:.3f} not below dynamic threshold {-dynamic_z_entry:.3f} (volatility protection)")
                        if KNIFE_PROTECTION_ENABLED and not (z_velocity > -z_vel_lim):
                            reasons.append(f"Z-velocity {z_velocity:.3f} too fast (falling knife protection, limit: {-z_vel_lim})")
                        if OBI_ENABLED and not obi_buy_pass:
                            reasons.append(f"OBI {net_obi:.3f} too low (min: 0.15)")
                        if REQUIRE_SMC_CONFLUENCE and not in_bullish_zone:
                            reasons.append("Price not in Bullish SMC Zone (Order Block/FVG)")
                    else:
                        if VOLATILITY_FILTER_ENABLED and not (z > dynamic_z_entry):
                            reasons.append(f"Z-score {z:.3f} not above dynamic threshold {dynamic_z_entry:.3f} (volatility protection)")
                        if KNIFE_PROTECTION_ENABLED and not (z_velocity < z_vel_lim):
                            reasons.append(f"Z-velocity {z_velocity:.3f} too fast (rising knife protection, limit: {z_vel_lim})")
                        if OBI_ENABLED and not obi_sell_pass:
                            reasons.append(f"OBI {net_obi:.3f} too high (max: -0.15)")
                        if REQUIRE_SMC_CONFLUENCE and not in_bearish_zone:
                            reasons.append("Price not in Bearish SMC Zone (Order Block/FVG)")
                    
                    if reasons:
                        logger.debug(f"Signal threshold crossed for {pk} (Z={z:.3f}), but skipped due to: {', '.join(reasons)}")

                # Fast non-blocking win rate lookup
                if pk not in WIN_RATE_CACHE:
                    if base_z_triggered:
                        try:
                            WIN_RATE_CACHE[pk] = simulate_win_rate_for_pair(s_a, s_b, z_entry=Z_ENTRY_THRESHOLD)
                        except Exception:
                            WIN_RATE_CACHE[pk] = 68.5
                    else:
                        WIN_RATE_CACHE[pk] = 68.5
                        
                win_rate = WIN_RATE_CACHE[pk]
                
                # Update scanned asset table for all pairs to populate Dashboard live UI candidate table
                update_scanned_asset(pk, p_a, p_b, win_rate, z, action)
                scanned_assets_z_cache[pk] = z

                # Track telemetry for current active pair
                if pk.upper().strip() == current_pair_context.upper().strip():
                    active_pair_z_score = z
                    active_pair_beta = beta
                    active_pair_obi_a = obi_a
                    active_pair_obi_b = obi_b
                    active_pair_velocity = z_velocity

                # Cooldown checks
                cooldown_dir = COOLDOWN_DIRECTIONS.get(pk)
                if cooldown_dir == "BUY_SPREAD" and z > -1.0:
                    COOLDOWN_DIRECTIONS[pk] = None
                    cooldown_dir = None
                elif cooldown_dir == "SELL_SPREAD" and z < 1.0:
                    COOLDOWN_DIRECTIONS[pk] = None
                    cooldown_dir = None

                if action != "NONE" and cooldown_dir != action and not is_pair_in_cooldown(s_a_resolved, s_b_resolved):
                    candidate_signals.append({
                        "pair": (s_a, s_b),
                        "action": action,
                        "win_rate": win_rate,
                        "z_score": z,
                        "z_velocity": z_velocity,
                        "beta": beta,
                        "net_obi": net_obi,
                        "tick_a": tick_a_scan,
                        "tick_b": tick_b_scan,
                        "price_a": p_a,
                        "price_b": p_b
                    })

            # Position exit checks for active pair


            # ── 3. MANAGE ACTIVE POSITION EXITS ──
            kf_active = get_kf_for_pair(S_A_resolved, S_B_resolved)
            manage_spread_positions(S_A_resolved, S_B_resolved, active_pair_z_score, kf=kf_active)

            # ── 4. MANUAL TRADE COMMANDS ──
            tick_a_active = mt5.symbol_info_tick(S_A_resolved) if get_symbol_category(S_A_resolved) != "crypto" else get_binance_live_tick(S_A_resolved)
            tick_b_active = mt5.symbol_info_tick(S_B_resolved) if get_symbol_category(S_B_resolved) != "crypto" else get_binance_live_tick(S_B_resolved)
            if tick_a_active and tick_b_active:
                poll_manual_commands(tick_a_active, tick_b_active, SL_PIPS)

            # ── 5. ALGO TRADING & AUTO-EXECUTION ──
            trades_today = get_trades_count_today()
            is_trade_limit_ok = (not RISK_LIMITS_ENABLED) or is_demo or (trades_today < MAX_DAILY_TRADES)
            
            if AUTO_EXECUTE and not has_positions and is_trade_limit_ok and not is_news_halted and candidate_signals:
                # Prioritize current active pair signal first, fallback to scanning highest win-rate signal second
                active_pair_sig = None
                for sig in candidate_signals:
                    if sig["pair"] == (S_A, S_B) or sig["pair"] == (GLOBAL_CONFIG["SYMBOL_A"], GLOBAL_CONFIG["SYMBOL_B"]):
                        active_pair_sig = sig
                        break

                if active_pair_sig:
                    logger.info(f"Signal detected on current active pair {S_A}/{S_B}. Executing active pair trade.")
                    best_sig = active_pair_sig
                else:
                    # Sort candidate signals by win rate descending
                    candidate_signals.sort(key=lambda x: x["win_rate"], reverse=True)
                    best_sig = candidate_signals[0]
                
                best_pair = best_sig["pair"]
                best_action = best_sig["action"]
                best_s_a, best_s_b = best_pair
                best_cat_a = get_symbol_category(best_s_a)
                best_cat_b = get_symbol_category(best_s_b)
                
                if (best_cat_a == "crypto" or is_spread_valid(best_s_a)) and (best_cat_b == "crypto" or is_spread_valid(best_s_b)):
                    
                    # Machine Learning Filter evaluation (only run if explicitly enabled via USE_ML_FILTER env var)
                    use_ml_filter = os.getenv("USE_ML_FILTER", "False").lower() in ("true", "1", "yes")
                    if ML_MODEL is not None and use_ml_filter and Z_ENTRY_THRESHOLD > 0.5:
                        now_dt = datetime.datetime.now()
                        feature_vector = [
                            float(best_sig["z_score"]),
                            float(best_sig["z_velocity"]),
                            float(best_sig["price_a"] - best_sig["price_b"] * best_sig["beta"]),
                            float(best_sig["beta"]),
                            int(now_dt.hour),
                            int(now_dt.weekday())
                        ]
                        try:
                            proba_success = float(ML_MODEL.predict_proba([feature_vector])[0][1])
                            logger.info(f"ML Filter Evaluation for {best_s_a}/{best_s_b} | Win Probability: {proba_success*100:.1f}%")
                            if proba_success < 0.65:
                                logger.info(f"ML Filter: Skipping trade because probability {proba_success*100:.1f}% is below threshold 65%")
                                continue
                        except Exception as ml_err:
                            logger.error(f"ML inference error: {ml_err}")
                            
                    logger.info(f"Scanning selected pair: {best_s_a}/{best_s_b} with max win rate {best_sig['win_rate']}% and action {best_action}")
                    
                    # Switch active pair
                    S_A, S_B = best_s_a, best_s_b
                    GLOBAL_CONFIG["SYMBOL_A"] = S_A
                    GLOBAL_CONFIG["SYMBOL_B"] = S_B
                    current_pair_context = f"{S_A}/{S_B}"
                    save_config(current_pair_context)
                    
                    # Log signal
                    signal_id = log_signal(
                        S_A, S_B, 
                        best_sig["price_a"], best_sig["price_b"], 
                        best_sig["beta"], 0.0, 
                        best_sig["z_score"], best_sig["net_obi"], 
                        best_action
                    )
                    
                    sl_dist = get_sl_distance(S_A, best_sig["price_a"], SL_PIPS)
                    sl_dist_b = get_sl_distance(S_B, best_sig["price_b"], SL_PIPS)
                    tp_dist = get_tp_distance(S_A, best_sig["price_a"], TP_PIPS)
                    
                    COOLDOWN_DIRECTIONS[current_pair_context] = best_action
                    is_long = (best_action == "BUY_SPREAD")
                    
                    if is_long:
                        if best_cat_a == "crypto":
                            usdt_bal, _ = get_binance_usdt_balance()
                            if usdt_bal <= 0:
                                usdt_bal = 100.0  # Fallback safety balance

                            if DEFAULT_LOTS > 0.0001:
                                qty_a = float(DEFAULT_LOTS)
                            else:
                                # Deploy 80% of available USDT margin balance at 20x leverage on Binance Futures
                                margin_alloc = usdt_bal * 0.80
                                notional_val = margin_alloc * 20.0
                                qty_a = float(notional_val / best_sig["price_a"])
                                
                            filters_a = get_symbol_filters(S_A)
                            if filters_a:
                                step_size = filters_a.get("stepSize", 0.001)
                                qty_prec = filters_a.get("quantityPrecision", 3)
                                qty_a = round(round(qty_a / step_size) * step_size, qty_prec)
                                if qty_a < step_size * 3.0:
                                    qty_a = step_size * 3.0
                                
                            qty_b = get_hedge_quantity(S_A, S_B, qty_a, best_sig["beta"], best_cat_a, best_cat_b)
                            
                            if execute_three_part_binance_trade(
                                S_A, True, best_sig["tick_a"].ask, best_sig["tick_a"].ask - sl_dist, qty_a,
                                best_sig["price_a"] + tp_dist * 0.5, best_sig["price_a"] + tp_dist, best_sig["price_a"] + tp_dist * 1.5,
                                signal_id=signal_id
                            ):
                                order_type_b, side_b, price_b, sl_sign_b = get_hedge_execution_parameters(best_action, best_sig["beta"], best_sig["tick_b"])
                                sl_b = price_b + sl_sign_b * sl_dist_b
                                if best_cat_b == "crypto":
                                    hedge_params = {"symbol": S_B, "side": side_b, "type": "MARKET", "quantity": qty_b}
                                    h_res = send_signed_request("POST", "/fapi/v1/order", hedge_params)
                                    if h_res and h_res.status_code == 200:
                                        avg_price_b = float(h_res.json().get("avgPrice") or price_b)
                                        log_trade_entry(h_res.json()["orderId"], S_B, side_b, qty_b, avg_price_b, datetime.datetime.now(), "Binance JS_HEDGE", signal_id)
                                        price_prec = get_symbol_filters(S_B)["pricePrecision"] if get_symbol_filters(S_B) else 2
                                        qty_prec_b = get_symbol_filters(S_B)["quantityPrecision"] if get_symbol_filters(S_B) else 3
                                        opp_side_b = "BUY" if side_b == "SELL" else "SELL"
                                        send_signed_request("POST", "/fapi/v1/algoOrder", {
                                            "algoType": "CONDITIONAL",
                                            "symbol": S_B,
                                            "side": opp_side_b,
                                            "type": "STOP_MARKET",
                                            "triggerPrice": round(sl_b, price_prec),
                                            "quantity": round(qty_b, qty_prec_b),
                                            "reduceOnly": "true"
                                        })
                                else:
                                    res_hedge = send_order(S_B, order_type_b, price_b, qty_b, sl_b, 0.0, "JS_HEDGE")
                                    if res_hedge and res_hedge.retcode == mt5.TRADE_RETCODE_DONE:
                                        log_trade_entry(res_hedge.order, S_B, side_b, qty_b, res_hedge.price, datetime.datetime.now(), "JS_HEDGE", signal_id)
                        else:
                            lots_a = DEFAULT_LOTS if DEFAULT_LOTS > 0 else calculate_lots(S_A, sl_dist, acc_info)
                            # Apply 3-part safeguard scaling correction
                            info_a_check = mt5.symbol_info(S_A)
                            min_vol_a = info_a_check.volume_min if info_a_check else 0.01
                            part_lots_a = round(lots_a / 3.0, 2)
                            if part_lots_a < min_vol_a:
                                part_lots_a = min_vol_a
                            actual_lots_a = part_lots_a * 3.0
                            
                            qty_b = get_hedge_quantity(S_A, S_B, actual_lots_a, best_sig["beta"], best_cat_a, best_cat_b)
                            
                            if execute_three_part_trade(
                                S_A, True, best_sig["tick_a"].ask, best_sig["tick_a"].ask - sl_dist, lots_a,
                                best_sig["price_a"] + tp_dist * 0.5, best_sig["price_a"] + tp_dist, best_sig["price_a"] + tp_dist * 1.5,
                                signal_id=signal_id
                            ):
                                order_type_b, side_b, price_b, sl_sign_b = get_hedge_execution_parameters(best_action, best_sig["beta"], best_sig["tick_b"])
                                sl_b = price_b + sl_sign_b * sl_dist_b
                                if best_cat_b == "crypto":
                                    hedge_params = {"symbol": S_B, "side": side_b, "type": "MARKET", "quantity": qty_b}
                                    h_res = send_signed_request("POST", "/fapi/v1/order", hedge_params)
                                    if h_res and h_res.status_code == 200:
                                        avg_price_b = float(h_res.json().get("avgPrice") or price_b)
                                        log_trade_entry(h_res.json()["orderId"], S_B, side_b, qty_b, avg_price_b, datetime.datetime.now(), "Binance JS_HEDGE", signal_id)
                                        price_prec = get_symbol_filters(S_B)["pricePrecision"] if get_symbol_filters(S_B) else 2
                                        qty_prec_b = get_symbol_filters(S_B)["quantityPrecision"] if get_symbol_filters(S_B) else 3
                                        opp_side_b = "BUY" if side_b == "SELL" else "SELL"
                                        send_signed_request("POST", "/fapi/v1/algoOrder", {
                                            "algoType": "CONDITIONAL",
                                            "symbol": S_B,
                                            "side": opp_side_b,
                                            "type": "STOP_MARKET",
                                            "triggerPrice": round(sl_b, price_prec),
                                            "quantity": round(qty_b, qty_prec_b),
                                            "reduceOnly": "true"
                                        })
                                else:
                                    res_hedge = send_order(S_B, order_type_b, price_b, qty_b, sl_b, 0.0, "JS_HEDGE")
                                    if res_hedge and res_hedge.retcode == mt5.TRADE_RETCODE_DONE:
                                        log_trade_entry(res_hedge.order, S_B, side_b, qty_b, res_hedge.price, datetime.datetime.now(), "JS_HEDGE", signal_id)
                    else:
                        if best_cat_a == "crypto":
                            usdt_bal, _ = get_binance_usdt_balance()
                            if usdt_bal <= 0:
                                usdt_bal = 100.0  # Fallback safety balance

                            if DEFAULT_LOTS > 0.0001:
                                qty_a = float(DEFAULT_LOTS)
                            else:
                                # Deploy 80% of available USDT margin balance at 20x leverage on Binance Futures
                                margin_alloc = usdt_bal * 0.80
                                notional_val = margin_alloc * 20.0
                                qty_a = float(notional_val / best_sig["price_a"])
                                
                            filters_a = get_symbol_filters(S_A)
                            if filters_a:
                                step_size = filters_a.get("stepSize", 0.001)
                                qty_prec = filters_a.get("quantityPrecision", 3)
                                qty_a = round(round(qty_a / step_size) * step_size, qty_prec)
                                if qty_a < step_size * 3.0:
                                    qty_a = step_size * 3.0
                                
                            qty_b = get_hedge_quantity(S_A, S_B, qty_a, best_sig["beta"], best_cat_a, best_cat_b)
                            
                            if execute_three_part_binance_trade(
                                S_A, False, best_sig["tick_a"].bid, best_sig["tick_a"].bid + sl_dist, qty_a,
                                max(0.0001, best_sig["price_a"] - tp_dist * 0.5), max(0.0001, best_sig["price_a"] - tp_dist), max(0.0001, best_sig["price_a"] - tp_dist * 1.5),
                                signal_id=signal_id
                            ):
                                order_type_b, side_b, price_b, sl_sign_b = get_hedge_execution_parameters(best_action, best_sig["beta"], best_sig["tick_b"])
                                sl_b = price_b + sl_sign_b * sl_dist_b
                                if best_cat_b == "crypto":
                                    hedge_params = {"symbol": S_B, "side": side_b, "type": "MARKET", "quantity": qty_b}
                                    h_res = send_signed_request("POST", "/fapi/v1/order", hedge_params)
                                    if h_res and h_res.status_code == 200:
                                        avg_price_b = float(h_res.json().get("avgPrice") or price_b)
                                        log_trade_entry(h_res.json()["orderId"], S_B, side_b, qty_b, avg_price_b, datetime.datetime.now(), "Binance JS_HEDGE", signal_id)
                                        price_prec = get_symbol_filters(S_B)["pricePrecision"] if get_symbol_filters(S_B) else 2
                                        qty_prec_b = get_symbol_filters(S_B)["quantityPrecision"] if get_symbol_filters(S_B) else 3
                                        opp_side_b = "BUY" if side_b == "SELL" else "SELL"
                                        send_signed_request("POST", "/fapi/v1/algoOrder", {
                                            "algoType": "CONDITIONAL",
                                            "symbol": S_B,
                                            "side": opp_side_b,
                                            "type": "STOP_MARKET",
                                            "triggerPrice": round(sl_b, price_prec),
                                            "quantity": round(qty_b, qty_prec_b),
                                            "reduceOnly": "true"
                                        })
                                else:
                                    res_hedge = send_order(S_B, order_type_b, price_b, qty_b, sl_b, 0.0, "JS_HEDGE")
                                    if res_hedge and res_hedge.retcode == mt5.TRADE_RETCODE_DONE:
                                        log_trade_entry(res_hedge.order, S_B, side_b, qty_b, res_hedge.price, datetime.datetime.now(), "JS_HEDGE", signal_id)
                        else:
                            lots_a = DEFAULT_LOTS if DEFAULT_LOTS > 0 else calculate_lots(S_A, sl_dist, acc_info)
                            # Apply 3-part safeguard scaling correction
                            info_a_check = mt5.symbol_info(S_A)
                            min_vol_a = info_a_check.volume_min if info_a_check else 0.01
                            part_lots_a = round(lots_a / 3.0, 2)
                            if part_lots_a < min_vol_a:
                                part_lots_a = min_vol_a
                            actual_lots_a = part_lots_a * 3.0
                            
                            qty_b = get_hedge_quantity(S_A, S_B, actual_lots_a, best_sig["beta"], best_cat_a, best_cat_b)
                            
                            if execute_three_part_trade(
                                S_A, False, best_sig["tick_a"].bid, best_sig["tick_a"].bid + sl_dist, lots_a,
                                best_sig["price_a"] - sl_dist, best_sig["price_a"] - tp_dist, best_sig["price_a"] - sl_dist * 3.5,
                                signal_id=signal_id
                            ):
                                order_type_b, side_b, price_b, sl_sign_b = get_hedge_execution_parameters(best_action, best_sig["beta"], best_sig["tick_b"])
                                sl_b = price_b + sl_sign_b * sl_dist_b
                                if best_cat_b == "crypto":
                                    hedge_params = {"symbol": S_B, "side": side_b, "type": "MARKET", "quantity": qty_b}
                                    h_res = send_signed_request("POST", "/fapi/v1/order", hedge_params)
                                    if h_res and h_res.status_code == 200:
                                        avg_price_b = float(h_res.json().get("avgPrice") or price_b)
                                        log_trade_entry(h_res.json()["orderId"], S_B, side_b, qty_b, avg_price_b, datetime.datetime.now(), "Binance JS_HEDGE", signal_id)
                                        price_prec = get_symbol_filters(S_B)["pricePrecision"] if get_symbol_filters(S_B) else 2
                                        opp_side_b = "BUY" if side_b == "SELL" else "SELL"
                                        send_signed_request("POST", "/fapi/v1/order", {"symbol": S_B, "side": opp_side_b, "type": "STOP_MARKET", "stopPrice": round(sl_b, price_prec), "closePosition": "true", "timeInForce": "GTC"})
                                else:
                                    res_hedge = send_order(S_B, order_type_b, price_b, qty_b, sl_b, 0.0, "JS_HEDGE")
                                    if res_hedge and res_hedge.retcode == mt5.TRADE_RETCODE_DONE:
                                        log_trade_entry(res_hedge.order, S_B, side_b, qty_b, res_hedge.price, datetime.datetime.now(), "JS_HEDGE", signal_id)
                    invalidate_trades_cache()

            # Trail Stop Loss if active
            best_cat_a_check = get_symbol_category(S_A)
            if best_cat_a_check != "crypto" and len(active_js_positions) > 0:
                leg_a_parts = [p for p in active_js_positions if p.symbol == S_A]
                comments = [p.comment for p in leg_a_parts]
                if not any("JS_TP1" in c for c in comments) and leg_a_parts:
                    modify_sl_for_trade(S_A, leg_a_parts[0].price_open)

            # Sync all active Binance Futures positions to DB so Dashboard matches Binance 100%
            try:
                from binance_execution import sync_all_binance_open_positions_to_db
                sync_all_binance_open_positions_to_db()
            except Exception as sync_ex:
                logger.error(f"Error calling sync_all_binance_open_positions_to_db: {sync_ex}")

            # Update dashboard status
            if is_news_halted:
                status_str = f"HALTED ({news_msg})"
            elif low_correlation_warning:
                status_str = "RUNNING (Warning: Low Correlation)"
            else:
                status_str = "RUNNING (Active)" if AUTO_EXECUTE else "RUNNING (Signals Only)"
            
            update_bot_state(
                active_pair=current_pair_context,
                system_status=status_str,
                equity=current_equity,
                drawdown_percent=daily_loss_p,
                floating_profit=floating_profit,
                z_score=active_pair_z_score,
                hedge_ratio=active_pair_beta,
                obi_a=active_pair_obi_a,
                obi_b=active_pair_obi_b,
                trades_today=trades_today,
                sl_pips=SL_PIPS,
            )

            update_daily_metrics(
                datetime.date.today(),
                start_equity=daily_start_equity,
                current_equity=current_equity,
                max_dd=daily_loss_p,
                trades_count=trades_today,
            )

            if loop_log_counter % 15 == 0:
                try:
                    summary_parts = []
                    conn_scan = get_connection()
                    cur_scan = conn_scan.cursor()
                    cur_scan.execute("SELECT symbol_pair, z_score FROM scanned_assets ORDER BY symbol_pair")
                    scanned_rows = cur_scan.fetchall()
                    cur_scan.close()
                    conn_scan.close()
                    for pair_name, z_val in scanned_rows:
                        summary_parts.append(f"{pair_name}: {float(z_val):.2f}")
                    scan_summary_str = " | ".join(summary_parts) if summary_parts else "Scanning..."
                    logger.info(f"[LIVE SCAN SUMMARY] {scan_summary_str}")
                except Exception as ex_sum:
                    logger.error(f"Error compiling scan summary log: {ex_sum}")

                smc_str = f"SMC: [{'ENABLED' if REQUIRE_SMC_CONFLUENCE else 'OFF'}]"
                obi_str = f"OBI: [{'ENABLED' if OBI_ENABLED else 'OFF'}] ({active_pair_obi_a:.1f}/{active_pair_obi_b:.1f})"
                logger.info(
                    f"[LIVE SCAN DETAIL] Active Focus: {current_pair_context} | Z-Score: {active_pair_z_score:.3f} "
                    f"| Z-Vel: {active_pair_velocity:.3f} | {smc_str} | {obi_str} "
                    f"| Status: {status_str}"
                )
            loop_log_counter += 1

        except Exception as loop_err:
            logger.error(f"Error in main run loop: {loop_err}")

        time.sleep(LOOP_INTERVAL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    finally:
        shutdown_mt5()
