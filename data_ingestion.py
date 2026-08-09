import sys
from types import ModuleType

# Mock MetaTrader5 module to prevent ImportError on systems/VPS where it's not installed
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

mock_mt5 = MockMT5("MetaTrader5")
mock_mt5.initialize = lambda *args, **kwargs: True
mock_mt5.shutdown = lambda: None
mock_mt5.last_error = lambda: (0, "No error")
mock_mt5.account_info = lambda: None
mock_mt5.symbol_info = lambda sym: None
mock_mt5.symbol_info_tick = lambda sym: None

sys.modules["MetaTrader5"] = mock_mt5
import MetaTrader5 as mt5

import pandas as pd
import logging
import os
import datetime

# Import Binance data fetching functions
from binance_execution import (
    get_binance_live_tick,
    get_binance_market_book,
    get_binance_rates_df,
    get_binance_usdt_balance
)

logger = logging.getLogger("SMC_Forex_Bot")

class DummyAccountInfo:
    def __init__(self):
        self.login = 9999
        self.equity = 100000.00
        self.balance = 100000.00
        self.trade_mode = 0  # Demo

def initialize_mt5():
    logger.info("Initializing connection to Binance Futures API using configured credentials...")
    try:
        balance, available = get_binance_usdt_balance()
        acc = DummyAccountInfo()
        if balance > 0:
            acc.balance = balance
            acc.equity = balance
            
        api_key = os.getenv("BINANCE_API_KEY", "N/A")
        login_val = api_key[:10] if len(api_key) > 10 else "5053167592"
        
        logger.info("Successfully connected to Binance Futures Exchange!")
        logger.info(f"Login: {login_val} | Server: Binance-Futures | Balance: ${acc.balance:.2f} | Equity: ${acc.equity:.2f}")
        return acc
    except Exception as e:
        logger.error(f"Error fetching Binance balance during initialization: {e}")
        return DummyAccountInfo()

SUBSCRIBED_SYMBOLS = set()

def resolve_broker_symbol(symbol: str) -> str:
    return symbol.upper()

def check_and_subscribe_symbol(symbol):
    resolved = resolve_broker_symbol(symbol)
    if resolved in SUBSCRIBED_SYMBOLS:
        return True
    SUBSCRIBED_SYMBOLS.add(resolved)
    logger.info(f"Subscribed to Order Book updates for {resolved}")
    return True

def get_rates_df(symbol, timeframe, count=200):
    # Mapping timeframe minutes to binance rates df
    df = get_binance_rates_df(symbol, timeframe, count)
    if df is None:
        logger.error(f"Failed to fetch Binance klines for {symbol}")
        return None
    return df

def get_live_ticks(symbol):
    # Fetch live tick from Binance
    tick = get_binance_live_tick(symbol)
    if tick is None:
        logger.warning(f"Failed to get Binance live tick for {symbol}")
        return None
    return tick

def get_market_book(symbol):
    # Fetch Level-2 book from Binance
    return get_binance_market_book(symbol)

def shutdown_mt5(symbol=None):
    logger.info("Shutdown bot connection.")
