"""
Pure Smart Money Concepts (SMC) & ICT Institutional Price Action Detectors
Calibrated for Crypto USDT-M Perpetual Futures across ALL price scales
($0.00001 meme coins, $0.30 altcoins, $150 SOL, $3000 ETH, $95,000+ BTC).
Zero Forex hardcoded pip/dollar constants; zero Z-score or lagging oscillators.
"""
import numpy as np
import pandas as pd


def _calc_crypto_scale(df: pd.DataFrame) -> dict:
    """
    Derives percentage-normalized structural thresholds from the coin's recent close price.
    Ensures identical SMC behavior whether price is $95,000 (BTCUSDT) or $0.25 (DOGEUSDT).
    """
    if df is None or len(df) == 0:
        ref = 100.0
    else:
        ref = float(df["close"].iloc[-1])
        if not np.isfinite(ref) or ref <= 0:
            ref = 100.0

    return {
        "ref_price": ref,
        "m15_min_amp": ref * 0.0022,        # 0.22% structural M15 swing amplitude
        "m15_target_min_amp": ref * 0.0014, # 0.14% opposing target swing amplitude
        "m5_min_amp": ref * 0.0006,         # 0.06% M5 swing amplitude
        "min_struct_depth": ref * 0.0008,   # 0.08% minimum prior swing leg depth
        "min_penetration": ref * 0.00015,   # 0.015% minimum wick sweep penetration
        "reclaim_max_dip": ref * 0.0006,    # 0.06% max 1-bar overshoot before bar-2 reclaim
        "min_gap": ref * 0.00035,           # 0.035% minimum 3-candle FVG gap
        "mit_tol": ref * 0.00010,           # 0.01% close mitigation tolerance
        "max_dist": ref * 0.030,            # 3.0% chart visibility & proximity radius
        "min_ob_disp": ref * 0.0006,        # 0.06% minimum OB displacement body
        "sweep_margin": ref * 0.0004,       # 0.04% sweep origin FVG tolerance
        "wick_buf": ref * 0.0004,           # 0.04% FVG retest wick tolerance
        "close_tol": ref * 0.00015,         # 0.015% FVG retest close tolerance
        "sl_buf": ref * 0.0008,             # 0.08% safety buffer behind sweep wick
        "front_run_buf": ref * 0.0006,      # 0.06% front-run buffer before opposing M15 pool
        "target_min_move": ref * 0.0012,    # 0.12% minimum target travel
        "max_chase_dist": ref * 0.0035,     # 0.35% max entry chase past FVG boundary
    }


def get_swing_points(df: pd.DataFrame, n_left: int = 3, n_right: int = 3, min_amplitude: float = 0.0):
    """
    Identifies fractal Swing Highs & Swing Lows strictly with left & right confirmation.
    """
    if df is None or len(df) < (n_left + n_right + 1):
        return [], []

    highs = df["high"].values
    lows = df["low"].values
    n = len(df)

    swing_highs = []
    swing_lows = []

    for i in range(n_left, n - n_right):
        curr_h = highs[i]
        curr_l = lows[i]

        is_sh = True
        is_sl = True

        for j in range(1, n_left + 1):
            if curr_h <= highs[i - j]:
                is_sh = False
            if curr_l >= lows[i - j]:
                is_sl = False

        for j in range(1, n_right + 1):
            if curr_h <= highs[i + j]:
                is_sh = False
            if curr_l >= lows[i + j]:
                is_sl = False

        if is_sh and min_amplitude > 0.0:
            base_l = float(np.min(lows[max(0, i - n_left): min(n, i + n_right + 1)]))
            if (curr_h - base_l) < min_amplitude:
                is_sh = False

        if is_sh:
            swing_highs.append((float(curr_h), int(i)))

        if is_sl and min_amplitude > 0.0:
            base_h = float(np.max(highs[max(0, i - n_left): min(n, i + n_right + 1)]))
            if (base_h - curr_l) < min_amplitude:
                is_sl = False

        if is_sl:
            swing_lows.append((float(curr_l), int(i)))

    return swing_highs, swing_lows


