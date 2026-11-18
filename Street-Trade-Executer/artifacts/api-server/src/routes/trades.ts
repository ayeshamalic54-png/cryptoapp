import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, botStateTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { GetTradesQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/trades", async (req, res) => {
  try {
    const parsed = GetTradesQueryParams.safeParse(req.query);
    const limit = parsed.success ? (parsed.data.limit ?? 50) : 50;
    const status = parsed.success ? (parsed.data.status ?? "ALL") : "ALL";
    const includeLegacy = req.query.all === "true";

    const [botRows, rows] = await Promise.all([
      db.select().from(botStateTable).where(eq(botStateTable.id, 1)).limit(1),
      db.select().from(tradesTable).orderBy(desc(tradesTable.entryTime)).limit(limit),
    ]);

    const resetAtMs =
      !includeLegacy && botRows[0]?.metricsResetAt ? new Date(botRows[0].metricsResetAt).getTime() : 0;

    const filtered = rows.filter((r) => {
      if (status !== "ALL" && r.status !== status) return false;
      if (resetAtMs && r.status === "CLOSED" && r.closeTime && r.closeTime.getTime() < resetAtMs) return false;
      return true;
    });

    return res.json(
      filtered.map((t) => ({
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
      }))
    );
  } catch (err) {
    req.log.error({ err }, "Failed to get trades");
    return res.status(500).json({ error: "Failed to get trades" });
  }
});

export default router;
