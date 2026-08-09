import sys
from types import ModuleType

# Mock MetaTrader5 module to prevent ImportError on VPS
class MockMT5(ModuleType):
    pass

mock_mt5 = MockMT5("MetaTrader5")
mock_mt5.initialize = lambda *args, **kwargs: True
mock_mt5.shutdown = lambda: None
mock_mt5.last_error = lambda: (0, "No error")

sys.modules["MetaTrader5"] = mock_mt5
import MetaTrader5 as mt5

import datetime
import logging
import time
from database import update_daily_metrics, get_connection
from data_ingestion import get_live_ticks
from binance_execution import (
    calculate_binance_quantity,
    get_symbol_filters
)

logger = logging.getLogger("SMC_Forex_Bot")

# Maximum daily drawdown allowed before halting trading (e.g. 4.2% to safely stay below prop firm 5%)
MAX_DAILY_LOSS_PERCENT = 4.2
# Maximum number of trades allowed per day
MAX_DAILY_TRADES = 3
# Risk percentage per trade (e.g. 1.0% of account equity)
RISK_PERCENT = 1.0

_cached_start_equity = None
_cached_start_equity_date = None

_cached_trades_count = None
_cached_trades_count_date = None
_cached_last_login = None

_last_metrics_update_time = 0

def invalidate_trades_cache():
    global _cached_trades_count
    _cached_trades_count = None

def increment_trades_count():
    global _cached_trades_count
    if _cached_trades_count is not None:
        _cached_trades_count += 1

def get_broker_today_date():
    """
    Returns today's date in UTC/local timezone for Binance.
    """
    return datetime.date.today()

