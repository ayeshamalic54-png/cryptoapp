import { Router } from "express";
import { db } from "@workspace/db";
import {
  tradesTable,
  botStateTable,
  fvgZonesTable,
  scannedAssetsTable,
  smcTelemetryTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { analyzeLiveSmcTelemetry, formatCryptoPrice, parseFavoritePairs, resolveBinanceSymbol } from "../lib/smcEngine";
import { fetchBinanceKlinesWithMeta, getSymbolMarketType, resolveLiveBinanceSymbol } from "./binance";
import { fetchLivePriceMap } from "./prices";

const router = Router();

const ZONE_META: Record<string, { label: string; bullish: boolean }> = {
  bullish_ob: { label: "OB", bullish: true },
  bearish_ob: { label: "OB", bullish: false },
  bullish_fvg: { label: "FVG", bullish: true },
  bearish_fvg: { label: "FVG", bullish: false },
  bullish_breaker: { label: "BREAKER", bullish: true },
  bearish_breaker: { label: "BREAKER", bullish: false },
  bullish_ifvg: { label: "iFVG", bullish: true },
  bearish_ifvg: { label: "iFVG", bullish: false },
};

function formatTelemetryRow(row: any) {
  return {
    symbol: row.symbol,
    m15_bias: row.m15Bias ?? "NEUTRAL ⚪",
    sweep_status: row.sweepStatus ?? "FAIL ⚪",
    sweep_price: Number(row.sweepPrice ?? 0),
    choch_status: row.chochStatus ?? "FAIL ⚪",
    choch_price: Number(row.chochPrice ?? 0),
    fvg_status: row.fvgStatus ?? "FAIL ⚪",
    fvg_bounds_json: row.fvgBoundsJson ?? "{}",
    retest_status: row.retestStatus ?? "FAIL ⚪",
    s6_status: row.s6Status ?? "FAIL ⚪",
    s7_status: row.s7Status ?? "FAIL ⚪",
    s8_status: row.s8Status ?? "",
    s9_status: row.s9Status ?? "",
    action: row.action ?? "NONE",
    updatedAt: row.updatedAt?.toISOString?.() ?? new Date().toISOString(),
  };
}

function hasCandlesInTelemetry(rawJson: unknown): boolean {
  try {
    const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    return Array.isArray((parsed as any)?.candles) && (parsed as any).candles.length >= 8;
  } catch {
    return false;
  }
}

router.get("/dashboard", async (req, res) => {
  try {
    const [
      botStateRows,
      openDbTrades,
      recentClosedTradesRows,
      zoneRows,
      scannedAssetsRows,
      closedTradesSumRows,
      telemetryRows,
      livePriceMap,
    ] = await Promise.all([
      db.select().from(botStateTable).where(eq(botStateTable.id, 1)).limit(1),
      db.select().from(tradesTable).where(eq(tradesTable.status, "OPEN")),
      db.select().from(tradesTable).where(eq(tradesTable.status, "CLOSED")).orderBy(desc(tradesTable.entryTime)).limit(20),
      db.select().from(fvgZonesTable).orderBy(desc(fvgZonesTable.updatedAt)).limit(250),
      db.select().from(scannedAssetsTable).orderBy(desc(scannedAssetsTable.winRate)),
      db.select({ profit: tradesTable.profit }).from(tradesTable).where(eq(tradesTable.status, "CLOSED")),
      db.select().from(smcTelemetryTable),
      fetchLivePriceMap(),
    ]);

    const botState = botStateRows[0];
    const activeSym = resolveBinanceSymbol(botState?.activePair ?? "BTCUSDT");
    const resetAtMs = botState?.metricsResetAt ? new Date(botState.metricsResetAt).getTime() : 0;

    const totalClosedProfit = closedTradesSumRows.reduce((sum, t) => sum + Number(t.profit ?? 0), 0);
    const isOnline =
      botState?.lastHeartbeat != null &&
      Date.now() - new Date(botState.lastHeartbeat).getTime() < 30_000;

    const openPositions = openDbTrades.map((t) => {
      const symU = String(t.symbol || "").toUpperCase();
      const liveMark = livePriceMap[symU];
      return {
        ticket: Number(t.ticket),
        symbol: t.symbol,
        type: t.orderType,
        lots: Number(t.lots),
        entry: Number(t.entryPrice),
        current: liveMark && liveMark > 0 ? liveMark : Number(t.closePrice ?? t.entryPrice),
        sl: t.sl != null ? Number(t.sl) : 0,
        tp: t.tp != null ? Number(t.tp) : 0,
        profit: Number(t.profit ?? 0),
        comment: t.comment ?? "",
      };
    });

    const recentClosedTrades = recentClosedTradesRows
      .filter((t) => !resetAtMs || (t.closeTime ? t.closeTime.getTime() >= resetAtMs : t.entryTime.getTime() >= resetAtMs))
      .map((t) => ({
        ticket: Number(t.ticket),
        symbol: t.symbol,
        orderType: t.orderType,
        lots: Number(t.lots),
        entryPrice: Number(t.entryPrice),
        closePrice: t.closePrice != null ? Number(t.closePrice) : null,
        sl: t.sl != null ? Number(t.sl) : null,
        tp: t.tp != null ? Number(t.tp) : null,
        profit: t.profit != null ? Number(t.profit) : null,
        entryTime: t.entryTime.toISOString(),
        closeTime: t.closeTime?.toISOString() ?? null,
        status: t.status,
        comment: t.comment ?? null,
      }));

    const activeZones = zoneRows.map((z) => {
      const meta = ZONE_META[z.zoneType] ?? { label: z.zoneType.toUpperCase(), bullish: true };
      const dir = meta.bullish ? "BULLISH" : "BEARISH";
      return {
        type: `${dir}_${meta.label}`,
        label: `${meta.bullish ? "🟢" : "🔴"} ${meta.label} - ${z.symbol}`,
        range: `${formatCryptoPrice(Number(z.lowPrice))}-${formatCryptoPrice(Number(z.highPrice))}`,
      };
    });

    const telemetryMap: Record<string, any> = {};
    for (const r of telemetryRows) {
      telemetryMap[String(r.symbol).toUpperCase()] = formatTelemetryRow(r);
    }
    const activeTelemetry = telemetryMap[activeSym] ?? Object.values(telemetryMap)[0] ?? null;

    return res.json({
      systemStatus: botState?.systemStatus ?? "BOT OFFLINE",
      currentPair: activeSym,
      favoritePairs: parseFavoritePairs((botState as any)?.favoritePairs),
      lastUpdate: botState?.updatedAt?.toISOString() ?? null,
      equity: Number(botState?.equity ?? 0),
      drawdownPercent: Number(botState?.drawdownPercent ?? 0),
      floatingProfit: Number(botState?.floatingProfit ?? 0),
      zScore: 0,
      hedgeRatio: Number(botState?.leverage ?? 5),
      obiA: 0,
      obiB: 0,
      tradesToday: botState?.tradesToday ?? 0,
      maxTrades: Number(botState?.maxTrades ?? 10),
      initialBalance: Number(botState?.initialBalance ?? 10000),
      overallDrawdown: Number(botState?.overallDrawdown ?? 0),
      maxEquityPeak: Number(botState?.maxEquityPeak ?? 10000),
      totalClosedProfit: Number(totalClosedProfit.toFixed(2)),
      mt5Login: Number(botState?.mt5Login ?? 0),
      accountMode: String(botState?.accountMode ?? "PROP_FIRM"),
      leverage: Number(botState?.leverage ?? 5),
      riskPercent: Number(botState?.riskPercent ?? 1.0),
      maxMarginPct:
        String(botState?.accountMode ?? "PROP_FIRM").toUpperCase() === "PERSONAL"
          ? Math.min(100, Number(botState?.maxMarginPct ?? 100))
          : Math.min(80, Number(botState?.maxMarginPct ?? 80)),
      maxSlPct: Number(botState?.maxSlPct ?? 1.2),
      haltDrawdownLimit: Number(botState?.haltDrawdownLimit ?? 3.5),
      maxDrawdownLimit: Number(botState?.maxDrawdownLimit ?? 4.0),
      guardianShieldPct: Number(botState?.guardianShieldPct ?? 1.8),
      sessionGuardEnabled: Boolean(botState?.sessionGuardEnabled ?? false),
      sessionStartHour: Number(botState?.sessionStartHour ?? 12),
      sessionEndHour: Number(botState?.sessionEndHour ?? 16),
      session2Enabled: Boolean(botState?.session2Enabled ?? true),
      session2StartHour: Number(botState?.session2StartHour ?? 18),
      session2EndHour: Number(botState?.session2EndHour ?? 22),
      isBotRunning: Boolean(botState?.isBotRunning ?? true),
      activePositions: openPositions,
      recentTrades: recentClosedTrades,
      activeZones,
      scannedAssets: scannedAssetsRows
        .filter((s) => !String(s.symbolPair).includes("/"))
        .map((s) => {
          const symU = String(s.symbolPair).toUpperCase();
          const liveMark = livePriceMap[symU];
          return {
            symbolPair: s.symbolPair,
            priceA: liveMark && liveMark > 0 ? liveMark : Number(s.priceA ?? 0),
            priceB: Number(s.priceB ?? 0),
            winRate: Number(s.winRate ?? 0),
            zScore: Number(s.zScore ?? 0),
            action: s.action ?? "NEUTRAL",
          };
        }),
      livePrices: livePriceMap,
      smcTelemetry: activeTelemetry,
      smcTelemetryAll: telemetryMap,
      botOnline: isOnline,
      autoExecute: botState?.autoExecute ?? true,
      cryptoEnabled: true,
      metalsEnabled: false,
      forexEnabled: false,
      indicesEnabled: false,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get dashboard data");
    return res.status(500).json({ error: "Failed to get dashboard data" });
  }
});

router.get("/smc_telemetry", async (req, res) => {
  try {
    const requestedSym = req.query.symbol ? resolveBinanceSymbol(String(req.query.symbol)) : null;
    const [rows, livePriceMap] = await Promise.all([
      db.select().from(smcTelemetryTable),
      fetchLivePriceMap(),
    ]);
    if (requestedSym) {
      const resolvedSym = await resolveLiveBinanceSymbol(requestedSym);
      const dbMatch = rows.find((r) => String(r.symbol).toUpperCase() === requestedSym || String(r.symbol).toUpperCase() === resolvedSym);
      const ageMs = dbMatch?.updatedAt ? Date.now() - new Date(dbMatch.updatedAt).getTime() : Infinity;
      const liveTicker = livePriceMap[resolvedSym] ?? livePriceMap[requestedSym] ?? 0;
      const dbHasCandles = dbMatch ? hasCandlesInTelemetry(dbMatch.fvgBoundsJson) : false;

      if (dbMatch && ageMs < 45_000 && dbHasCandles) {
        const [dbZones, marketType] = await Promise.all([
          db
            .select()
            .from(fvgZonesTable)
            .where(eq(fvgZonesTable.symbol, dbMatch.symbol)),
          getSymbolMarketType(resolvedSym),
        ]);
        const mappedZones = dbZones.map((z) => {
          const meta = ZONE_META[z.zoneType] ?? { label: z.zoneType.toUpperCase(), bullish: true };
          const dir = meta.bullish ? "BULLISH" : "BEARISH";
          return {
            type: `${dir}_${meta.label}`,
            label: `${meta.bullish ? "🟢" : "🔴"} ${meta.label} - ${z.symbol}`,
            range: `${formatCryptoPrice(Number(z.lowPrice))}-${formatCryptoPrice(Number(z.highPrice))}`,
          };
        });
        return res.json({
          telemetry: formatTelemetryRow(dbMatch),
          activeZones: mappedZones,
          livePrice: liveTicker || undefined,
          resolvedSymbol: dbMatch.symbol,
          marketType,
          source: "db",
        });
      }

      // On-demand live Binance SMC computation (Futures Testnet/Mainnet + Vision CDN fallback)
      const [m5Res, m15Res] = await Promise.all([
        fetchBinanceKlinesWithMeta(resolvedSym, "5m", 100),
        fetchBinanceKlinesWithMeta(resolvedSym, "15m", 80),
      ]);
      if (m5Res.bars.length === 0 && dbMatch && dbHasCandles) {
        const dbZones = await db
          .select()
          .from(fvgZonesTable)
          .where(eq(fvgZonesTable.symbol, dbMatch.symbol));
        const mappedZones = dbZones.map((z) => {
          const meta = ZONE_META[z.zoneType] ?? { label: z.zoneType.toUpperCase(), bullish: true };
          const dir = meta.bullish ? "BULLISH" : "BEARISH";
          return {
            type: `${dir}_${meta.label}`,
            label: `${meta.bullish ? "🟢" : "🔴"} ${meta.label} - ${z.symbol}`,
            range: `${formatCryptoPrice(Number(z.lowPrice))}-${formatCryptoPrice(Number(z.highPrice))}`,
          };
        });
        return res.json({
          telemetry: formatTelemetryRow(dbMatch),
          activeZones: mappedZones,
          livePrice: liveTicker || undefined,
          resolvedSymbol: dbMatch.symbol,
          marketType: m5Res.marketType,
          source: "db_fallback",
        });
      }

      const botRow = (await db.select().from(botStateTable).limit(1))[0];
      const live = analyzeLiveSmcTelemetry(
        m5Res.resolvedSymbol,
        m5Res.bars,
        m15Res.bars,
        Number(botRow?.maxSlPct ?? 1.2),
        Number(botRow?.leverage ?? 5)
      );
      return res.json({
        telemetry: live.telemetry,
        activeZones: live.activeZones,
        livePrice: liveTicker || live.livePrice,
        resolvedSymbol: m5Res.resolvedSymbol,
        marketType: m5Res.marketType,
        source: "binance_live",
      });
    }

    const out: Record<string, any> = {};
    for (const r of rows) {
      out[String(r.symbol).toUpperCase()] = formatTelemetryRow(r);
    }
    return res.json(out);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch smc_telemetry");
    return res.status(500).json({ error: "Failed to fetch smc_telemetry" });
  }
});

export default router;
