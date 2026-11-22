/**
 * Direct Cloud Crypto USDT-M Futures Execution & 10-Coin Pure 9-Step SMC Worker.
 * Runs directly inside the Render Web Service (NO Windows VPS required!).
 * Handles:
 *   - Binance Futures Testnet / Mainnet HMAC-SHA256 signed requests + server time sync
 *   - Top 10 volatile coins + custom pinned coin M15+M5 Pure 9-Step SMC scanning
 *   - Dual Account Mode: Blue Guardian Prop Firm vs Personal ($50-$300+ USDT)
 *   - Strict <= 80% Max Margin Cap + Binance MIN_NOTIONAL safety check
 *   - Single Direct Market Order + Server-Side Conditional STOP_MARKET SL & TAKE_PROFIT_MARKET TP
 *   - One-Time Fee-Aware Breakeven (+1.0R / 60m stagnation, +/-0.12% buffer)
 *   - Live position sync, closed UserTrades reconciliation & Rich Discord Signal Alerts
 */
import crypto from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  analyzeLiveSmcTelemetry,
  computeFeeAdjustedRiskDist,
  formatCryptoPrice,
  parseFavoritePairs,
  resolveBinanceSymbol,
} from "./smcEngine";
import { fetchBinanceKlines, isSymbolTradableOnVenue, resolveLiveBinanceSymbol, TOP_10_CRYPTO_COINS } from "../routes/binance";
import { postDiscordPayload, sendDiscordCryptoCloseAlert, sendDiscordCryptoSignalAlert } from "./discord";
import { getHostCooldownState, recordBinanceResponse } from "./binanceRateLimit";
import { logger } from "./logger";

interface SymbolFilter {
  symbol: string;
  stepSize: number;
  tickSize: number;
  minQty: number;
  minNotional: number;
}

const filterCache = new Map<string, { ts: number; filter: SymbolFilter }>();
const leverageCache = new Map<string, number>();
const beLockedTickets = new Set<number>();
const tpSyncedTickets = new Set<number>();
const peakFloatingMap = new Map<number, number>();
const closeConfirmCount = new Map<string, number>();
const tradeCooldown = new Map<string, number>();
const signalCooldown = new Map<string, number>();
const usedSweepKeys = new Map<string, number>();

export function triggerFastCycleNow() {
  void runFastCycle();
}

let timeOffsetMs = 0;
let timeSynced = false;
let isFastTickRunning = false;
let isScanTickRunning = false;
let started = false;
let peakEquityTracker = 0;
let lastSyncedConfigLev = 0;
let didInitialLedgerReconcile = false;

function isTestnet(): boolean {
  return ["true", "1", "yes"].includes((process.env.USE_BINANCE_TESTNET || "").trim().toLowerCase());
}

function getBaseUrl(): string {
  return isTestnet() ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
}

function getApiCreds(): { key: string; secret: string } {
  return {
    key: (process.env.BINANCE_API_KEY || "").trim(),
    secret: (process.env.BINANCE_API_SECRET || "").trim(),
  };
}

function hasApiCreds(): boolean {
  const c = getApiCreds();
  return Boolean(c.key && c.secret);
}

async function syncBinanceTime() {
  try {
    const r = await fetch(`${getBaseUrl()}/fapi/v1/time`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const data = (await r.json()) as { serverTime?: number };
      if (data.serverTime) {
        timeOffsetMs = data.serverTime - Date.now();
        timeSynced = true;
      }
    }
  } catch {}
}

async function signedBinanceRequest(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  params: Record<string, string | number | boolean> = {}
): Promise<{ status: number; ok: boolean; data: any; text: string }> {
  const { key, secret } = getApiCreds();
  if (!key || !secret) {
    return { status: 0, ok: false, data: null, text: "Missing Binance API keys" };
  }
  const base = getBaseUrl();
  const cd = getHostCooldownState(base);
  if (cd.coolingDown) {
    return {
      status: cd.status || 429,
      ok: false,
      data: null,
      text: `Binance rate-limit cooldown active (${Math.ceil(cd.remainingMs / 1000)}s remaining)`,
    };
  }
  if (!timeSynced) await syncBinanceTime();

  const buildUrl = () => {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) usp.set(k, String(v));
    usp.set("timestamp", String(Date.now() + timeOffsetMs));
    usp.set("recvWindow", "10000");
    const qs = usp.toString();
    const sig = crypto.createHmac("sha256", secret).update(qs).digest("hex");
    return `${base}${endpoint}?${qs}&signature=${sig}`;
  };

  try {
    const reqUrl = buildUrl();
    let resp = await fetch(reqUrl, {
      method,
      headers: { "X-MBX-APIKEY": key },
      signal: AbortSignal.timeout(10000),
    });
    recordBinanceResponse(
      reqUrl,
      resp.status,
      resp.headers.get("retry-after"),
      resp.headers.get("x-mbx-used-weight-1m")
    );
    let text = await resp.text();
    if (resp.status === 400 && text.includes("-1021")) {
      await syncBinanceTime();
      const retryUrl = buildUrl();
      resp = await fetch(retryUrl, {
        method,
        headers: { "X-MBX-APIKEY": key },
        signal: AbortSignal.timeout(10000),
      });
      recordBinanceResponse(
        retryUrl,
        resp.status,
        resp.headers.get("retry-after"),
        resp.headers.get("x-mbx-used-weight-1m")
      );
      text = await resp.text();
    }
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: resp.status, ok: resp.ok, data, text };
  } catch (err: any) {
    return { status: 504, ok: false, data: null, text: err?.message || "Binance request timeout" };
  }
}

