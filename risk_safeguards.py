"""
Risk Safeguards & Prop Firm / Personal Futures Compliance Module.
Enforces:
  - PROP_FIRM Mode (Blue Guardian Crypto/Futures Rules):
      * 4.0% Daily Drawdown Limit -> bot halts at configurable halt_drawdown_limit (default 3.5%)
      * 8.0% Static Overall Drawdown Limit -> bot halts at 7.2%
      * 2.0% Guardian Shield Floating Loss Cut -> bot halts/protects at 1.8% floating loss
      * >= 120s Minimum Hold Rule -> bot enforces 140s minimum hold before discretionary exits
      * Max Margin Cap <= 80% of capital
  - PERSONAL Mode ($50 / $100 / $300+ USDT Personal Binance Futures):
      * Max Margin Cap <= 80% of capital
      * Configurable risk % per trade + leverage (1x-20x) + optional drawdown circuit breaker
"""
from datetime import datetime, timezone, timedelta
import database as db
import binance_execution as be

PKT_TZ = timezone(timedelta(hours=5))

# Prop Firm Blue Guardian Defaults (safely buffered inside official limits)
DEFAULT_DAILY_HALT_DD_PCT = 3.5
DEFAULT_MAX_DAILY_DD_PCT = 4.0
DEFAULT_OVERALL_HALT_DD_PCT = 7.2
DEFAULT_GUARDIAN_SHIELD_PCT = 1.8
MIN_PROP_HOLD_SECONDS = 140
MAX_CAPITAL_MARGIN_PCT = 80.0

_TRADES_TODAY_CACHE = {"date": None, "count": 0, "ts": 0.0}
_DAILY_START_EQUITY_CACHE = {"date": None, "equity": 0.0}


def invalidate_trades_cache():
    _TRADES_TODAY_CACHE["ts"] = 0.0
    _TRADES_TODAY_CACHE["date"] = None


def increment_trades_count():
    today = get_broker_today_date()
    if _TRADES_TODAY_CACHE["date"] == today:
        _TRADES_TODAY_CACHE["count"] += 1
    else:
        _TRADES_TODAY_CACHE["date"] = today
        _TRADES_TODAY_CACHE["count"] = 1


def get_broker_today_date():
    """Returns PKT (Asia/Karachi) trading date."""
    return datetime.now(PKT_TZ).date()


def get_active_account_login() -> int:
    return 0


def get_or_create_daily_start_equity(current_equity: float) -> float:
    """Fetches or initializes today's starting equity baseline for daily drawdown tracking."""
    today = get_broker_today_date()
    if _DAILY_START_EQUITY_CACHE["date"] == today and _DAILY_START_EQUITY_CACHE["equity"] > 0:
        return _DAILY_START_EQUITY_CACHE["equity"]

    conn = None
    try:
        conn = db.get_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT start_equity FROM daily_metrics WHERE trading_date = %s AND COALESCE(mt5_login, 0) = 0 LIMIT 1",
            (today,),
        )
        row = cur.fetchone()
        if row and float(row[0] or 0) > 0:
            start_eq = float(row[0])
            _DAILY_START_EQUITY_CACHE["date"] = today
            _DAILY_START_EQUITY_CACHE["equity"] = start_eq
            cur.close()
            return start_eq

        start_eq = float(current_equity) if current_equity > 0 else 10000.0
        cur.execute(
            """
            INSERT INTO daily_metrics (trading_date, start_equity, current_equity, max_drawdown_percent, trades_today, mt5_login, updated_at)
            VALUES (%s, %s, %s, 0, 0, 0, NOW())
            ON CONFLICT (trading_date, mt5_login) DO NOTHING
            """,
            (today, start_eq, start_eq),
        )
        conn.commit()
        cur.close()
        _DAILY_START_EQUITY_CACHE["date"] = today
        _DAILY_START_EQUITY_CACHE["equity"] = start_eq
        return start_eq
    except Exception as e:
        print(f"[Risk] get_or_create_daily_start_equity error: {e}")
        return float(current_equity) if current_equity > 0 else 10000.0
    finally:
        if conn:
            conn.close()


