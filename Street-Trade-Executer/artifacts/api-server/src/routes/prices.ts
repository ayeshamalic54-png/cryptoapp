import { Router } from "express";
import { db } from "@workspace/db";
import { scannedAssetsTable } from "@workspace/db";

const router = Router();

async function fetchBinanceFuturesPrices(): Promise<Array<{
  symbol: string;
  price: number;
  change24h: number | null;
  changePct24h: number | null;
  category: string;
  source: string;
  updatedAt: string;
}>> {
  const result: Array<{
    symbol: string;
    price: number;
    change24h: number | null;
    changePct24h: number | null;
    category: string;
    source: string;
    updatedAt: string;
  }> = [];
  try {
    const resp = await fetch(
      "https://fapi.binance.com/fapi/v1/ticker/24hr",
      { signal: AbortSignal.timeout(6000) }
    );
    if (!resp.ok) return result;
    const data = (await resp.json()) as Array<{
      symbol: string;
      lastPrice: string;
      priceChange: string;
      priceChangePercent: string;
    }>;
    const nowStr = new Date().toISOString();
    for (const item of data) {
      if (item.symbol.endsWith("USDT")) {
        result.push({
          symbol: item.symbol,
          price: parseFloat(item.lastPrice) || 0,
          change24h: parseFloat(item.priceChange) || null,
          changePct24h: parseFloat(item.priceChangePercent) || null,
          category: "crypto",
          source: "Binance Futures",
          updatedAt: nowStr,
        });
      }
    }
  } catch {
    // silent fallback
  }
  return result;
}

router.get("/prices", async (req, res) => {
  try {
    const prices: Array<{
      symbol: string;
      price: number;
      change24h: number | null;
      changePct24h: number | null;
      category: string;
      source: string;
      updatedAt: string;
    }> = [];

    const seenSymbols = new Set<string>();

    // 1. Fetch live prices from database scanned_assets
    try {
      const dbAssets = await db.select().from(scannedAssetsTable);
      for (const asset of dbAssets) {
        const parts = asset.symbolPair.split('/');
        if (parts.length === 2) {
          const priceA = Number(asset.priceA ?? 0);
          const priceB = Number(asset.priceB ?? 0);
          
          const pushSymbol = (sym: string, price: number) => {
            if (price > 0 && !seenSymbols.has(sym)) {
              prices.push({
                symbol: sym,
                price,
                change24h: null,
                changePct24h: null,
                category: "crypto",
                source: "Binance Futures",
                updatedAt: asset.updatedAt?.toISOString() ?? new Date().toISOString(),
              });
              seenSymbols.add(sym);
            }
          };

          pushSymbol(parts[0], priceA);
          pushSymbol(parts[1], priceB);
        }
      }
    } catch (dbErr) {
      // silent fallback
    }

    // 2. Fetch live crypto prices from Binance
    const cryptoFutures = await fetchBinanceFuturesPrices();
    for (const item of cryptoFutures) {
      if (!seenSymbols.has(item.symbol)) {
        prices.push(item);
        seenSymbols.add(item.symbol);
      }
    }

    res.json(prices);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch prices");
    res.status(500).json({ error: "Failed to fetch prices" });
  }
});

export default router;
