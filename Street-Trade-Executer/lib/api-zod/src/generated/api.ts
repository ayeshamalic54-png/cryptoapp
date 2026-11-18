/**
 * Crypto Futures SMC Terminal API Validation Schemas
 */
import * as zod from 'zod';

export const HealthCheckResponse = zod.object({
  "status": zod.string()
});

export const GetDashboardResponse = zod.object({
  "systemStatus": zod.string(),
  "currentPair": zod.string(),
  "lastUpdate": zod.string().nullish(),
  "equity": zod.number(),
  "drawdownPercent": zod.number(),
  "floatingProfit": zod.number(),
  "zScore": zod.number(),
  "hedgeRatio": zod.number(),
  "obiA": zod.number(),
  "obiB": zod.number(),
  "tradesToday": zod.number(),
  "maxTrades": zod.number(),
  "activePositions": zod.array(zod.object({
    "ticket": zod.number(),
    "symbol": zod.string(),
    "type": zod.string(),
    "lots": zod.number(),
    "entry": zod.number(),
    "current": zod.number().optional(),
    "sl": zod.number().optional(),
    "tp": zod.number().optional(),
    "profit": zod.number(),
    "comment": zod.string().optional()
  })),
  "recentTrades": zod.array(zod.object({
    "ticket": zod.number(),
    "symbol": zod.string(),
    "orderType": zod.string(),
    "lots": zod.number(),
    "entryPrice": zod.number(),
    "closePrice": zod.number().nullish(),
    "sl": zod.number().nullish(),
    "tp": zod.number().nullish(),
    "profit": zod.number().nullish(),
    "entryTime": zod.string(),
    "closeTime": zod.string().nullish(),
    "status": zod.string(),
    "comment": zod.string().nullish()
  })),
  "activeZones": zod.array(zod.object({
    "type": zod.string(),
    "label": zod.string(),
    "range": zod.string()
  })),
  "botOnline": zod.boolean(),
  "autoExecute": zod.boolean(),
  "scannedAssets": zod.array(zod.object({
    "symbolPair": zod.string(),
    "priceA": zod.number(),
    "priceB": zod.number(),
    "winRate": zod.number(),
    "zScore": zod.number(),
    "action": zod.string()
  }))
});

export const getTradesQueryLimitDefault = 50;
export const getTradesQueryStatusDefault = `ALL`;

export const GetTradesQueryParams = zod.object({
  "limit": zod.coerce.number().default(getTradesQueryLimitDefault),
  "status": zod.enum(['OPEN', 'CLOSED', 'ALL']).default(getTradesQueryStatusDefault)
});

export const GetTradesResponseItem = zod.object({
  "ticket": zod.number(),
  "symbol": zod.string(),
  "orderType": zod.string(),
  "lots": zod.number(),
  "entryPrice": zod.number(),
  "closePrice": zod.number().nullish(),
  "sl": zod.number().nullish(),
  "tp": zod.number().nullish(),
  "profit": zod.number().nullish(),
  "entryTime": zod.string(),
  "closeTime": zod.string().nullish(),
  "status": zod.string(),
  "comment": zod.string().nullish()
});
export const GetTradesResponse = zod.array(GetTradesResponseItem);

export const getSignalsQueryLimitDefault = 30;

export const GetSignalsQueryParams = zod.object({
  "limit": zod.coerce.number().default(getSignalsQueryLimitDefault)
});

export const GetSignalsResponseItem = zod.object({
  "id": zod.number(),
  "timestamp": zod.string(),
  "symbolA": zod.string(),
  "symbolB": zod.string(),
  "priceA": zod.number().optional(),
  "priceB": zod.number().optional(),
  "beta": zod.number().optional(),
  "alpha": zod.number().optional(),
  "zScore": zod.number(),
  "obi": zod.number().optional(),
  "action": zod.string(),
  "totalLots": zod.number().optional(),
  "totalProfit": zod.number().optional(),
  "trades": zod.array(zod.object({
    "ticket": zod.number().optional(),
    "symbol": zod.string().optional(),
    "lots": zod.number().optional(),
    "status": zod.string().optional(),
    "profit": zod.number().optional(),
    "comment": zod.string().optional()
  })).optional()
});
export const GetSignalsResponse = zod.array(GetSignalsResponseItem);

export const getMetricsQueryDaysDefault = 7;

export const GetMetricsQueryParams = zod.object({
  "days": zod.coerce.number().default(getMetricsQueryDaysDefault)
});

export const GetMetricsResponseItem = zod.object({
  "tradingDate": zod.string(),
  "startEquity": zod.number(),
  "currentEquity": zod.number(),
  "maxDrawdownPercent": zod.number(),
  "tradesToday": zod.number(),
  "pnl": zod.number()
});
export const GetMetricsResponse = zod.array(GetMetricsResponseItem);

export const GetMetricsSummaryResponse = zod.object({
  "totalTrades": zod.number(),
  "winningTrades": zod.number(),
  "losingTrades": zod.number(),
  "winRate": zod.number(),
  "totalPnl": zod.number(),
  "avgPnl": zod.number(),
  "bestTrade": zod.number(),
  "worstTrade": zod.number(),
  "maxDrawdown": zod.number()
});