def check_drawdown_limit(current_equity: float, settings: dict = None, floating_pnl: float = 0.0):
    """
    Evaluates Daily Drawdown, Static Overall Drawdown, and Guardian Shield Floating Loss Limit.
    Returns (is_halted: bool, drawdown_pct: float, reason: str).
    """
    if current_equity <= 0:
        return False, 0.0, ""

    cfg = settings or db.get_crypto_bot_settings() or {}
    risk_enabled = cfg.get("risk_limits_enabled", True)
    account_mode = str(cfg.get("account_mode", "PROP_FIRM")).upper()
    halt_limit = float(cfg.get("halt_drawdown_limit", DEFAULT_DAILY_HALT_DD_PCT))
    shield_limit = float(cfg.get("guardian_shield_pct", DEFAULT_GUARDIAN_SHIELD_PCT))
    initial_bal = float(cfg.get("initial_balance", current_equity) or current_equity)

    start_eq = get_or_create_daily_start_equity(current_equity)
    daily_dd_pct = max(0.0, ((start_eq - current_equity) / start_eq) * 100.0) if start_eq > 0 else 0.0
    overall_dd_pct = max(0.0, ((initial_bal - current_equity) / initial_bal) * 100.0) if initial_bal > 0 else 0.0
    float_loss_pct = max(0.0, (-float(floating_pnl) / current_equity) * 100.0) if (current_equity > 0 and floating_pnl < 0) else 0.0

    if not risk_enabled:
        return False, round(daily_dd_pct, 2), ""

    if account_mode == "PROP_FIRM":
        if float_loss_pct >= shield_limit:
            return True, round(daily_dd_pct, 2), f"HALTED (Guardian Shield Floating {float_loss_pct:.2f}% >= {shield_limit:.2f}%)"
        if overall_dd_pct >= DEFAULT_OVERALL_HALT_DD_PCT:
            return True, round(daily_dd_pct, 2), f"HALTED (Blue Guardian Static DD {overall_dd_pct:.2f}% >= {DEFAULT_OVERALL_HALT_DD_PCT:.2f}%)"

    if daily_dd_pct >= halt_limit:
        return True, round(daily_dd_pct, 2), f"HALTED (Daily DD {daily_dd_pct:.2f}% >= {halt_limit:.2f}%)"

    return False, round(daily_dd_pct, 2), ""


def get_trades_count_today() -> int:
    """
    Counts real executed SMC setups today (PKT timezone) strictly after metrics_reset_at.
    Eliminates legacy TP1/Manual exclusion bug.
    """
    today = get_broker_today_date()
    now_ts = datetime.now(timezone.utc).timestamp()
    if _TRADES_TODAY_CACHE["date"] == today and (now_ts - _TRADES_TODAY_CACHE["ts"]) < 15.0:
        return _TRADES_TODAY_CACHE["count"]

    conn = None
    try:
        conn = db.get_connection()
        cur = conn.cursor()
        cur.execute("SELECT metrics_reset_at FROM bot_state ORDER BY id ASC LIMIT 1")
        reset_row = cur.fetchone()
        reset_at = reset_row[0] if reset_row else None

        if reset_at is not None:
            cur.execute(
                """
                SELECT COUNT(*) FROM trades
                WHERE DATE(entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Karachi') = %s
                  AND entry_time >= %s
                """,
                (today, reset_at),
            )
        else:
            cur.execute(
                """
                SELECT COUNT(*) FROM trades
                WHERE DATE(entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Karachi') = %s
                """,
                (today,),
            )
        count = int((cur.fetchone() or [0])[0] or 0)
        cur.close()
        _TRADES_TODAY_CACHE["date"] = today
        _TRADES_TODAY_CACHE["count"] = count
        _TRADES_TODAY_CACHE["ts"] = now_ts
        return count
    except Exception as e:
        print(f"[Risk] get_trades_count_today error: {e}")
        return 0
    finally:
        if conn:
            conn.close()


def round_volume(symbol: str, volume: float) -> float:
    filters = be.get_symbol_filters_ext(symbol)
    return be.round_to_step_size(volume, filters["step_size"], up=False)


def calculate_lots(symbol: str, sl_distance_price: float, acc_info=None, settings: dict = None) -> float:
    tick = be.get_binance_live_tick(symbol)
    entry_price = tick[2] if tick else 100.0
    cfg = settings or db.get_crypto_bot_settings() or {}
    equity = float(acc_info.get("equity", 10000.0)) if isinstance(acc_info, dict) else 10000.0
    sl_price = max(entry_price * 0.5, entry_price - abs(float(sl_distance_price or entry_price * 0.01)))
    qty, _ = be.calculate_crypto_smc_quantity(
        symbol=symbol,
        entry_price=entry_price,
        sl_price=sl_price,
        usdt_equity=equity,
        risk_pct=float(cfg.get("risk_percent", 1.0)),
        leverage=int(cfg.get("leverage", 5)),
        max_margin_pct=min(MAX_CAPITAL_MARGIN_PCT, float(cfg.get("max_margin_pct", 80.0))),
        account_mode=str(cfg.get("account_mode", "PROP_FIRM")),
    )
    return qty


def is_spread_valid(symbol: str, max_spread_pct: float = 0.20):
    """Checks Binance bid-ask spread stays <= 0.20% so illiquid spikes never eat entries."""
    tick = be.get_binance_live_tick(symbol)
    if not tick or tick[2] <= 0:
        return True, 0.0
    bid, ask, mid = tick
    spread_pct = ((ask - bid) / mid) * 100.0
    return (spread_pct <= max_spread_pct), round(spread_pct, 4)
