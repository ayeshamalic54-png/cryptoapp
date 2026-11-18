import {
  pgTable,
  serial,
  varchar,
  numeric,
  boolean,
  timestamp,
  date,
  bigint,
  text,
  integer,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

export const botStateTable = pgTable("bot_state", {
  id: serial("id").primaryKey(),
  activePair: varchar("active_pair", { length: 50 }).notNull().default("BTCUSDT"),
  systemStatus: varchar("system_status", { length: 50 }).notNull().default("BOT OFFLINE"),
  equity: numeric("equity", { precision: 15, scale: 2 }).default("0"),
  drawdownPercent: numeric("drawdown_percent", { precision: 5, scale: 2 }).default("0"),
  floatingProfit: numeric("floating_profit", { precision: 15, scale: 2 }).default("0"),
  zScore: numeric("z_score", { precision: 10, scale: 4 }).default("0"),
  hedgeRatio: numeric("hedge_ratio", { precision: 10, scale: 4 }).default("0"),
  obiA: numeric("obi_a", { precision: 10, scale: 4 }).default("0"),
  obiB: numeric("obi_b", { precision: 10, scale: 4 }).default("0"),
  tradesToday: integer("trades_today").default(0),
  slPips: numeric("sl_pips", { precision: 6, scale: 2 }).default("1.20"),
  tpPips: numeric("tp_pips", { precision: 6, scale: 2 }).default("2.40"),
  smcEnabled: boolean("smc_enabled").default(true),
  autoExecute: boolean("auto_execute").default(true),
  cryptoEnabled: boolean("crypto_enabled").default(true),
  metalsEnabled: boolean("metals_enabled").default(false),
  forexEnabled: boolean("forex_enabled").default(false),
  indicesEnabled: boolean("indices_enabled").default(false),
  riskLimitsEnabled: boolean("risk_limits_enabled").default(true),
  zEntryThreshold: numeric("z_entry_threshold", { precision: 4, scale: 2 }).default("0.00"),
  defaultLots: numeric("default_lots", { precision: 10, scale: 4 }).default("0.01"),
  lastHeartbeat: timestamp("last_heartbeat"),
  updatedAt: timestamp("updated_at").defaultNow(),
  maxTrades: integer("max_trades").default(10),
  adminUsername: varchar("admin_username", { length: 50 }).default("wasee"),
  adminPassword: varchar("admin_password", { length: 100 }).default("AWais1133@"),
  initialBalance: numeric("initial_balance", { precision: 15, scale: 2 }).default("10000.00"),
  overallDrawdown: numeric("overall_drawdown", { precision: 5, scale: 2 }).default("0.00"),
  maxEquityPeak: numeric("max_equity_peak", { precision: 15, scale: 2 }).default("10000.00"),
  mt5Login: bigint("mt5_login", { mode: "number" }).default(0),
  knifeProtectionEnabled: boolean("knife_protection_enabled").default(false),
  obiEnabled: boolean("obi_enabled").default(false),
  volatilityFilterEnabled: boolean("volatility_filter_enabled").default(false),
  // Pure Crypto Futures SMC + Dual Account Mode (Prop Firm / Personal) + Session Guard
  accountMode: varchar("account_mode", { length: 20 }).default("PROP_FIRM"),
  leverage: integer("leverage").default(5),
  riskPercent: numeric("risk_percent", { precision: 5, scale: 2 }).default("1.00"),
  maxMarginPct: numeric("max_margin_pct", { precision: 5, scale: 2 }).default("80.00"),
  maxSlPct: numeric("max_sl_pct", { precision: 5, scale: 2 }).default("1.20"),
  haltDrawdownLimit: numeric("halt_drawdown_limit", { precision: 5, scale: 2 }).default("3.50"),
  maxDrawdownLimit: numeric("max_drawdown_limit", { precision: 5, scale: 2 }).default("4.00"),
  guardianShieldPct: numeric("guardian_shield_pct", { precision: 5, scale: 2 }).default("1.80"),
  sessionGuardEnabled: boolean("session_guard_enabled").default(false),
  sessionStartHour: numeric("session_start_hour", { precision: 4, scale: 2 }).default("12.00"),
  sessionEndHour: numeric("session_end_hour", { precision: 4, scale: 2 }).default("16.00"),
  session2Enabled: boolean("session2_enabled").default(true),
  session2StartHour: numeric("session2_start_hour", { precision: 4, scale: 2 }).default("18.00"),
  session2EndHour: numeric("session2_end_hour", { precision: 4, scale: 2 }).default("22.00"),
  isBotRunning: boolean("is_bot_running").default(true),
  metricsResetAt: timestamp("metrics_reset_at"),
  favoritePairs: text("favorite_pairs").default("[]"),
});

export const tradesTable = pgTable("trades", {
  ticket: bigint("ticket", { mode: "number" }).primaryKey(),
  symbol: varchar("symbol", { length: 50 }).notNull(),
  orderType: varchar("order_type", { length: 10 }).notNull(),
  lots: numeric("lots", { precision: 18, scale: 6 }).notNull(),
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }).notNull(),
  closePrice: numeric("close_price", { precision: 20, scale: 8 }),
  sl: numeric("sl", { precision: 20, scale: 8 }),
  tp: numeric("tp", { precision: 20, scale: 8 }),
  profit: numeric("profit", { precision: 15, scale: 2 }),
  entryTime: timestamp("entry_time").notNull(),
  closeTime: timestamp("close_time"),
  status: varchar("status", { length: 20 }).default("OPEN"),
  comment: varchar("comment", { length: 100 }),
  signalId: integer("signal_id"),
  mt5Login: bigint("mt5_login", { mode: "number" }).default(0),
});

