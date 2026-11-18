import { Router } from "express";
import dashboardRouter from "./dashboard";
import configRouter from "./config";
import executeRouter from "./execute";
import healthRouter from "./health";
import metricsRouter from "./metrics";
import pricesRouter from "./prices";
import signalsRouter from "./signals";
import tradesRouter from "./trades";
import backtestRouter from "./backtest";
import backupRouter from "./backup";
import authRouter from "./auth";
import binanceRouter from "./binance";

const router = Router();

router.use(dashboardRouter);
router.use(configRouter);
router.use(executeRouter);
router.use(healthRouter);
router.use(metricsRouter);
router.use(pricesRouter);
router.use(signalsRouter);
router.use(tradesRouter);
router.use(backtestRouter);
router.use(backupRouter);
router.use(authRouter);
router.use(binanceRouter);

export default router;
