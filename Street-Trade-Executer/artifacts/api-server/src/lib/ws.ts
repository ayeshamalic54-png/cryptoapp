import { WebSocketServer, WebSocket } from "ws";
import type http from "http";
import { db } from "@workspace/db";
import {
  botStateTable,
  tradesTable,
  fvgZonesTable,
  scannedAssetsTable,
  smcTelemetryTable,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { logger } from "./logger";
import { formatCryptoPrice, resolveBinanceSymbol } from "./smcEngine";

let wss: WebSocketServer | null = null;

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

export function initWsServer(server: http.Server) {
  wss = new WebSocketServer({ server, path: "/api/ws" });

  wss.on("connection", (ws) => {
    logger.info("WS client connected");
    ws.on("close", () => logger.info("WS client disconnected"));
    ws.on("error", (err) => logger.warn({ err }, "WS client error"));
    void sendSnapshot(ws);
  });

  setInterval(() => {
    void broadcastAll();
  }, 1000);
  logger.info("WebSocket server active on /api/ws - broadcasting every 1s");
}

let cachedRecentTrades: any = null;
let lastTradesFetch = 0;

let cachedZoneRows: any = null;
let lastZonesFetch = 0;

let cachedTelemetryRows: any = null;
let lastTelemetryFetch = 0;

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

async function buildDashboardPayload() {
  const now = Date.now();

  if (!cachedRecentTrades || now - lastTradesFetch > 2500) {
    cachedRecentTrades = await db.select().from(tradesTable).orderBy(desc(tradesTable.entryTime)).limit(15);
    lastTradesFetch = now;
  }

  if (!cachedZoneRows || now - lastZonesFetch > 5000) {
    cachedZoneRows = await db.select().from(fvgZonesTable).orderBy(desc(fvgZonesTable.updatedAt)).limit(60);
    lastZonesFetch = now;
  }

  if (!cachedTelemetryRows || now - lastTelemetryFetch > 2500) {
    cachedTelemetryRows = await db.select().from(smcTelemetryTable);
    lastTelemetryFetch = now;
  }

  const [botStateRows, scannedAssetsRows] = await Promise.all([
    db.select().from(botStateTable).where(eq(botStateTable.id, 1)).limit(1),
    db.select().from(scannedAssetsTable).orderBy(desc(scannedAssetsTable.winRate)),
  ]);

  const botState = botStateRows[0];
  const isOnline =
    botState?.lastHeartbeat != null &&
    Date.now() - new Date(botState.lastHeartbeat).getTime() < 30_000;

  const activeSym = resolveBinanceSymbol(botState?.activePair ?? "BTCUSDT");

  const openPositions = cachedRecentTrades
    .filter((t: any) => t.status === "OPEN")
    .map((t: any) => ({
      ticket: Number(t.ticket),
      symbol: t.symbol,
      type: t.orderType,
      lots: Number(t.lots),
      entry: Number(t.entryPrice),
      current: Number(t.closePrice ?? t.entryPrice),
      sl: t.sl != null ? Number(t.sl) : 0,
      tp: t.tp != null ? Number(t.tp) : 0,
      profit: Number(t.profit ?? 0),
      comment: t.comment ?? "",
    }));

  const activeZones = cachedZoneRows.map((z: any) => {
    const meta = ZONE_META[z.zoneType] ?? { label: z.zoneType.toUpperCase(), bullish: true };
    const dir = meta.bullish ? "BULLISH" : "BEARISH";
    return {
      type: `${dir}_${meta.label}`,
      label: `${meta.bullish ? "🟢" : "🔴"} ${meta.label} - ${z.symbol}`,
      range: `${formatCryptoPrice(Number(z.lowPrice))}-${formatCryptoPrice(Number(z.highPrice))}`,
    };
  });

  const telemetryMap: Record<string, any> = {};
  for (const r of cachedTelemetryRows || []) {
    telemetryMap[String(r.symbol).toUpperCase()] = formatTelemetryRow(r);
  }
  const activeTelemetry = telemetryMap[activeSym] ?? Object.values(telemetryMap)[0] ?? null;

  return {
    systemStatus: botState?.systemStatus ?? "BOT OFFLINE",
    currentPair: activeSym,
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
    mt5Login: Number(botState?.mt5Login ?? 0),
    accountMode: String(botState?.accountMode ?? "PROP_FIRM"),
    leverage: Number(botState?.leverage ?? 5),
    riskPercent: Number(botState?.riskPercent ?? 1.0),
    maxMarginPct: Math.min(80, Number(botState?.maxMarginPct ?? 80)),
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
    recentTrades: cachedRecentTrades.map((t: any) => ({
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
    })),
    activeZones,
    scannedAssets: scannedAssetsRows
      .filter((s: any) => !String(s.symbolPair).includes("/"))
      .map((s: any) => ({
        symbolPair: s.symbolPair,
        priceA: Number(s.priceA ?? 0),
        priceB: Number(s.priceB ?? 0),
        winRate: Number(s.winRate ?? 0),
        zScore: Number(s.zScore ?? 0),
        action: s.action ?? "NEUTRAL",
      })),
    smcTelemetry: activeTelemetry,
    smcTelemetryAll: telemetryMap,
    botOnline: isOnline,
    autoExecute: botState?.autoExecute ?? true,
    cryptoEnabled: true,
    metalsEnabled: false,
    forexEnabled: false,
    indicesEnabled: false,
  };
}

async function sendSnapshot(ws: WebSocket) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    const data = await buildDashboardPayload();
    ws.send(JSON.stringify({ type: "dashboard", data }));
  } catch (err) {
    logger.warn({ err }, "WS snapshot error");
  }
}

async function broadcastAll() {
  if (!wss) return;
  const clients = [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN);
  if (!clients.length) return;
  try {
    const data = await buildDashboardPayload();
    const msg = JSON.stringify({ type: "dashboard", data });
    clients.forEach((c) => c.send(msg));
  } catch (err) {
    logger.warn({ err }, "WS broadcast error");
  }
}