def detect_market_structure(df_m15: pd.DataFrame, min_amp: float = None) -> str:
    """
    Step 1: Determine M15 Higher-Timeframe Market Structure Bias (BULLISH / BEARISH / NEUTRAL).
    Percentage-scaled to coin price with adaptive swing cascade.
    """
    if df_m15 is None or len(df_m15) < 5:
        return "NEUTRAL"

    scale = _calc_crypto_scale(df_m15)
    amp = float(min_amp) if min_amp is not None else scale["m15_min_amp"]

    sh, sl = get_swing_points(df_m15, n_left=3, n_right=3, min_amplitude=amp)
    if len(sh) < 2 or len(sl) < 2:
        sh, sl = get_swing_points(df_m15, n_left=2, n_right=2, min_amplitude=amp * 0.65)
    if len(sh) < 2 or len(sl) < 2:
        sh, sl = get_swing_points(df_m15, n_left=2, n_right=2, min_amplitude=0.0)
    if len(sh) < 2 or len(sl) < 2:
        return "NEUTRAL"

    has_hh = sh[-1][0] > sh[-2][0]
    has_hl = sl[-1][0] > sl[-2][0]
    has_lh = sh[-1][0] < sh[-2][0]
    has_ll = sl[-1][0] < sl[-2][0]

    closes = df_m15["close"].values
    curr_close = float(closes[-1])

    last_sh_val, last_sh_idx = sh[-1]
    last_sl_val, last_sl_idx = sl[-1]

    last_bull_bos_idx = -1
    for k in range(last_sh_idx + 1, len(closes)):
        if closes[k] > last_sh_val:
            last_bull_bos_idx = k

    last_bear_bos_idx = -1
    for k in range(last_sl_idx + 1, len(closes)):
        if closes[k] < last_sl_val:
            last_bear_bos_idx = k

    recent_sh = [p[0] for p in sh[-2:]]
    recent_sl = [p[0] for p in sl[-2:]]
    key_res = max(recent_sh)
    key_sup = min(recent_sl)

    if has_hh and has_hl:
        if last_bear_bos_idx > last_bull_bos_idx and curr_close < last_sl_val:
            return "BEARISH"
        return "BULLISH"
    if has_lh and has_ll:
        if last_bull_bos_idx > last_bear_bos_idx and curr_close > last_sh_val:
            return "BULLISH"
        return "BEARISH"
    if has_ll:
        return "BULLISH" if curr_close > key_res else "BEARISH"
    if has_hh:
        return "BEARISH" if curr_close < key_sup else "BULLISH"
    if has_lh and has_hl:
        if last_bear_bos_idx > last_bull_bos_idx:
            return "BEARISH"
        if last_bull_bos_idx > last_bear_bos_idx:
            return "BULLISH"
        return "NEUTRAL"
    if has_hl and not has_ll:
        return "BULLISH"
    if has_lh and not has_hh:
        return "BEARISH"
    return "NEUTRAL"


