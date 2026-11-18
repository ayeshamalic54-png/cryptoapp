import psycopg2
from psycopg2 import extras
import datetime
import os

def load_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("=", 1)
                if len(parts) == 2:
                    key = parts[0].strip()
                    val = parts[1].strip()
                    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                        val = val[1:-1]
                    os.environ[key] = val

load_env()
DB_URL = os.getenv("DATABASE_URL", "")
if not DB_URL:
    raise RuntimeError("DATABASE_URL is not set. Add it to your .env file.")

def execute_with_deadlock_retry(func, max_retries=3, delay=0.5):
    """Executes a database function with retries on deadlock/lock timeout/SSL disconnection, with rollback handling."""
    import time
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            err_str = str(e).lower()
            if any(x in err_str for x in ["deadlock", "lock timeout", "could not obtain lock", "ssl connection", "closed unexpectedly", "connection reset", "operationalerror"]):
                if attempt < max_retries - 1:
                    time.sleep(delay * (attempt + 1))
                    continue
            raise e

def get_connection():
    """Returns a new connection to the Neon database with retries to handle transient errors."""
    import time
    last_err = None
    for attempt in range(5):
        try:
            conn = psycopg2.connect(DB_URL, connect_timeout=10)
            # Set statement timeout of 30 seconds to prevent hanging queries
            with conn.cursor() as cur:
                cur.execute("SET statement_timeout = 30000;")
            return conn
        except Exception as e:
            last_err = e
            print(f"Database connection attempt {attempt+1} failed: {e}. Retrying in 2 seconds...")
            time.sleep(2)
    raise last_err