export async function getSymbolFilters(symbol: string): Promise<SymbolFilter> {
  const sym = await resolveLiveBinanceSymbol(symbol);
  const cached = filterCache.get(sym);
  if (cached && Date.now() - cached.ts < 600_000) return cached.filter;

  for (const base of [...new Set(["https://fapi.binance.com", getBaseUrl()])]) {
    if (getHostCooldownState(base).coolingDown) continue;
    try {
      const r = await fetch(`${base}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(8000) });
      recordBinanceResponse(base, r.status, r.headers.get("retry-after"), r.headers.get("x-mbx-used-weight-1m"));
      if (!r.ok) continue;
      const json = (await r.json()) as { symbols?: any[] };
      if (!Array.isArray(json.symbols) || json.symbols.length === 0) continue;
      for (const s of json.symbols) {
        const fmap: Record<string, any> = {};
        for (const f of s.filters || []) fmap[f.filterType] = f;
        const entry: SymbolFilter = {
          symbol: s.symbol,
          stepSize: parseFloat(fmap.LOT_SIZE?.stepSize || "0.001") || 0.001,
          tickSize: parseFloat(fmap.PRICE_FILTER?.tickSize || "0.01") || 0.01,
          minQty: parseFloat(fmap.LOT_SIZE?.minQty || "0.001") || 0.001,
          minNotional: parseFloat(fmap.MIN_NOTIONAL?.notional || fmap.MIN_NOTIONAL?.minNotional || "5") || 5,
        };
        filterCache.set(s.symbol, { ts: Date.now(), filter: entry });
      }
      if (filterCache.get(sym)) break;
    } catch {}
  }

  return (
    filterCache.get(sym)?.filter || {
      symbol: sym,
      stepSize: 0.001,
      tickSize: 0.01,
      minQty: 0.001,
      minNotional: 5,
    }
  );
}

function quantizeStep(val: number, step: number, up = false): number {
  if (val <= 0) return 0;
  if (step <= 0) return val;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const scaled = val / step;
  const rounded = up ? Math.ceil(scaled - 1e-9) * step : Math.floor(scaled + 1e-9) * step;
  return Number(rounded.toFixed(decimals));
}

function quantizeTick(price: number, tick: number): number {
  if (tick <= 0) return price;
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  const rounded = Math.round(price / tick) * tick;
  return Number(rounded.toFixed(decimals));
}

async function ensureLeverage(symbol: string, targetLev: number, force = false): Promise<number> {
  const lev = Math.max(1, Math.min(50, Math.round(targetLev || 5)));
  const symU = symbol.toUpperCase();
  if (!force && leverageCache.get(symU) === lev) return lev;
  for (const cand of [...new Set([lev, Math.min(lev, 20), Math.min(lev, 10), Math.min(lev, 5), 1])]) {
    const res = await signedBinanceRequest("POST", "/fapi/v1/leverage", { symbol: symU, leverage: cand });
    if (res.ok) {
      const actual = Number(res.data?.leverage ?? cand);
      leverageCache.set(symU, actual);
      return actual;
    }
    logger.warn({ symbol: symU, cand, status: res.status, body: res.text.slice(0, 120) }, "Binance set leverage retry");
  }
  return lev;
}

export async function syncLeverageAcrossCoins(targetLev: number, extraSymbol?: string): Promise<void> {
  if (!hasApiCreds()) return;
  const lev = Math.max(1, Math.min(50, Math.round(targetLev || 5)));
  const list = [...TOP_10_CRYPTO_COINS];
  if (extraSymbol) {
    const res = await resolveLiveBinanceSymbol(extraSymbol);
    if (res && !list.includes(res)) list.push(res);
  }
  leverageCache.clear();
  for (const sym of list) {
    await ensureLeverage(sym, lev, true);
  }
  lastSyncedConfigLev = lev;
  logger.info({ leverage: lev, symbols: list.length }, "Synced Binance Futures leverage across scanner coins");
}

const STABLECOIN_ASSETS = new Set(["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "USDP"]);

/**
 * Computes Futures walletBalance, equity, and available balance 1-to-1 with Binance Futures UI.
 * Uses top-level Binance `/fapi/v2/account` totals (`totalWalletBalance`, `totalMarginBalance`,
 * `availableBalance`) so Multi-Asset margin collateral (e.g. BTC + USDT + USDC on Testnet) and
 * live unrealized P&L match the Binance account screen cent-for-cent, falling back to stablecoin
 * sum only when top-level totals are unavailable.
 */
export function extractAccountSnapshotBalances(accData: any): { walletBalance: number; equity: number; avail: number } {
  const assets = Array.isArray(accData?.assets) ? accData.assets : [];
  const stableAssets = assets.filter((a: any) =>
    STABLECOIN_ASSETS.has(String(a?.asset || "").toUpperCase())
  );
  const stableWalletSum = stableAssets.reduce((sum: number, a: any) => sum + Number(a?.walletBalance ?? 0), 0);
  const unreal = Number(accData?.totalUnrealizedProfit ?? 0);

  const rawWallet = Number(accData?.totalWalletBalance ?? 0);
  const rawMarginBal = Number(accData?.totalMarginBalance ?? 0);
  const topAvail = Number(accData?.availableBalance ?? 0);
  const usdtAsset = stableAssets.find((a: any) => String(a?.asset || "").toUpperCase() === "USDT");
  const usdtAvail = Number(usdtAsset?.availableBalance ?? 0);

  if (rawMarginBal > 0 || rawWallet > 0) {
    const walletBal = rawWallet > 0 ? rawWallet : Math.max(0, rawMarginBal - unreal);
    const marginBal = rawMarginBal > 0 ? rawMarginBal : walletBal + unreal;
    const rawAvail = topAvail > 0 ? topAvail : usdtAvail > 0 ? usdtAvail : marginBal;
    const avail = Math.min(rawAvail, Math.max(0, marginBal));
    return {
      walletBalance: Number(walletBal.toFixed(2)),
      equity: Number(marginBal.toFixed(2)),
      avail: Number(avail.toFixed(2)),
    };
  }

  const fallbackWallet = stableWalletSum > 0 ? stableWalletSum : 0;
  const fallbackEq = fallbackWallet + unreal;
  const fallbackAvail = topAvail > 0 ? topAvail : usdtAvail > 0 ? usdtAvail : fallbackEq;
  return {
    walletBalance: Number(fallbackWallet.toFixed(2)),
    equity: Number(fallbackEq.toFixed(2)),
    avail: Number(Math.max(0, fallbackAvail).toFixed(2)),
  };
}

function mapBinancePositionRow(p: any, fallbackUnReal = 0) {
  const amt = Number(p.positionAmt || 0);
  const pnlRaw = Number(p.unRealizedProfit ?? p.unrealizedProfit ?? 0);
  const unrealizedPnl = Math.abs(pnlRaw) > 0 ? pnlRaw : fallbackUnReal;
  return {
    symbol: String(p.symbol),
    side: amt > 0 ? ("BUY" as const) : ("SELL" as const),
    qty: Math.abs(amt),
    entryPrice: Number(p.entryPrice || 0),
    markPrice: Number(p.markPrice || p.entryPrice || 0),
    unrealizedPnl,
    leverage: Number(p.leverage || 0),
  };
}

/**
 * Resolves next Floating P&L without flickering to $0.00 on transient Binance API errors,
 * empty bulk positionRisk responses, or 1-cycle close confirmation waits while DB has OPEN trades.
 */
export function resolveNextFloatingProfit(opts: {
  credsPresent: boolean;
  snapOk: boolean;
  positions: Array<{ unrealizedPnl?: number }>;
  totalUnrealizedProfit: number;
  openDbCount: number;
  prevFloating: number;
}): number {
  if (!opts.credsPresent) return 0;
  if (!opts.snapOk) {
    return opts.openDbCount > 0 ? Number(opts.prevFloating.toFixed(2)) : 0;
  }
  if (opts.positions.length > 0) {
    const posSum = Number(opts.positions.reduce((s, p) => s + Number(p.unrealizedPnl || 0), 0).toFixed(2));
    if (Math.abs(posSum) < 0.01 && Math.abs(opts.totalUnrealizedProfit) >= 0.01) {
      return Number(opts.totalUnrealizedProfit.toFixed(2));
    }
    return posSum;
  }
  if (opts.openDbCount > 0) {
    return Math.abs(opts.totalUnrealizedProfit) >= 0.01
      ? Number(opts.totalUnrealizedProfit.toFixed(2))
      : Number(opts.prevFloating.toFixed(2));
  }
  return 0;
}

async function getAccountSnapshot(): Promise<{
  equity: number;
  avail: number;
  totalUnrealizedProfit: number;
  positions: any[];
  statusCode: number;
}> {
  const accRes = await signedBinanceRequest("GET", "/fapi/v2/account");
  if (!accRes.ok) {
    return { equity: 0, avail: 0, totalUnrealizedProfit: 0, positions: [], statusCode: accRes.status || 502 };
  }
  const { equity, avail } = extractAccountSnapshotBalances(accRes.data);
  const totalUnrealizedProfit = Number(accRes.data?.totalUnrealizedProfit ?? 0);

  const accPosBySym = new Map<string, any>();
  if (Array.isArray(accRes.data?.positions)) {
    for (const ap of accRes.data.positions) {
      if (Math.abs(Number(ap.positionAmt || 0)) > 0) {
        accPosBySym.set(String(ap.symbol).toUpperCase(), ap);
      }
    }
  }

  // Only query bulk /fapi/v2/positionRisk (weight 5) when an active position exists to get live markPrice
  const posRes =
    accPosBySym.size > 0
      ? await signedBinanceRequest("GET", "/fapi/v2/positionRisk")
      : { ok: false, data: null };

  const posBySym = new Map<string, any>();
  if (posRes.ok && Array.isArray(posRes.data)) {
    for (const p of posRes.data) {
      if (Math.abs(Number(p.positionAmt || 0)) > 0) {
        const symU = String(p.symbol).toUpperCase();
        const ap = accPosBySym.get(symU);
        const accPnl = Number(ap?.unrealizedProfit ?? 0);
        posBySym.set(symU, mapBinancePositionRow(p, accPnl));
      }
    }
  }
  for (const [symU, ap] of accPosBySym.entries()) {
    if (!posBySym.has(symU)) {
      posBySym.set(symU, mapBinancePositionRow(ap));
    }
  }

  return {
    equity,
    avail,
    totalUnrealizedProfit,
    positions: Array.from(posBySym.values()),
    statusCode: 200,
  };
}

export function calculateFuturesQty(
  filter: SymbolFilter,
  entryPrice: number,
  slPrice: number,
  equity: number,
  riskPct: number,
  leverage: number,
  maxMarginPct: number,
  accountMode: string
): { qty: number; marginPct: number; marginUsed: number; riskUsdt: number; error?: string } {
  const isPersonal = accountMode.toUpperCase() === "PERSONAL";
  // Prop Firm strictly <= 80%; Personal uses up to 100% (reserving 1.5% cushion only for Binance open/close fees so -2019 never triggers)
  const capMarginPct = isPersonal
    ? Math.min(98.5, Math.max(5, maxMarginPct || 100))
    : Math.min(80, Math.max(5, maxMarginPct || 80));
  const effLev = Math.max(1, Math.min(50, leverage || 5));
  const effRiskPct = !isPersonal ? Math.min(riskPct, 1.75) : riskPct;
  const slDist = Math.abs(entryPrice - slPrice);
  if (entryPrice <= 0 || slDist <= 0 || equity <= 0) {
    return { qty: 0, marginPct: 0, marginUsed: 0, riskUsdt: 0, error: "Invalid entry/SL/equity" };
  }

  const riskBudget = equity * (effRiskPct / 100);
  const effSlDist = computeFeeAdjustedRiskDist(entryPrice, slDist);
  const rawQtyRisk = riskBudget / effSlDist;
  const maxNotional = equity * (capMarginPct / 100) * effLev;
  const maxQtyMargin = maxNotional / entryPrice;
  let qty = quantizeStep(Math.min(rawQtyRisk, maxQtyMargin), filter.stepSize, false);
  let notional = qty * entryPrice;

  if (notional < filter.minNotional || qty < filter.minQty) {
    const reqNotional = Math.max(filter.minNotional * 1.02, filter.minQty * entryPrice);
    const bumpQty = quantizeStep(reqNotional / entryPrice, filter.stepSize, true);
    const bumpNotional = bumpQty * entryPrice;
    const bumpRiskPct = ((bumpQty * effSlDist) / equity) * 100;
    const maxSafeBumpRisk = !isPersonal ? 1.9 : 15.0;
    if (bumpNotional <= maxNotional && bumpRiskPct <= maxSafeBumpRisk) {
      qty = bumpQty;
      notional = bumpNotional;
    } else {
      return {
        qty: 0,
        marginPct: 0,
        marginUsed: 0,
        riskUsdt: 0,
        error: `${filter.symbol} minNotional $${filter.minNotional} > safe margin/risk cap`,
      };
    }
  }

  const marginUsed = notional / effLev;
  const marginPct = (marginUsed / equity) * 100;
  return {
    qty,
    marginUsed: Number(marginUsed.toFixed(2)),
    marginPct: Number(marginPct.toFixed(2)),
    riskUsdt: Number((qty * effSlDist).toFixed(2)),
  };
}

async function cancelAllOrders(symbol: string) {
  await Promise.all([
    signedBinanceRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol }),
    signedBinanceRequest("DELETE", "/fapi/v1/algoOpenOrders", { symbol }),
  ]);
}

async function placeConditionalClose(symbol: string, exitSide: "BUY" | "SELL", type: "STOP_MARKET" | "TAKE_PROFIT_MARKET", triggerPrice: number) {
  const res = await signedBinanceRequest("POST", "/fapi/v1/algoOrder", {
    algoType: "CONDITIONAL",
    symbol,
    side: exitSide,
    type,
    triggerPrice: String(triggerPrice),
    closePosition: "true",
    workingType: "MARK_PRICE",
    priceProtect: "TRUE",
  });
  if (res.ok) return true;
  const fb = await signedBinanceRequest("POST", "/fapi/v1/order", {
    symbol,
    side: exitSide,
    type,
    stopPrice: String(triggerPrice),
    closePosition: "true",
    workingType: "MARK_PRICE",
  });
  return fb.ok;
}

/**
 * Places TAKE_PROFIT_MARKET (closePosition: true) so Binance Positions -> "TP/SL for position"
 * visibly displays TP alongside SL and guarantees close on fast wicks; falls back to reduceOnly LIMIT.
 */
async function placeVisibleTpOrder(symbol: string, exitSide: "BUY" | "SELL", tpPrice: number, fallbackQty: number) {
  const condOk = await placeConditionalClose(symbol, exitSide, "TAKE_PROFIT_MARKET", tpPrice);
  if (condOk) return true;
  const lim = await signedBinanceRequest("POST", "/fapi/v1/order", {
    symbol,
    side: exitSide,
    type: "LIMIT",
    timeInForce: "GTC",
    quantity: String(fallbackQty),
    price: String(tpPrice),
    reduceOnly: "true",
  });
  return lim.ok;
}

/**
 * Ensures an open Binance position has TAKE_PROFIT_MARKET (closePosition: true) registered so
 * Binance's "TP/SL for position" shows TP (replacing any standalone LIMIT TP2 at the same price while preserving TP1).
 */
export async function ensureExchangeTpForOpenPosition(
  symbol: string,
  side: "BUY" | "SELL",
  markPrice: number,
  slPrice: number,
  tpPrice: number
): Promise<{ synced: boolean; placedTp: boolean; cancelledLimitIds: number[] }> {
  const exitSide = side === "BUY" ? "SELL" : "BUY";
  const filter = await getSymbolFilters(symbol);
  const tpRound = quantizeTick(tpPrice, filter.tickSize);
  const slRound = quantizeTick(slPrice, filter.tickSize);
  const cancelledLimitIds: number[] = [];

  const [aoRes, ooRes] = await Promise.all([
    signedBinanceRequest("GET", "/fapi/v1/openAlgoOrders", { symbol }),
    signedBinanceRequest("GET", "/fapi/v1/openOrders", { symbol }),
  ]);
  if (!aoRes.ok && !ooRes.ok) return { synced: false, placedTp: false, cancelledLimitIds };

  const algoList: any[] = Array.isArray(aoRes.data) ? aoRes.data : Array.isArray(aoRes.data?.orders) ? aoRes.data.orders : [];
  const openList: any[] = Array.isArray(ooRes.data) ? ooRes.data : [];
  const allOrders = [...algoList, ...openList];

  const hasTp = allOrders.some((o) => String(o.orderType || o.type || "").toUpperCase().startsWith("TAKE_PROFIT"));
  const hasSl = allOrders.some((o) => String(o.orderType || o.type || "").toUpperCase().startsWith("STOP"));

  if (!hasSl && slRound > 0) {
    const slSafe = side === "BUY" ? markPrice > slRound * 1.0002 : markPrice < slRound * 0.9998;
    if (slSafe) {
      await placeConditionalClose(symbol, exitSide, "STOP_MARKET", slRound);
    }
  }

  let placedTp = false;
  if (!hasTp && tpRound > 0) {
    const tpSafe = side === "BUY" ? markPrice < tpRound * 0.9998 : markPrice > tpRound * 1.0002;
    if (!tpSafe) return { synced: false, placedTp: false, cancelledLimitIds };

    const tol = Math.max(filter.tickSize * 2, tpRound * 0.0005);
    for (const o of openList) {
      const oType = String(o.type || "").toUpperCase();
      const oPx = Number(o.price || 0);
      if (oType === "LIMIT" && o.reduceOnly && Math.abs(oPx - tpRound) <= tol && o.orderId) {
        const del = await signedBinanceRequest("DELETE", "/fapi/v1/order", { symbol, orderId: o.orderId });
        if (del.ok) cancelledLimitIds.push(Number(o.orderId));
      }
    }
    placedTp = await placeConditionalClose(symbol, exitSide, "TAKE_PROFIT_MARKET", tpRound);
    return { synced: placedTp, placedTp, cancelledLimitIds };
  }

  return { synced: hasTp, placedTp, cancelledLimitIds };
}

async function executeSingleFuturesOrder(
  symbol: string,
  side: "BUY" | "SELL",
  qty: number,
  entryPrice: number,
  slPrice: number,
  tpPrice: number,
  leverage: number,
  comment: string,
  signalId?: number
): Promise<{ ok: boolean; orderId?: number; fillPrice?: number; sl?: number; tp?: number; error?: string }> {
  const filter = await getSymbolFilters(symbol);
  const binSym = filter.symbol;
  const rQty = quantizeStep(qty, filter.stepSize, false);
  if (rQty <= 0 || rQty < filter.minQty) return { ok: false, error: `Qty ${rQty} < minQty ${filter.minQty}` };

  if (isTestnet() && entryPrice > 0) {
    try {
      const btResp = await fetch(`${getBaseUrl()}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(binSym)}`, {
        signal: AbortSignal.timeout(3500),
      });
      recordBinanceResponse(
        getBaseUrl(),
        btResp.status,
        btResp.headers.get("retry-after"),
        btResp.headers.get("x-mbx-used-weight-1m")
      );
      if (btResp.ok) {
        const bt = (await btResp.json()) as { bidPrice?: string; askPrice?: string };
        const bid = Number(bt.bidPrice || 0);
        const ask = Number(bt.askPrice || 0);
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
        if (mid > 0 && Math.abs(mid - entryPrice) / entryPrice >= 0.025) {
          return { ok: false, error: `Testnet book diverged (${mid} vs ${entryPrice})` };
        }
      }
    } catch {}
  }

  const actualLev = await ensureLeverage(binSym, leverage, true);
  logger.info({ symbol: binSym, requestedLev: leverage, actualLev }, "Binance leverage verified before entry");
  const orderRes = await signedBinanceRequest("POST", "/fapi/v1/order", {
    symbol: binSym,
    side,
    type: "MARKET",
    quantity: String(rQty),
    newOrderRespType: "RESULT",
  });
  if (!orderRes.ok) return { ok: false, error: `Binance ${orderRes.status}: ${orderRes.text}` };

  const orderId = Number(orderRes.data?.orderId || Date.now());
  const fillPrice = Number(orderRes.data?.avgPrice || 0) || entryPrice;
  const execQty = Number(orderRes.data?.executedQty || rQty) || rQty;

  const priceDelta =
    isTestnet() &&
    entryPrice > 0 &&
    Math.abs(fillPrice - entryPrice) / entryPrice > 0.0005 &&
    Math.abs(fillPrice - entryPrice) / entryPrice < 0.025
      ? fillPrice - entryPrice
      : 0;
  let slRound = quantizeTick(slPrice + priceDelta, filter.tickSize);
  let tpRound = quantizeTick(tpPrice + priceDelta, filter.tickSize);
  if (side === "BUY") {
    if (slRound >= fillPrice) slRound = quantizeTick(fillPrice * 0.992, filter.tickSize);
    if (tpRound <= fillPrice) tpRound = quantizeTick(fillPrice * 1.015, filter.tickSize);
  } else {
    if (slRound <= fillPrice) slRound = quantizeTick(fillPrice * 1.008, filter.tickSize);
    if (tpRound >= fillPrice) tpRound = quantizeTick(fillPrice * 0.985, filter.tickSize);
  }

  await cancelAllOrders(binSym);
  const exitSide = side === "BUY" ? "SELL" : "BUY";
  await placeConditionalClose(binSym, exitSide, "STOP_MARKET", slRound);

  // Split into 2-Stage Institutional Partial Profit: 50% Limit TP1 @ +0.85R + 50% Runner TP2 @ tpRound
  const initSlDist = Math.abs(fillPrice - slRound);
  const tp1Raw = side === "BUY" ? fillPrice + initSlDist * 0.85 : fillPrice - initSlDist * 0.85;
  const tp1Round = quantizeTick(tp1Raw, filter.tickSize);
  const tp1Qty = quantizeStep(execQty * 0.5, filter.stepSize, false);
  const tp2Qty = quantizeStep(execQty - tp1Qty, filter.stepSize, false);
  const tp1DirectionalOk = side === "BUY" ? tp1Round > fillPrice && tp1Round < tpRound : tp1Round < fillPrice && tp1Round > tpRound;
  const canSplitTp =
    tp1DirectionalOk &&
    tp1Qty >= filter.minQty &&
    tp2Qty >= filter.minQty &&
    tp1Qty * tp1Round >= 6.0 &&
    tp2Qty * tpRound >= 6.0;

  let splitPlaced = false;
  if (canSplitTp) {
    const tp1Res = await signedBinanceRequest("POST", "/fapi/v1/order", {
      symbol: binSym,
      side: exitSide,
      type: "LIMIT",
      timeInForce: "GTC",
      quantity: String(tp1Qty),
      price: String(tp1Round),
      reduceOnly: "true",
    });
    if (tp1Res.ok) {
      await placeVisibleTpOrder(binSym, exitSide, tpRound, tp2Qty);
      splitPlaced = true;
    }
  }
  if (!splitPlaced) {
    await placeVisibleTpOrder(binSym, exitSide, tpRound, execQty);
  }

  await db.execute(
    sql`INSERT INTO trades (ticket, symbol, order_type, lots, entry_price, sl, tp, entry_time, status, comment, signal_id, mt5_login)
        VALUES (${orderId}, ${binSym}, ${side}, ${execQty.toString()}, ${fillPrice.toString()}, ${slRound.toString()}, ${tpRound.toString()}, NOW(), 'OPEN', ${comment}, ${signalId ?? null}, 0)
        ON CONFLICT (ticket) DO NOTHING`
  );

  return { ok: true, orderId, fillPrice, sl: slRound, tp: tpRound };
}

async function closeSymbolPositions(targetSymbol: string, positions: any[], reason = "Closed"): Promise<{ closed: number; error?: string }> {
  const resolved = targetSymbol.toUpperCase() === "ALL" ? null : await resolveLiveBinanceSymbol(targetSymbol);
  let targets = positions.filter((pos) => !resolved || pos.symbol.toUpperCase() === resolved.toUpperCase());

  // Fallback direct Binance position check if snapshot list missed target symbol
  if (!targets.length && resolved) {
    const directRes = await signedBinanceRequest("GET", "/fapi/v2/positionRisk", { symbol: resolved });
    if (directRes.ok && Array.isArray(directRes.data)) {
      targets = directRes.data
        .filter((p) => Math.abs(Number(p.positionAmt || 0)) > 0)
        .map((p) => ({
          symbol: String(p.symbol),
          side: Number(p.positionAmt) > 0 ? ("BUY" as const) : ("SELL" as const),
          qty: Math.abs(Number(p.positionAmt)),
          entryPrice: Number(p.entryPrice || 0),
          markPrice: Number(p.markPrice || p.entryPrice || 0),
          unrealizedPnl: Number(p.unRealizedProfit || 0),
        }));
    }
  }

  let closed = 0;
  let lastErr: string | undefined;
  for (const pos of targets) {
    const exitSide = pos.side === "BUY" ? "SELL" : "BUY";
    let r = await signedBinanceRequest("POST", "/fapi/v1/order", {
      symbol: pos.symbol,
      side: exitSide,
      type: "MARKET",
      quantity: String(pos.qty),
      reduceOnly: "true",
      newOrderRespType: "RESULT",
    });
    if (!r.ok && r.text.includes("-1106")) {
      r = await signedBinanceRequest("POST", "/fapi/v1/order", {
        symbol: pos.symbol,
        side: exitSide,
        type: "MARKET",
        quantity: String(pos.qty),
        newOrderRespType: "RESULT",
      });
    }
    if (r.ok) {
      closed++;
      await cancelAllOrders(pos.symbol);
      const closeP = Number(r.data?.avgPrice || 0) || pos.markPrice || pos.entryPrice;
      await reconcileClosedSymbol(pos.symbol, closeP, pos.unrealizedPnl, reason);
    } else {
      lastErr = `Binance close ${r.status}: ${r.text.slice(0, 140)}`;
      logger.error({ symbol: pos.symbol, status: r.status, body: r.text }, "Binance close order rejected");
    }
  }
  return { closed, error: lastErr };
}

async function fetchSymbolFillsRange(symbol: string, startMs: number, endMs?: number): Promise<any[]> {
  const params: Record<string, string | number> = {
    symbol,
    startTime: Math.max(0, Math.floor(startMs)),
    limit: 1000,
  };
  if (endMs && endMs > startMs) params.endTime = Math.ceil(endMs);
  const firstRes = await signedBinanceRequest("GET", "/fapi/v1/userTrades", params);
  if (!firstRes.ok || !Array.isArray(firstRes.data)) return [];
  const all = [...firstRes.data];
  let page = 0;
  let lastBatch = firstRes.data;
  while (lastBatch.length === 1000 && page < 4) {
    page++;
    const lastId = Number(lastBatch[lastBatch.length - 1]?.id || 0);
    if (!lastId) break;
    const nextRes = await signedBinanceRequest("GET", "/fapi/v1/userTrades", {
      symbol,
      fromId: lastId + 1,
      limit: 1000,
    });
    if (!nextRes.ok || !Array.isArray(nextRes.data) || nextRes.data.length === 0) break;
    const filtered = endMs
      ? nextRes.data.filter((f: any) => Number(f.time || 0) <= endMs)
      : nextRes.data;
    all.push(...filtered);
    lastBatch = nextRes.data;
    if (endMs && filtered.length < nextRes.data.length) break;
  }
  return all;
}

async function fetchSymbolIncomeLedger(
  symbol: string,
  startMs: number,
  endMs?: number
): Promise<{ matched: boolean; rpnl: number; fees: number }> {
  const params: Record<string, string | number> = {
    symbol,
    startTime: Math.max(0, Math.floor(startMs)),
    limit: 1000,
  };
  if (endMs && endMs > startMs) params.endTime = Math.ceil(endMs);
  const res = await signedBinanceRequest("GET", "/fapi/v1/income", params);
  if (!res.ok || !Array.isArray(res.data)) return { matched: false, rpnl: 0, fees: 0 };
  let rpnl = 0;
  let fees = 0;
  let matched = false;
  for (const inc of res.data) {
    const t = String(inc.incomeType || "").toUpperCase();
    const val = Number(inc.income || 0);
    if (t === "REALIZED_PNL") {
      rpnl += val;
      matched = true;
    } else if (t === "COMMISSION" && String(inc.asset || "USDT").toUpperCase() === "USDT") {
      fees += Math.abs(val);
    }
  }
  return { matched, rpnl, fees };
}

export async function computeBinanceTradeOutcome(
  symbol: string,
  orderType: string,
  expectedLots: number,
  entryMs: number,
  closeMs?: number,
  fallbackClose = 0,
  fallbackPnl = 0
): Promise<{ matched: boolean; netPnl: number; closePrice: number; exitQtySum: number }> {
  const windowStart = Math.max(0, entryMs - 15_000);
  const windowEnd = closeMs ? closeMs + 30_000 : undefined;
  const entrySide = String(orderType || "BUY").toUpperCase();

  const summarizeFills = (rows: any[]) => {
    let rpnl = 0;
    let fees = 0;
    let closeQtySum = 0;
    let closeWeightedPx = 0;
    let matched = false;
    for (const f of rows) {
      const fTime = Number(f.time || 0);
      if (fTime < windowStart || (windowEnd && fTime > windowEnd)) continue;
      const rp = Number(f.realizedPnl || 0);
      const fQty = Number(f.qty || 0);
      const fPx = Number(f.price || 0);
      const fSide = String(f.side || "").toUpperCase();
      if (Math.abs(rp) > 0) {
        rpnl += rp;
        matched = true;
      }
      if ((fSide && fSide !== entrySide) || Math.abs(rp) > 0) {
        if (fQty > 0 && fPx > 0) {
          closeWeightedPx += fPx * fQty;
          closeQtySum += fQty;
        }
      }
      if (String(f.commissionAsset || "").toUpperCase() === "USDT") {
        fees += Number(f.commission || 0);
      }
    }
    const closePrice =
      closeQtySum > 0 ? Number((closeWeightedPx / closeQtySum).toFixed(8)) : fallbackClose;
    return { matched, netPnl: Number((rpnl - fees).toFixed(2)), closePrice, exitQtySum: closeQtySum, rpnl };
  };

  let fills = await fetchSymbolFillsRange(symbol, windowStart, windowEnd);
  let summary = summarizeFills(fills);

  // Brief retry if live close fills just settled and matching engine hasn't indexed all chunks yet
  if (!closeMs && expectedLots > 0 && summary.exitQtySum < expectedLots * 0.9) {
    await new Promise((r) => setTimeout(r, 1500));
    fills = await fetchSymbolFillsRange(symbol, windowStart, windowEnd);
    summary = summarizeFills(fills);
  }

  // Cross-verify against /fapi/v1/income when fills were truncated or incomplete
  if (!summary.matched || (expectedLots > 0 && summary.exitQtySum < expectedLots * 0.9)) {
    const ledger = await fetchSymbolIncomeLedger(symbol, windowStart, windowEnd);
    if (ledger.matched && (!summary.matched || Math.abs(ledger.rpnl) > Math.abs(summary.rpnl))) {
      return {
        matched: true,
        netPnl: Number((ledger.rpnl - ledger.fees).toFixed(2)),
        closePrice: summary.closePrice || fallbackClose,
        exitQtySum: Math.max(summary.exitQtySum, expectedLots),
      };
    }
  }

  if (summary.matched) {
    return {
      matched: true,
      netPnl: summary.netPnl,
      closePrice: summary.closePrice || fallbackClose,
      exitQtySum: summary.exitQtySum,
    };
  }
  return {
    matched: false,
    netPnl: Number(fallbackPnl.toFixed(2)),
    closePrice: fallbackClose,
    exitQtySum: 0,
  };
}

async function reconcileClosedSymbol(symbol: string, fallbackClose = 0, fallbackPnl = 0, reason = "SL/TP Fill") {
  const openRows = (
    await db.execute(
      sql`SELECT ticket, (EXTRACT(EPOCH FROM (entry_time AT TIME ZONE 'UTC')) * 1000) AS entry_ms, entry_price, order_type, lots
          FROM trades WHERE status='OPEN' AND UPPER(symbol)=${symbol.toUpperCase()}`
    )
  ).rows as any[];
  if (!openRows.length) return;

  for (const row of openRows) {
    const entryMs = Number(row.entry_ms || 0);
    const lots = Number(row.lots || 0);
    const outcome = await computeBinanceTradeOutcome(
      symbol,
      String(row.order_type || "BUY"),
      lots,
      entryMs,
      undefined,
      fallbackClose || Number(row.entry_price || 0),
      fallbackPnl
    );
    const closeP = outcome.closePrice || Number(row.entry_price || 0);
    const netPnl = outcome.netPnl;
    const ticket = Number(row.ticket);
    peakFloatingMap.delete(ticket);
    beLockedTickets.delete(ticket);
    tpSyncedTickets.delete(ticket);
    await db.execute(
      sql`UPDATE trades SET close_price=${closeP.toString()}, profit=${netPnl.toString()}, close_time=NOW(), status='CLOSED' WHERE ticket=${ticket}`
    );
    await sendDiscordCryptoCloseAlert(
      ticket,
      symbol,
      String(row.order_type || "BUY"),
      lots,
      closeP,
      netPnl,
      reason
    );
  }
}

/**
 * Computes static Drawdown % strictly when balance falls below Starting Equity / daily floor,
 * so profit pullbacks while still above Starting Equity are never counted as drawdown.
 */
export function computeDrawdownMetrics(
  equity: number,
  initBal: number,
  startEq: number
): { dailyDdPct: number; overallDdPct: number } {
  const capitalBase = initBal > 0 ? initBal : startEq;
  const dailyFloor = startEq > 0 && capitalBase > 0 ? Math.min(startEq, capitalBase) : capitalBase || startEq;
  const dailyLossUsd = dailyFloor > 0 && equity > 0 ? Math.max(0, dailyFloor - equity) : 0;
  const dailyDdPct = capitalBase > 0 && equity > 0 ? Number(((dailyLossUsd / capitalBase) * 100).toFixed(2)) : 0;
  const overallDdPct =
    initBal > 0 && equity > 0 ? Math.max(0, Number((((initBal - equity) / initBal) * 100).toFixed(2))) : 0;
  return { dailyDdPct, overallDdPct };
}

/** Repairs any recent closed trades whose DB PnL missed partial/chunked Binance fills. */
async function reconcileRecentClosedDiscrepancies(preloadedSnap?: {
  equity: number;
  positions: any[];
  statusCode: number;
}): Promise<{ cleanedPeak?: number }> {
  if (!hasApiCreds()) return {};
  let cleanedPeak: number | undefined;
  try {
    // Heal any impossible daily_metrics drawdown spike or zero-trade multi-asset BTC baseline skew
    const snap = preloadedSnap ?? (await getAccountSnapshot());
    if (snap.statusCode === 200 && snap.equity > 0) {
      didInitialLedgerReconcile = true;
      const todayStr = getPktDateStr();
      const botRow = ((await db.execute(sql`SELECT id, initial_balance, max_equity_peak, metrics_reset_at FROM bot_state ORDER BY id ASC LIMIT 1`)).rows || [])[0] as any;
      const dmRow = ((await db.execute(sql`SELECT start_equity, max_drawdown_percent, trades_today FROM daily_metrics WHERE trading_date=${todayStr} AND COALESCE(mt5_login,0)=0 LIMIT 1`)).rows || [])[0] as any;
      const initBal = Number(botRow?.initial_balance ?? 0) > 0 ? Number(botRow.initial_balance) : snap.equity;
      const startEq = Number(dmRow?.start_equity ?? 0);
      const recordedMaxDd = Number(dmRow?.max_drawdown_percent ?? 0);
      const dmTradesToday = Number(dmRow?.trades_today ?? 0);

      if (dmRow && dmTradesToday === 0 && snap.positions.length === 0 && Math.abs(startEq - snap.equity) > 50) {
        await db.execute(
          sql`UPDATE daily_metrics
              SET start_equity=${snap.equity.toString()},
                  current_equity=${snap.equity.toString()},
                  max_drawdown_percent=0,
                  updated_at=NOW()
              WHERE trading_date=${todayStr} AND COALESCE(mt5_login,0)=0`
        );
        logger.info({ todayStr, prevStartEq: startEq, syncedEquity: snap.equity }, "Aligned today daily_metrics baseline to Binance Futures margin balance (0 trades)");
      } else if (startEq > 0 && recordedMaxDd > 20 && snap.equity / startEq > 0.85) {
        const { dailyDdPct } = computeDrawdownMetrics(snap.equity, initBal, startEq);
        await db.execute(
          sql`UPDATE daily_metrics
              SET current_equity=${snap.equity.toString()},
                  max_drawdown_percent=${dailyDdPct.toString()},
                  updated_at=NOW()
              WHERE trading_date=${todayStr} AND COALESCE(mt5_login,0)=0`
        );
        logger.info({ todayStr, prevMaxDd: recordedMaxDd, healedDd: dailyDdPct, equity: snap.equity }, "Healed spurious daily_metrics drawdown spike");
      }

      if (botRow?.id && snap.positions.length === 0) {
        const recordedPeak = Number(botRow.max_equity_peak ?? 0);
        const resetAt = botRow.metrics_reset_at ? new Date(botRow.metrics_reset_at) : null;
        const closedProfitsRes = resetAt
          ? await db.execute(sql`SELECT profit FROM trades WHERE status='CLOSED' AND close_time >= ${resetAt.toISOString()} ORDER BY close_time ASC`)
          : await db.execute(sql`SELECT profit FROM trades WHERE status='CLOSED' ORDER BY close_time ASC`);
        let runningEq = initBal;
        let realizedPeak = Math.max(initBal, snap.equity);
        for (const cr of (closedProfitsRes.rows || []) as any[]) {
          runningEq += Number(cr.profit ?? 0);
          if (runningEq > realizedPeak) realizedPeak = runningEq;
        }
        if (recordedPeak - realizedPeak > 50) {
          const nextPeak = Number(realizedPeak.toFixed(2));
          cleanedPeak = nextPeak;
          peakEquityTracker = nextPeak;
          await db.execute(
            sql`UPDATE bot_state SET max_equity_peak=${nextPeak.toString()}, updated_at=NOW() WHERE id=${Number(botRow.id)}`
          );
          logger.info({ prevPeak: recordedPeak, cleanPeak: nextPeak }, "Reconciled max_equity_peak to realized ledger history");
        }
      }
    }

    const rows = (
      await db.execute(
        sql`SELECT ticket, symbol, order_type, lots, entry_price, close_price, profit,
                   (EXTRACT(EPOCH FROM (entry_time AT TIME ZONE 'UTC')) * 1000) AS entry_ms,
                   (EXTRACT(EPOCH FROM (close_time AT TIME ZONE 'UTC')) * 1000) AS close_ms
            FROM trades
            WHERE status='CLOSED' AND close_time >= NOW() - INTERVAL '72 hours'
            ORDER BY close_time DESC LIMIT 20`
      )
    ).rows as any[];
    if (!rows.length) return { cleanedPeak };

    for (const r of rows) {
      const sym = String(r.symbol || "").toUpperCase();
      const entryMs = Number(r.entry_ms || 0);
      const closeMs = Number(r.close_ms || 0);
      const lots = Number(r.lots || 0);
      if (!sym || !entryMs || !closeMs || lots <= 0) continue;

      // Skip if another DB trade for the same symbol overlaps this exact window
      const overlaps = rows.some(
        (other) =>
          Number(other.ticket) !== Number(r.ticket) &&
          String(other.symbol || "").toUpperCase() === sym &&
          Number(other.entry_ms || 0) <= closeMs + 30_000 &&
          Number(other.close_ms || 0) >= entryMs - 15_000
      );
      if (overlaps) continue;

      const dbProfit = Number(r.profit ?? 0);
      const outcome = await computeBinanceTradeOutcome(
        sym,
        String(r.order_type || "BUY"),
        lots,
        entryMs,
        closeMs,
        Number(r.close_price || r.entry_price || 0),
        dbProfit
      );
      if (outcome.matched && outcome.exitQtySum >= lots * 0.85 && Math.abs(outcome.netPnl - dbProfit) > 0.5) {
        await db.execute(
          sql`UPDATE trades SET close_price=${outcome.closePrice.toString()}, profit=${outcome.netPnl.toString()} WHERE ticket=${Number(r.ticket)}`
        );
        logger.info(
          { ticket: Number(r.ticket), sym, oldPnl: dbProfit, fixedPnl: outcome.netPnl, closePrice: outcome.closePrice },
          "Backfilled truncated closed trade PnL from Binance ledger"
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, "Startup closed-trade ledger reconciliation skipped");
  }
  return { cleanedPeak };
}

function getPktDateStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isSessionWindowOpen(state: any): boolean {
  if (!state?.session_guard_enabled) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value || 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
  const val = h + m / 60;
  const inWin = (s: number, e: number) => (Math.abs(s - e) < 1e-6 ? true : s < e ? val >= s && val < e : val >= s || val < e);
  const w1 = inWin(Number(state.session_start_hour ?? 12), Number(state.session_end_hour ?? 16));
  const w2 = Boolean(state.session2_enabled ?? true) && inWin(Number(state.session2_start_hour ?? 18), Number(state.session2_end_hour ?? 22));
  return w1 || w2;
}

async function runFastCycle() {
  if (isFastTickRunning) return;
  isFastTickRunning = true;
  try {
    const botRow = ((await db.execute(sql`SELECT * FROM bot_state ORDER BY id ASC LIMIT 1`)).rows || [])[0] as any;
    if (!botRow) return;

    const credsPresent = hasApiCreds();
    let equity = Number(botRow.equity ?? 0);
    let positions: any[] = [];
    let binanceStatusCode = 200;
    let totalUnrealizedProfit = 0;
    let healedPeak: number | undefined;

    if (credsPresent) {
      const snap = await getAccountSnapshot();
      binanceStatusCode = snap.statusCode;
      if (snap.statusCode === 200) {
        equity = snap.equity;
        positions = snap.positions;
        totalUnrealizedProfit = snap.totalUnrealizedProfit;
        if (!didInitialLedgerReconcile) {
          const rec = await reconcileRecentClosedDiscrepancies({
            equity: snap.equity,
            positions: snap.positions,
            statusCode: 200,
          });
          healedPeak = rec.cleanedPeak;
        }
      }
    }
    const binanceBlocked451 = binanceStatusCode === 451;
    const binanceAuthErr = credsPresent && binanceStatusCode !== 200 && !binanceBlocked451;

    // Reconcile closed / open DB positions with live Binance ONLY when account endpoints returned HTTP 200
    if (credsPresent && binanceStatusCode === 200) {
      const cfgLev = Math.max(1, Math.min(50, Math.round(Number(botRow.leverage || 5))));
      if (lastSyncedConfigLev === 0) {
        // Avoid 10 simultaneous POST /leverage requests on cold boot; per-coin leverage is synced before execution
        lastSyncedConfigLev = cfgLev;
      } else if (lastSyncedConfigLev !== cfgLev) {
        void syncLeverageAcrossCoins(cfgLev, String(botRow.active_pair || ""));
      }

      const openDbSyms = (await db.execute(sql`SELECT DISTINCT UPPER(symbol) AS sym FROM trades WHERE status='OPEN'`)).rows as any[];
      const liveSet = new Set(positions.map((p) => p.symbol.toUpperCase()));
      for (const r of openDbSyms) {
        const symU = String(r.sym).toUpperCase();
        if (liveSet.has(symU)) {
          closeConfirmCount.delete(symU);
          continue;
        }
        // Double-check directly per symbol & require 2 consecutive zero-qty checks before cancelling orders or closing DB row
        const chk = await signedBinanceRequest("GET", "/fapi/v2/positionRisk", { symbol: symU });
        const chkOpenRows =
          chk.ok && Array.isArray(chk.data)
            ? chk.data.filter((px) => Math.abs(Number(px.positionAmt || 0)) > 0)
            : [];
        if (chkOpenRows.length > 0) {
          closeConfirmCount.delete(symU);
          for (const px of chkOpenRows) {
            positions.push(mapBinancePositionRow(px, Math.abs(chkOpenRows.length) === 1 ? totalUnrealizedProfit : 0));
          }
          liveSet.add(symU);
          continue;
        }
        if (chk.ok) {
          const misses = (closeConfirmCount.get(symU) || 0) + 1;
          closeConfirmCount.set(symU, misses);
          if (misses >= 2) {
            closeConfirmCount.delete(symU);
            await cancelAllOrders(symU);
            await reconcileClosedSymbol(symU, 0, 0, "Server SL/TP Fill");
          }
        }
      }
      for (const p of positions) {
        const symU = p.symbol.toUpperCase();
        closeConfirmCount.delete(symU);
        if (p.leverage > 0 && p.leverage !== cfgLev) {
          await ensureLeverage(symU, cfgLev, true);
        }
        await db.execute(
          sql`UPDATE trades SET close_price=${p.markPrice.toString()}, profit=${Number(p.unrealizedPnl.toFixed(2)).toString()} WHERE status='OPEN' AND UPPER(symbol)=${symU}`
        );
      }

      // Poll pending manual trade commands
      const cmds = (
        await db.execute(sql`SELECT * FROM trade_commands WHERE status='PENDING' ORDER BY id ASC LIMIT 5`)
      ).rows as any[];
      for (const cmd of cmds) {
        let status = "EXECUTED";
        let errMsg: string | null = null;
        try {
          const dir = String(cmd.direction).toUpperCase();
          if (dir === "CLOSE") {
            const cRes = await closeSymbolPositions(String(cmd.symbol), positions, "Manual Close");
            if (cRes.error) {
              status = "FAILED";
              errMsg = cRes.error;
            }
          } else if (dir === "BUY" || dir === "SELL") {
            const sym = await resolveLiveBinanceSymbol(String(cmd.symbol));
            const tRes = await fetch(`${getBaseUrl()}/fapi/v1/ticker/bookTicker?symbol=${sym}`, { signal: AbortSignal.timeout(5000) });
            const td = (await tRes.json()) as any;
            const entryP = (Number(td.bidPrice) + Number(td.askPrice)) * 0.5;
            const slFrac = Number(cmd.sl_pips || 1.2) / 100;
            const tpFrac = Number(cmd.tp_pips || 2.4) / 100;
            const slP = dir === "BUY" ? entryP * (1 - slFrac) : entryP * (1 + slFrac);
            const tpP = dir === "BUY" ? entryP * (1 + tpFrac) : entryP * (1 - tpFrac);
            const ex = await executeSingleFuturesOrder(sym, dir, Number(cmd.lots), entryP, slP, tpP, cfgLev, String(cmd.comment || "MANUAL_FUTURES"));
            if (!ex.ok) {
              status = "FAILED";
              errMsg = ex.error || "Order rejected";
            }
          }
        } catch (e: any) {
          status = "FAILED";
          errMsg = e?.message || "Command error";
        }
        await db.execute(
          sql`UPDATE trade_commands SET status=${status}, executed_at=NOW(), error_msg=${errMsg} WHERE id=${Number(cmd.id)}`
        );
      }

      // Guardian Shield + 2-Stage Partial Profit Breakeven Guard (+0.85R / 50% TP1 Fill -> Fee-Neutral +0.05% BE)
      // Matches backtest mechanics: no premature 0.35R / 60m clipping while winners develop.
      const accMode = String(botRow.account_mode || "PROP_FIRM").toUpperCase();
      const shieldPct = Number(botRow.guardian_shield_pct ?? 1.8);
      const riskEnabled = Boolean(botRow.risk_limits_enabled ?? true);
      const riskPct = Number(botRow.risk_percent ?? 1.0);
      const effRiskPct = accMode === "PROP_FIRM" ? Math.min(riskPct, 1.75) : riskPct;
      const riskBudgetUsd = equity > 0 ? equity * (effRiskPct / 100) : 100;
      const tp1TriggerUsd = accMode === "PROP_FIRM" ? Math.max(15.0, Number((riskBudgetUsd * 0.85).toFixed(2))) : Math.max(1.0, Number((riskBudgetUsd * 0.85).toFixed(2)));

      for (const p of positions) {
        const upnl = Number(p.unrealizedPnl || 0);
        if (accMode === "PROP_FIRM" && riskEnabled && equity > 0 && upnl < 0 && (-upnl / equity) * 100 >= shieldPct) {
          await closeSymbolPositions(p.symbol, [p], `Guardian Shield -${shieldPct}%`);
          await postDiscordPayload(`🛡️ **GUARDIAN SHIELD TRIGGERED**: Closed \`${p.symbol}\` to protect Blue Guardian floating limit.`);
          continue;
        }
        const meta = ((
          await db.execute(
            sql`SELECT ticket, (EXTRACT(EPOCH FROM (entry_time AT TIME ZONE 'UTC')) * 1000) AS entry_ms, entry_price, COALESCE(lots,0) AS lots, COALESCE(sl,0) AS sl, COALESCE(tp,0) AS tp
                FROM trades WHERE status='OPEN' AND UPPER(symbol)=${p.symbol.toUpperCase()} ORDER BY entry_time DESC LIMIT 1`
          )
        ).rows || [])[0] as any;
        if (!meta) continue;
        const ticket = Number(meta.ticket);
        const entryP = Number(meta.entry_price || p.entryPrice);
        const origLots = Number(meta.lots || 0);
        const slP = Number(meta.sl || 0);
        const tpP = Number(meta.tp || 0);

        if (!tpSyncedTickets.has(ticket) && tpP > 0) {
          const syncRes = await ensureExchangeTpForOpenPosition(p.symbol, p.side, p.markPrice, slP, tpP);
          if (syncRes.synced) {
            tpSyncedTickets.add(ticket);
            if (syncRes.placedTp) {
              logger.info({ symbol: p.symbol, ticket, tp: tpP, cancelledLimitIds: syncRes.cancelledLimitIds }, "Synced TAKE_PROFIT_MARKET onto open Binance position");
            }
          }
        }

        const peakFloat = Math.max(peakFloatingMap.get(ticket) ?? upnl, upnl);
        peakFloatingMap.set(ticket, peakFloat);
        if (beLockedTickets.has(ticket)) continue;

        const isLong = p.side === "BUY";
        const alreadyBe = isLong ? slP >= entryP * 1.0002 : slP > 0 && slP <= entryP * 0.9998;
        if (alreadyBe) {
          beLockedTickets.add(ticket);
          continue;
        }

        const initSlDist = slP > 0 ? Math.abs(entryP - slP) : entryP * 0.0055;
        const tp1Target = isLong ? entryP + initSlDist * 0.85 : entryP - initSlDist * 0.85;
        const tp1PriceHit = isLong ? p.markPrice >= tp1Target : p.markPrice <= tp1Target;
        const partialFilled = origLots > 0 && p.qty <= origLots * 0.72;
        const profitBeHit = Math.max(upnl, peakFloat) >= tp1TriggerUsd;

        if (partialFilled || tp1PriceHit || profitBeHit) {
          const filter = await getSymbolFilters(p.symbol);
          const beSl = quantizeTick(isLong ? entryP * 1.0005 : entryP * 0.9995, filter.tickSize);
          // Safety check: only move SL if markPrice is safely on winning side of beSl so STOP_MARKET doesn't reject -2021
          const safeGap = isLong ? p.markPrice > beSl * 1.0004 : p.markPrice < beSl * 0.9996;
          if (!safeGap) continue;

          const exitSide = isLong ? "SELL" : "BUY";
          const okBe = await placeConditionalClose(p.symbol, exitSide, "STOP_MARKET", beSl);
          if (okBe) {
            const aoRes = await signedBinanceRequest("GET", "/fapi/v1/openAlgoOrders", { symbol: p.symbol });
            if (aoRes.ok && Array.isArray(aoRes.data)) {
              for (const ao of aoRes.data) {
                const trg = Number(ao.triggerPrice || 0);
                if (ao.orderType === "STOP_MARKET" && Math.abs(trg - beSl) > filter.tickSize * 0.5 && ao.algoId) {
                  await signedBinanceRequest("DELETE", "/fapi/v1/algoOrder", { symbol: p.symbol, algoId: ao.algoId });
                }
              }
            }
            beLockedTickets.add(ticket);
            await db.execute(sql`UPDATE trades SET sl=${beSl.toString()} WHERE ticket=${ticket}`);
            const reasonStr = partialFilled
              ? `50% TP1 Filled (@ +0.85R)`
              : `Reached +0.85R ($${Math.max(upnl, peakFloat).toFixed(2)} >= $${tp1TriggerUsd.toFixed(2)})`;
            await postDiscordPayload(
              `🛡️ **TP1 + FEE-NEUTRAL BREAKEVEN LOCKED** · \`${p.symbol}\` (#${ticket})\n` +
                `Trigger: \`${reasonStr}\`\n` +
                `Runner SL locked at \`$${formatCryptoPrice(beSl)}\` (+0.05% fee-neutral BE) | TP2 active at \`$${formatCryptoPrice(tpP)}\``
            );
          }
        }
      }
    }

    const remainingOpenRes = await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM trades WHERE status='OPEN'`);
    const openDbCount = Number(((remainingOpenRes.rows || [])[0] as any)?.cnt ?? 0);
    const floating = resolveNextFloatingProfit({
      credsPresent,
      snapOk: binanceStatusCode === 200,
      positions,
      totalUnrealizedProfit,
      openDbCount,
      prevFloating: Number(botRow.floating_profit ?? 0),
    });
    const todayStr = getPktDateStr();
    const initBal = Number(botRow.initial_balance ?? 0) > 0 ? Number(botRow.initial_balance) : equity || 10000;
    const dmRow = ((
      await db.execute(sql`SELECT start_equity FROM daily_metrics WHERE trading_date=${todayStr} AND COALESCE(mt5_login,0)=0 LIMIT 1`)
    ).rows || [])[0] as any;
    const startEq = Number(dmRow?.start_equity ?? 0) > 0 ? Number(dmRow.start_equity) : equity || initBal;
    if (!dmRow && equity > 0) {
      await db.execute(
        sql`INSERT INTO daily_metrics (trading_date, start_equity, current_equity, max_drawdown_percent, trades_today, mt5_login, updated_at)
            VALUES (${todayStr}, ${startEq.toString()}, ${equity.toString()}, 0, 0, 0, NOW())
            ON CONFLICT (trading_date, mt5_login) DO NOTHING`
      );
    }

    // Compute Daily Drawdown & Overall Drawdown strictly when balance is below Starting Equity / floor
    const { dailyDdPct, overallDdPct } = computeDrawdownMetrics(equity, initBal, startEq);
    const dbPeakEq = Math.max(healedPeak ?? Number(botRow.max_equity_peak ?? 0), equity);
    peakEquityTracker = dbPeakEq;

    const resetAt = botRow.metrics_reset_at ? new Date(botRow.metrics_reset_at) : null;
    const tradesTodayRes = resetAt
      ? await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM trades WHERE DATE(entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Karachi')=${todayStr} AND entry_time >= ${resetAt.toISOString()}`)
      : await db.execute(sql`SELECT COUNT(*)::int AS cnt FROM trades WHERE DATE(entry_time AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Karachi')=${todayStr}`);
    const tradesToday = Number(((tradesTodayRes.rows || [])[0] as any)?.cnt ?? 0);

    const haltDd = Number(botRow.halt_drawdown_limit ?? 3.5);
    const accMode = String(botRow.account_mode || "PROP_FIRM").toUpperCase();
    const riskEnabled = Boolean(botRow.risk_limits_enabled ?? true);
    const isHalted = riskEnabled && (dailyDdPct >= haltDd || (accMode === "PROP_FIRM" && overallDdPct >= 7.2));
    const isRunning = Boolean(botRow.is_bot_running ?? true);
    const rateCooldown = getHostCooldownState(getBaseUrl());
    const binanceRateLimited = binanceStatusCode === 418 || binanceStatusCode === 429 || rateCooldown.coolingDown;
    const cooldownSecs = Math.max(1, Math.ceil((rateCooldown.remainingMs || 60_000) / 1000));
    const sysStatus = binanceBlocked451
      ? "BLOCKED (Binance US IP 451 — Deploy Render Singapore)"
      : binanceRateLimited
      ? `COOLDOWN (Binance ${binanceStatusCode === 418 || rateCooldown.status === 418 ? 418 : 429} Rate Limit — Retry ${cooldownSecs}s)`
      : binanceAuthErr
      ? `API ERR (Binance HTTP ${binanceStatusCode} — Check Keys/Testnet)`
      : !isRunning
      ? "PAUSED (User Control)"
      : isHalted
      ? `HALTED (DD ${dailyDdPct.toFixed(2)}%)`
      : !credsPresent
      ? "SCANNING (Add Binance Keys)"
      : isSessionWindowOpen(botRow)
      ? "RUNNING (Cloud SMC Active)"
      : "PAUSED (Session Guard)";

    await db.execute(
      sql`UPDATE bot_state
          SET system_status=${sysStatus},
              equity=${equity.toString()},
              drawdown_percent=${dailyDdPct.toString()},
              overall_drawdown=${overallDdPct.toString()},
              max_equity_peak=${peakEquityTracker.toString()},
              floating_profit=${Number(floating.toFixed(2)).toString()},
              trades_today=${tradesToday},
              last_heartbeat=NOW(),
              updated_at=NOW()
          WHERE id=${Number(botRow.id)}`
    );

    if (equity > 0) {
      await db.execute(
        sql`INSERT INTO daily_metrics (trading_date, start_equity, current_equity, max_drawdown_percent, trades_today, mt5_login, updated_at)
            VALUES (${todayStr}, ${startEq.toString()}, ${equity.toString()}, ${dailyDdPct.toString()}, ${tradesToday}, 0, NOW())
            ON CONFLICT (trading_date, mt5_login) DO UPDATE
            SET current_equity = EXCLUDED.current_equity,
                max_drawdown_percent = GREATEST(daily_metrics.max_drawdown_percent, EXCLUDED.max_drawdown_percent),
                trades_today = EXCLUDED.trades_today,
                updated_at = NOW()`
      );
    }
  } catch (err) {
    logger.warn({ err }, "cryptoBotWorker fast cycle error");
  } finally {
    isFastTickRunning = false;
  }
}