def detect_liquidity_sweep(df_m5: pd.DataFrame, min_amp: float = None):
    """
    Step 2: M5 Liquidity Sweep Detection (Sell-Side Sweep -> LONG setup; Buy-Side Sweep -> SHORT setup).
    Evaluates strictly on provided closed M5 slice so zero forming-bar fake sweeps pass.
    """
    empty = (False, 0.0, 0.0, -1)
    if df_m5 is None or len(df_m5) < 10:
        return {"sell_sweep": empty, "buy_sweep": empty}

    scale = _calc_crypto_scale(df_m5)
    amp = float(min_amp) if min_amp is not None else scale["m5_min_amp"]
    min_depth = scale["min_struct_depth"]
    min_pen = scale["min_penetration"]
    reclaim_dip = scale["reclaim_max_dip"]

    swing_highs, swing_lows = get_swing_points(df_m5, n_left=3, n_right=3, min_amplitude=amp)
    if len(swing_highs) < 2 or len(swing_lows) < 2:
        swing_highs, swing_lows = get_swing_points(df_m5, n_left=2, n_right=2, min_amplitude=amp)
    if not swing_highs or not swing_lows:
        swing_highs, swing_lows = get_swing_points(df_m5, n_left=2, n_right=2, min_amplitude=0.0)
    if not swing_highs or not swing_lows:
        return {"sell_sweep": empty, "buy_sweep": empty}

    highs = df_m5["high"].values
    lows = df_m5["low"].values
    closes = df_m5["close"].values
    n = len(df_m5)
    lookback_start = max(1, n - 18)

    # 1. Sell-side liquidity sweep (wick pokes below swing low, reclaims above)
    sell_sweep = empty
    for i in range(n - 1, lookback_start - 1, -1):
        for sl_val, sl_idx in reversed(swing_lows):
            if i <= sl_idx + 1:
                continue
            prior_peak = float(np.max(highs[max(0, sl_idx - 6): sl_idx + 1]))
            if (prior_peak - sl_val) < min_depth:
                continue
            if closes[i - 1] < sl_val:
                continue

            one_bar = (sl_val - lows[i] >= min_pen) and (closes[i] >= sl_val)
            two_bar = (
                (i + 1 < n)
                and (sl_val - lows[i] >= min_pen)
                and (closes[i] >= sl_val - reclaim_dip)
                and (closes[i + 1] >= sl_val)
            )
            if one_bar or two_bar:
                sweep_low = float(min(lows[i], lows[i + 1]) if two_bar else lows[i])
                sweep_end = (i + 1) if two_bar else i
                prior_lower = any(lows[k] < sweep_low for k in range(max(sl_idx + 1, i - 3), i))
                subsequent_break = any(closes[k] < sweep_low for k in range(sweep_end + 1, n))
                if not prior_lower and not subsequent_break:
                    sell_sweep = (True, sweep_low, float(sl_val), int(i))
                    break
        if sell_sweep[0]:
            break

    # 2. Buy-side liquidity sweep (wick pokes above swing high, reclaims below)
    buy_sweep = empty
    for i in range(n - 1, lookback_start - 1, -1):
        for sh_val, sh_idx in reversed(swing_highs):
            if i <= sh_idx + 1:
                continue
            prior_trough = float(np.min(lows[max(0, sh_idx - 6): sh_idx + 1]))
            if (sh_val - prior_trough) < min_depth:
                continue
            if closes[i - 1] > sh_val:
                continue

            one_bar = (highs[i] - sh_val >= min_pen) and (closes[i] <= sh_val)
            two_bar = (
                (i + 1 < n)
                and (highs[i] - sh_val >= min_pen)
                and (closes[i] <= sh_val + reclaim_dip)
                and (closes[i + 1] <= sh_val)
            )
            if one_bar or two_bar:
                sweep_high = float(max(highs[i], highs[i + 1]) if two_bar else highs[i])
                sweep_end = (i + 1) if two_bar else i
                prior_higher = any(highs[k] > sweep_high for k in range(max(sh_idx + 1, i - 3), i))
                subsequent_break = any(closes[k] > sweep_high for k in range(sweep_end + 1, n))
                if not prior_higher and not subsequent_break:
                    buy_sweep = (True, sweep_high, float(sh_val), int(i))
                    break
        if buy_sweep[0]:
            break

    return {"sell_sweep": sell_sweep, "buy_sweep": buy_sweep}


def detect_choch_bos(df_m5: pd.DataFrame, sweep_idx: int, is_bullish: bool):
    """
    Step 3: Change of Character (CHoCH) / Break of Structure (BOS) by candle CLOSE after sweep_idx.
    """
    if df_m5 is None or sweep_idx < 0 or sweep_idx >= len(df_m5):
        return (False, 0.0, -1)

    swing_highs, swing_lows = get_swing_points(df_m5, n_left=2, n_right=2, min_amplitude=0.0)
    highs = df_m5["high"].values
    lows = df_m5["low"].values
    closes = df_m5["close"].values
    n = len(df_m5)

    if is_bullish:
        prior_highs = [p for p in swing_highs if p[1] < sweep_idx]
        if prior_highs:
            choch_lvl = float(prior_highs[-1][0])
        else:
            win = highs[max(0, sweep_idx - 6): sweep_idx]
            choch_lvl = float(np.max(win)) if len(win) > 0 else 0.0
        if choch_lvl <= 0:
            return (False, 0.0, -1)
        for j in range(sweep_idx + 1, n):
            if closes[j] > choch_lvl:
                return (True, choch_lvl, int(j))
    else:
        prior_lows = [p for p in swing_lows if p[1] < sweep_idx]
        if prior_lows:
            choch_lvl = float(prior_lows[-1][0])
        else:
            win = lows[max(0, sweep_idx - 6): sweep_idx]
            choch_lvl = float(np.min(win)) if len(win) > 0 else 0.0
        if choch_lvl <= 0:
            return (False, 0.0, -1)
        for j in range(sweep_idx + 1, n):
            if closes[j] < choch_lvl:
                return (True, choch_lvl, int(j))

    return (False, 0.0, -1)