def initialize_database():
    """Creates all tables if they do not exist."""
    commands = [
        """
        CREATE TABLE IF NOT EXISTS daily_metrics (
            trading_date DATE NOT NULL,
            mt5_login BIGINT DEFAULT 0,
            start_equity NUMERIC(15, 2) NOT NULL,
            current_equity NUMERIC(15, 2) NOT NULL,
            max_drawdown_percent NUMERIC(5, 2) DEFAULT 0.00,
            trades_today INTEGER DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT daily_metrics_unique_date_login UNIQUE (trading_date, mt5_login)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS signals (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            symbol_a VARCHAR(50) NOT NULL,
            symbol_b VARCHAR(50) NOT NULL,
            price_a NUMERIC(15, 5) NOT NULL,
            price_b NUMERIC(15, 5) NOT NULL,
            beta NUMERIC(15, 5) NOT NULL,
            alpha NUMERIC(15, 5) NOT NULL,
            z_score NUMERIC(10, 4) NOT NULL,
            obi NUMERIC(10, 4) NOT NULL,
            action VARCHAR(20) NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS trades (
            ticket BIGINT PRIMARY KEY,
            symbol VARCHAR(50) NOT NULL,
            order_type VARCHAR(10) NOT NULL,
            lots NUMERIC(10, 2) NOT NULL,
            entry_price NUMERIC(15, 5) NOT NULL,
            close_price NUMERIC(15, 5),
            profit NUMERIC(15, 2),
            entry_time TIMESTAMP NOT NULL,
            close_time TIMESTAMP,
            status VARCHAR(20) DEFAULT 'OPEN',
            comment VARCHAR(100),
            signal_id INTEGER REFERENCES signals(id)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS bot_state (
            id SERIAL PRIMARY KEY,
            active_pair VARCHAR(50) NOT NULL DEFAULT 'BTCUSDT/ETHUSDT',
            system_status VARCHAR(50) NOT NULL DEFAULT 'BOT OFFLINE',
            equity NUMERIC(15, 2) DEFAULT 0,
            drawdown_percent NUMERIC(5, 2) DEFAULT 0,
            floating_profit NUMERIC(15, 2) DEFAULT 0,
            z_score NUMERIC(10, 4) DEFAULT 0,
            hedge_ratio NUMERIC(10, 4) DEFAULT 0,
            obi_a NUMERIC(10, 4) DEFAULT 0,
            obi_b NUMERIC(10, 4) DEFAULT 0,
            trades_today INTEGER DEFAULT 0,
            sl_pips NUMERIC(6, 1) DEFAULT 10,
            tp_pips NUMERIC(6, 1) DEFAULT 20,
            smc_enabled BOOLEAN DEFAULT TRUE,
            auto_execute BOOLEAN DEFAULT TRUE,
            crypto_enabled BOOLEAN DEFAULT TRUE,
            metals_enabled BOOLEAN DEFAULT TRUE,
            forex_enabled BOOLEAN DEFAULT TRUE,
            indices_enabled BOOLEAN DEFAULT TRUE,
            risk_limits_enabled BOOLEAN DEFAULT TRUE,
            z_entry_threshold NUMERIC(4, 2) DEFAULT 2.00,
            default_lots NUMERIC(5, 2) DEFAULT 0.01,
            last_heartbeat TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            max_trades INTEGER DEFAULT 3,
            admin_username VARCHAR(50) DEFAULT 'wasee',
            admin_password VARCHAR(100) DEFAULT 'AWais1133@',
            initial_balance NUMERIC(15, 2) DEFAULT 100000.00,
            overall_drawdown NUMERIC(5, 2) DEFAULT 0.00,
            max_equity_peak NUMERIC(15, 2) DEFAULT 0.00,
            mt5_login BIGINT DEFAULT 0
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS fvg_zones (
            id SERIAL PRIMARY KEY,
            symbol VARCHAR(50) NOT NULL,
            zone_type VARCHAR(30) NOT NULL,
            low_price NUMERIC(15, 5) NOT NULL,
            high_price NUMERIC(15, 5) NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS scanned_assets (
            symbol_pair VARCHAR(100) PRIMARY KEY,
            price_a NUMERIC(15, 5),
            price_b NUMERIC(15, 5),
            win_rate NUMERIC(5, 2),
            z_score NUMERIC(10, 4),
            action VARCHAR(20),
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS trade_commands (
            id SERIAL PRIMARY KEY,
            symbol VARCHAR(20) NOT NULL,
            direction VARCHAR(10) NOT NULL,
            lots NUMERIC(10, 2) NOT NULL,
            sl_pips NUMERIC(6, 1),
            tp_pips NUMERIC(6, 1),
            comment VARCHAR(100),
            status VARCHAR(20) DEFAULT 'PENDING',
            executed_at TIMESTAMP,
            error_msg TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    ]

    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        for cmd in commands:
            cur.execute(cmd)
        conn.commit()

        # Add risk_limits_enabled column to bot_state if it doesn't exist yet
        cur.execute("""
            SELECT 1 FROM information_schema.columns 
            WHERE table_name='bot_state' AND column_name='risk_limits_enabled'
        """)
        if not cur.fetchone():
            cur.execute("ALTER TABLE bot_state ADD COLUMN risk_limits_enabled BOOLEAN DEFAULT TRUE")
            conn.commit()
            print("Added risk_limits_enabled column to bot_state table.")

        # Add signal_id column to trades if it doesn't exist yet
        cur.execute("""
            SELECT 1 FROM information_schema.columns 
            WHERE table_name='trades' AND column_name='signal_id'
        """)
        if not cur.fetchone():
            cur.execute("ALTER TABLE trades ADD COLUMN signal_id INTEGER REFERENCES signals(id)")
            conn.commit()
            print("Added signal_id column to trades table.")

        # Add z_entry_threshold column to bot_state if it doesn't exist yet
        cur.execute("""
            SELECT 1 FROM information_schema.columns 
            WHERE table_name='bot_state' AND column_name='z_entry_threshold'
        """)
        if not cur.fetchone():
            cur.execute("ALTER TABLE bot_state ADD COLUMN z_entry_threshold NUMERIC(4, 2) DEFAULT 2.00")
            conn.commit()
            print("Added z_entry_threshold column to bot_state table.")

        # Add tp_pips column to bot_state if it doesn't exist yet
        cur.execute("""
            SELECT 1 FROM information_schema.columns 
            WHERE table_name='bot_state' AND column_name='tp_pips'
        """)
        if not cur.fetchone():
            cur.execute("ALTER TABLE bot_state ADD COLUMN tp_pips NUMERIC(6, 1) DEFAULT 20.0")
            conn.commit()
            print("Added tp_pips column to bot_state table.")

        # Add default_lots column to bot_state if it doesn't exist yet
        cur.execute("""
            SELECT 1 FROM information_schema.columns 
            WHERE table_name='bot_state' AND column_name='default_lots'
        """)
        if not cur.fetchone():
            cur.execute("ALTER TABLE bot_state ADD COLUMN default_lots NUMERIC(5, 3) DEFAULT 0.01")
            conn.commit()
            print("Added default_lots column to bot_state table.")

        # Add admin_username column to bot_state if it doesn't exist yet
        cur.execute("""
            SELECT 1 FROM information_schema.columns 
            WHERE table_name='bot_state' AND column_name='admin_username'
        """)
        if not cur.fetchone():
            cur.execute("ALTER TABLE bot_state ADD COLUMN admin_username VARCHAR(50) DEFAULT 'wasee'")
            conn.commit()
            print("Added admin_username column to bot_state table.")

        # Create performance indexes for ultra-fast query and dashboard loading speeds
        cur.execute("CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp DESC);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_scanned_assets_updated ON scanned_assets(updated_at DESC);")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_fvg_zones_symbol ON fvg_zones(symbol);")
        cur.execute("""
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS account_mode VARCHAR(20) DEFAULT 'PROP_FIRM';
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS leverage INTEGER DEFAULT 5;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS risk_percent NUMERIC(5,2) DEFAULT 1.00;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS max_margin_pct NUMERIC(5,2) DEFAULT 80.00;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS max_sl_pct NUMERIC(5,2) DEFAULT 1.20;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS halt_drawdown_limit NUMERIC(5,2) DEFAULT 3.50;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS max_drawdown_limit NUMERIC(5,2) DEFAULT 4.00;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS guardian_shield_pct NUMERIC(5,2) DEFAULT 1.80;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session_guard_enabled BOOLEAN DEFAULT FALSE;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session_start_hour NUMERIC(4,2) DEFAULT 12.00;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session_end_hour NUMERIC(4,2) DEFAULT 16.00;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session2_enabled BOOLEAN DEFAULT TRUE;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session2_start_hour NUMERIC(4,2) DEFAULT 18.00;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session2_end_hour NUMERIC(4,2) DEFAULT 22.00;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS is_bot_running BOOLEAN DEFAULT TRUE;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS metrics_reset_at TIMESTAMP DEFAULT NULL;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS knife_protection_enabled BOOLEAN DEFAULT FALSE;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS obi_enabled BOOLEAN DEFAULT FALSE;
            ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS volatility_filter_enabled BOOLEAN DEFAULT FALSE;
            ALTER TABLE trades ADD COLUMN IF NOT EXISTS sl NUMERIC(20, 8);
            ALTER TABLE trades ADD COLUMN IF NOT EXISTS tp NUMERIC(20, 8);
            ALTER TABLE trades ADD COLUMN IF NOT EXISTS mt5_login BIGINT DEFAULT 0;
            CREATE TABLE IF NOT EXISTS smc_telemetry (
                symbol VARCHAR(25) PRIMARY KEY,
                m15_bias VARCHAR(30) DEFAULT 'NEUTRAL',
                sweep_status VARCHAR(80) DEFAULT 'FAIL',
                sweep_price NUMERIC(20, 8) DEFAULT 0,
                choch_status VARCHAR(80) DEFAULT 'FAIL',
                choch_price NUMERIC(20, 8) DEFAULT 0,
                fvg_status VARCHAR(80) DEFAULT 'FAIL',
                fvg_bounds_json TEXT DEFAULT '{}',
                retest_status VARCHAR(80) DEFAULT 'FAIL',
                s6_status VARCHAR(80) DEFAULT 'FAIL',
                s7_status VARCHAR(80) DEFAULT 'FAIL',
                s8_status VARCHAR(100) DEFAULT '',
                s9_status VARCHAR(100) DEFAULT '',
                action VARCHAR(20) DEFAULT 'NONE',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.commit()

        cur.close()
        print("Database initialized successfully!")
    except Exception as e:
        print(f"Failed to initialize database: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

def update_bot_state(active_pair, system_status, equity, drawdown_percent,
                     floating_profit, z_score, hedge_ratio, obi_a, obi_b,
                     trades_today, sl_pips=10.0):
    """
    Upserts live bot telemetry into bot_state table.
    Tracks overall drawdown, max equity peak, and resets metrics if a new MT5 account is attached.
    """
    query = """
        INSERT INTO bot_state (
            id, active_pair, system_status, equity, drawdown_percent,
            floating_profit, z_score, hedge_ratio, obi_a, obi_b,
            trades_today, sl_pips, last_heartbeat, updated_at,
            initial_balance, overall_drawdown, max_equity_peak, mt5_login
        )
        VALUES (
            1, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, %s, %s, %s, %s
        )
        ON CONFLICT (id) DO UPDATE SET
            active_pair        = EXCLUDED.active_pair,
            system_status      = EXCLUDED.system_status,
            equity             = EXCLUDED.equity,
            drawdown_percent   = EXCLUDED.drawdown_percent,
            floating_profit    = EXCLUDED.floating_profit,
            z_score            = EXCLUDED.z_score,
            hedge_ratio        = EXCLUDED.hedge_ratio,
            obi_a              = EXCLUDED.obi_a,
            obi_b              = EXCLUDED.obi_b,
            trades_today       = EXCLUDED.trades_today,
            initial_balance    = EXCLUDED.initial_balance,
            overall_drawdown   = EXCLUDED.overall_drawdown,
            max_equity_peak    = EXCLUDED.max_equity_peak,
            mt5_login          = EXCLUDED.mt5_login,
            last_heartbeat     = CURRENT_TIMESTAMP,
            updated_at         = CURRENT_TIMESTAMP
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()

        # 1. Fetch current saved overall metrics from DB
        cur.execute("SELECT initial_balance, max_equity_peak, mt5_login FROM bot_state WHERE id = 1")
        row = cur.fetchone()

        initial_balance_val = float(equity)
        max_equity_peak_val = float(equity)
        saved_login = 888888

        if row:
            initial_balance_val = float(row[0] or equity)
            max_equity_peak_val = float(row[1] or equity)
            saved_login = int(row[2] or 888888)

        binance_login_val = saved_login

        # 3. Detect if a new account has been attached
        trades_today_val = int(trades_today)
        # Check if there are active positions in the database
        cur.execute("SELECT COUNT(*) FROM trades WHERE status = 'OPEN'")
        open_trades_count = cur.fetchone()[0] or 0
        
        # Guard: If no trades are open in database, force floating_profit to 0.00!
        if open_trades_count == 0:
            floating_profit = 0.00
            
        has_positions = (open_trades_count > 0)
        login_changed = (saved_login > 0 and saved_login != binance_login_val and binance_login_val != 9999)

        if login_changed:
            print(f"Syncing account metrics: New account attached. Resetting initial_balance and max_equity_peak to current equity: ${equity:.2f}")
            initial_balance_val = float(equity)
            max_equity_peak_val = float(equity)
            saved_login = binance_login_val

        # 4. Update peak equity if exceeded
        if float(equity) > max_equity_peak_val:
            max_equity_peak_val = float(equity)

        # 5. Calculate overall drawdown from peak
        overall_drawdown_val = 0.00
        if max_equity_peak_val > 0.0:
            overall_drawdown_val = ((max_equity_peak_val - float(equity)) / max_equity_peak_val) * 100.0
            overall_drawdown_val = max(0.00, overall_drawdown_val)

        cur.execute(query, (
            str(active_pair), str(system_status),
            float(equity), float(drawdown_percent),
            float(floating_profit), float(z_score),
            float(hedge_ratio), float(obi_a), float(obi_b),
            int(trades_today), float(sl_pips),
            float(initial_balance_val), float(overall_drawdown_val),
            float(max_equity_peak_val), int(saved_login)
        ))
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"Error updating bot_state: {e}")
    finally:
        if conn:
            conn.close()

def get_auto_execute():
    """
    Reads auto_execute flag from bot_state. Returns True by default.
    Called by the bot every ~10s to check if auto-trading is enabled from dashboard.
    """
    query = "SELECT auto_execute FROM bot_state WHERE id = 1"
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(query)
        row = cur.fetchone()
        cur.close()
        if row is not None:
            return bool(row[0])
        return True
    except Exception as e:
        print(f"Error reading auto_execute: {e}")
        return True
    finally:
        if conn:
            conn.close()

def log_fvg_zones(symbol, zones_dict):
    """
    Replaces all active FVG/OB/Breaker/iFVG zones for a symbol.
    zones_dict: output of detect_smc_zones() — dict of zone_type -> [(low, high), ...]
    Called every 10 loops (~20s) when SMC scan updates.
    """
    zone_type_map = {
        'bullish_ob':      'bullish_ob',
        'bearish_ob':      'bearish_ob',
        'bullish_fvg':     'bullish_fvg',
        'bearish_fvg':     'bearish_fvg',
        'bullish_breaker': 'bullish_breaker',
        'bearish_breaker': 'bearish_breaker',
        'bullish_ifvg':    'bullish_ifvg',
        'bearish_ifvg':    'bearish_ifvg',
    }

    rows = []
    for zone_key, db_type in zone_type_map.items():
        for (low, high) in zones_dict.get(zone_key, []):
            rows.append((symbol, db_type, float(low), float(high)))

    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM fvg_zones WHERE symbol = %s", (symbol,))
        if rows:
            cur.executemany(
                "INSERT INTO fvg_zones (symbol, zone_type, low_price, high_price, updated_at) "
                "VALUES (%s, %s, %s, %s, CURRENT_TIMESTAMP)",
                rows
            )
        conn.commit()
        cur.close()
        # Console output for live verification of active SMC zones
        # Silently saved to database without console flooding
        pass
    except Exception as e:
        print(f"Error logging FVG zones: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

def log_signal(symbol_a, symbol_b, price_a, price_b, beta, alpha, z_score, obi, action):
    """Logs a generated mathematical signal. Returns the signal ID."""
    query = """
        INSERT INTO signals (symbol_a, symbol_b, price_a, price_b, beta, alpha, z_score, obi, action)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(query, (
            symbol_a, symbol_b,
            float(price_a), float(price_b),
            float(beta), float(alpha),
            float(z_score), float(obi),
            action
        ))
        row = cur.fetchone()
        conn.commit()
        cur.close()
        if row:
            return row[0]
    except Exception as e:
        print(f"Error logging signal to database: {e}")
    finally:
        if conn:
            conn.close()
    return None

def format_pkt_time_str(dt_val=None):
    """Formats a datetime (or current UTC) in Pakistani Time (PKT) identically to the Forex terminal."""
    from datetime import datetime, timezone, timedelta
    pkt_tz = timezone(timedelta(hours=5))
    try:
        if dt_val is None:
            dt = datetime.now(timezone.utc)
        else:
            dt = dt_val
            if getattr(dt, "tzinfo", None) is None:
                dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(pkt_tz).strftime("%Y-%m-%d %I:%M:%S %p PKT")
    except Exception:
        return str(dt_val or "")


def _fmt_price_str(val):
    p = abs(float(val or 0))
    if p >= 1000:
        return f"{float(val):.2f}"
    if p >= 10:
        return f"{float(val):.3f}"
    if p >= 1:
        return f"{float(val):.4f}"
    if p >= 0.05:
        return f"{float(val):.5f}"
    return f"{float(val):.8f}"


def send_discord_message(content):
    """Sends a notification strictly to the dedicated Crypto Discord Webhook (separate from Forex channel)."""
    import os
    import requests
    webhook_url = (os.getenv("CRYPTO_DISCORD_WEBHOOK_URL") or os.getenv("DISCORD_WEBHOOK_URL") or "").strip()
    if not webhook_url or not webhook_url.startswith("http"):
        return False
    try:
        payload = {"content": content}
        res = requests.post(webhook_url, json=payload, timeout=5)
        return res.status_code in (200, 204)
    except Exception as e:
        print(f"Error sending Crypto Discord notification: {e}")
        return False


def log_trade_entry(ticket, symbol, order_type, lots, entry_price, entry_time, comment="", signal_id=None):
    """Logs the entry of a trade into Neon PostgreSQL (full 9-step Discord signal card sent by strategy engine)."""
    query = """
        INSERT INTO trades (ticket, symbol, order_type, lots, entry_price, entry_time, status, comment, signal_id)
        VALUES (%s, %s, %s, %s, %s, %s, 'OPEN', %s, %s)
        ON CONFLICT (ticket) DO NOTHING
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(query, (
            int(ticket), symbol, order_type,
            float(lots), float(entry_price), entry_time, comment,
            int(signal_id) if signal_id is not None else None
        ))
        conn.commit()
        cur.close()
        if "MANUAL" in str(comment).upper():
            side_txt = "LONG (BUY) 🟢" if str(order_type).upper() == "BUY" else "SHORT (SELL) 🔴"
            disc_msg = (
                f"🚀 **[ MANUAL CRYPTO FUTURES OPENED ]** 🚀\n\n"
                f"🎫 **Ticket:** `{ticket}`\n"
                f"💱 **Coin:** `{symbol}` (`{side_txt}` | Qty `{lots}`)\n"
                f"📥 **Entry Price:** `${_fmt_price_str(entry_price)}`\n"
                f"⏱ **Open Time:** `{format_pkt_time_str(entry_time)}`\n"
            )
            send_discord_message(disc_msg)
    except Exception as e:
        print(f"Error logging trade entry: {e}")
    finally:
        if conn:
            conn.close()

def get_open_trades_count(symbol=None):
    """Returns the number of currently open trades in the database."""
    query = "SELECT COUNT(*) FROM trades WHERE status = 'OPEN'"
    params = ()
    if symbol:
        query += " AND symbol = %s"
        params = (symbol,)
    conn = None
    count = 0
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(query, params)
        count = cur.fetchone()[0]
        cur.close()
    except Exception as e:
        print(f"Error fetching open trades count: {e}")
    finally:
        if conn:
            conn.close()
    return count

def log_trade_exit(ticket, close_price, profit, close_time):
    """Updates a trade when it is closed and sends a Discord webhook notification."""
    query = """
        UPDATE trades
        SET close_price = %s, profit = %s, close_time = %s, status = 'CLOSED'
        WHERE ticket = %s
        RETURNING symbol, order_type, lots
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(query, (
            float(close_price), float(profit), close_time, int(ticket)
        ))
        row = cur.fetchone()
        conn.commit()
        cur.close()

        symbol_str = row[0] if row else "Crypto"
        order_type_str = row[1] if row else "TRADE"
        lots_val = float(row[2]) if row else 0.0

        pnl_val = float(profit)
        pnl_emoji = "🟢" if pnl_val >= 0 else "🔴"
        pnl_sign = "+" if pnl_val >= 0 else ""
        side_label = "LONG" if str(order_type_str).upper() == "BUY" else "SHORT"
        pkt_str = format_pkt_time_str(close_time)

        disc_msg = (
            f"🏁 **CRYPTO FUTURES POSITION CLOSED** 🏁\n\n"
            f"🎫 **Ticket:** `{ticket}`\n"
            f"💱 **Coin:** `{symbol_str}` (`{side_label}` | Qty `{lots_val}`)\n"
            f"💵 **Close Price:** `${_fmt_price_str(close_price)}`\n"
            f"💰 **Realized P&L:** `{pnl_sign}${pnl_val:.2f} USDT` {pnl_emoji}\n"
            f"⏱ **Close Time:** `{pkt_str}`\n"
        )
        send_discord_message(disc_msg)
    except Exception as e:
        print(f"Error logging trade exit: {e}")
    finally:
        if conn:
            conn.close()

def update_daily_metrics(date_obj, start_equity, current_equity, max_dd, trades_count, login_id=0):
    """Updates the daily challenge metrics in database for a specific login_id."""
    query = """
        INSERT INTO daily_metrics (trading_date, mt5_login, start_equity, current_equity, max_drawdown_percent, trades_today, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
        ON CONFLICT (trading_date, mt5_login) DO UPDATE
        SET start_equity = EXCLUDED.start_equity,
            current_equity = EXCLUDED.current_equity,
            max_drawdown_percent = GREATEST(daily_metrics.max_drawdown_percent, EXCLUDED.max_drawdown_percent),
            trades_today = EXCLUDED.trades_today,
            updated_at = CURRENT_TIMESTAMP
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        login_val = int(login_id) if login_id else 0
        cur.execute(query, (
            date_obj, login_val,
            float(start_equity), float(current_equity),
            float(max_dd), int(trades_count)
        ))
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"Error updating daily metrics: {e}")
    finally:
        if conn:
            conn.close()

def update_scanned_asset(symbol_pair, price_a, price_b, win_rate, z_score, action):
    query = """
        INSERT INTO scanned_assets (symbol_pair, price_a, price_b, win_rate, z_score, action, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
        ON CONFLICT (symbol_pair) DO UPDATE
        SET price_a = EXCLUDED.price_a,
            price_b = EXCLUDED.price_b,
            win_rate = EXCLUDED.win_rate,
            z_score = EXCLUDED.z_score,
            action = EXCLUDED.action,
            updated_at = CURRENT_TIMESTAMP
    """
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(query, (
            symbol_pair,
            float(price_a), float(price_b),
            float(win_rate), float(z_score),
            action
        ))
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"Error updating scanned asset: {e}")
    finally:
        if conn:
            conn.close()


def reset_database_metrics_for_new_account(login_id, equity):
    """
    Force-updates the database metrics (both bot_state and daily_metrics for today)
    to match the new connected account's starting balance.
    """
    import datetime
    today = datetime.date.today()
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        login_val = int(login_id) if login_id else 0
        
        # 1. Update bot_state
        cur.execute("""
            UPDATE bot_state 
            SET initial_balance = %s, max_equity_peak = %s, mt5_login = %s, equity = %s, drawdown_percent = 0.00 
            WHERE id = 1
        """, (float(equity), float(equity), login_val, float(equity)))
        
        # 2. Update or Insert daily_metrics for today and this specific login
        cur.execute("""
            INSERT INTO daily_metrics (trading_date, mt5_login, start_equity, current_equity, max_drawdown_percent, trades_today)
            VALUES (%s, %s, %s, %s, 0.0, 0)
            ON CONFLICT (trading_date, mt5_login) DO UPDATE
            SET start_equity = EXCLUDED.start_equity,
                current_equity = EXCLUDED.current_equity,
                max_drawdown_percent = 0.00,
                updated_at = CURRENT_TIMESTAMP
        """, (today, login_val, float(equity), float(equity)))
            
        conn.commit()
        cur.close()
        print(f"Successfully reset database metrics for account {login_val} (Equity: ${equity:.2f})")
    except Exception as e:
        print(f"Error resetting database metrics for new account: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()
            


if __name__ == "__main__":
    initialize_database()


def log_smc_zones_full(symbol, zones_dict):
    """Stores all 4 SMC zone families (FVG, iFVG, OB, BREAKER) cleanly for chart & dashboard."""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM fvg_zones WHERE symbol = %s", (symbol.upper(),))
        zone_types = [
            "bullish_fvg", "bearish_fvg",
            "bullish_ifvg", "bearish_ifvg",
            "bullish_ob", "bearish_ob",
            "bullish_breaker", "bearish_breaker",
        ]
        for ztype in zone_types:
            for item in zones_dict.get(ztype, []) or []:
                low_p = float(item[0])
                high_p = float(item[1])
                if high_p > low_p:
                    cur.execute(
                        "INSERT INTO fvg_zones (symbol, zone_type, low_price, high_price, updated_at) VALUES (%s, %s, %s, %s, NOW())",
                        (symbol.upper(), ztype, low_p, high_p),
                    )
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"DB Error log_smc_zones_full: {e}")
    finally:
        if conn:
            conn.close()


def update_smc_telemetry(symbol, tel):
    """Persists real-time 9-Step SMC telemetry & candle snapshot JSON for live UI chart overlay."""
    if not tel:
        return
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO smc_telemetry (
                symbol, m15_bias, sweep_status, sweep_price,
                choch_status, choch_price, fvg_status, fvg_bounds_json,
                retest_status, s6_status, s7_status, s8_status, s9_status,
                action, updated_at
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
            ON CONFLICT (symbol) DO UPDATE SET
                m15_bias = EXCLUDED.m15_bias,
                sweep_status = EXCLUDED.sweep_status,
                sweep_price = EXCLUDED.sweep_price,
                choch_status = EXCLUDED.choch_status,
                choch_price = EXCLUDED.choch_price,
                fvg_status = EXCLUDED.fvg_status,
                fvg_bounds_json = EXCLUDED.fvg_bounds_json,
                retest_status = EXCLUDED.retest_status,
                s6_status = EXCLUDED.s6_status,
                s7_status = EXCLUDED.s7_status,
                s8_status = EXCLUDED.s8_status,
                s9_status = EXCLUDED.s9_status,
                action = EXCLUDED.action,
                updated_at = NOW()
            """,
            (
                symbol.upper(),
                str(tel.get("m15_bias", "NEUTRAL ⚪"))[:30],
                str(tel.get("sweep_status", "FAIL"))[:80],
                float(tel.get("sweep_price", 0) or 0),
                str(tel.get("choch_status", "FAIL"))[:80],
                float(tel.get("choch_price", 0) or 0),
                str(tel.get("fvg_status", "FAIL"))[:80],
                str(tel.get("fvg_bounds_json", "{}")),
                str(tel.get("retest_status", "FAIL"))[:80],
                str(tel.get("s6_status", "FAIL"))[:80],
                str(tel.get("s7_status", "FAIL"))[:80],
                str(tel.get("s8_status", ""))[:100],
                str(tel.get("s9_status", ""))[:100],
                str(tel.get("action", "NONE"))[:20],
            ),
        )
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"DB Error update_smc_telemetry: {e}")
    finally:
        if conn:
            conn.close()


def save_trade_sl_tp(ticket, sl=0.0, tp=0.0, mt5_login=0):
    """Saves exact structural SL & TP on a live Crypto Futures trade row."""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(
            "UPDATE trades SET sl = %s, tp = %s, mt5_login = %s WHERE ticket = %s",
            (float(sl or 0), float(tp or 0), int(mt5_login or 0), int(ticket)),
        )
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"DB Error save_trade_sl_tp: {e}")
    finally:
        if conn:
            conn.close()


def cleanup_stale_scanned_assets(valid_symbols):
    """Removes legacy Z-score pair rows (containing '/') or disabled coins from scanned_assets."""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("DELETE FROM scanned_assets WHERE symbol_pair LIKE '%/%'")
        if valid_symbols:
            upper = [s.upper() for s in valid_symbols]
            cur.execute("DELETE FROM scanned_assets WHERE NOT (UPPER(symbol_pair) = ANY(%s))", (upper,))
        conn.commit()
        cur.close()
    except Exception as e:
        print(f"DB Error cleanup_stale_scanned_assets: {e}")
    finally:
        if conn:
            conn.close()


def get_crypto_bot_settings():
    """Fetches complete Pure Crypto Futures SMC configuration & Session Guard state from bot_state."""
    conn = None
    try:
        conn = get_connection()
        cur = conn.cursor()
        cur.execute("""
            SELECT active_pair, auto_execute, smc_enabled, risk_limits_enabled,
                   max_trades, default_lots, sl_pips, tp_pips,
                   initial_balance, max_equity_peak, overall_drawdown,
                   account_mode, leverage, risk_percent, max_margin_pct, max_sl_pct,
                   halt_drawdown_limit, max_drawdown_limit, guardian_shield_pct,
                   session_guard_enabled, session_start_hour, session_end_hour,
                   session2_enabled, session2_start_hour, session2_end_hour,
                   is_bot_running, metrics_reset_at
            FROM bot_state
            ORDER BY id ASC
            LIMIT 1
        """)
        row = cur.fetchone()
        cur.close()
        if not row:
            return {}
        return {
            "active_pair": str(row[0] or "BTCUSDT").split("/")[0].strip().upper(),
            "auto_execute": bool(row[1]) if row[1] is not None else True,
            "smc_enabled": bool(row[2]) if row[2] is not None else True,
            "risk_limits_enabled": bool(row[3]) if row[3] is not None else True,
            "max_trades": int(row[4] or 10),
            "default_lots": float(row[5] or 0.01),
            "sl_pct": float(row[6] or 1.2),
            "tp_pct": float(row[7] or 2.4),
            "initial_balance": float(row[8] or 10000.0),
            "max_equity_peak": float(row[9] or 10000.0),
            "overall_drawdown": float(row[10] or 0.0),
            "account_mode": str(row[11] or "PROP_FIRM").upper(),
            "leverage": int(row[12] or 5),
            "risk_percent": float(row[13] or 1.0),
            "max_margin_pct": min(80.0, float(row[14] or 80.0)),
            "max_sl_pct": float(row[15] or 1.2),
            "halt_drawdown_limit": float(row[16] or 3.5),
            "max_drawdown_limit": float(row[17] or 4.0),
            "guardian_shield_pct": float(row[18] or 1.8),
            "session_guard_enabled": bool(row[19]) if row[19] is not None else False,
            "session_start_hour": float(row[20] if row[20] is not None else 12.0),
            "session_end_hour": float(row[21] if row[21] is not None else 16.0),
            "session2_enabled": bool(row[22]) if row[22] is not None else True,
            "session2_start_hour": float(row[23] if row[23] is not None else 18.0),
            "session2_end_hour": float(row[24] if row[24] is not None else 22.0),
            "is_bot_running": bool(row[25]) if row[25] is not None else True,
            "metrics_reset_at": row[26],
        }
    except Exception as e:
        print(f"DB Error get_crypto_bot_settings: {e}")
        return {}
    finally:
        if conn:
            conn.close()