/**
 * Evaluates a single coin on closed M15/M5 klines plus M1 LTF refinement (when S1+S2 pass or pinned active)
 * and persists live SMC telemetry, zones & scanner state. Shared across background scan loop and Favorite pinning.
 */
export async function evaluateAndPersistSymbolSmc(
  rawSym: string,
  maxSlPct: number,
  leverage: number,
  openTradeMap?: Map<string, { side: string; isSmc: boolean }>,
  activeSym?: string
): Promise<{ sym: string; evalRes: ReturnType<typeof analyzeLiveSmcTelemetry> } | null> {
  const sym = await resolveLiveBinanceSymbol(rawSym);
  const [m5, m15] = await Promise.all([
    fetchBinanceKlines(sym, "5m", 120),
    fetchBinanceKlines(sym, "15m", 90),
  ]);
  if (m5.length < 25 || m15.length < 15) return null;

  let evalRes = analyzeLiveSmcTelemetry(sym, m5, m15, maxSlPct, leverage, 1.35);
  const preBias = String(evalRes.telemetry.m15_bias || "");
  const hasM15Bias = preBias.includes("BULLISH") || preBias.includes("BEARISH");
  const hasM5Sweep = String(evalRes.telemetry.sweep_status || "").includes("PASS");
  const isPinnedActive = Boolean(activeSym && sym.toUpperCase() === activeSym.toUpperCase());
  if (isPinnedActive || (hasM15Bias && hasM5Sweep)) {
    const m1 = await fetchBinanceKlines(sym, "1m", 120);
    if (m1.length >= 25) {
      evalRes = analyzeLiveSmcTelemetry(sym, m5, m15, maxSlPct, leverage, 1.35, m1);
    }
  }
  const t = evalRes.telemetry as any;
  const openInfo = openTradeMap?.get(sym.toUpperCase());

  if (openInfo?.isSmc) {
    // Keep all 9/9 PASS step telemetry locked while an SMC trade is actively running on this coin; refresh live M5 candles only
    await db.execute(
      sql`INSERT INTO smc_telemetry (
            symbol, m15_bias, sweep_status, sweep_price, choch_status, choch_price,
            fvg_status, fvg_bounds_json, retest_status, s6_status, s7_status, s8_status, s9_status, action, updated_at
          ) VALUES (
            ${sym},
            ${openInfo.side === "BUY" ? "BULLISH 🟢" : "BEARISH 🔴"},
            'PASS 🟢 (Active Trade)', ${Number(t.sweep_price || 0).toString()},
            'PASS 🟢 (Active Trade)', ${Number(t.choch_price || 0).toString()},
            'PASS 🟢 (Active Trade)', ${t.fvg_bounds_json},
            'PASS 🟢 (Active Trade)', 'PASS 🟢 (Active Trade)', 'PASS 🟢 (Active Trade)',
            'PASS 🟢 (SL Protected)', 'PASS 🟢 (M15 Target Active)', ${openInfo.side}, NOW()
          )
          ON CONFLICT (symbol) DO UPDATE SET
            m15_bias = ${openInfo.side === "BUY" ? "BULLISH 🟢" : "BEARISH 🔴"},
            sweep_status = 'PASS 🟢 (Active Trade)',
            choch_status = 'PASS 🟢 (Active Trade)',
            fvg_status = 'PASS 🟢 (Active Trade)',
            fvg_bounds_json = EXCLUDED.fvg_bounds_json,
            retest_status = 'PASS 🟢 (Active Trade)',
            s6_status = 'PASS 🟢 (Active Trade)',
            s7_status = 'PASS 🟢 (Active Trade)',
            s8_status = 'PASS 🟢 (SL Protected)',
            s9_status = 'PASS 🟢 (M15 Target Active)',
            action = ${openInfo.side},
            updated_at = NOW()`
    );
  } else {
    await db.execute(
      sql`INSERT INTO smc_telemetry (
            symbol, m15_bias, sweep_status, sweep_price, choch_status, choch_price,
            fvg_status, fvg_bounds_json, retest_status, s6_status, s7_status, s8_status, s9_status, action, updated_at
          ) VALUES (
            ${sym}, ${t.m15_bias}, ${t.sweep_status}, ${Number(t.sweep_price || 0).toString()},
            ${t.choch_status}, ${Number(t.choch_price || 0).toString()},
            ${t.fvg_status}, ${t.fvg_bounds_json}, ${t.retest_status}, ${t.s6_status}, ${t.s7_status},
            ${t.s8_status || ""}, ${t.s9_status || ""}, ${t.action}, NOW()
          )
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
            updated_at = NOW()`
    );
  }

  await db.execute(sql`DELETE FROM fvg_zones WHERE UPPER(symbol) = ${sym.toUpperCase()}`);
  for (const rz of evalRes.rawZones) {
    await db.execute(
      sql`INSERT INTO fvg_zones (symbol, zone_type, low_price, high_price, updated_at)
          VALUES (${sym}, ${rz.zoneType}, ${rz.low.toString()}, ${rz.high.toString()}, NOW())`
    );
  }

  const biasStr = String(t.m15_bias || "");
  const actLabel =
    t.action === "BUY" || t.action === "SELL"
      ? t.action
      : biasStr.includes("BULLISH")
      ? "BULL_BIAS"
      : biasStr.includes("BEARISH")
      ? "BEAR_BIAS"
      : "NEUTRAL";
  const pctScore = Number(((evalRes.stepProgress / Math.max(1, evalRes.stepTotal ?? 7)) * 100).toFixed(2));
  const tpCol = evalRes.tpPrice > 0 ? evalRes.tpPrice : evalRes.livePrice;

  await db.execute(
    sql`INSERT INTO scanned_assets (symbol_pair, price_a, price_b, win_rate, z_score, action, updated_at)
        VALUES (${sym}, ${evalRes.livePrice.toString()}, ${tpCol.toString()}, ${pctScore.toString()}, ${Number(evalRes.rrr || 0).toString()}, ${actLabel}, NOW())
        ON CONFLICT (symbol_pair) DO UPDATE SET
          price_a = EXCLUDED.price_a,
          price_b = EXCLUDED.price_b,
          win_rate = EXCLUDED.win_rate,
          z_score = EXCLUDED.z_score,
          action = EXCLUDED.action,
          updated_at = NOW()`
  );

  return { sym, evalRes };
}

