import { Router } from "express";
import { resolveBinanceSymbol, runCryptoSmcBacktest, type OhlcBar } from "../lib/smcEngine";
import { resolveLiveBinanceSymbol } from "./binance";

const router = Router();

async function fetchPaginatedBinanceKlines(
  symbol: string,
  interval: "5m" | "15m",
  startTimeMs: number,
  endTimeMs: number
): Promise<OhlcBar[]> {
  const sym = resolveBinanceSymbol(symbol);
  const allBars: OhlcBar[] = [];
  let cursor = startTimeMs;
  const maxPages = interval === "5m" ? 8 : 3;

  for (let p = 0; p < maxPages && cursor < endTimeMs; p++) {
    const query = `symbol=${encodeURIComponent(
      sym
    )}&interval=${interval}&startTime=${cursor}&endTime=${endTimeMs}&limit=1500`;
    let resp: Response | null = null;
    for (const base of ["https://fapi.binance.com", "https://testnet.binancefuture.com"]) {
      const cand = await fetch(`${base}/fapi/v1/klines?${query}`, { signal: AbortSignal.timeout(8000) });
      resp = cand;
      if (cand.ok) break;
    }
    if (!resp || !resp.ok) {
      throw new Error(`Binance klines HTTP ${resp?.status ?? 0} for ${sym}`);
    }
    const raw = (await resp.json()) as any[];
    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const k of raw) {
      allBars.push({
        time: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5] ?? 100),
      });
    }

    const lastOpen = Number(raw[raw.length - 1]![0]);
    if (raw.length < 1500 || lastOpen <= cursor) break;
    cursor = lastOpen + (interval === "5m" ? 300_000 : 900_000);
  }

  // Deduplicate and sort strictly chronologically
  const byTime = new Map<number, OhlcBar>();
  for (const b of allBars) byTime.set(b.time, b);
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

router.post("/backtest", async (req, res) => {
  try {
    const body = req.body || {};
    const rawSym = String(body.symbol || body.symbolA || "BTCUSDT").trim().toUpperCase();
    const symbol = await resolveLiveBinanceSymbol(rawSym);

    const days = Math.min(30, Math.max(1, Number(body.days ?? 14) || 14));
    const accountMode: "PROP_FIRM" | "PERSONAL" =
      String(body.accountMode ?? "PROP_FIRM").toUpperCase() === "PERSONAL" ? "PERSONAL" : "PROP_FIRM";

    const initialBalance = Math.max(
      10,
      Number(body.initialBalance ?? (accountMode === "PROP_FIRM" ? 10000 : 100)) || 10000
    );
    const riskPercent = Math.min(15, Math.max(0.2, Number(body.riskPercent ?? (accountMode === "PROP_FIRM" ? 1.0 : 2.5)) || 1.0));
    const leverage = Math.min(50, Math.max(1, Math.round(Number(body.leverage ?? 5) || 5)));
    const maxMarginPct = Math.min(80, Math.max(10, Number(body.maxMarginPct ?? 80) || 80));
    const maxSlPct = Math.min(10, Math.max(0.3, Number(body.maxSlPct ?? 1.2) || 1.2));
    const minRrr = Math.min(4.0, Math.max(1.2, Number(body.minRrr ?? 1.85) || 1.85));
    const sessionFilterEnabled = body.sessionFilterEnabled !== undefined ? Boolean(body.sessionFilterEnabled) : false;
    const breakevenEnabled = body.breakevenEnabled !== undefined ? Boolean(body.breakevenEnabled) : true;

    const endMs = Date.now();
    const startMs = endMs - days * 86_400_000;
    const warmupM5Start = startMs - 2 * 86_400_000;
    const warmupM15Start = startMs - 5 * 86_400_000;

    const [m5Bars, m15Bars] = await Promise.all([
      fetchPaginatedBinanceKlines(symbol, "5m", warmupM5Start, endMs),
      fetchPaginatedBinanceKlines(symbol, "15m", warmupM15Start, endMs),
    ]);

    if (m5Bars.length < 60 || m15Bars.length < 25) {
      return res.status(400).json({
        error: `Not enough historical Binance Futures klines returned for ${symbol}. Check symbol spelling (e.g. BTCUSDT, SOLUSDT).`,
      });
    }

    const results = runCryptoSmcBacktest({
      symbol,
      m5Bars,
      m15Bars,
      startTimeMs: startMs,
      initialBalance,
      accountMode,
      riskPercent,
      leverage,
      maxMarginPct,
      maxSlPct,
      minRrr,
      sessionFilterEnabled,
      breakevenEnabled,
    });

    return res.json(results);
  } catch (err: any) {
    req.log.error({ err }, "Crypto SMC backtest error");
    return res.status(500).json({ error: err?.message || "Backtest simulation failed" });
  }
});

export default router;
