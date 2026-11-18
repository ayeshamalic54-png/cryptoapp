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
  formatCryptoPrice,
  resolveBinanceSymbol,
} from "./smcEngine";
import { fetchBinanceKlines, resolveLiveBinanceSymbol, TOP_10_CRYPTO_COINS } from "../routes/binance";
import { postDiscordPayload, sendDiscordCryptoCloseAlert, sendDiscordCryptoSignalAlert } from "./discord";
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
const tradeCooldown = new Map<string, number>();
const signalCooldown = new Map<string, number>();

let timeOffsetMs = 0;
let timeSynced = false;
let isFastTickRunning = false;
let isScanTickRunning = false;
let started = false;
let peakEquityTracker = 0;

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
  if (!timeSynced) await syncBinanceTime();

  const buildUrl = () => {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) usp.set(k, String(v));
    usp.set("timestamp", String(Date.now() + timeOffsetMs));
    usp.set("recvWindow", "10000");
    const qs = usp.toString();
    const sig = crypto.createHmac("sha256", secret).update(qs).digest("hex");
    return `${getBaseUrl()}${endpoint}?${qs}&signature=${sig}`;
  };

  let resp = await fetch(buildUrl(), {
    method,
    headers: { "X-MBX-APIKEY": key },
    signal: AbortSignal.timeout(10000),
  });
  let text = await resp.text();
  if (resp.status === 400 && text.includes("-1021")) {
    await syncBinanceTime();
    resp = await fetch(buildUrl(), {
      method,
      headers: { "X-MBX-APIKEY": key },
      signal: AbortSignal.timeout(10000),
    });
    text = await resp.text();
  }
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: resp.status, ok: resp.ok, data, text };
}