export const signalsTable = pgTable("signals", {
  id: serial("id").primaryKey(),
  timestamp: timestamp("timestamp").defaultNow(),
  symbolA: varchar("symbol_a", { length: 50 }).notNull(),
  symbolB: varchar("symbol_b", { length: 50 }).notNull(),
  priceA: numeric("price_a", { precision: 20, scale: 8 }).notNull(),
  priceB: numeric("price_b", { precision: 20, scale: 8 }).notNull(),
  beta: numeric("beta", { precision: 15, scale: 5 }).notNull(),
  alpha: numeric("alpha", { precision: 15, scale: 5 }).notNull(),
  zScore: numeric("z_score", { precision: 10, scale: 4 }).notNull(),
  obi: numeric("obi", { precision: 10, scale: 4 }).notNull(),
  action: varchar("action", { length: 20 }).notNull(),
});

export const fvgZonesTable = pgTable("fvg_zones", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 50 }).notNull(),
  zoneType: varchar("zone_type", { length: 30 }).notNull(),
  lowPrice: numeric("low_price", { precision: 20, scale: 8 }).notNull(),
  highPrice: numeric("high_price", { precision: 20, scale: 8 }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const dailyMetricsTable = pgTable("daily_metrics", {
  tradingDate: date("trading_date").primaryKey(),
  startEquity: numeric("start_equity", { precision: 15, scale: 2 }).notNull(),
  currentEquity: numeric("current_equity", { precision: 15, scale: 2 }).notNull(),
  maxDrawdownPercent: numeric("max_drawdown_percent", { precision: 5, scale: 2 }).default("0"),
  tradesToday: integer("trades_today").default(0),
  mt5Login: bigint("mt5_login", { mode: "number" }).default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const tradeCommandsTable = pgTable("trade_commands", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  direction: varchar("direction", { length: 10 }).notNull(),
  lots: numeric("lots", { precision: 18, scale: 6 }).notNull(),
  slPips: numeric("sl_pips", { precision: 10, scale: 4 }),
  tpPips: numeric("tp_pips", { precision: 10, scale: 4 }),
  comment: varchar("comment", { length: 100 }),
  status: varchar("status", { length: 20 }).default("PENDING"),
  executedAt: timestamp("executed_at"),
  errorMsg: text("error_msg"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const scannedAssetsTable = pgTable("scanned_assets", {
  symbolPair: varchar("symbol_pair", { length: 100 }).primaryKey(),
  priceA: numeric("price_a", { precision: 20, scale: 8 }),
  priceB: numeric("price_b", { precision: 20, scale: 8 }),
  winRate: numeric("win_rate", { precision: 5, scale: 2 }),
  zScore: numeric("z_score", { precision: 10, scale: 4 }),
  action: varchar("action", { length: 30 }),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const smcTelemetryTable = pgTable("smc_telemetry", {
  symbol: varchar("symbol", { length: 25 }).primaryKey(),
  m15Bias: varchar("m15_bias", { length: 30 }).default("NEUTRAL"),
  sweepStatus: varchar("sweep_status", { length: 80 }).default("FAIL"),
  sweepPrice: numeric("sweep_price", { precision: 20, scale: 8 }).default("0"),
  chochStatus: varchar("choch_status", { length: 80 }).default("FAIL"),
  chochPrice: numeric("choch_price", { precision: 20, scale: 8 }).default("0"),
  fvgStatus: varchar("fvg_status", { length: 80 }).default("FAIL"),
  fvgBoundsJson: text("fvg_bounds_json").default("{}"),
  retestStatus: varchar("retest_status", { length: 80 }).default("FAIL"),
  s6Status: varchar("s6_status", { length: 80 }).default("FAIL"),
  s7Status: varchar("s7_status", { length: 80 }).default("FAIL"),
  s8Status: varchar("s8_status", { length: 100 }).default(""),
  s9Status: varchar("s9_status", { length: 100 }).default(""),
  action: varchar("action", { length: 20 }).default("NONE"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Parse timestamp without timezone (type OID 1114) as UTC
pg.types.setTypeParser(1114, (str) => new Date(str + " UTC"));

const connectionString = process.env.DATABASE_URL;

export const pool = new pg.Pool({
  connectionString,
});

export const db = drizzle(pool);