def detect_order_blocks(df: pd.DataFrame, min_displacement: float = None, max_dist: float = None):
    """
    Detects unmitigated institutional Order Blocks (OB) & invalidated Breaker Blocks.
    """
    if df is None or len(df) < 10:
        return {"bullish_ob": [], "bearish_ob": [], "bullish_breaker": [], "bearish_breaker": []}

    scale = _calc_crypto_scale(df)
    m_disp = float(min_displacement) if min_displacement is not None else scale["min_ob_disp"]
    m_dist = float(max_dist) if max_dist is not None else scale["max_dist"]

    highs = df["high"].values
    lows = df["low"].values
    opens = df["open"].values
    closes = df["close"].values
    last_price = float(closes[-1])
    n = len(df)

    raw_bull = []
    raw_bear = []

    for i in range(2, n - 1):
        disp = abs(closes[i] - opens[i])
        if disp < m_disp:
            continue
        # Bullish OB: last red candle before strong green break above i-2 high
        if closes[i - 1] < opens[i - 1] and closes[i] > highs[i - 2]:
            ob_l, ob_h = float(lows[i - 1]), float(highs[i - 1])
            if abs((ob_l + ob_h) * 0.5 - last_price) <= m_dist:
                raw_bull.append((ob_l, ob_h, i))
        # Bearish OB: last green candle before strong red break below i-2 low
        elif closes[i - 1] > opens[i - 1] and closes[i] < lows[i - 2]:
            ob_l, ob_h = float(lows[i - 1]), float(highs[i - 1])
            if abs((ob_l + ob_h) * 0.5 - last_price) <= m_dist:
                raw_bear.append((ob_l, ob_h, i))

    bull_ob, bear_ob = [], []
    bull_brk, bear_brk = [], []

    for ob_l, ob_h, idx in raw_bull:
        mit = any(closes[j] < ob_l for j in range(idx + 1, n))
        if not mit:
            bull_ob.append((ob_l, ob_h, idx))
        elif last_price <= ob_h and abs(last_price - ob_l) <= m_dist:
            bear_brk.append((ob_l, ob_h, idx))

    for ob_l, ob_h, idx in raw_bear:
        mit = any(closes[j] > ob_h for j in range(idx + 1, n))
        if not mit:
            bear_ob.append((ob_l, ob_h, idx))
        elif last_price >= ob_l and abs(last_price - ob_h) <= m_dist:
            bull_brk.append((ob_l, ob_h, idx))

    return {
        "bullish_ob": bull_ob[-2:],
        "bearish_ob": bear_ob[-2:],
        "bullish_breaker": bull_brk[-2:],
        "bearish_breaker": bear_brk[-2:],
    }


def detect_smc_zones(
    df: pd.DataFrame,
    symbol: str = "",
    min_idx: int = 0,
    sweep_low: float = None,
    sweep_high: float = None,
):
    """
    Unified Crypto SMC Zone Scanner:
    - Step 4: Displacement FVGs (bullish_fvg / bearish_fvg)
    - Inversion FVGs (bullish_ifvg / bearish_ifvg)
    - Order Blocks (bullish_ob / bearish_ob)
    - Breaker Blocks (bullish_breaker / bearish_breaker)
    """
    empty = {
        "bullish_fvg": [],
        "bearish_fvg": [],
        "bullish_ifvg": [],
        "bearish_ifvg": [],
        "bullish_ob": [],
        "bearish_ob": [],
        "bullish_breaker": [],
        "bearish_breaker": [],
    }
    if df is None or len(df) < 10:
        return empty

    scale = _calc_crypto_scale(df)
    min_gap = scale["min_gap"]
    mit_tol = scale["mit_tol"]
    max_dist = scale["max_dist"]
    sweep_margin = scale["sweep_margin"]

    highs = df["high"].values
    lows = df["low"].values
    closes = df["close"].values
    last_price = float(closes[-1])
    n = len(df)

    raw_bull = []
    raw_bear = []
    start_scan = max(2, int(min_idx))

    for i in range(start_scan, n):
        gap_up = lows[i] - highs[i - 2]
        gap_dn = lows[i - 2] - highs[i]
        if gap_up >= min_gap:
            if sweep_low is None or highs[i - 2] >= (sweep_low - sweep_margin):
                raw_bull.append((float(highs[i - 2]), float(lows[i]), i))
        elif gap_dn >= min_gap:
            if sweep_high is None or lows[i - 2] <= (sweep_high + sweep_margin):
                raw_bear.append((float(highs[i]), float(lows[i - 2]), i))

    active_bull_fvg = []
    active_bear_fvg = []
    active_bull_ifvg = []
    active_bear_ifvg = []

    for f_l, f_h, idx in raw_bull:
        inv_idx = next((j for j in range(idx + 1, n - 1) if closes[j] < f_l - mit_tol), None)
        mid = (f_l + f_h) * 0.5
        if inv_idx is None:
            if abs(mid - last_price) <= max_dist:
                active_bull_fvg.append((f_l, f_h, idx))
        else:
            # Inverted bullish FVG flips to bearish resistance (bearish_ifvg) if not reclaimed above f_h
            reclaimed = any(closes[k] > f_h + mit_tol for k in range(inv_idx + 1, n))
            if not reclaimed and abs(mid - last_price) <= max_dist:
                active_bear_ifvg.append((f_l, f_h, idx))

    for f_l, f_h, idx in raw_bear:
        inv_idx = next((j for j in range(idx + 1, n - 1) if closes[j] > f_h + mit_tol), None)
        mid = (f_l + f_h) * 0.5
        if inv_idx is None:
            if abs(mid - last_price) <= max_dist:
                active_bear_fvg.append((f_l, f_h, idx))
        else:
            # Inverted bearish FVG flips to bullish support (bullish_ifvg) if not broken back below f_l
            broken = any(closes[k] < f_l - mit_tol for k in range(inv_idx + 1, n))
            if not broken and abs(mid - last_price) <= max_dist:
                active_bull_ifvg.append((f_l, f_h, idx))

    obs = detect_order_blocks(df, min_displacement=scale["min_ob_disp"], max_dist=max_dist)

    return {
        "bullish_fvg": active_bull_fvg[-3:],
        "bearish_fvg": active_bear_fvg[-3:],
        "bullish_ifvg": active_bull_ifvg[-2:],
        "bearish_ifvg": active_bear_ifvg[-2:],
        "bullish_ob": obs["bullish_ob"],
        "bearish_ob": obs["bearish_ob"],
        "bullish_breaker": obs["bullish_breaker"],
        "bearish_breaker": obs["bearish_breaker"],
    }


