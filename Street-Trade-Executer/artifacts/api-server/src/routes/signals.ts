import { Router } from "express";
import { db } from "@workspace/db";
import { signalsTable, tradesTable, botStateTable } from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { GetSignalsQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/signals", async (req, res) => {
  try {
    const parsed = GetSignalsQueryParams.safeParse(req.query);
    const limit = parsed.success ? (parsed.data.limit ?? 30) : 30;
    const includeLegacy = req.query.all === "true";

    const [botRows, rows] = await Promise.all([
      db.select().from(botStateTable).where(eq(botStateTable.id, 1)).limit(1),
      db.select().from(signalsTable).orderBy(desc(signalsTable.timestamp)).limit(limit),
    ]);

    const resetAtMs =
      !includeLegacy && botRows[0]?.metricsResetAt ? new Date(botRows[0].metricsResetAt).getTime() : 0;

    const filteredRows = rows.filter((s) => {
      if (resetAtMs && s.timestamp && s.timestamp.getTime() < resetAtMs) return false;
      return true;
    });

    const signalIds = filteredRows.map((s) => s.id);
    const trades =
      signalIds.length > 0
        ? await db.select().from(tradesTable).where(inArray(tradesTable.signalId, signalIds))
        : [];

    return res.json(
      filteredRows.map((s) => {
        const tradesForSignal = trades.filter((t) => t.signalId === s.id);
        const totalLots = tradesForSignal.reduce((sum, t) => sum + Number(t.lots), 0);
        const hasProfitVal = tradesForSignal.some((t) => t.profit != null);
        const totalProfit = hasProfitVal
          ? tradesForSignal.reduce((sum, t) => sum + Number(t.profit ?? 0), 0)
          : null;

        return {
          id: s.id,
          timestamp: s.timestamp?.toISOString() ?? new Date().toISOString(),
          symbolA: s.symbolA,
          symbolB: s.symbolB,
          priceA: Number(s.priceA),
          priceB: Number(s.priceB),
          beta: Number(s.beta),
          alpha: Number(s.alpha),
          zScore: Number(s.zScore),
          obi: Number(s.obi),
          action: s.action,
          totalLots: totalLots > 0 ? totalLots : undefined,
          totalProfit: totalProfit !== null ? totalProfit : undefined,
          trades: tradesForSignal.map((t) => ({
            ticket: Number(t.ticket),
            symbol: t.symbol,
            lots: Number(t.lots),
            status: t.status,
            profit: t.profit != null ? Number(t.profit) : null,
            comment: t.comment,
          })),
        };
      })
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get signals");
    return res.status(500).json({ error: "Failed to get signals" });
  }
});

export default router;