def get_active_account_login():
    """
    Returns the active connected account login ID from bot_state.
    Defaults to 888888 if not specified.
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("SELECT mt5_login FROM bot_state WHERE id = 1")
        row = cur.fetchone()
        if row and row[0] is not None and int(row[0]) > 0:
            return int(row[0])
    except Exception:
        pass
    finally:
        if conn:
            conn.close()
    return 888888

def get_or_create_daily_start_equity(current_equity):
    """
    Retrieves the starting equity for the current day from the database.
    If it doesn't exist or if account metrics were reset, initializes it with current/reset equity.
    """
    global _cached_start_equity, _cached_start_equity_date, _cached_last_login
    today = get_broker_today_date()
    
    current_login = get_active_account_login()
        
    if _cached_last_login is not None and _cached_last_login != current_login:
        logger.info(f"Safeguards: Account switch detected. Resetting daily start equity cache to ${current_equity:.2f} for account {current_login}")
        _cached_start_equity = None
        _cached_start_equity_date = None
        
    _cached_last_login = current_login
    
    # If cached start_equity is significantly lower than current_equity (e.g. balance reset or updated live balance), invalidate cache
    if _cached_start_equity is not None and current_equity > _cached_start_equity * 1.05:
        _cached_start_equity = None

    if _cached_start_equity is not None and _cached_start_equity_date == today:
        return _cached_start_equity
        
    conn = None
    start_equity = current_equity
    
    try:
        conn = get_connection()
        cur = conn.cursor()
        
        # Fetch current initial_balance from bot_state
        cur.execute("SELECT initial_balance, mt5_login FROM bot_state WHERE id = 1")
        state_row = cur.fetchone()
        db_initial_balance = None
        if state_row and state_row[0] is not None:
            db_initial_balance = float(state_row[0])
            if state_row[1] is not None and int(state_row[1]) > 0:
                current_login = int(state_row[1])
                _cached_last_login = current_login
        
        # Check if we already have a record for today and this specific login
        cur.execute("SELECT start_equity FROM daily_metrics WHERE trading_date = %s AND mt5_login = %s", (today, current_login))
        row = cur.fetchone()
            
        if row:
            start_equity = float(row[0])
            # If start_equity is lower than db_initial_balance or current_equity after account reset, sync start_equity!
            if db_initial_balance is not None and (abs(start_equity - db_initial_balance) > 0.01 or current_equity > start_equity * 1.05):
                start_equity = max(db_initial_balance, current_equity)
                cur.execute(
                    "UPDATE daily_metrics SET start_equity = %s, max_drawdown_percent = 0.00 WHERE trading_date = %s AND mt5_login = %s",
                    (start_equity, today, current_login)
                )
                conn.commit()
                
            logger.info(f"Retrieved saved daily starting equity for account {current_login} from database: ${start_equity:.2f}")
            
            # Update current equity for today
            cur.execute(
                "UPDATE daily_metrics SET current_equity = %s WHERE trading_date = %s AND mt5_login = %s",
                (current_equity, today, current_login)
            )
            cur.execute(
                "UPDATE bot_state SET initial_balance = %s, max_equity_peak = CASE WHEN max_equity_peak > %s * 2.0 THEN %s ELSE max_equity_peak END, mt5_login = %s, equity = %s WHERE id = 1",
                (start_equity, start_equity, start_equity, current_login, current_equity)
            )
            conn.commit()
        else:
            # Create a new record for today for this specific login
            start_equity = db_initial_balance if (db_initial_balance is not None and db_initial_balance > 0) else current_equity
            cur.execute(
                """
                INSERT INTO daily_metrics (trading_date, mt5_login, start_equity, current_equity, max_drawdown_percent, trades_today)
                VALUES (%s, %s, %s, %s, 0.0, 0)
                ON CONFLICT (trading_date, mt5_login) DO UPDATE
                SET start_equity = EXCLUDED.start_equity,
                    current_equity = EXCLUDED.current_equity,
                    max_drawdown_percent = 0.0
                """,
                (today, current_login, start_equity, current_equity)
            )
            cur.execute(
                "UPDATE bot_state SET initial_balance = %s, max_equity_peak = CASE WHEN max_equity_peak > %s * 2.0 THEN %s ELSE max_equity_peak END, mt5_login = %s, equity = %s WHERE id = 1",
                (start_equity, start_equity, start_equity, current_login, current_equity)
            )
            conn.commit()
            logger.info(f"Initialized new daily trading session for account {current_login}. Starting equity: ${start_equity:.2f}")
            
        cur.close()
        _cached_start_equity = start_equity
        _cached_start_equity_date = today
    except Exception as e:
        logger.error(f"Error in get_or_create_daily_start_equity: {e}")
    finally:
        if conn:
            conn.close()
            
    return start_equity

def check_drawdown_limit(current_equity):
    """
    Checks if the daily drawdown limit has been breached.
    Returns: (is_breached, daily_loss_percent)
    """
    global _last_metrics_update_time
    start_equity = get_or_create_daily_start_equity(current_equity)
    
    current_login = 0
    
    daily_loss = start_equity - current_equity
    daily_loss_percent = (daily_loss / start_equity) * 100.0 if start_equity > 0 else 0.0
    
    today = get_broker_today_date()
    trades_today = get_trades_count_today()
    
    # Throttle metrics database writes to once every 30 seconds
    now = time.time()
    if now - _last_metrics_update_time >= 30.0:
        try:
            update_daily_metrics(today, start_equity, current_equity, max(0.0, daily_loss_percent), trades_today, login_id=current_login)
            _last_metrics_update_time = now
        except Exception as e:
            logger.error(f"Error updating daily metrics: {e}")
    
    if daily_loss_percent >= MAX_DAILY_LOSS_PERCENT:
        logger.info(f"DAILY LIMIT BREACHED: Drawdown is {daily_loss_percent:.2f}% (Limit: {MAX_DAILY_LOSS_PERCENT}%)")
        return True, daily_loss_percent
        
    return False, daily_loss_percent

def get_trades_count_today():
    """Returns the number of trades taken today with caching."""
    global _cached_trades_count, _cached_trades_count_date
    today = get_broker_today_date()
    
    if _cached_trades_count is not None and _cached_trades_count_date == today:
        return _cached_trades_count
        
    conn = None
    count = 0
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM trades WHERE CAST(entry_time AS DATE) = %s AND (comment LIKE '%%TP1%%' OR comment LIKE '%%Manual%%' OR comment LIKE '%%MANUAL%%')",
            (today,)
        )
        count = cur.fetchone()[0]
        cur.close()
        
        _cached_trades_count = count
        _cached_trades_count_date = today
    except Exception as e:
        logger.error(f"Error fetching trades count: {e}")
    finally:
        if conn:
            conn.close()
    return count

def round_volume(symbol, volume):
    """Rounds trade volume to Binance symbol step and precision."""
    filters = get_symbol_filters(symbol)
    if not filters:
        return round(volume, 3)
    step = filters["stepSize"]
    
    rounded = round(round(volume / step) * step, filters["quantityPrecision"])
    return rounded

def calculate_lots(symbol, sl_distance_price, acc_info):
    """
    Calculates lot size based on a fixed risk percentage of account equity.
    sl_distance_price: Absolute price difference between entry and stop loss
    """
    return calculate_binance_quantity(symbol, sl_distance_price, acc_info.equity, RISK_PERCENT)

def is_spread_valid(symbol):
    """Returns True if the current market spread is below the threshold."""
    tick = get_live_ticks(symbol)
    if tick is None:
        return False
        
    spread = tick.ask - tick.bid
    price = (tick.bid + tick.ask) / 2.0
    
    # Check if the spread is wider than 0.2% of mid price
    spread_pct = (spread / price) * 100.0
    if spread_pct > 0.2:
        logger.warning(f"Spread for {symbol} is too wide: {spread_pct:.3f}% (Max: 0.2%)")
        return False
        
    return True