def check_fvg_retest(
    df_m5: pd.DataFrame,
    fvg_list: list,
    is_bullish: bool,
    symbol: str = "",
    check_closed_candle: bool = True,
):
    """
    Step 5: Strictly verifies whether a CLOSED M5 bar tapped & respected the active FVG.
    If caller passes df_closed (already sliced without forming bar), check_closed_candle=False checks iloc[-1].
    """
    if df_m5 is None or not fvg_list or len(df_m5) < 3:
        return (False, None)

    scale = _calc_crypto_scale(df_m5)
    wick_buf = scale["wick_buf"]
    close_tol = scale["close_tol"]
    min_depth_gap = scale["min_gap"] * 2.1

    bar_idx = (len(df_m5) - 2) if check_closed_candle else (len(df_m5) - 1)
    if bar_idx < 1:
        return (False, None)

    bar = df_m5.iloc[bar_idx]
    prev_bar = df_m5.iloc[bar_idx - 1]
    prev_idx = bar_idx - 1

    c_open = float(bar["open"])
    c_high = float(bar["high"])
    c_low = float(bar["low"])
    c_close = float(bar["close"])

    p_high = float(prev_bar["high"])
    p_low = float(prev_bar["low"])
    p_close = float(prev_bar["close"])

    for fvg_l, fvg_h, fvg_idx in reversed(fvg_list):
        if bar_idx <= fvg_idx:
            continue
        can_use_prev = prev_idx > fvg_idx
        gap = max(0.0, float(fvg_h) - float(fvg_l))
        pen_depth = 0.35 * gap if gap >= min_depth_gap else 0.0

        if is_bullish:
            entry_ceil = float(fvg_h) - pen_depth
            direct = (
                c_low <= entry_ceil
                and c_low >= float(fvg_l) - wick_buf
                and c_close >= float(fvg_l) - close_tol
            )
            two_bar = (
                can_use_prev
                and p_low <= entry_ceil
                and p_low >= float(fvg_l) - wick_buf
                and p_close >= float(fvg_l) - close_tol
                and c_close >= float(fvg_l)
                and c_close >= c_open
            )
            if direct or two_bar:
                return (True, (float(fvg_l), float(fvg_h)))
        else:
            entry_floor = float(fvg_l) + pen_depth
            direct = (
                c_high >= entry_floor
                and c_high <= float(fvg_h) + wick_buf
                and c_close <= float(fvg_h) + close_tol
            )
            two_bar = (
                can_use_prev
                and p_high >= entry_floor
                and p_high <= float(fvg_h) + wick_buf
                and p_close <= float(fvg_h) + close_tol
                and c_close <= float(fvg_h)
                and c_close <= c_open
            )
            if direct or two_bar:
                return (True, (float(fvg_l), float(fvg_h)))

    return (False, None)
