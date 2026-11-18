import { Router } from "express";
import { db } from "@workspace/db";
import { botStateTable } from "@workspace/db";
import { UpdateConfigBody } from "@workspace/api-zod";
import { sql } from "drizzle-orm";
import { resolveBinanceSymbol, parseFavoritePairs } from "../lib/smcEngine";
import { getCryptoDiscordWebhookUrl, sendDiscordCryptoSignalAlert } from "../lib/discord";
import { evaluateAndPersistSymbolSmc, syncLeverageAcrossCoins } from "../lib/cryptoBotWorker";
import { fetchBinanceKlines, resolveLiveBinanceSymbol, TOP_10_CRYPTO_COINS } from "./binance";

const router = Router();

function parseSessionHour(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const wrapped = ((n % 24) + 24) % 24;
  return Math.round(wrapped * 2) / 2;
}

function serializeConfig(state: any) {
  const activeSym = resolveBinanceSymbol(state?.activePair ?? "BTCUSDT");
  const accMode = String(state?.accountMode ?? "PROP_FIRM").toUpperCase();
  return {
    activePair: activeSym,
    symbolA: activeSym,
    symbolB: "USDT",
    zEntryThreshold: 0,
    maxDailyTrades: Number(state?.maxTrades ?? 10),
    maxDailyLossPercent: Number(state?.maxDrawdownLimit ?? 4.0),
    requireSmcConfluence: true,
    slPips: Number(state?.maxSlPct ?? state?.slPips ?? 1.2),
    tpPips: Number(state?.tpPips ?? 2.4),
    smcEnabled: true,
    autoExecute: state?.autoExecute ?? true,
    cryptoEnabled: true,
    metalsEnabled: false,
    forexEnabled: false,
    indicesEnabled: false,
    riskLimitsEnabled: state?.riskLimitsEnabled ?? true,
    defaultLots: Number(state?.defaultLots ?? 0.01),
    initialBalance: Number(state?.initialBalance ?? 10000),
    knifeProtectionEnabled: false,
    obiEnabled: false,
    volatilityFilterEnabled: false,
    accountMode: accMode,
    leverage: Number(state?.leverage ?? 5),
    riskPercent: Number(state?.riskPercent ?? (accMode === "PROP_FIRM" ? 1.0 : 2.5)),
    maxMarginPct:
      accMode === "PERSONAL"
        ? Math.min(100, Number(state?.maxMarginPct ?? 100.0))
        : Math.min(80, Number(state?.maxMarginPct ?? 80.0)),
    maxSlPct: Number(state?.maxSlPct ?? 1.2),
    haltDrawdownLimit: Number(state?.haltDrawdownLimit ?? 3.5),
    maxDrawdownLimit: Number(state?.maxDrawdownLimit ?? 4.0),
    guardianShieldPct: Number(state?.guardianShieldPct ?? 1.8),
    sessionGuardEnabled: Boolean(state?.sessionGuardEnabled ?? false),
    sessionStartHour: Number(state?.sessionStartHour ?? 12.0),
    sessionEndHour: Number(state?.sessionEndHour ?? 16.0),
    session2Enabled: Boolean(state?.session2Enabled ?? true),
    session2StartHour: Number(state?.session2StartHour ?? 18.0),
    session2EndHour: Number(state?.session2EndHour ?? 22.0),
    isBotRunning: Boolean(state?.isBotRunning ?? true),
    favoritePairs: parseFavoritePairs(state?.favoritePairs),
  };
}

router.get("/config", async (req, res) => {
  try {
    const rows = await db.select().from(botStateTable).limit(1);
    return res.json(serializeConfig(rows[0]));
  } catch (err) {
    req.log.error({ err }, "Failed to get config");
    return res.status(500).json({ error: "Failed to get config" });
  }
});

