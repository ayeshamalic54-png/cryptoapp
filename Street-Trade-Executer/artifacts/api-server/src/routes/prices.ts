import { Router } from "express";
import { TOP_10_CRYPTO_COINS } from "./binance";

const router = Router();

interface PriceRow {
  symbol: string;
  price: number;
  change24h: number | null;
  changePct24h: number | null;
  quoteVolume: number;
  category: string;
  source: string;
  updatedAt: string;
}

async function fetchBinanceFuturesPrices(): Promise<PriceRow[]> {
  const isTestnet = ["true", "1", "yes"].includes((process.env.USE_BINANCE_TESTNET || "").trim().toLowerCase());
  const endpoints = isTestnet
    ? ["https://testnet.binancefuture.com/fapi/v1/ticker/24hr", "https://fapi.binance.com/fapi/v1/ticker/24hr"]
    : ["https://fapi.binance.com/fapi/v1/ticker/24hr"];

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!resp.ok) continue;
      const data = (await resp.json()) as Array<{
        symbol: string;
        lastPrice: string;
        priceChange: string;
        priceChangePercent: string;
        quoteVolume?: string;
      }>;
      const nowStr = new Date().toISOString();
      const topRank = new Map(TOP_10_CRYPTO_COINS.map((sym, idx) => [sym, idx]));
      const list: PriceRow[] = [];
      for (const item of data) {
        if (!item.symbol.endsWith("USDT")) continue;
        const price = parseFloat(item.lastPrice) || 0;
        if (price <= 0) continue;
        list.push({
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
      if (list.length > 0) {
        list.sort((a, b) => {
          const ra = topRank.has(a.symbol) ? topRank.get(a.symbol)! : 9999;
          const rb = topRank.has(b.symbol) ? topRank.get(b.symbol)! : 9999;
          if (ra !== rb) return ra - rb;
          return b.quoteVolume - a.quoteVolume;
        });
        return list;
      }
    } catch {
      // fallback to next endpoint
    }
  }
  return [];
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
