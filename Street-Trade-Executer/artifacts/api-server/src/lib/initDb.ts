import { pool } from "@workspace/db";
import { logger } from "./logger";

export async function initDb(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS bot_state (
      id SERIAL PRIMARY KEY,
      active_pair VARCHAR(50) NOT NULL DEFAULT 'BTCUSDT',
      system_status VARCHAR(50) NOT NULL DEFAULT 'BOT OFFLINE',
      equity NUMERIC(15, 2) DEFAULT 0,
      drawdown_percent NUMERIC(5, 2) DEFAULT 0,
      floating_profit NUMERIC(15, 2) DEFAULT 0,
      z_score NUMERIC(10, 4) DEFAULT 0,
      hedge_ratio NUMERIC(10, 4) DEFAULT 0,
      obi_a NUMERIC(10, 4) DEFAULT 0,
      obi_b NUMERIC(10, 4) DEFAULT 0,
      trades_today INTEGER DEFAULT 0,
      sl_pips NUMERIC(6, 2) DEFAULT 1.20,
      tp_pips NUMERIC(6, 2) DEFAULT 2.40,
      smc_enabled BOOLEAN DEFAULT TRUE,
      auto_execute BOOLEAN DEFAULT TRUE,
      crypto_enabled BOOLEAN DEFAULT TRUE,
      metals_enabled BOOLEAN DEFAULT FALSE,
      forex_enabled BOOLEAN DEFAULT FALSE,
      indices_enabled BOOLEAN DEFAULT FALSE,
      risk_limits_enabled BOOLEAN DEFAULT TRUE,
      z_entry_threshold NUMERIC(4, 2) DEFAULT 0.00,
      default_lots NUMERIC(10, 4) DEFAULT 0.01,
      last_heartbeat TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      max_trades INTEGER DEFAULT 10,
      admin_username VARCHAR(50) DEFAULT 'wasee',
      admin_password VARCHAR(100) DEFAULT 'AWais1133@',
      initial_balance NUMERIC(15, 2) DEFAULT 10000.00,
      overall_drawdown NUMERIC(5, 2) DEFAULT 0.00,
      max_equity_peak NUMERIC(15, 2) DEFAULT 10000.00,
      mt5_login BIGINT DEFAULT 0
    )`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS account_mode VARCHAR(20) DEFAULT 'PROP_FIRM'`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS leverage INTEGER DEFAULT 5`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS risk_percent NUMERIC(5,2) DEFAULT 1.00`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS max_margin_pct NUMERIC(5,2) DEFAULT 80.00`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS max_sl_pct NUMERIC(5,2) DEFAULT 1.20`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS halt_drawdown_limit NUMERIC(5,2) DEFAULT 3.50`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS max_drawdown_limit NUMERIC(5,2) DEFAULT 4.00`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS guardian_shield_pct NUMERIC(5,2) DEFAULT 1.80`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session_guard_enabled BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session_start_hour NUMERIC(4,2) DEFAULT 12.00`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session_end_hour NUMERIC(4,2) DEFAULT 16.00`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session2_enabled BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session2_start_hour NUMERIC(4,2) DEFAULT 18.00`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS session2_end_hour NUMERIC(4,2) DEFAULT 22.00`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS is_bot_running BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS metrics_reset_at TIMESTAMP DEFAULT NULL`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS knife_protection_enabled BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS obi_enabled BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS volatility_filter_enabled BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE bot_state ADD COLUMN IF NOT EXISTS favorite_pairs TEXT DEFAULT '[]'`,
    `CREATE TABLE IF NOT EXISTS signals (
      id SERIAL PRIMARY KEY,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      symbol_a VARCHAR(50) NOT NULL,
      symbol_b VARCHAR(50) NOT NULL,
      price_a NUMERIC(20, 8) NOT NULL,
      price_b NUMERIC(20, 8) NOT NULL,
      beta NUMERIC(15, 5) NOT NULL,
      alpha NUMERIC(15, 5) NOT NULL,
      z_score NUMERIC(10, 4) NOT NULL,
      obi NUMERIC(10, 4) NOT NULL,
      action VARCHAR(20) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS trades (
      ticket BIGINT PRIMARY KEY,
      symbol VARCHAR(50) NOT NULL,
      order_type VARCHAR(10) NOT NULL,
      lots NUMERIC(18, 6) NOT NULL,
      entry_price NUMERIC(20, 8) NOT NULL,
      close_price NUMERIC(20, 8),
      sl NUMERIC(20, 8),
      tp NUMERIC(20, 8),
      profit NUMERIC(15, 2),
      entry_time TIMESTAMP NOT NULL,
      close_time TIMESTAMP,
      status VARCHAR(20) DEFAULT 'OPEN',
      comment VARCHAR(100),
      signal_id INTEGER REFERENCES signals(id),
      mt5_login BIGINT DEFAULT 0
    )`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS sl NUMERIC(20, 8)`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS tp NUMERIC(20, 8)`,
    `ALTER TABLE trades ADD COLUMN IF NOT EXISTS mt5_login BIGINT DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS fvg_zones (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(50) NOT NULL,
      zone_type VARCHAR(30) NOT NULL,
      low_price NUMERIC(20, 8) NOT NULL,
      high_price NUMERIC(20, 8) NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS daily_metrics (
      trading_date DATE NOT NULL,
      start_equity NUMERIC(15, 2) NOT NULL,
      current_equity NUMERIC(15, 2) NOT NULL,
      max_drawdown_percent NUMERIC(5, 2) DEFAULT 0.00,
      trades_today INTEGER DEFAULT 0,
      mt5_login BIGINT DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS trade_commands (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      lots NUMERIC(18, 6) NOT NULL,
      sl_pips NUMERIC(10, 4),
      tp_pips NUMERIC(10, 4),
      comment VARCHAR(100),
      status VARCHAR(20) DEFAULT 'PENDING',
      executed_at TIMESTAMP,
      error_msg TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS manual_commands (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(20) NOT NULL,
      direction VARCHAR(10) NOT NULL,
      lots NUMERIC(18, 6) NOT NULL,
      sl_pips NUMERIC(10, 4),
      tp_pips NUMERIC(10, 4),
      comment VARCHAR(100),
      status VARCHAR(20) DEFAULT 'PENDING',
      error_msg TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS scanned_assets (
      symbol_pair VARCHAR(100) PRIMARY KEY,
      price_a NUMERIC(20, 8),
      price_b NUMERIC(20, 8),
      win_rate NUMERIC(5, 2),
      z_score NUMERIC(10, 4),
      action VARCHAR(30),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS smc_telemetry (
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
    )`,
  ];

  const client = await pool.connect();
  try {
    for (const stmt of statements) {
      await client.query(stmt);
    }
    logger.info("Crypto Futures SMC Database tables & columns ready");
  } catch (err) {
    logger.error({ err }, "Failed to initialize database tables");
    throw err;
  } finally {
    client.release();
  }
}