router.post("/config", async (req, res) => {
  try {
    const parsed = UpdateConfigBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
    }

    const d = parsed.data;
    const activeSym = await resolveLiveBinanceSymbol(d.activePair);
    const currRow = (await db.select().from(botStateTable).limit(1))[0];

    const accMode = (d.accountMode ?? (currRow?.accountMode as "PROP_FIRM" | "PERSONAL") ?? "PROP_FIRM").toUpperCase();
    const leverage = Math.max(1, Math.min(50, Math.round(Number(d.leverage ?? currRow?.leverage ?? 5))));
    const riskPercent = Math.max(0.1, Math.min(20, Number(d.riskPercent ?? currRow?.riskPercent ?? (accMode === "PROP_FIRM" ? 1.0 : 2.5))));
    // Prop Firm strictly <= 80% max margin cap; Personal Futures allows up to 100% full capital usage
    const capMax = accMode === "PERSONAL" ? 100 : 80;
    const defaultMarginCap = accMode === "PERSONAL" ? 100 : 80;
    const maxMarginPct = Math.max(5, Math.min(capMax, Number(d.maxMarginPct ?? currRow?.maxMarginPct ?? defaultMarginCap)));
    const maxSlPct = Math.max(0.2, Math.min(10, Number(d.maxSlPct ?? d.slPips ?? currRow?.maxSlPct ?? 1.2)));
    const haltDD = Math.max(0.5, Math.min(15, Number(d.haltDrawdownLimit ?? currRow?.haltDrawdownLimit ?? 3.5)));
    const maxDD = Math.max(1.0, Math.min(20, Number(d.maxDrawdownLimit ?? currRow?.maxDrawdownLimit ?? 4.0)));
    const shieldPct = Math.max(0.5, Math.min(10, Number(d.guardianShieldPct ?? currRow?.guardianShieldPct ?? 1.8)));

    const autoExec = d.autoExecute ?? currRow?.autoExecute ?? true;
    const riskLimits = d.riskLimitsEnabled ?? currRow?.riskLimitsEnabled ?? true;
    const defLots = d.defaultLots ?? Number(currRow?.defaultLots ?? 0.01);
    const maxDailyTrades = d.maxDailyTrades ?? Number(currRow?.maxTrades ?? 10);
    const initBal = d.initialBalance !== undefined ? d.initialBalance : Number(currRow?.initialBalance ?? 10000);

    const sgEnabled = d.sessionGuardEnabled ?? Boolean(currRow?.sessionGuardEnabled ?? false);
    const sgStart = parseSessionHour(d.sessionStartHour, Number(currRow?.sessionStartHour ?? 12.0));
    const sgEnd = parseSessionHour(d.sessionEndHour, Number(currRow?.sessionEndHour ?? 16.0));
    const sg2Enabled = d.session2Enabled ?? Boolean(currRow?.session2Enabled ?? true);
    const sg2Start = parseSessionHour(d.session2StartHour, Number(currRow?.session2StartHour ?? 18.0));
    const sg2End = parseSessionHour(d.session2EndHour, Number(currRow?.session2EndHour ?? 22.0));

    await db.execute(
      sql`INSERT INTO bot_state (
            id, active_pair, sl_pips, tp_pips, z_entry_threshold, smc_enabled, auto_execute,
            crypto_enabled, metals_enabled, forex_enabled, indices_enabled, risk_limits_enabled,
            default_lots, max_trades, system_status, initial_balance,
            knife_protection_enabled, obi_enabled, volatility_filter_enabled,
            account_mode, leverage, risk_percent, max_margin_pct, max_sl_pct,
            halt_drawdown_limit, max_drawdown_limit, guardian_shield_pct,
            session_guard_enabled, session_start_hour, session_end_hour,
            session2_enabled, session2_start_hour, session2_end_hour, updated_at
          )
          SELECT 1, ${activeSym}, ${maxSlPct.toString()}, ${(d.tpPips ?? 2.4).toString()}, '0.00', TRUE, ${autoExec},
                 TRUE, FALSE, FALSE, FALSE, ${riskLimits}, ${defLots.toString()}, ${maxDailyTrades},
                 'BOT OFFLINE', ${initBal.toString()}, FALSE, FALSE, FALSE,
                 ${accMode}, ${leverage}, ${riskPercent.toString()}, ${maxMarginPct.toString()}, ${maxSlPct.toString()},
                 ${haltDD.toString()}, ${maxDD.toString()}, ${shieldPct.toString()},
                 ${sgEnabled}, ${sgStart.toString()}, ${sgEnd.toString()},
                 ${sg2Enabled}, ${sg2Start.toString()}, ${sg2End.toString()}, NOW()
          WHERE NOT EXISTS (SELECT 1 FROM bot_state)`
    );

    await db.execute(
      sql`UPDATE bot_state
          SET active_pair = ${activeSym},
              sl_pips = ${maxSlPct.toString()},
              tp_pips = ${(d.tpPips ?? 2.4).toString()},
              z_entry_threshold = '0.00',
              smc_enabled = TRUE,
              auto_execute = ${autoExec},
              crypto_enabled = TRUE,
              metals_enabled = FALSE,
              forex_enabled = FALSE,
              indices_enabled = FALSE,
              risk_limits_enabled = ${riskLimits},
              default_lots = ${defLots.toString()},
              max_trades = ${maxDailyTrades},
              initial_balance = ${initBal.toString()},
              knife_protection_enabled = FALSE,
              obi_enabled = FALSE,
              volatility_filter_enabled = FALSE,
              account_mode = ${accMode},
              leverage = ${leverage},
              risk_percent = ${riskPercent.toString()},
              max_margin_pct = ${maxMarginPct.toString()},
              max_sl_pct = ${maxSlPct.toString()},
              halt_drawdown_limit = ${haltDD.toString()},
              max_drawdown_limit = ${maxDD.toString()},
              guardian_shield_pct = ${shieldPct.toString()},
              session_guard_enabled = ${sgEnabled},
              session_start_hour = ${sgStart.toString()},
              session_end_hour = ${sgEnd.toString()},
              session2_enabled = ${sg2Enabled},
              session2_start_hour = ${sg2Start.toString()},
              session2_end_hour = ${sg2End.toString()},
              updated_at = NOW()
          WHERE id = (SELECT MIN(id) FROM bot_state)`
    );

    if (d.initialBalance !== undefined && Math.abs(initBal - Number(currRow?.initialBalance ?? 0)) > 0.01) {
      const todayPkt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Karachi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const liveOrInitEq = Number(currRow?.equity ?? 0) > 0 ? Number(currRow?.equity) : initBal;
      await db.execute(
        sql`UPDATE bot_state
            SET drawdown_percent = 0.00,
                overall_drawdown = 0.00,
                max_equity_peak = GREATEST(${initBal.toString()}::numeric, COALESCE(equity, 0))
            WHERE id = (SELECT MIN(id) FROM bot_state)`
      );
      await db.execute(
        sql`INSERT INTO daily_metrics (trading_date, start_equity, current_equity, max_drawdown_percent, trades_today, mt5_login, updated_at)
            VALUES (${todayPkt}, ${liveOrInitEq.toString()}, ${liveOrInitEq.toString()}, 0.00, 0, 0, NOW())
            ON CONFLICT (trading_date, mt5_login) DO UPDATE
            SET start_equity = EXCLUDED.start_equity,
                current_equity = EXCLUDED.current_equity,
                max_drawdown_percent = 0.00,
                updated_at = NOW()`
      );
    }

    const updated = (await db.select().from(botStateTable).limit(1))[0];
    void syncLeverageAcrossCoins(leverage, activeSym);
    await evaluateAndPersistSymbolSmc(activeSym, maxSlPct, leverage);
    return res.json(serializeConfig(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update config");
    return res.status(500).json({ error: "Failed to update config" });
  }
});

router.get("/favorites", async (_req, res) => {
  try {
    const row = (await db.select().from(botStateTable).limit(1))[0] as any;
    return res.json({ favoritePairs: parseFavoritePairs(row?.favoritePairs) });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load favorites" });
  }
});

router.post("/favorites/toggle", async (req, res) => {
  try {
    const rawSym = String(req.body?.symbol ?? "").trim();
    if (!rawSym) return res.status(400).json({ error: "Symbol required" });
    const sym = await resolveLiveBinanceSymbol(rawSym);
    const row = (await db.select().from(botStateTable).limit(1))[0] as any;
    const currentFavs = parseFavoritePairs(row?.favoritePairs);
    const exists = currentFavs.includes(sym);
    const forceMode = String(req.body?.mode ?? "").toLowerCase();
    const shouldAdd = forceMode === "add" ? true : forceMode === "remove" ? false : !exists;

    let nextFavs: string[];
    if (shouldAdd) {
      nextFavs = currentFavs.includes(sym) ? currentFavs : [...currentFavs, sym].slice(-25);
    } else {
      nextFavs = currentFavs.filter((f) => f !== sym);
    }

    await db.execute(
      sql`UPDATE bot_state SET favorite_pairs = ${JSON.stringify(nextFavs)}, updated_at = NOW() WHERE id = (SELECT MIN(id) FROM bot_state)`
    );

    const maxSlPct = Number(row?.maxSlPct ?? 1.2);
    const leverage = Number(row?.leverage ?? 5);
    const activeSym = await resolveLiveBinanceSymbol(String(row?.activePair ?? "BTCUSDT"));

    let evalOut: any = null;
    if (shouldAdd) {
      const persisted = await evaluateAndPersistSymbolSmc(sym, maxSlPct, leverage);
      evalOut = persisted?.evalRes ?? null;
    } else if (!TOP_10_CRYPTO_COINS.includes(sym) && sym !== activeSym) {
      await db.execute(sql`DELETE FROM scanned_assets WHERE UPPER(symbol_pair) = ${sym.toUpperCase()}`);
    }

    return res.json({
      status: "ok",
      action: shouldAdd ? "added" : "removed",
      symbol: sym,
      favoritePairs: nextFavs,
      telemetry: evalOut?.telemetry ?? null,
      activeZones: evalOut?.activeZones ?? [],
      livePrice: evalOut?.livePrice ?? 0,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to toggle favorite symbol");
    return res.status(500).json({ error: "Failed to toggle favorite coin" });
  }
});

router.post("/toggle-session-guard", async (req, res) => {
  try {
    const body = req.body || {};
    const curr = (await db.select().from(botStateTable).limit(1))[0];
    const enabled = body.enabled !== undefined ? Boolean(body.enabled) : !Boolean(curr?.sessionGuardEnabled);
    const startH = parseSessionHour(body.start_hour ?? body.sessionStartHour, Number(curr?.sessionStartHour ?? 12.0));
    const endH = parseSessionHour(body.end_hour ?? body.sessionEndHour, Number(curr?.sessionEndHour ?? 16.0));
    const s2Enabled =
      body.session2_enabled !== undefined
        ? Boolean(body.session2_enabled)
        : body.session2Enabled !== undefined
        ? Boolean(body.session2Enabled)
        : Boolean(curr?.session2Enabled ?? true);
    const s2Start = parseSessionHour(
      body.session2_start_hour ?? body.session2StartHour,
      Number(curr?.session2StartHour ?? 18.0)
    );
    const s2End = parseSessionHour(
      body.session2_end_hour ?? body.session2EndHour,
      Number(curr?.session2EndHour ?? 22.0)
    );

    await db.execute(
      sql`UPDATE bot_state
          SET session_guard_enabled = ${enabled},
              session_start_hour = ${startH.toString()},
              session_end_hour = ${endH.toString()},
              session2_enabled = ${s2Enabled},
              session2_start_hour = ${s2Start.toString()},
              session2_end_hour = ${s2End.toString()},
              updated_at = NOW()
          WHERE id = (SELECT MIN(id) FROM bot_state)`
    );

    const updated = (await db.select().from(botStateTable).limit(1))[0];
    return res.json({
      status: "ok",
      sessionGuardEnabled: Boolean(updated?.sessionGuardEnabled ?? enabled),
      sessionStartHour: Number(updated?.sessionStartHour ?? startH),
      sessionEndHour: Number(updated?.sessionEndHour ?? endH),
      session2Enabled: Boolean(updated?.session2Enabled ?? s2Enabled),
      session2StartHour: Number(updated?.session2StartHour ?? s2Start),
      session2EndHour: Number(updated?.session2EndHour ?? s2End),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to toggle session guard");
    return res.status(500).json({ error: "Failed to toggle session guard" });
  }
});

router.post("/bot/control", async (req, res) => {
  try {
    const action = String(req.body?.action ?? "").toUpperCase();
    const running = action === "START" ? true : action === "PAUSE" || action === "STOP" ? false : Boolean(req.body?.isBotRunning);
    const nextStatus = running ? "RUNNING (Active SMC)" : "PAUSED (User Control)";
    await db.execute(
      sql`UPDATE bot_state
          SET is_bot_running = ${running},
              system_status = ${nextStatus},
              updated_at = NOW()
          WHERE id = (SELECT MIN(id) FROM bot_state)`
    );
    return res.json({ status: "ok", isBotRunning: running, systemStatus: nextStatus });
  } catch (err) {
    req.log.error({ err }, "Failed to update bot control state");
    return res.status(500).json({ error: "Failed to update bot state" });
  }
});

router.get("/discord/status", (_req, res) => {
  const configured = Boolean(getCryptoDiscordWebhookUrl());
  return res.json({ configured });
});

router.post("/discord/test", async (req, res) => {
  try {
    const webhookUrl = getCryptoDiscordWebhookUrl();
    if (!webhookUrl || !webhookUrl.startsWith("http")) {
      return res.status(400).json({
        ok: false,
        configured: false,
        status: 0,
        detail: "CRYPTO_DISCORD_WEBHOOK_URL is not set on this server. Add your new Crypto Discord channel webhook in Render Environment Variables.",
      });
    }

    const state = (await db.select().from(botStateTable).limit(1))[0] as any;
    const sym = resolveBinanceSymbol(String(req.body?.symbol || state?.activePair || "BTCUSDT"));
    const accMode = String(state?.accountMode ?? "PROP_FIRM").toUpperCase();
    const leverage = Math.max(1, Number(state?.leverage ?? 5) || 5);
    const riskPct = Math.max(0.1, Number(state?.riskPercent ?? 1.0) || 1.0);
    const capMax = accMode === "PERSONAL" ? 100 : 80;
    const maxMarginPct = Math.min(capMax, Math.max(10, Number(state?.maxMarginPct ?? capMax) || capMax));
    const equity = Math.max(50, Number(state?.equity ?? state?.initialBalance ?? 10000) || 10000);

    const klines = await fetchBinanceKlines(sym, "5m", 5);
    const liveClose = klines.length > 0 ? Number(klines[klines.length - 1].close) : 0;
    const entryPrice = liveClose > 0 ? liveClose : sym.startsWith("BTC") ? 91500 : sym.startsWith("ETH") ? 3120 : 185.5;
    const slPrice = entryPrice * 0.992;
    const tpPrice = entryPrice * 1.024;
    const rrr = 3.0;
    const riskUsdt = (equity * riskPct) / 100;
    const stopDist = Math.abs(entryPrice - slPrice);
    const qty = stopDist > 0 ? riskUsdt / stopDist : 0;
    const notional = qty * entryPrice;
    const marginUsed = notional / leverage;
    const marginPct = Math.min(maxMarginPct, equity > 0 ? (marginUsed / equity) * 100 : 0);

    const result = await sendDiscordCryptoSignalAlert({
      action: "BUY",
      symbol: sym,
      entryPrice,
      slPrice,
      tpPrice,
      rrr,
      qty,
      leverage,
      accountMode: accMode,
      riskUsdt,
      marginPct,
      maxMarginPct,
      isSignalOnly: true,
      isTestPreview: true,
    });

    if (!result.ok) {
      return res.status(502).json({
        ok: false,
        configured: true,
        status: result.status,
        detail: result.detail || `Discord returned HTTP ${result.status}`,
      });
    }

    return res.json({
      ok: true,
      configured: true,
      status: result.status,
      symbol: sym,
      entryPrice,
      slPrice,
      tpPrice,
      rrr,
    });
  } catch (err: any) {
    req.log.error({ err }, "Failed to send Discord test preview");
    return res.status(500).json({ ok: false, error: err?.message || "Discord test error" });
  }
});

export default router;
