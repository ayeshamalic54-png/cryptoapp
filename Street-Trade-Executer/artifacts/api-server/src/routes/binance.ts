import { Router } from "express";
import { analyzeLiveSmcTelemetry, resolveBinanceSymbol, type OhlcBar } from "../lib/smcEngine";

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
}

let symbolsCache: { ts: number; base: string; list: ExchangeSymEntry[] } = { ts: 0, base: "", list: [] };

async function loadExchangeSymbols(): Promise<ExchangeSymEntry[]> {
  const base = getBinanceBaseUrl();
  if (symbolsCache.list.length > 0 && symbolsCache.base === base && Date.now() - symbolsCache.ts < 300_000) {
    return symbolsCache.list;
  }

  for (const endpoint of [base, "https://fapi.binance.com"]) {
    try {
      const resp = await fetch(`${endpoint}/fapi/v1/exchangeInfo`, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) continue;
      const json = (await resp.json()) as { symbols?: any[] };
      const parsed: ExchangeSymEntry[] = [];
      for (const s of json.symbols || []) {
        if (s.status !== "TRADING" || s.quoteAsset !== "USDT") continue;
        const fmap: Record<string, any> = {};
        for (const f of s.filters || []) fmap[f.filterType] = f;
        parsed.push({
          symbol: s.symbol,
          baseAsset: s.baseAsset,
          quoteAsset: s.quoteAsset,
          tickSize: parseFloat(fmap.PRICE_FILTER?.tickSize || "0.01") || 0.01,
          stepSize: parseFloat(fmap.LOT_SIZE?.stepSize || "0.001") || 0.001,
          minNotional: parseFloat(fmap.MIN_NOTIONAL?.notional || fmap.MIN_NOTIONAL?.minNotional || "5") || 5,
        });
      }
      if (parsed.length > 0) {
        // Put Top 10 high-volatility favorites first, rest alphabetical
        const topSet = new Set(TOP_10_CRYPTO_COINS);
        const topList = TOP_10_CRYPTO_COINS.map((sym) => parsed.find((x) => x.symbol === sym)).filter(
          Boolean
        ) as ExchangeSymEntry[];
        const rest = parsed.filter((x) => !topSet.has(x.symbol)).sort((a, b) => a.symbol.localeCompare(b.symbol));
        const combined = [...topList, ...rest];
        symbolsCache = { ts: Date.now(), base, list: combined };
        return combined;
      }
    } catch {
      // try fallback host
    }
  }
  return symbolsCache.list;
}

export async function resolveLiveBinanceSymbol(rawSymbol: string): Promise<string> {
  const sym = resolveBinanceSymbol(rawSymbol);
  const all = await loadExchangeSymbols();
  if (!all.length) return sym;
  const set = new Set(all.map((x) => x.symbol));
  if (set.has(sym)) return sym;
  const k1000 = `1000${sym}`;
  if (set.has(k1000)) return k1000;
  const match = all.find((x) => x.symbol.endsWith(sym) || x.baseAsset === sym.replace("USDT", ""));
  return match ? match.symbol : sym;
}

export async function fetchBinanceKlines(symbol: string, interval: "5m" | "15m", limit = 120): Promise<OhlcBar[]> {
  const sym = await resolveLiveBinanceSymbol(symbol);
  const endpoints = [getBinanceBaseUrl(), "https://fapi.binance.com"];
  for (const base of [...new Set(endpoints)]) {
    try {
      const url = `${base}/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(7000) });
      if (!resp.ok) continue;
      const raw = (await resp.json()) as any[];
      if (!Array.isArray(raw) || raw.length === 0) continue;
      return raw.map((k) => ({
        time: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5] ?? 100),
      }));
    } catch {
      // try fallback
    }
  }
  return [];
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
    const sym = resolveBinanceSymbol(String(req.query.symbol ?? "BTCUSDT"));
    const [m5, m15] = await Promise.all([
      fetchBinanceKlines(sym, "5m", 100),
      fetchBinanceKlines(sym, "15m", 80),
    ]);
    const live = analyzeLiveSmcTelemetry(sym, m5, m15);
    return res.json(live);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch live Binance SMC analysis");
    return res.status(500).json({ error: "Failed to load coin candles" });
  }
});

export default router;