async function getSymbolFilters(symbol: string): Promise<SymbolFilter> {
  const sym = await resolveLiveBinanceSymbol(symbol);
  const cached = filterCache.get(sym);
  if (cached && Date.now() - cached.ts < 600_000) return cached.filter;

  try {
    const r = await fetch(`${getBaseUrl()}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const json = (await r.json()) as { symbols?: any[] };
      for (const s of json.symbols || []) {
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
    }
  } catch {}

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

async function ensureLeverage(symbol: string, targetLev: number): Promise<number> {
  const lev = Math.max(1, Math.min(50, Math.round(targetLev || 5)));
  if (leverageCache.get(symbol) === lev) return lev;
  for (const cand of [lev, Math.min(lev, 20), Math.min(lev, 10), Math.min(lev, 5), 1]) {
    const res = await signedBinanceRequest("POST", "/fapi/v1/leverage", { symbol, leverage: cand });
    if (res.ok) {
      const actual = Number(res.data?.leverage ?? cand);
      leverageCache.set(symbol, actual);
      return actual;
    }
  }
  return lev;
}

async function getAccountSnapshot(): Promise<{
  equity: number;
  avail: number;
  positions: any[];
  statusCode: number;
}> {
  const [accRes, posRes] = await Promise.all([
    signedBinanceRequest("GET", "/fapi/v2/account"),
    signedBinanceRequest("GET", "/fapi/v2/positionRisk"),
  ]);
  if (!accRes.ok) {
    return { equity: 0, avail: 0, positions: [], statusCode: accRes.status };
  }
  const wallet = Number(accRes.data?.totalWalletBalance ?? 0);
  const unreal = Number(accRes.data?.totalUnrealizedProfit ?? 0);
  const marginBal = Number(accRes.data?.totalMarginBalance ?? wallet + unreal);
  const usdtAsset = Array.isArray(accRes.data?.assets)
    ? accRes.data.assets.find((a: any) => String(a.asset || "").toUpperCase() === "USDT")
    : null;
  const lockedInitMargin = Number(accRes.data?.totalInitialMargin ?? 0);
  const usdtMultiEq = usdtAsset ? Number(usdtAsset.availableBalance ?? 0) + lockedInitMargin : 0;
  const avail = usdtAsset && Number(usdtAsset.availableBalance ?? 0) > 0
    ? Number(usdtAsset.availableBalance)
    : Number(accRes.data?.availableBalance ?? wallet);
  const equityVal = accRes.data?.multiAssetsMargin && usdtMultiEq > 0 ? Math.max(marginBal, usdtMultiEq) : marginBal;

  const positions = Array.isArray(posRes.data)
    ? posRes.data
        .filter((p) => Math.abs(Number(p.positionAmt || 0)) > 0)
        .map((p) => ({
          symbol: String(p.symbol),
          side: Number(p.positionAmt) > 0 ? ("BUY" as const) : ("SELL" as const),
          qty: Math.abs(Number(p.positionAmt)),
          entryPrice: Number(p.entryPrice || 0),
          markPrice: Number(p.markPrice || p.entryPrice || 0),
          unrealizedPnl: Number(p.unRealizedProfit || 0),
        }))
    : [];

  return { equity: Number(equityVal.toFixed(2)), avail: Number(avail.toFixed(2)), positions, statusCode: 200 };
}

function calculateFuturesQty(
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
  const rawQtyRisk = riskBudget / slDist;
  const maxNotional = equity * (capMarginPct / 100) * effLev;
  const maxQtyMargin = maxNotional / entryPrice;
  let qty = quantizeStep(Math.min(rawQtyRisk, maxQtyMargin), filter.stepSize, false);
  let notional = qty * entryPrice;

  if (notional < filter.minNotional || qty < filter.minQty) {
    const reqNotional = Math.max(filter.minNotional * 1.02, filter.minQty * entryPrice);
    const bumpQty = quantizeStep(reqNotional / entryPrice, filter.stepSize, true);
    const bumpNotional = bumpQty * entryPrice;
    const bumpRiskPct = ((bumpQty * slDist) / equity) * 100;
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
    riskUsdt: Number((qty * slDist).toFixed(2)),
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
 * Places a reduceOnly LIMIT Take Profit order (0.02% Maker fee vs 0.05% Taker fee — saves 60% exit fee),
 * falling back to TAKE_PROFIT_MARKET only if the exchange rejects immediate limit placement.
 */
async function placeLowFeeTpOrder(symbol: string, exitSide: "BUY" | "SELL", tpPrice: number, qty: number) {
  const lim = await signedBinanceRequest("POST", "/fapi/v1/order", {
    symbol,
    side: exitSide,
    type: "LIMIT",
    timeInForce: "GTC",
    quantity: String(qty),
    price: String(tpPrice),
    reduceOnly: "true",
  });
  if (lim.ok) return true;
  return placeConditionalClose(symbol, exitSide, "TAKE_PROFIT_MARKET", tpPrice);
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

  await ensureLeverage(binSym, leverage);
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

  let slRound = quantizeTick(slPrice, filter.tickSize);
  let tpRound = quantizeTick(tpPrice, filter.tickSize);
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
  await placeLowFeeTpOrder(binSym, exitSide, tpRound, execQty);

  await db.execute(
    sql`INSERT INTO trades (ticket, symbol, order_type, lots, entry_price, sl, tp, entry_time, status, comment, signal_id, mt5_login)
        VALUES (${orderId}, ${binSym}, ${side}, ${execQty.toString()}, ${fillPrice.toString()}, ${slRound.toString()}, ${tpRound.toString()}, NOW(), 'OPEN', ${comment}, ${signalId ?? null}, 0)
        ON CONFLICT (ticket) DO NOTHING`
  );

  return { ok: true, orderId, fillPrice, sl: slRound, tp: tpRound };
}

async function closeSymbolPositions(targetSymbol: string, positions: any[], reason = "Closed") {
  const resolved = targetSymbol.toUpperCase() === "ALL" ? null : await resolveLiveBinanceSymbol(targetSymbol);
  for (const pos of positions) {
    if (resolved && pos.symbol !== resolved) continue;
    await cancelAllOrders(pos.symbol);
    const exitSide = pos.side === "BUY" ? "SELL" : "BUY";
    const r = await signedBinanceRequest("POST", "/fapi/v1/order", {
      symbol: pos.symbol,
      side: exitSide,
      type: "MARKET",
      quantity: String(pos.qty),
      reduceOnly: "true",
      newOrderRespType: "RESULT",
    });
    if (r.ok) {
      const closeP = Number(r.data?.avgPrice || 0) || pos.markPrice || pos.entryPrice;
      await reconcileClosedSymbol(pos.symbol, closeP, pos.unrealizedPnl, reason);
    }
  }
}

async function reconcileClosedSymbol(symbol: string, fallbackClose = 0, fallbackPnl = 0, reason = "SL/TP Fill") {
  const openRows = (
    await db.execute(sql`SELECT ticket, entry_time, entry_price, order_type, lots FROM trades WHERE status='OPEN' AND UPPER(symbol)=${symbol.toUpperCase()}`)
  ).rows as any[];
  if (!openRows.length) return;

  let fills: any[] = [];
  const uRes = await signedBinanceRequest("GET", "/fapi/v1/userTrades", { symbol, limit: 25 });
  if (uRes.ok && Array.isArray(uRes.data)) fills = uRes.data;

  for (const row of openRows) {
    const entryMs = row.entry_time ? new Date(row.entry_time).getTime() : 0;
    let rpnl = 0;
    let fees = 0;
    let closeP = fallbackClose || Number(row.entry_price || 0);
    let matched = false;
    for (const f of fills) {
      if (Number(f.time || 0) >= entryMs - 5000) {
        const rp = Number(f.realizedPnl || 0);
        if (Math.abs(rp) > 0) {
          rpnl += rp;
          closeP = Number(f.price || closeP) || closeP;
          matched = true;
        }
        if (String(f.commissionAsset || "").toUpperCase() === "USDT") {
          fees += Number(f.commission || 0);
        }
      }
    }
    const netPnl = matched ? Number((rpnl - fees).toFixed(2)) : Number(fallbackPnl.toFixed(2));
    await db.execute(
      sql`UPDATE trades SET close_price=${closeP.toString()}, profit=${netPnl.toString()}, close_time=NOW(), status='CLOSED' WHERE ticket=${Number(row.ticket)}`
    );
    await sendDiscordCryptoCloseAlert(
      Number(row.ticket),
      symbol,
      String(row.order_type || "BUY"),
      Number(row.lots || 0),
      closeP,
      netPnl,
      reason
    );
  }
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

    if (credsPresent) {
      const snap = await getAccountSnapshot();
      binanceStatusCode = snap.statusCode;
      if (snap.statusCode === 200) {
        equity = snap.equity;
        positions = snap.positions;
      }
    }
    const binanceBlocked451 = binanceStatusCode === 451;
    const binanceAuthErr = credsPresent && binanceStatusCode !== 200 && !binanceBlocked451;

    // Reconcile closed / open DB positions with live Binance
    if (credsPresent && !binanceBlocked451) {
      const openDbSyms = (await db.execute(sql`SELECT DISTINCT UPPER(symbol) AS sym FROM trades WHERE status='OPEN'`)).rows as any[];
      const liveSet = new Set(positions.map((p) => p.symbol.toUpperCase()));
      for (const r of openDbSyms) {
        if (!liveSet.has(r.sym)) {
          await cancelAllOrders(r.sym);
          await reconcileClosedSymbol(r.sym, 0, 0, "Server SL/TP Fill");
        }
      }
      for (const p of positions) {
        await db.execute(
          sql`UPDATE trades SET close_price=${p.markPrice.toString()}, profit=${Number(p.unrealizedPnl.toFixed(2)).toString()} WHERE status='OPEN' AND UPPER(symbol)=${p.symbol.toUpperCase()}`
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
            await closeSymbolPositions(String(cmd.symbol), positions, "Manual Close");
          } else if (dir === "BUY" || dir === "SELL") {
            const sym = await resolveLiveBinanceSymbol(String(cmd.symbol));
            const tRes = await fetch(`${getBaseUrl()}/fapi/v1/ticker/bookTicker?symbol=${sym}`, { signal: AbortSignal.timeout(5000) });
            const td = (await tRes.json()) as any;
            const entryP = (Number(td.bidPrice) + Number(td.askPrice)) * 0.5;
            const slFrac = Number(cmd.sl_pips || 1.2) / 100;
            const tpFrac = Number(cmd.tp_pips || 2.4) / 100;
            const slP = dir === "BUY" ? entryP * (1 - slFrac) : entryP * (1 + slFrac);
            const tpP = dir === "BUY" ? entryP * (1 + tpFrac) : entryP * (1 - tpFrac);
            const ex = await executeSingleFuturesOrder(sym, dir, Number(cmd.lots), entryP, slP, tpP, Number(botRow.leverage ?? 5), String(cmd.comment || "MANUAL_FUTURES"));
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

      // Guardian Shield + One-Time Fee-Aware Breakeven (ZERO Trailing Stop!)
      const accMode = String(botRow.account_mode || "PROP_FIRM").toUpperCase();
      const shieldPct = Number(botRow.guardian_shield_pct ?? 1.8);
      const riskEnabled = Boolean(botRow.risk_limits_enabled ?? true);

      for (const p of positions) {
        const upnl = Number(p.unrealizedPnl || 0);
        if (accMode === "PROP_FIRM" && riskEnabled && equity > 0 && upnl < 0 && (-upnl / equity) * 100 >= shieldPct) {
          await closeSymbolPositions(p.symbol, [p], `Guardian Shield -${shieldPct}%`);
          await postDiscordPayload(`🛡️ **GUARDIAN SHIELD TRIGGERED**: Closed \`${p.symbol}\` to protect Blue Guardian floating limit.`);
          continue;
        }
        const meta = ((
          await db.execute(sql`SELECT ticket, entry_time, entry_price, COALESCE(sl,0) AS sl, COALESCE(tp,0) AS tp FROM trades WHERE status='OPEN' AND UPPER(symbol)=${p.symbol.toUpperCase()} ORDER BY entry_time DESC LIMIT 1`)
        ).rows || [])[0] as any;
        if (!meta) continue;
        const ticket = Number(meta.ticket);
        if (beLockedTickets.has(ticket)) continue;
        const ageSec = meta.entry_time ? (Date.now() - new Date(meta.entry_time).getTime()) / 1000 : 999;
        if (accMode === "PROP_FIRM" && ageSec < 140) continue;

        const isLong = p.side === "BUY";
        const entryP = Number(meta.entry_price || p.entryPrice);
        const slP = Number(meta.sl || 0);
        const tpP = Number(meta.tp || 0);
        const alreadyBe = isLong ? slP >= entryP * 1.0005 : slP > 0 && slP <= entryP * 0.9995;
        if (alreadyBe) {
          beLockedTickets.add(ticket);
          continue;
        }

        const slDist = slP > 0 ? Math.abs(entryP - slP) : entryP * 0.01;
        const favMove = isLong ? p.markPrice - entryP : entryP - p.markPrice;
        const currR = slDist > 0 ? favMove / slDist : 0;
        const notional = p.qty * entryP;
        const stagBe = ageSec >= 3600 && notional > 0 && upnl / notional >= 0.0015;

        if (currR >= 1.0 || stagBe) {
          const filter = await getSymbolFilters(p.symbol);
          const beSl = quantizeTick(isLong ? entryP * 1.0015 : entryP * 0.9985, filter.tickSize);
          await cancelAllOrders(p.symbol);
          const exitSide = isLong ? "SELL" : "BUY";
          const okBe = await placeConditionalClose(p.symbol, exitSide, "STOP_MARKET", beSl);
          if (tpP > 0) await placeLowFeeTpOrder(p.symbol, exitSide, quantizeTick(tpP, filter.tickSize), p.qty);
          if (okBe) {
            beLockedTickets.add(ticket);
            await db.execute(sql`UPDATE trades SET sl=${beSl.toString()} WHERE ticket=${ticket}`);
            await postDiscordPayload(
              `🛡️ **ONE-TIME FEE-SAFE BREAKEVEN LOCKED** · \`${p.symbol}\` (#${ticket})\n` +
                `SL moved to \`$${formatCryptoPrice(beSl)}\` (+0.15% fee buffer) | Maker TP remains fixed at \`$${formatCryptoPrice(tpP)}\``
            );
          }
        }
      }
    }

    const floating = positions.reduce((s, p) => s + Number(p.unrealizedPnl || 0), 0);
    const todayStr = getPktDateStr();
    const dmRow = ((
      await db.execute(sql`SELECT start_equity FROM daily_metrics WHERE trading_date=${todayStr} AND COALESCE(mt5_login,0)=0 LIMIT 1`)
    ).rows || [])[0] as any;
    const startEq = Number(dmRow?.start_equity ?? 0) > 0 ? Number(dmRow.start_equity) : equity || Number(botRow.initial_balance || 10000);
    if (!dmRow && equity > 0) {
      await db.execute(
        sql`INSERT INTO daily_metrics (trading_date, start_equity, current_equity, max_drawdown_percent, trades_today, mt5_login, updated_at)
            VALUES (${todayStr}, ${startEq.toString()}, ${equity.toString()}, 0, 0, 0, NOW())
            ON CONFLICT (trading_date, mt5_login) DO NOTHING`
      );
    }

    const dailyDdPct = startEq > 0 && equity > 0 ? Math.max(0, Number((((startEq - equity) / startEq) * 100).toFixed(2))) : 0;
    const initBal = Number(botRow.initial_balance ?? 0) > 0 ? Number(botRow.initial_balance) : equity || 10000;
    const overallDdPct = initBal > 0 && equity > 0 ? Math.max(0, Number((((initBal - equity) / initBal) * 100).toFixed(2))) : 0;
    peakEquityTracker = Math.max(peakEquityTracker, Number(botRow.max_equity_peak ?? 0), equity);

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
    const sysStatus = binanceBlocked451
      ? "BLOCKED (Binance US IP 451 — Deploy Render Singapore)"
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

