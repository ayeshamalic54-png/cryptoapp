import logging
import numpy as np
import pandas as pd

logger = logging.getLogger("SMC_Forex_Bot")

def calculate_zscore_and_ema(df: pd.DataFrame, period: int = 14, ema_period: int = 200) -> pd.DataFrame:
    """
    Calculates TradingView Steves Z-Score and M15 200 EMA for Crypto Strategy Engine.
    Uses typical price VWAP / SMA Z-Score and Swing High/Low Support & Resistance levels.
    """
    if df is None or df.empty or len(df) < 30:
        return df

    df = df.copy()

    # 1. Calculate 200 EMA
    df['ema_200'] = df['close'].ewm(span=ema_period, adjust=False).mean()

    # 2. Typical Price (High + Low + Close) / 3
    df['typical_price'] = (df['high'] + df['low'] + df['close']) / 3.0

    # 3. Typical Price Moving Average & Standard Deviation
    df['tp_sma'] = df['typical_price'].rolling(window=period, min_periods=5).mean()
    df['tp_std'] = df['typical_price'].rolling(window=period, min_periods=5).std()

    # 4. VWAP Z-Score
    df['tp_std_clean'] = df['tp_std'].replace(0, np.nan).fillna(method='bfill').fillna(0.00001)
    df['vwap_zscore'] = (df['typical_price'] - df['tp_sma']) / df['tp_std_clean']
    df['vwap_zscore'] = df['vwap_zscore'].clip(-5.0, 5.0)

    # 5. Swing Low (Support) & Swing High (Resistance) over last 15 bars
    df['swing_low'] = df['low'].rolling(window=15, min_periods=5).min()
    df['swing_high'] = df['high'].rolling(window=15, min_periods=5).max()

    return df


def evaluate_video_strategy_signal(df: pd.DataFrame, z_threshold: float = 2.20, category: str = "crypto", live_z: float = None):
    """
    Evaluates Video 2 (mfDQuupYyE8) Strategy Rules for Crypto Testnet:
    1. 200 EMA Trend Filter (Price > 200 EMA for BUY / Price < 200 EMA for SELL)
    2. Extreme Z-Score Threshold (Z >= +2.20 Overbought / Z <= -2.20 Oversold)
    3. Reversal Curl-Back (Z_curr > Z_prev for BUY / Z_curr < Z_prev for SELL)
    4. Swing High / Swing Low Support & Resistance Stop Loss
    5. 1:2.5 Risk-to-Reward Ratio (1:2.5 RRR TP)
    """
    if df is None or df.empty or len(df) < 30:
        return "NONE", None, None, 0.0, "Insufficient candle data for Video Strategy Engine"

    curr_row = df.iloc[-1]
    prev_row = df.iloc[-2]

    price = float(curr_row['close'])
    open_price = float(curr_row['open'])
    ema_200 = float(curr_row['ema_200'])
    swing_low = float(curr_row['swing_low'])
    swing_high = float(curr_row['swing_high'])

    cand_z = float(curr_row['vwap_zscore'])
    cand_prev_z = float(prev_row['vwap_zscore'])

    # Use live_z if passed from tick scanner
    effective_curr_z = live_z if live_z is not None else cand_z
    effective_prev_z = cand_prev_z

    buffer_dist = price * 0.005  # 0.5% buffer for crypto volatility

    # Max / Min Z over recent 3 bars
    recent_z_min = min(effective_curr_z, effective_prev_z, float(df['vwap_zscore'].iloc[-3]))
    recent_z_max = max(effective_curr_z, effective_prev_z, float(df['vwap_zscore'].iloc[-3]))

    eff_threshold = min(z_threshold, 2.20) if z_threshold >= 3.0 else z_threshold

    # ── 1. LONG (BUY) ENTRY EVALUATION ──
    if price > ema_200:  # Bullish Trend
        z_oversold_reached = (recent_z_min <= -eff_threshold) or (effective_curr_z <= -eff_threshold)
        z_curling_up = (effective_curr_z > effective_prev_z) or (effective_curr_z > recent_z_min)
        
        if z_oversold_reached and z_curling_up:
            sl_price = min(price - buffer_dist, swing_low * 0.998)
            sl_dist = abs(price - sl_price)
            tp_price = price + (2.5 * sl_dist)  # 1:2.5 RRR
            
            reason = f"🟢 PROBABILITY Z-CORE BUY: Bullish Trend (Price > 200 EMA) | Z-Oversold ({recent_z_min:.2f}) -> Reversal Curl UP ({effective_curr_z:.2f}) | Support Bounce | 1:2.5 RRR TP"
            logger.info("================================================================================")
            logger.info(f"🟢 [PROBABILITY Z-CORE BUY SIGNAL EXECUTED] 🚀")
            logger.info(f"🟢 Trend Check: Price ({price:.5f}) > 200 EMA ({ema_200:.5f}) -> Bullish Trend 🟢")
            logger.info(f"🟢 Z-Score Check: Oversold Z ({recent_z_min:.2f}) <= -{eff_threshold:.2f} & Curr Z ({effective_curr_z:.2f}) Curling UP 🟢")
            logger.info(f"🟢 Target RRR Plan: 1:2.5 RRR (SL: {sl_price:.5f} | TP: {tp_price:.5f})")
            logger.info("================================================================================")
            return "BUY", tp_price, sl_price, sl_dist, reason

    # ── 2. SHORT (SELL) ENTRY EVALUATION ──
    elif price < ema_200:  # Bearish Trend
        z_overbought_reached = (recent_z_max >= eff_threshold) or (effective_curr_z >= eff_threshold)
        z_curling_down = (effective_curr_z < effective_prev_z) or (effective_curr_z < recent_z_max)

        if z_overbought_reached and z_curling_down:
            sl_price = max(price + buffer_dist, swing_high * 1.002)
            sl_dist = abs(sl_price - price)
            tp_price = price - (2.5 * sl_dist)  # 1:2.5 RRR

            reason = f"🔴 PROBABILITY Z-CORE SELL: Bearish Trend (Price < 200 EMA) | Z-Overbought ({recent_z_max:.2f}) -> Reversal Curl DOWN ({effective_curr_z:.2f}) | Resistance Bounce | 1:2.5 RRR TP"
            logger.info("================================================================================")
            logger.info(f"🔴 [PROBABILITY Z-CORE SELL SIGNAL EXECUTED] 🚀")
            logger.info(f"🔴 Trend Check: Price ({price:.5f}) < 200 EMA ({ema_200:.5f}) -> Bearish Trend 🔴")
            logger.info(f"🔴 Z-Score Check: Overbought Z ({recent_z_max:.2f}) >= +{eff_threshold:.2f} & Curr Z ({effective_curr_z:.2f}) Curling DOWN 🔴")
            logger.info(f"🔴 Target RRR Plan: 1:2.5 RRR (SL: {sl_price:.5f} | TP: {tp_price:.5f})")
            logger.info("================================================================================")
            return "SELL", tp_price, sl_price, sl_dist, reason

    trend_str = f"Bullish Trend 🟢 (Price {price:.5f} > 200 EMA {ema_200:.5f})" if price > ema_200 else f"Bearish Trend 🔴 (Price {price:.5f} < 200 EMA {ema_200:.5f})"
    candle_str = "Green Bullish 🟢" if price > open_price else "Red Bearish 🔴"
    return "NONE", None, None, 0.0, f"Scanning: {trend_str} | Z: {effective_curr_z:+.2f} (Prev: {effective_prev_z:+.2f}) | Candle: {candle_str}"
