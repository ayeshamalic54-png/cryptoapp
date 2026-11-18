export interface HealthStatus {
  status: string;
}

export interface Position {
  ticket: number;
  symbol: string;
  type: string;
  lots: number;
  entry: number;
  current?: number;
  sl?: number;
  tp?: number;
  profit: number;
  comment?: string;
}

export interface Trade {
  ticket: number;
  symbol: string;
  orderType: string;
  lots: number;
  entryPrice: number;
  closePrice?: number | null;
  sl?: number | null;
  tp?: number | null;
  profit?: number | null;
  entryTime: string;
  closeTime?: string | null;
  status: string;
  comment?: string | null;
}

export interface Zone {
  type: string;
  label: string;
  range: string;
}

export interface ScannedAsset {
  symbolPair: string;
  priceA: number;
  priceB: number;
  winRate: number;
  zScore: number;
  action: string;
}

export interface DashboardData {
  systemStatus: string;
  currentPair: string;
  lastUpdate?: string | null;
  equity: number;
  drawdownPercent: number;
  floatingProfit: number;
  zScore: number;
  hedgeRatio: number;
  obiA: number;
  obiB: number;
  tradesToday: number;
  maxTrades: number;
  activePositions: Position[];
  recentTrades: Trade[];
  activeZones: Zone[];
  botOnline: boolean;
  autoExecute: boolean;
  scannedAssets: ScannedAsset[];
  cryptoEnabled?: boolean;
  metalsEnabled?: boolean;
  forexEnabled?: boolean;
  indicesEnabled?: boolean;
  initialBalance?: number;
  overallDrawdown?: number;
  maxEquityPeak?: number;
  mt5Login?: number;
  accountMode?: "PROP_FIRM" | "PERSONAL" | string;
  leverage?: number;
  riskPercent?: number;
  maxMarginPct?: number;
  maxSlPct?: number;
  haltDrawdownLimit?: number;
  maxDrawdownLimit?: number;
  guardianShieldPct?: number;
  sessionGuardEnabled?: boolean;
  sessionStartHour?: number;
  sessionEndHour?: number;
  session2Enabled?: boolean;
  session2StartHour?: number;
  session2EndHour?: number;
  isBotRunning?: boolean;
  smcTelemetry?: Record<string, any> | null;
  smcTelemetryAll?: Record<string, any>;
}

export type SignalTradesItem = {
  ticket?: number;
  symbol?: string;
  lots?: number;
  status?: string;
  profit?: number;
  comment?: string;
};

export interface Signal {
  id: number;
  timestamp: string;
  symbolA: string;
  symbolB: string;
  priceA?: number;
  priceB?: number;
  beta?: number;
  alpha?: number;
  zScore: number;
  obi?: number;
  action: string;
  totalLots?: number;
  totalProfit?: number;
  trades?: SignalTradesItem[];
}

export interface DailyMetric {
  tradingDate: string;
  startEquity: number;
  currentEquity: number;
  maxDrawdownPercent: number;
  tradesToday: number;
  wins?: number;
  losses?: number;
  pnl: number;
}

export interface MetricsSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  bestTrade: number;
  worstTrade: number;
  maxDrawdown: number;
}

export interface BotConfig {
  activePair: string;
  symbolA: string;
  symbolB: string;
  zEntryThreshold: number;
  maxDailyTrades: number;
  maxDailyLossPercent: number;
  requireSmcConfluence: boolean;
  slPips: number;
  tpPips: number;
  smcEnabled: boolean;
  autoExecute: boolean;
  cryptoEnabled: boolean;
  metalsEnabled: boolean;
  forexEnabled: boolean;
  indicesEnabled: boolean;
  riskLimitsEnabled: boolean;
  defaultLots?: number;
  initialBalance?: number;
  knifeProtectionEnabled?: boolean;
  obiEnabled?: boolean;
  volatilityFilterEnabled?: boolean;
  accountMode?: "PROP_FIRM" | "PERSONAL" | string;
  leverage?: number;
  riskPercent?: number;
  maxMarginPct?: number;
  maxSlPct?: number;
  haltDrawdownLimit?: number;
  maxDrawdownLimit?: number;
  guardianShieldPct?: number;
  sessionGuardEnabled?: boolean;
  sessionStartHour?: number;
  sessionEndHour?: number;
  session2Enabled?: boolean;
  session2StartHour?: number;
  session2EndHour?: number;
  isBotRunning?: boolean;
}

export interface BotConfigInput {
  activePair: string;
  slPips?: number;
  tpPips?: number;
  zEntryThreshold?: number;
  smcEnabled?: boolean;
  autoExecute?: boolean;
  cryptoEnabled?: boolean;
  metalsEnabled?: boolean;
  forexEnabled?: boolean;
  indicesEnabled?: boolean;
  riskLimitsEnabled?: boolean;
  defaultLots?: number;
  maxDailyTrades?: number;
  initialBalance?: number;
  knifeProtectionEnabled?: boolean;
  obiEnabled?: boolean;
  volatilityFilterEnabled?: boolean;
  accountMode?: "PROP_FIRM" | "PERSONAL";
  leverage?: number;
  riskPercent?: number;
  maxMarginPct?: number;
  maxSlPct?: number;
  haltDrawdownLimit?: number;
  maxDrawdownLimit?: number;
  guardianShieldPct?: number;
  sessionGuardEnabled?: boolean;
  sessionStartHour?: number;
  sessionEndHour?: number;
  session2Enabled?: boolean;
  session2StartHour?: number;
  session2EndHour?: number;
}

export type ManualTradeRequestDirection = typeof ManualTradeRequestDirection[keyof typeof ManualTradeRequestDirection];

export const ManualTradeRequestDirection = {
  BUY: 'BUY',
  SELL: 'SELL',
  CLOSE: 'CLOSE',
} as const;

export interface ManualTradeRequest {
  symbol: string;
  direction: ManualTradeRequestDirection;
  lots: number;
  slPips?: number;
  tpPips?: number;
  comment?: string;
}

export interface ManualTradeResponse {
  commandId: number;
  symbol: string;
  direction: string;
  lots: number;
  status: string;
  message: string;
}

export interface TradeCommand {
  id: number;
  symbol: string;
  direction: string;
  lots: number;
  slPips?: number | null;
  tpPips?: number | null;
  comment?: string | null;
  status: string;
  createdAt: string;
}

export interface MarketPrice {
  symbol: string;
  price: number;
  change24h?: number | null;
  changePct24h?: number | null;
  category: string;
  source: string;
  updatedAt: string;
}

export type GetTradesParams = {
  limit?: number;
  status?: GetTradesStatus;
};

export type GetTradesStatus = typeof GetTradesStatus[keyof typeof GetTradesStatus];

export const GetTradesStatus = {
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  ALL: 'ALL',
} as const;

export type GetSignalsParams = {
  limit?: number;
};

export type GetMetricsParams = {
  days?: number;
};

export type GetPricesParams = {
  category?: GetPricesCategory;
};

export type GetPricesCategory = typeof GetPricesCategory[keyof typeof GetPricesCategory];

export const GetPricesCategory = {
  forex: 'forex',
  crypto: 'crypto',
  metals: 'metals',
  stocks: 'stocks',
  all: 'all',
} as const;
