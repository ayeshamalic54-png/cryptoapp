import { Router } from "express";
import { analyzeLiveSmcTelemetry, resolveBinanceSymbol, type OhlcBar } from "../lib/smcEngine";
import { getHostCooldownState, recordBinanceResponse } from "../lib/binanceRateLimit";

const router = Router();

export const TOP_10_CRYPTO_COINS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "SUIUSDT",
];

function getBinanceBaseUrl(): string {
  const isTestnet = ["true", "1", "yes"].includes((process.env.USE_BINANCE_TESTNET || "").trim().toLowerCase());
  return isTestnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
}

interface ExchangeSymEntry {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  stepSize: number;
  minNotional: number;
  marketType: "FUTURES" | "SPOT";
  tradableOnActiveVenue: boolean;
}

let symbolsCache: { ts: number; base: string; list: ExchangeSymEntry[] } = { ts: 0, base: "", list: [] };

function parseExchangeSymbols(json: { symbols?: any[] }, marketType: "FUTURES" | "SPOT", isActiveVenue: boolean): ExchangeSymEntry[] {
  const out: ExchangeSymEntry[] = [];
  for (const s of json.symbols || []) {
    if (s.status !== "TRADING" || s.quoteAsset !== "USDT") continue;
    const fmap: Record<string, any> = {};
    for (const f of s.filters || []) fmap[f.filterType] = f;
    out.push({
      symbol: String(s.symbol).toUpperCase(),
      baseAsset: String(s.baseAsset || "").toUpperCase(),
      quoteAsset: "USDT",
      tickSize: parseFloat(fmap.PRICE_FILTER?.tickSize || "0.01") || 0.01,
      stepSize: parseFloat(fmap.LOT_SIZE?.stepSize || "0.001") || 0.001,
      minNotional: parseFloat(fmap.MIN_NOTIONAL?.notional || fmap.MIN_NOTIONAL?.minNotional || fmap.NOTIONAL?.minNotional || "5") || 5,
      marketType,
      tradableOnActiveVenue: isActiveVenue,
    });
  }
  return out;
}

