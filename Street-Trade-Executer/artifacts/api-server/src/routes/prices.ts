import { Router } from "express";
import { TOP_10_CRYPTO_COINS } from "./binance";
import { getHostCooldownState, recordBinanceResponse } from "../lib/binanceRateLimit";

const router = Router();

export interface PriceRow {
  symbol: string;
  price: number;
  change24h: number | null;
  changePct24h: number | null;
  quoteVolume: number;
  category: string;
  source: string;
  updatedAt: string;
}

let livePriceMapCache: { ts: number; map: Record<string, number> } = { ts: 0, map: {} };
let inFlightPriceMap: Promise<Record<string, number>> | null = null;
let spotPriceCache: { ts: number; map: Record<string, number> } = { ts: 0, map: {} };
let futuresPricesCache: { ts: number; list: PriceRow[] } = { ts: 0, list: [] };
let inFlightFuturesPrices: Promise<PriceRow[]> | null = null;

async function fetchSpotPriceFallback(): Promise<Record<string, number>> {
  if (Date.now() - spotPriceCache.ts < 15_000 && Object.keys(spotPriceCache.map).length > 0) {
    return spotPriceCache.map;
  }
  const url = "https://data-api.binance.vision/api/v3/ticker/price";
  if (getHostCooldownState(url).coolingDown) return spotPriceCache.map;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    recordBinanceResponse(url, resp.status, resp.headers.get("retry-after"), resp.headers.get("x-mbx-used-weight-1m"));
    if (resp.ok) {
      const arr = (await resp.json()) as Array<{ symbol: string; price: string }>;
      const m: Record<string, number> = {};
      for (const item of arr) {
        const symU = item.symbol?.toUpperCase();
        const p = parseFloat(item.price);
        if (symU && symU.endsWith("USDT") && p > 0) m[symU] = p;
      }
      if (Object.keys(m).length > 0) {
        spotPriceCache = { ts: Date.now(), map: m };
      }
    }
  } catch {}
  return spotPriceCache.map;
}

export async function fetchLivePriceMap(): Promise<Record<string, number>> {
  if (Date.now() - livePriceMapCache.ts < 5_000 && Object.keys(livePriceMapCache.map).length > 0) {
    return livePriceMapCache.map;
  }
  if (inFlightPriceMap) return inFlightPriceMap;

  inFlightPriceMap = (async () => {
    const isTestnet = ["true", "1", "yes"].includes((process.env.USE_BINANCE_TESTNET || "").trim().toLowerCase());
    const futEndpoints = isTestnet
      ? ["https://testnet.binancefuture.com/fapi/v1/ticker/price", "https://fapi.binance.com/fapi/v1/ticker/price"]
      : ["https://fapi.binance.com/fapi/v1/ticker/price", "https://testnet.binancefuture.com/fapi/v1/ticker/price"];

    const nextMap: Record<string, number> = {};
    for (const url of futEndpoints) {
      if (getHostCooldownState(url).coolingDown) continue;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(3500) });
        recordBinanceResponse(url, resp.status, resp.headers.get("retry-after"), resp.headers.get("x-mbx-used-weight-1m"));
        if (!resp.ok) continue;
        const arr = (await resp.json()) as Array<{ symbol: string; price: string }>;
        if (!Array.isArray(arr) || arr.length === 0) continue;
        for (const item of arr) {
          const p = parseFloat(item.price);
          const symU = item.symbol?.toUpperCase();
          if (symU && p > 0 && nextMap[symU] === undefined) {
            nextMap[symU] = p;
          }
        }
        if (Object.keys(nextMap).length > 0) break;
      } catch {
        // try next endpoint
      }
    }

    // Supplement missing Mainnet/Spot USDT tickers cleanly from non-geo-blocked Binance Vision CDN
    const spotMap = await fetchSpotPriceFallback();
    for (const [symU, p] of Object.entries(spotMap)) {
      if (nextMap[symU] === undefined) nextMap[symU] = p;
    }

    if (Object.keys(nextMap).length > 0) {
      livePriceMapCache = { ts: Date.now(), map: nextMap };
      return nextMap;
    }
    return livePriceMapCache.map;
  })().finally(() => {
    inFlightPriceMap = null;
  });

  return inFlightPriceMap;
}