async function runSmcScanCycle() {
  if (isScanTickRunning) return;
  isScanTickRunning = true;
  try {
    const botRow = ((await db.execute(sql`SELECT * FROM bot_state ORDER BY id ASC LIMIT 1`)).rows || [])[0] as any;
    if (!botRow) return;

    const activeSym = await resolveLiveBinanceSymbol(String(botRow.active_pair || "BTCUSDT"));
    const favList = parseFavoritePairs(botRow.favorite_pairs);
    const scanSet = new Set<string>(TOP_10_CRYPTO_COINS);
    for (const f of favList) scanSet.add(await resolveLiveBinanceSymbol(f));
    if (activeSym) scanSet.add(activeSym);
    const scanList = Array.from(scanSet);

    // Clean any legacy Forex/slash pairs and unpinned stale non-Top10 symbols from scanned_assets
    await db.execute(sql`DELETE FROM scanned_assets WHERE symbol_pair LIKE '%/%'`);
    const existingRows = (await db.execute(sql`SELECT symbol_pair FROM scanned_assets`)).rows as any[];
    for (const er of existingRows) {
      const sU = String(er.symbol_pair || "").toUpperCase();
      if (sU && !scanSet.has(sU)) {
        await db.execute(sql`DELETE FROM scanned_assets WHERE UPPER(symbol_pair) = ${sU}`);
      }
    }

    const maxSlPct = Number(botRow.max_sl_pct ?? 1.2);
    const leverage = Number(botRow.leverage ?? 5);
    const riskPct = Number(botRow.risk_percent ?? 1.0);
    const accountMode = String(botRow.account_mode || "PROP_FIRM").toUpperCase();
    const maxMarginPct =
      accountMode === "PERSONAL"
        ? Math.min(100, Number(botRow.max_margin_pct ?? 100))
        : Math.min(80, Number(botRow.max_margin_pct ?? 80));
    const autoExec = Boolean(botRow.auto_execute ?? true);
    const isRunning = Boolean(botRow.is_bot_running ?? true);

    const openTradeRows = (
      await db.execute(sql`SELECT UPPER(symbol) AS sym, order_type, comment FROM trades WHERE status='OPEN'`)
    ).rows as any[];
    const openTradeMap = new Map<string, { side: string; isSmc: boolean }>();
    for (const r of openTradeRows) {
      openTradeMap.set(String(r.sym).toUpperCase(), {
        side: String(r.order_type || "BUY").toUpperCase(),
        isSmc: String(r.comment || "").toUpperCase().includes("SMC"),
      });
    }

    const candidates: Array<{
      sym: string;
      evalRes: ReturnType<typeof analyzeLiveSmcTelemetry>;
      sc: number;
      sweepKey: string;
    }> = [];

    const hostCd = getHostCooldownState(getBaseUrl());
    if (hostCd.softThrottled && !hostCd.coolingDown) {
      logger.info("Skipping background SMC kline scan briefly while Binance API weight cools down");
      return;
    }

    for (let i = 0; i < scanList.length; i++) {
      const sym = scanList[i]!;
      const evaluated = await evaluateAndPersistSymbolSmc(sym, maxSlPct, leverage, openTradeMap, activeSym);
      if (i < scanList.length - 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!evaluated) continue;
      const { evalRes } = evaluated;
      const t = evalRes.telemetry as any;

      if (t.action === "BUY" || t.action === "SELL") {
        const tradable = await isSymbolTradableOnVenue(evaluated.sym);
        if (!tradable) continue;
        const m1Boost = evalRes.executionMode === "M1_LTF" ? 0.25 : 0;
        const sc = (evalRes.rrr || 1.35) + m1Boost + (evaluated.sym === activeSym ? 2.0 : favList.includes(evaluated.sym) ? 1.0 : 0);
        candidates.push({
          sym: evaluated.sym,
          evalRes,
          sc,
          sweepKey: String(evalRes.sweepKey || ""),
        });
      }
    }

    if (candidates.length === 0) return;
    candidates.sort((a, b) => b.sc - a.sc);

    const nowMs = Date.now();
    for (const [k, ts] of usedSweepKeys.entries()) {
      if (nowMs - ts > 4 * 3600_000) usedSweepKeys.delete(k);
    }

    const equity = Number(botRow.equity ?? 0) || Number(botRow.initial_balance ?? 10000);
    if (!autoExec) {
      const top = candidates[0]!;
      const topAction = (top.evalRes.telemetry as any).action as "BUY" | "SELL";
      const filter = await getSymbolFilters(top.sym);
      const sized = calculateFuturesQty(
        filter,
        top.evalRes.livePrice,
        top.evalRes.slPrice,
        equity,
        riskPct,
        leverage,
        maxMarginPct,
        accountMode
      );
      const lastAlert = signalCooldown.get(top.sym) || 0;
      if (Date.now() - lastAlert >= 300_000) {
        signalCooldown.set(top.sym, Date.now());
        await sendDiscordCryptoSignalAlert({
          action: topAction,
          symbol: top.sym,
          entryPrice: top.evalRes.livePrice,
          slPrice: top.evalRes.slPrice,
          tpPrice: top.evalRes.tpPrice,
          rrr: top.evalRes.rrr,
          qty: sized.qty,
          leverage,
          accountMode,
          riskUsdt: sized.riskUsdt,
          marginPct: sized.marginPct,
          maxMarginPct,
          isSignalOnly: true,
        });
      }
      return;
    }

    if (!isRunning || !hasApiCreds() || !isSessionWindowOpen(botRow)) return;
    if (String(botRow.system_status || "").startsWith("HALTED")) return;
    if (Boolean(botRow.risk_limits_enabled ?? true) && Number(botRow.trades_today ?? 0) >= Number(botRow.max_trades ?? 10)) {
      return;
    }

    // Strict Single-Trade Lock verified directly on Binance
    const snap = await getAccountSnapshot();
    if (snap.statusCode !== 200 || snap.positions.length >= 1) return;

    for (const cand of candidates) {
      const { sym, evalRes, sweepKey } = cand;
      const action = (evalRes.telemetry as any).action as "BUY" | "SELL";
      const sweepToken = sweepKey ? `${sym}|${sweepKey}` : "";
      if (sweepToken && usedSweepKeys.has(sweepToken)) continue;

      const lastCd = tradeCooldown.get(sym) || 0;
      if (Date.now() - lastCd < 180_000) continue;

      const filter = await getSymbolFilters(sym);
      const sized = calculateFuturesQty(
        filter,
        evalRes.livePrice,
        evalRes.slPrice,
        equity,
        riskPct,
        leverage,
        maxMarginPct,
        accountMode
      );
      if (sized.qty <= 0) {
        logger.info({ sym, err: sized.error }, "SMC sizing skipped");
        continue;
      }

      const sigIns = await db.execute(
        sql`INSERT INTO signals (symbol_a, symbol_b, price_a, price_b, beta, alpha, z_score, obi, action)
            VALUES (${sym}, ${`${evalRes.rrr.toFixed(2)}R`}, ${evalRes.livePrice.toString()}, ${evalRes.tpPrice.toString()}, ${evalRes.slPrice.toString()}, ${leverage.toString()}, ${evalRes.rrr.toString()}, ${sized.marginPct.toString()}, ${action})
            RETURNING id`
      );
      const sigId = Number(((sigIns.rows || [])[0] as any)?.id || 0) || undefined;

      const modeTag = evalRes.executionMode === "M1_LTF" ? "M1" : "M5";
      const exec = await executeSingleFuturesOrder(
        sym,
        action,
        sized.qty,
        evalRes.livePrice,
        evalRes.slPrice,
        evalRes.tpPrice,
        leverage,
        `SMC_9STEP_${modeTag}_${accountMode}`,
        sigId
      );
      if (exec.ok) {
        tradeCooldown.set(sym, Date.now());
        if (sweepToken) usedSweepKeys.set(sweepToken, Date.now());
        await sendDiscordCryptoSignalAlert({
          action,
          symbol: sym,
          entryPrice: exec.fillPrice || evalRes.livePrice,
          slPrice: exec.sl || evalRes.slPrice,
          tpPrice: exec.tp || evalRes.tpPrice,
          rrr: evalRes.rrr,
          qty: sized.qty,
          leverage,
          accountMode,
          riskUsdt: sized.riskUsdt,
          marginPct: sized.marginPct,
          maxMarginPct,
          ticketId: exec.orderId,
          isSignalOnly: false,
        });
        logger.info({ sym, action, modeTag, qty: sized.qty, entry: exec.fillPrice }, "Cloud Crypto SMC order executed");
        break;
      } else {
        logger.warn({ sym, action, err: exec.error }, "Cloud Crypto SMC execution rejected; checking next candidate");
      }
    }
  } catch (err) {
    logger.warn({ err }, "cryptoBotWorker scan cycle error");
  } finally {
    isScanTickRunning = false;
  }
}

export function startCryptoBotWorker() {
  if (started) return;
  if ((process.env.ENABLE_CLOUD_BOT || "").trim().toLowerCase() === "false") {
    logger.info("Cloud Crypto SMC Worker disabled via ENABLE_CLOUD_BOT=false");
    return;
  }
  started = true;
  logger.info(
    { mode: isTestnet() ? "BINANCE_TESTNET" : "BINANCE_MAINNET", hasKeys: hasApiCreds() },
    "Starting Direct Cloud Crypto 9-Step SMC Worker (No VPS required)"
  );

  void syncBinanceTime().then(() => {
    void reconcileRecentClosedDiscrepancies();
  });
  setTimeout(() => {
    void runFastCycle();
    void runSmcScanCycle();
  }, 1500);

  setInterval(() => void runFastCycle(), 15000);
  setInterval(() => void runSmcScanCycle(), 25000);
}