async function fetchJsonSafe(url: string, timeoutMs = 7000): Promise<any | null> {
  if (getHostCooldownState(url).coolingDown) return null;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    recordBinanceResponse(
      url,
      resp.status,
      resp.headers.get("retry-after"),
      resp.headers.get("x-mbx-used-weight-1m")
    );
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function loadExchangeSymbols(): Promise<ExchangeSymEntry[]> {
  const base = getBinanceBaseUrl();
  if (symbolsCache.list.length > 0 && symbolsCache.base === base && Date.now() - symbolsCache.ts < 300_000) {
    return symbolsCache.list;
  }

  const isMainnet = base === "https://fapi.binance.com";
  const [activeFutJson, mainnetFutJson, visionSpotJson] = await Promise.all([
    fetchJsonSafe(`${base}/fapi/v1/exchangeInfo`, 8000),
    isMainnet ? Promise.resolve(null) : fetchJsonSafe("https://fapi.binance.com/fapi/v1/exchangeInfo", 8000),
    fetchJsonSafe("https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT", 8000),
  ]);

  const bySym = new Map<string, ExchangeSymEntry>();
  if (visionSpotJson?.symbols) {
    for (const item of parseExchangeSymbols(visionSpotJson, "SPOT", false)) {
      bySym.set(item.symbol, item);
    }
  }
  if (mainnetFutJson?.symbols) {
    for (const item of parseExchangeSymbols(mainnetFutJson, "FUTURES", false)) {
      bySym.set(item.symbol, item);
    }
  }
  if (activeFutJson?.symbols) {
    for (const item of parseExchangeSymbols(activeFutJson, "FUTURES", true)) {
      bySym.set(item.symbol, item);
    }
  }

  if (bySym.size > 0) {
    const topSet = new Set(TOP_10_CRYPTO_COINS);
    const topList = TOP_10_CRYPTO_COINS.map((sym) => bySym.get(sym)).filter(Boolean) as ExchangeSymEntry[];
    const rest = Array.from(bySym.values())
      .filter((x) => !topSet.has(x.symbol))
      .sort((a, b) => {
        if (a.marketType !== b.marketType) return a.marketType === "FUTURES" ? -1 : 1;
        return a.symbol.localeCompare(b.symbol);
      });
    const combined = [...topList, ...rest];
    symbolsCache = { ts: Date.now(), base, list: combined };
    return combined;
  }
  return symbolsCache.list;
}

export async function isSymbolTradableOnVenue(rawSymbol: string): Promise<boolean> {
  const sym = await resolveLiveBinanceSymbol(rawSymbol);
  const all = await loadExchangeSymbols();
  const hit = all.find((x) => x.symbol === sym);
  return hit ? hit.tradableOnActiveVenue : true;
}

export async function getSymbolMarketType(rawSymbol: string): Promise<"FUTURES" | "SPOT"> {
  const sym = await resolveLiveBinanceSymbol(rawSymbol);
  const all = await loadExchangeSymbols();
  return all.find((x) => x.symbol === sym)?.marketType ?? "FUTURES";
}

export async function resolveLiveBinanceSymbol(rawSymbol: string): Promise<string> {
  const sym = resolveBinanceSymbol(rawSymbol);
  const all = await loadExchangeSymbols();
  if (!all.length) return sym;
  const k1000 = `1000${sym}`;
  const baseNoUsdt = sym.replace("USDT", "");

  const findInTier = (list: ExchangeSymEntry[]) => {
    const byName = new Map(list.map((x) => [x.symbol, x.symbol]));
    if (byName.has(sym)) return byName.get(sym)!;
    if (byName.has(k1000)) return byName.get(k1000)!;
    const exactBase = list.find((x) => x.baseAsset === baseNoUsdt || x.baseAsset === `1000${baseNoUsdt}`);
    if (exactBase) return exactBase.symbol;
    const suffix = list.find((x) => x.symbol.endsWith(sym));
    return suffix?.symbol ?? null;
  };

  return (
    findInTier(all.filter((x) => x.tradableOnActiveVenue)) ??
    findInTier(all.filter((x) => x.marketType === "FUTURES")) ??
    findInTier(all) ??
    sym
  );
}

function mapRawKlines(raw: any[], priceScale = 1): OhlcBar[] {
  return raw.map((k) => ({
    time: Number(k[0]),
    open: Number(k[1]) * priceScale,
    high: Number(k[2]) * priceScale,
    low: Number(k[3]) * priceScale,
    close: Number(k[4]) * priceScale,
    volume: Number(k[5] ?? 100) / (priceScale > 1 ? priceScale : 1),
  }));
}

type KlineMetaResult = { bars: OhlcBar[]; resolvedSymbol: string; marketType: "FUTURES" | "SPOT" };
const klineCache = new Map<string, { ts: number; data: KlineMetaResult }>();
const inFlightKlines = new Map<string, Promise<KlineMetaResult>>();

function getKlineCacheTtlMs(interval: "1m" | "5m" | "15m"): number {
  if (interval === "15m") return 45_000;
  if (interval === "5m") return 15_000;
  return 10_000;
}

export async function fetchBinanceKlinesWithMeta(
  symbol: string,
  interval: "1m" | "5m" | "15m",
  limit = 120
): Promise<KlineMetaResult> {
  const sym = await resolveLiveBinanceSymbol(symbol);
  const ttlMs = getKlineCacheTtlMs(interval);
  const cacheKey = `${sym}|${interval}|${limit}`;
  const cached = klineCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ttlMs && cached.data.bars.length > 0) {
    return cached.data;
  }
  const existingFlight = inFlightKlines.get(cacheKey);
  if (existingFlight) return existingFlight;

  const task = (async (): Promise<KlineMetaResult> => {
    // Always query public Mainnet Futures first so scanner/chart klines never consume Testnet signed-IP quota
    if (!getHostCooldownState("https://fapi.binance.com").coolingDown) {
      const raw = await fetchJsonSafe(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`,
        7000
      );
      if (Array.isArray(raw) && raw.length > 0) {
        const res: KlineMetaResult = { bars: mapRawKlines(raw, 1), resolvedSymbol: sym, marketType: "FUTURES" };
        klineCache.set(cacheKey, { ts: Date.now(), data: res });
        return res;
      }
    }

    // Geo-block fallback via Binance Vision public CDN before touching Testnet
    const catalogType = await getSymbolMarketType(sym);
    const spotRaw = await fetchJsonSafe(
      `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`,
      7000
    );
    if (Array.isArray(spotRaw) && spotRaw.length > 0) {
      const res: KlineMetaResult = { bars: mapRawKlines(spotRaw, 1), resolvedSymbol: sym, marketType: catalogType };
      klineCache.set(cacheKey, { ts: Date.now(), data: res });
      return res;
    }
    if (sym.startsWith("1000")) {
      const stripped = sym.slice(4);
      const kRaw = await fetchJsonSafe(
        `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(stripped)}&interval=${interval}&limit=${limit}`,
        7000
      );
      if (Array.isArray(kRaw) && kRaw.length > 0) {
        const res: KlineMetaResult = { bars: mapRawKlines(kRaw, 1000), resolvedSymbol: sym, marketType: "FUTURES" };
        klineCache.set(cacheKey, { ts: Date.now(), data: res });
        return res;
      }
    }

    const activeBase = getBinanceBaseUrl();
    if (activeBase !== "https://fapi.binance.com" && !getHostCooldownState(activeBase).coolingDown) {
      const raw = await fetchJsonSafe(
        `${activeBase}/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`,
        7000
      );
      if (Array.isArray(raw) && raw.length > 0) {
        const res: KlineMetaResult = { bars: mapRawKlines(raw, 1), resolvedSymbol: sym, marketType: "FUTURES" };
        klineCache.set(cacheKey, { ts: Date.now(), data: res });
        return res;
      }
    }
    return cached?.data ?? { bars: [], resolvedSymbol: sym, marketType: catalogType };
  })().finally(() => {
    inFlightKlines.delete(cacheKey);
    if (klineCache.size > 400) {
      const oldestKey = klineCache.keys().next().value;
      if (oldestKey) klineCache.delete(oldestKey);
    }
  });

  inFlightKlines.set(cacheKey, task);
  return task;
}

export async function fetchBinanceKlines(symbol: string, interval: "1m" | "5m" | "15m", limit = 120): Promise<OhlcBar[]> {
  const res = await fetchBinanceKlinesWithMeta(symbol, interval, limit);
  return res.bars;
}

router.get("/binance/symbols", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim().toUpperCase();
    const limit = Math.min(200, Math.max(10, Number(req.query.limit ?? 50) || 50));
    const all = await loadExchangeSymbols();
    const filtered = q
      ? all.filter((s) => s.symbol.includes(q) || s.baseAsset.includes(q))
      : all;
    return res.json({
      totalSymbols: all.length,
      topCoins: TOP_10_CRYPTO_COINS,
      symbols: filtered.slice(0, limit),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to search Binance USDT-M symbols");
    return res.status(500).json({ error: "Failed to fetch Binance Futures symbols" });
  }
});

router.get("/binance/klines", async (req, res) => {
  try {
    const reqSym = resolveBinanceSymbol(String(req.query.symbol ?? "BTCUSDT"));
    const [m5Res, m15Res, m1Res] = await Promise.all([
      fetchBinanceKlinesWithMeta(reqSym, "5m", 100),
      fetchBinanceKlinesWithMeta(reqSym, "15m", 80),
      fetchBinanceKlinesWithMeta(reqSym, "1m", 120),
    ]);
    const live = analyzeLiveSmcTelemetry(m5Res.resolvedSymbol, m5Res.bars, m15Res.bars, 1.2, 5, 1.35, m1Res.bars);
    return res.json({ ...live, resolvedSymbol: m5Res.resolvedSymbol, marketType: m5Res.marketType });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch live Binance SMC analysis");
    return res.status(500).json({ error: "Failed to load coin candles" });
  }
});

export default router;