async function runSmcScanCycle() {
  if (isScanTickRunning) return;
  isScanTickRunning = true;
  try {
    const botRow = ((await db.execute(sql`SELECT * FROM bot_state ORDER BY id ASC LIMIT 1`)).rows || [])[0] as any;
    if (!botRow) return;

    const activeSym = await resolveLiveBinanceSymbol(String(botRow.active_pair || "BTCUSDT"));
    const scanList = [...TOP_10_CRYPTO_COINS];
    if (activeSym && !scanList.includes(activeSym)) scanList.push(activeSym);

    // Clean any legacy Forex/slash pairs from scanned_assets & fvg_zones
    await db.execute(sql`DELETE FROM scanned_assets WHERE symbol_pair LIKE '%/%'`);

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

    let bestCandidate: { sym: string; evalRes: ReturnType<typeof analyzeLiveSmcTelemetry> } | null = null;
    let bestScore = -1;

    for (const sym of scanList) {
      const [m5, m15] = await Promise.all([
        fetchBinanceKlines(sym, "5m", 120),
        fetchBinanceKlines(sym, "15m", 90),
      ]);
      if (m5.length < 25 || m15.length < 15) continue;

      const evalRes = analyzeLiveSmcTelemetry(sym, m5, m15, maxSlPct, leverage, 1.85);
      const t = evalRes.telemetry as any;

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
      const pctScore = Number(((evalRes.stepProgress / 9) * 100).toFixed(2));
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

      if (t.action === "BUY" || t.action === "SELL") {
        const sc = (evalRes.rrr || 1.85) + (sym === activeSym ? 2.0 : 0);
        if (sc > bestScore) {
          bestScore = sc;
          bestCandidate = { sym, evalRes };
        }
      }
    }

    if (!bestCandidate) return;

    const { sym, evalRes } = bestCandidate;
    const action = (evalRes.telemetry as any).action as "BUY" | "SELL";
    const equity = Number(botRow.equity ?? 0) || Number(botRow.initial_balance ?? 10000);
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

    if (!autoExec) {
      const lastAlert = signalCooldown.get(sym) || 0;
      if (Date.now() - lastAlert >= 300_000) {
        signalCooldown.set(sym, Date.now());
        await sendDiscordCryptoSignalAlert({
          action,
          symbol: sym,
          entryPrice: evalRes.livePrice,
          slPrice: evalRes.slPrice,
          tpPrice: evalRes.tpPrice,
          rrr: evalRes.rrr,
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

    const lastCd = tradeCooldown.get(sym) || 0;
    if (Date.now() - lastCd < 180_000) return;
    if (sized.qty <= 0) {
      logger.info({ sym, err: sized.error }, "SMC sizing skipped");
      return;
    }

    // Strict Single-Trade Lock verified directly on Binance
    const snap = await getAccountSnapshot();
    if (snap.statusCode !== 200 || snap.positions.length >= 1) return;

    const sigIns = await db.execute(
      sql`INSERT INTO signals (symbol_a, symbol_b, price_a, price_b, beta, alpha, z_score, obi, action)
          VALUES (${sym}, ${`${evalRes.rrr.toFixed(2)}R`}, ${evalRes.livePrice.toString()}, ${evalRes.tpPrice.toString()}, ${evalRes.slPrice.toString()}, ${leverage.toString()}, ${evalRes.rrr.toString()}, ${sized.marginPct.toString()}, ${action})
          RETURNING id`
    );
    const sigId = Number(((sigIns.rows || [])[0] as any)?.id || 0) || undefined;

    const exec = await executeSingleFuturesOrder(
      sym,
      action,
      sized.qty,
      evalRes.livePrice,
      evalRes.slPrice,
      evalRes.tpPrice,
      leverage,
      `SMC_9STEP_${accountMode}`,
      sigId
    );
    if (exec.ok) {
      tradeCooldown.set(sym, Date.now());
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
      logger.info({ sym, action, qty: sized.qty, entry: exec.fillPrice }, "Cloud Crypto SMC order executed");
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

  void syncBinanceTime();
  setTimeout(() => {
    void runFastCycle();
    void runSmcScanCycle();
  }, 1500);

  setInterval(() => void runFastCycle(), 4500);
  setInterval(() => void runSmcScanCycle(), 14000);
}