export const GetConfigResponse = zod.object({
  "activePair": zod.string(),
  "symbolA": zod.string(),
  "symbolB": zod.string(),
  "zEntryThreshold": zod.number(),
  "maxDailyTrades": zod.number(),
  "maxDailyLossPercent": zod.number(),
  "requireSmcConfluence": zod.boolean(),
  "slPips": zod.number(),
  "tpPips": zod.number(),
  "smcEnabled": zod.boolean(),
  "autoExecute": zod.boolean(),
  "cryptoEnabled": zod.boolean(),
  "metalsEnabled": zod.boolean(),
  "forexEnabled": zod.boolean(),
  "indicesEnabled": zod.boolean(),
  "riskLimitsEnabled": zod.boolean(),
  "knifeProtectionEnabled": zod.boolean().optional(),
  "obiEnabled": zod.boolean().optional(),
  "volatilityFilterEnabled": zod.boolean().optional(),
  "accountMode": zod.string().optional(),
  "leverage": zod.number().optional(),
  "riskPercent": zod.number().optional(),
  "maxMarginPct": zod.number().optional(),
  "maxSlPct": zod.number().optional(),
  "haltDrawdownLimit": zod.number().optional(),
  "maxDrawdownLimit": zod.number().optional(),
  "guardianShieldPct": zod.number().optional(),
  "sessionGuardEnabled": zod.boolean().optional(),
  "sessionStartHour": zod.number().optional(),
  "sessionEndHour": zod.number().optional(),
  "session2Enabled": zod.boolean().optional(),
  "session2StartHour": zod.number().optional(),
  "session2EndHour": zod.number().optional(),
  "isBotRunning": zod.boolean().optional()
});

export const UpdateConfigBody = zod.object({
  "activePair": zod.string().min(1),
  "slPips": zod.coerce.number().optional(),
  "tpPips": zod.coerce.number().optional(),
  "zEntryThreshold": zod.coerce.number().optional(),
  "smcEnabled": zod.boolean().optional(),
  "autoExecute": zod.boolean().optional(),
  "cryptoEnabled": zod.boolean().optional(),
  "metalsEnabled": zod.boolean().optional(),
  "forexEnabled": zod.boolean().optional(),
  "indicesEnabled": zod.boolean().optional(),
  "riskLimitsEnabled": zod.boolean().optional(),
  "defaultLots": zod.coerce.number().optional(),
  "maxDailyTrades": zod.coerce.number().optional(),
  "initialBalance": zod.coerce.number().optional(),
  "knifeProtectionEnabled": zod.boolean().optional(),
  "obiEnabled": zod.boolean().optional(),
  "volatilityFilterEnabled": zod.boolean().optional(),
  "accountMode": zod.enum(["PROP_FIRM", "PERSONAL"]).optional(),
  "leverage": zod.coerce.number().min(1).max(50).optional(),
  "riskPercent": zod.coerce.number().min(0.1).max(20).optional(),
  "maxMarginPct": zod.coerce.number().min(5).max(80).optional(),
  "maxSlPct": zod.coerce.number().min(0.2).max(10).optional(),
  "haltDrawdownLimit": zod.coerce.number().min(0.5).max(15).optional(),
  "maxDrawdownLimit": zod.coerce.number().min(1).max(20).optional(),
  "guardianShieldPct": zod.coerce.number().min(0.5).max(10).optional(),
  "sessionGuardEnabled": zod.boolean().optional(),
  "sessionStartHour": zod.coerce.number().optional(),
  "sessionEndHour": zod.coerce.number().optional(),
  "session2Enabled": zod.boolean().optional(),
  "session2StartHour": zod.coerce.number().optional(),
  "session2EndHour": zod.coerce.number().optional(),
});

export const UpdateConfigResponse = GetConfigResponse.extend({
  "defaultLots": zod.number().optional(),
  "initialBalance": zod.number().optional(),
});

export const ExecuteTradeBody = zod.object({
  "symbol": zod.string(),
  "direction": zod.enum(['BUY', 'SELL', 'CLOSE']),
  "lots": zod.coerce.number(),
  "slPips": zod.coerce.number().optional(),
  "tpPips": zod.coerce.number().optional(),
  "comment": zod.string().optional()
});

export const ExecuteTradeResponse = zod.object({
  "commandId": zod.number(),
  "symbol": zod.string(),
  "direction": zod.string(),
  "lots": zod.number(),
  "status": zod.string(),
  "message": zod.string()
});

export const GetPendingCommandsResponseItem = zod.object({
  "id": zod.number(),
  "symbol": zod.string(),
  "direction": zod.string(),
  "lots": zod.number(),
  "slPips": zod.number().nullish(),
  "tpPips": zod.number().nullish(),
  "comment": zod.string().nullish(),
  "status": zod.string(),
  "createdAt": zod.string()
});
export const GetPendingCommandsResponse = zod.array(GetPendingCommandsResponseItem);

export const getPricesQueryCategoryDefault = `all`;

export const GetPricesQueryParams = zod.object({
  "category": zod.enum(['forex', 'crypto', 'metals', 'stocks', 'all']).default(getPricesQueryCategoryDefault)
});

export const GetPricesResponseItem = zod.object({
  "symbol": zod.string(),
  "price": zod.number(),
  "change24h": zod.number().nullish(),
  "changePct24h": zod.number().nullish(),
  "category": zod.string(),
  "source": zod.string(),
  "updatedAt": zod.string()
});
export const GetPricesResponse = zod.array(GetPricesResponseItem);