async function fetchBinanceFuturesPrices(): Promise<PriceRow[]> {
  if (Date.now() - futuresPricesCache.ts < 12_000 && futuresPricesCache.list.length > 0) {
    return futuresPricesCache.list;
  }
  if (inFlightFuturesPrices) return inFlightFuturesPrices;

  inFlightFuturesPrices = (async () => {
    const isTestnet = ["true", "1", "yes"].includes((process.env.USE_BINANCE_TESTNET || "").trim().toLowerCase());
    const endpoints = isTestnet
      ? ["https://testnet.binancefuture.com/fapi/v1/ticker/24hr", "https://fapi.binance.com/fapi/v1/ticker/24hr"]
      : ["https://fapi.binance.com/fapi/v1/ticker/24hr"];

    const nowStr = new Date().toISOString();
    const topRank = new Map(TOP_10_CRYPTO_COINS.map((sym, idx) => [sym, idx]));
    const bySym = new Map<string, PriceRow>();

    for (const url of endpoints) {
      if (getHostCooldownState(url).coolingDown) continue;
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
        recordBinanceResponse(url, resp.status, resp.headers.get("retry-after"), resp.headers.get("x-mbx-used-weight-1m"));
        if (!resp.ok) continue;
        const data = (await resp.json()) as Array<{
          symbol: string;
          lastPrice: string;
          priceChange: string;
          priceChangePercent: string;
          quoteVolume?: string;
        }>;
        for (const item of data) {
          if (!item.symbol?.endsWith("USDT")) continue;
          const price = parseFloat(item.lastPrice) || 0;
          if (price <= 0 || bySym.has(item.symbol)) continue;
          bySym.set(item.symbol, {
            symbol: item.symbol,
            price,
            change24h: parseFloat(item.priceChange) || 0,
            changePct24h: parseFloat(item.priceChangePercent) || 0,
            quoteVolume: parseFloat(item.quoteVolume || "0") || 0,
            category: "crypto",
            source: isTestnet && url.includes("testnet") ? "Binance Testnet" : "Binance Futures",
            updatedAt: nowStr,
          });
        }
        if (bySym.size > 0) break;
      } catch {
        // fallback to next endpoint
      }
    }

    // Merge non-geo-blocked Spot 24hr tickers for coins missing on active Futures feed (e.g. ZKCUSDT on US cloud)
    const visionUrl = "https://data-api.binance.vision/api/v3/ticker/24hr";
    if (!getHostCooldownState(visionUrl).coolingDown) {
      try {
        const resp = await fetch(visionUrl, { signal: AbortSignal.timeout(6000) });
        recordBinanceResponse(visionUrl, resp.status, resp.headers.get("retry-after"), resp.headers.get("x-mbx-used-weight-1m"));
        if (resp.ok) {
          const data = (await resp.json()) as Array<{
            symbol: string;
            lastPrice: string;
            priceChange: string;
            priceChangePercent: string;
            quoteVolume?: string;
          }>;
          for (const item of data) {
            if (!item.symbol?.endsWith("USDT") || bySym.has(item.symbol)) continue;
            const price = parseFloat(item.lastPrice) || 0;
            if (price <= 0) continue;
            bySym.set(item.symbol, {
              symbol: item.symbol,
              price,
              change24h: parseFloat(item.priceChange) || 0,
              changePct24h: parseFloat(item.priceChangePercent) || 0,
              quoteVolume: parseFloat(item.quoteVolume || "0") || 0,
              category: "crypto",
              source: "Binance Spot",
              updatedAt: nowStr,
            });
          }
        }
      } catch {}
    }

    const list = Array.from(bySym.values());
    list.sort((a, b) => {
      const ra = topRank.has(a.symbol) ? topRank.get(a.symbol)! : 9999;
      const rb = topRank.has(b.symbol) ? topRank.get(b.symbol)! : 9999;
      if (ra !== rb) return ra - rb;
      return b.quoteVolume - a.quoteVolume;
    });
    if (list.length > 0) {
      futuresPricesCache = { ts: Date.now(), list };
    }
    return list.length > 0 ? list : futuresPricesCache.list;
  })().finally(() => {
    inFlightFuturesPrices = null;
  });

  return inFlightFuturesPrices;
}

router.get("/prices", async (req, res) => {
  try {
    const q = String(req.query.q ?? "").trim().toUpperCase();
    const limit = Math.min(200, Math.max(10, Number(req.query.limit ?? 60) || 60));
    const all = await fetchBinanceFuturesPrices();
    const filtered = q ? all.filter((p) => p.symbol.includes(q)) : all;
    return res.json(filtered.slice(0, limit));
  } catch (err) {
    req.log.error({ err }, "Failed to fetch live Binance Futures prices");
    return res.status(500).json({ error: "Failed to fetch live prices" });
  }
});

export default router;
