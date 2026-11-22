/**
 * Pure Rule-Based SMC / ICT 9-Condition Crypto USDT-M Futures Engine (TypeScript)
 * Mirrors Python smc_indicators.py & smc_strategy_engine.py percentage-normalized math:
 *   - Supports ANY Binance USDT-M Perpetual coin ($0.00001 - $100,000+)
 *   - Supports both LONG (BUY) and SHORT (SELL) Futures setups
 *   - Supports Prop Firm (Blue Guardian Rules) & Personal Capital ($50/$100/$300+ USDT)
 *   - Enforces <= 80% Max Margin Cap + Fee-Aware Risk-Free Breakeven (+0.12% buffer)
 */

export interface OhlcBar {
  time: number; // UTC ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface CryptoScale {
  refPrice: number;
  digits: number;
  m15MinAmp: number;
  m15TargetMinAmp: number;
  m5MinAmp: number;
  minStructDepth: number;
  minPenetration: number;
  reclaimMaxDip: number;
  minFvgGap: number;
  maxZoneDist: number;
  minObDisp: number;
  mitTol: number;
  sweepMargin: number;
  wickBuf: number;
  closeTol: number;
  slBuf: number;
  maxChaseDist: number;
  targetMinMove: number;
  frontRunBuf: number;
}

export function inferCryptoDigits(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 2;
  if (price >= 1000) return 2;
  if (price >= 10) return 3;
  if (price >= 1) return 4;
  if (price >= 0.05) return 5;
  if (price >= 0.001) return 6;
  return 8;
}

export function formatCryptoPrice(price: number): string {
  const d = inferCryptoDigits(price);
  return Number(price || 0).toFixed(d);
}

export function computeCryptoScale(refPrice: number): CryptoScale {
  const ref = Number.isFinite(refPrice) && refPrice > 0 ? refPrice : 100.0;
  return {
    refPrice: ref,
    digits: inferCryptoDigits(ref),
    m15MinAmp: ref * 0.0022,
    m15TargetMinAmp: ref * 0.0014,
    m5MinAmp: ref * 0.0006,
    minStructDepth: ref * 0.0008,
    minPenetration: ref * 0.00015,
    reclaimMaxDip: ref * 0.0006,
    minFvgGap: ref * 0.00035,
    maxZoneDist: ref * 0.03,
    minObDisp: ref * 0.0006,
    mitTol: ref * 0.0001,
    sweepMargin: ref * 0.0004,
    wickBuf: ref * 0.0004,
    closeTol: ref * 0.00015,
    slBuf: ref * 0.0008,
    maxChaseDist: ref * 0.0035,
    targetMinMove: ref * 0.0012,
    frontRunBuf: ref * 0.00025,
  };
}

export function resolveBinanceSymbol(rawSymbol: string): string {
  const cleaned = rawSymbol
    .trim()
    .toUpperCase()
    .split("/")[0]!
    .replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return "BTCUSDT";
  if (cleaned.endsWith("USD") && !cleaned.endsWith("USDT") && cleaned.length <= 8) {
    return `${cleaned}T`;
  }
  return cleaned.endsWith("USDT") ? cleaned : `${cleaned}USDT`;
}

/** Parses stored JSON/comma list of favorited Binance USDT-M symbols safely (unique uppercase, max 25). */
export function parseFavoritePairs(raw: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) list = parsed;
      } catch {}
    } else if (trimmed.length > 0) {
      list = trimmed.split(",");
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const s = String(item || "").trim();
    if (!s) continue;
    const norm = resolveBinanceSymbol(s);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
    if (out.length >= 25) break;
  }
  return out;
}

function rndPrice(val: number, digits: number): number {
  const f = Math.pow(10, Math.min(8, Math.max(2, digits)));
  return Math.round(val * f) / f;
}

function getPktHourDecimal(utcMs: number): number {
  const pktMs = utcMs + 5 * 3600 * 1000;
  const d = new Date(pktMs);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function formatPktHhMm(utcMs: number): string {
  const pktMs = utcMs + 5 * 3600 * 1000;
  const d = new Date(pktMs);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function isInPktKillzone(utcMs: number): boolean {
  const h = getPktHourDecimal(utcMs);
  return (h >= 12.0 && h < 16.0) || (h >= 18.0 && h < 22.0);
}

export function getPktSessionLabel(utcMs: number): string {
  const h = getPktHourDecimal(utcMs);
  if (h >= 12.0 && h < 16.0) return "London PKT";
  if (h >= 18.0 && h < 22.0) return "NY PKT";
  return "24/7 Crypto";
}

function getSwingPoints(
  bars: OhlcBar[],
  nLeft = 3,
  nRight = 3,
  minAmplitude = 0
): { highs: Array<[number, number]>; lows: Array<[number, number]> } {
  const n = bars.length;
  if (n < nLeft + nRight + 1) return { highs: [], lows: [] };
  const sh: Array<[number, number]> = [];
  const sl: Array<[number, number]> = [];

  for (let i = nLeft; i < n - nRight; i++) {
    let isSh = true;
    let isSl = true;
    for (let j = 1; j <= nLeft; j++) {
      // Allow equal highs/lows on the left so double-tops/bottoms register cleanly on their rightmost bar
      if (bars[i]!.high < bars[i - j]!.high) isSh = false;
      if (bars[i]!.low > bars[i - j]!.low) isSl = false;
    }
    for (let j = 1; j <= nRight; j++) {
      if (bars[i]!.high <= bars[i + j]!.high) isSh = false;
      if (bars[i]!.low >= bars[i + j]!.low) isSl = false;
    }
    if (isSh && minAmplitude > 0) {
      let baseLow = Infinity;
      for (let k = i - nLeft; k <= i + nRight; k++) {
        if (bars[k]!.low < baseLow) baseLow = bars[k]!.low;
      }
      if (bars[i]!.high - baseLow < minAmplitude) isSh = false;
    }
    if (isSh) sh.push([bars[i]!.high, i]);

    if (isSl && minAmplitude > 0) {
      let baseHigh = -Infinity;
      for (let k = i - nLeft; k <= i + nRight; k++) {
        if (bars[k]!.high > baseHigh) baseHigh = bars[k]!.high;
      }
      if (baseHigh - bars[i]!.low < minAmplitude) isSl = false;
    }
    if (isSl) sl.push([bars[i]!.low, i]);
  }
  return { highs: sh, lows: sl };
}

function detectMarketStructure(dfM15: OhlcBar[], scale: CryptoScale): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (dfM15.length < 5) return "NEUTRAL";
  let { highs, lows } = getSwingPoints(dfM15, 3, 3, scale.m15MinAmp);
  if (highs.length < 2 || lows.length < 2) {
    ({ highs, lows } = getSwingPoints(dfM15, 2, 2, scale.m15MinAmp * 0.65));
  }
  if (highs.length < 2 || lows.length < 2) {
    ({ highs, lows } = getSwingPoints(dfM15, 2, 2, 0));
  }
  if (highs.length < 2 || lows.length < 2) return "NEUTRAL";

  const hasHh = highs[highs.length - 1]![0] > highs[highs.length - 2]![0];
  const hasHl = lows[lows.length - 1]![0] > lows[lows.length - 2]![0];
  const hasLh = highs[highs.length - 1]![0] < highs[highs.length - 2]![0];
  const hasLl = lows[lows.length - 1]![0] < lows[lows.length - 2]![0];

  const currClose = dfM15[dfM15.length - 1]!.close;
  const [lastShVal, lastShIdx] = highs[highs.length - 1]!;
  const [lastSlVal, lastSlIdx] = lows[lows.length - 1]!;

  let lastBullBos = -1;
  for (let k = lastShIdx + 1; k < dfM15.length; k++) {
    if (dfM15[k]!.close > lastShVal) lastBullBos = k;
  }
  let lastBearBos = -1;
  for (let k = lastSlIdx + 1; k < dfM15.length; k++) {
    if (dfM15[k]!.close < lastSlVal) lastBearBos = k;
  }

  const keyResistance = Math.max(...highs.slice(-2).map((x) => x[0]));
  const keySupport = Math.min(...lows.slice(-2).map((x) => x[0]));

  if (hasHh && hasHl) {
    if (lastBearBos > lastBullBos && currClose < lastSlVal) return "BEARISH";
    return "BULLISH";
  }
  if (hasLh && hasLl) {
    if (lastBullBos > lastBearBos && currClose > lastShVal) return "BULLISH";
    return "BEARISH";
  }
  if (hasLl) return currClose > keyResistance ? "BULLISH" : "BEARISH";
  if (hasHh) return currClose < keySupport ? "BEARISH" : "BULLISH";
  if (hasLh && hasHl) {
    // Reject contracting choppy triangles (Lower High + Higher Low) as neutral
    return "NEUTRAL";
  }
  if (hasHl && !hasLl) return "BULLISH";
  if (hasLh && !hasHh) return "BEARISH";
  return "NEUTRAL";
}

interface SweepResult {
  found: boolean;
  sweepExtreme: number;
  swingLevel: number;
  sweepIdx: number;
}

function detectLiquiditySweep(
  dfM5: OhlcBar[],
  scale: CryptoScale
): { sellSweep: SweepResult; buySweep: SweepResult } {
  const empty: SweepResult = { found: false, sweepExtreme: 0, swingLevel: 0, sweepIdx: -1 };
  const n = dfM5.length;
  if (n < 10) return { sellSweep: empty, buySweep: empty };

  let { highs: swingHighs, lows: swingLows } = getSwingPoints(dfM5, 3, 3, scale.m5MinAmp);
  if (swingHighs.length < 2 || swingLows.length < 2) {
    ({ highs: swingHighs, lows: swingLows } = getSwingPoints(dfM5, 2, 2, scale.m5MinAmp));
  }
  if (!swingHighs.length || !swingLows.length) {
    ({ highs: swingHighs, lows: swingLows } = getSwingPoints(dfM5, 2, 2, 0));
  }
  if (!swingHighs.length || !swingLows.length) return { sellSweep: empty, buySweep: empty };

  let sellSweep = empty;
  let buySweep = empty;
  const lookbackStart = Math.max(1, n - 18);

  for (let i = n - 1; i >= lookbackStart && !sellSweep.found; i--) {
    for (let sIdx = swingLows.length - 1; sIdx >= 0; sIdx--) {
      const [slVal, slIdx] = swingLows[sIdx]!;
      if (i <= slIdx + 1) continue;

      let priorPeak = -Infinity;
      for (let k = Math.max(0, slIdx - 6); k <= slIdx; k++) {
        if (dfM5[k]!.high > priorPeak) priorPeak = dfM5[k]!.high;
      }
      if (priorPeak - slVal < scale.minStructDepth) continue;
      if (dfM5[i - 1]!.close < slVal) continue;

      const oneBar = slVal - dfM5[i]!.low >= scale.minPenetration && dfM5[i]!.close >= slVal;
      const twoBar =
        i + 1 < n &&
        slVal - dfM5[i]!.low >= scale.minPenetration &&
        dfM5[i]!.close >= slVal - scale.reclaimMaxDip &&
        dfM5[i + 1]!.close >= slVal;

      if (oneBar || twoBar) {
        const sweepLow = twoBar ? Math.min(dfM5[i]!.low, dfM5[i + 1]!.low) : dfM5[i]!.low;
        const sweepEnd = twoBar ? i + 1 : i;
        let priorLower = false;
        // Reject stale swings that were already broken/swept earlier between slIdx and this sweep cluster
        for (let k = slIdx + 1; k < Math.max(slIdx + 1, i - 1); k++) {
          if (dfM5[k]!.low <= slVal - scale.minPenetration) {
            priorLower = true;
            break;
          }
        }
        if (!priorLower) {
          for (let k = Math.max(slIdx + 1, i - 3); k < i; k++) {
            if (dfM5[k]!.low < sweepLow) {
              priorLower = true;
              break;
            }
          }
        }
        let subsequentBreak = false;
        for (let k = sweepEnd + 1; k < n; k++) {
          if (dfM5[k]!.close < sweepLow) {
            subsequentBreak = true;
            break;
          }
        }
        if (!priorLower && !subsequentBreak) {
          sellSweep = { found: true, sweepExtreme: sweepLow, swingLevel: slVal, sweepIdx: i };
          break;
        }
      }
    }
  }

  for (let i = n - 1; i >= lookbackStart && !buySweep.found; i--) {
    for (let sIdx = swingHighs.length - 1; sIdx >= 0; sIdx--) {
      const [shVal, shIdx] = swingHighs[sIdx]!;
      if (i <= shIdx + 1) continue;

      let priorTrough = Infinity;
      for (let k = Math.max(0, shIdx - 6); k <= shIdx; k++) {
        if (dfM5[k]!.low < priorTrough) priorTrough = dfM5[k]!.low;
      }
      if (shVal - priorTrough < scale.minStructDepth) continue;
      if (dfM5[i - 1]!.close > shVal) continue;

      const oneBar = dfM5[i]!.high - shVal >= scale.minPenetration && dfM5[i]!.close <= shVal;
      const twoBar =
        i + 1 < n &&
        dfM5[i]!.high - shVal >= scale.minPenetration &&
        dfM5[i]!.close <= shVal + scale.reclaimMaxDip &&
        dfM5[i + 1]!.close <= shVal;

      if (oneBar || twoBar) {
        const sweepHigh = twoBar ? Math.max(dfM5[i]!.high, dfM5[i + 1]!.high) : dfM5[i]!.high;
        const sweepEnd = twoBar ? i + 1 : i;
        let priorHigher = false;
        // Reject stale swings that were already broken/swept earlier between shIdx and this sweep cluster
        for (let k = shIdx + 1; k < Math.max(shIdx + 1, i - 1); k++) {
          if (dfM5[k]!.high >= shVal + scale.minPenetration) {
            priorHigher = true;
            break;
          }
        }
        if (!priorHigher) {
          for (let k = Math.max(shIdx + 1, i - 3); k < i; k++) {
            if (dfM5[k]!.high > sweepHigh) {
              priorHigher = true;
              break;
            }
          }
        }
        let subsequentBreak = false;
        for (let k = sweepEnd + 1; k < n; k++) {
          if (dfM5[k]!.close > sweepHigh) {
            subsequentBreak = true;
            break;
          }
        }
        if (!priorHigher && !subsequentBreak) {
          buySweep = { found: true, sweepExtreme: sweepHigh, swingLevel: shVal, sweepIdx: i };
          break;
        }
      }
    }
  }

  return { sellSweep, buySweep };
}

function detectChochBos(
  dfM5: OhlcBar[],
  sweepIdx: number,
  isBullish: boolean
): { found: boolean; level: number; idx: number } {
  if (sweepIdx < 0 || sweepIdx >= dfM5.length) return { found: false, level: 0, idx: -1 };
  const { highs: sh, lows: sl } = getSwingPoints(dfM5, 2, 2, 0);

  if (isBullish) {
    const prior = sh.filter(([, idx]) => idx < sweepIdx);
    let chochLvl = prior.length ? prior[prior.length - 1]![0] : 0;
    if (!prior.length) {
      for (let k = Math.max(0, sweepIdx - 6); k < sweepIdx; k++) {
        if (dfM5[k]!.high > chochLvl) chochLvl = dfM5[k]!.high;
      }
    }
    if (chochLvl <= 0) return { found: false, level: 0, idx: -1 };
    for (let j = sweepIdx + 1; j < dfM5.length; j++) {
      if (dfM5[j]!.close > chochLvl) return { found: true, level: chochLvl, idx: j };
    }
    return { found: false, level: chochLvl, idx: -1 };
  } else {
    const prior = sl.filter(([, idx]) => idx < sweepIdx);
    let chochLvl = prior.length ? prior[prior.length - 1]![0] : Infinity;
    if (!prior.length) {
      for (let k = Math.max(0, sweepIdx - 6); k < sweepIdx; k++) {
        if (dfM5[k]!.low < chochLvl) chochLvl = dfM5[k]!.low;
      }
    }
    if (!Number.isFinite(chochLvl)) return { found: false, level: 0, idx: -1 };
    for (let j = sweepIdx + 1; j < dfM5.length; j++) {
      if (dfM5[j]!.close < chochLvl) return { found: true, level: chochLvl, idx: j };
    }
    return { found: false, level: chochLvl, idx: -1 };
  }
}

interface ZoneBox {
  low: number;
  high: number;
  idx: number;
}

function detectOrderBlocksAndBreakers(bars: OhlcBar[], scale: CryptoScale) {
  const n = bars.length;
  const lastPrice = bars[n - 1]!.close;
  const rawBull: ZoneBox[] = [];
  const rawBear: ZoneBox[] = [];

  for (let i = 2; i < n - 1; i++) {
    const disp = Math.abs(bars[i]!.close - bars[i]!.open);
    if (disp < scale.minObDisp) continue;
    if (bars[i - 1]!.close < bars[i - 1]!.open && bars[i]!.close > bars[i - 2]!.high) {
      const obL = bars[i - 1]!.low;
      const obH = bars[i - 1]!.high;
      if (Math.abs((obL + obH) / 2 - lastPrice) <= scale.maxZoneDist) rawBull.push({ low: obL, high: obH, idx: i });
    } else if (bars[i - 1]!.close > bars[i - 1]!.open && bars[i]!.close < bars[i - 2]!.low) {
      const obL = bars[i - 1]!.low;
      const obH = bars[i - 1]!.high;
      if (Math.abs((obL + obH) / 2 - lastPrice) <= scale.maxZoneDist) rawBear.push({ low: obL, high: obH, idx: i });
    }
  }

  const bullOb: ZoneBox[] = [];
  const bearOb: ZoneBox[] = [];
  const bullBreaker: ZoneBox[] = [];
  const bearBreaker: ZoneBox[] = [];

  for (const b of rawBull) {
    let mit = false;
    for (let j = b.idx + 1; j < n; j++) {
      if (bars[j]!.close < b.low) {
        mit = true;
        break;
      }
    }
    if (!mit) bullOb.push(b);
    else if (lastPrice <= b.high && Math.abs(lastPrice - b.low) <= scale.maxZoneDist) bearBreaker.push(b);
  }

  for (const b of rawBear) {
    let mit = false;
    for (let j = b.idx + 1; j < n; j++) {
      if (bars[j]!.close > b.high) {
        mit = true;
        break;
      }
    }
    if (!mit) bearOb.push(b);
    else if (lastPrice >= b.low && Math.abs(lastPrice - b.high) <= scale.maxZoneDist) bullBreaker.push(b);
  }

  return {
    bullOb: bullOb.slice(-2),
    bearOb: bearOb.slice(-2),
    bullBreaker: bullBreaker.slice(-2),
    bearBreaker: bearBreaker.slice(-2),
  };
}

function detectSmcZones(
  bars: OhlcBar[],
  scale: CryptoScale,
  minIdx = 0,
  sweepLow?: number,
  sweepHigh?: number
) {
  const n = bars.length;
  const lastPrice = bars[n - 1]!.close;
  const rawBull: ZoneBox[] = [];
  const rawBear: ZoneBox[] = [];

  const startScan = Math.max(2, minIdx);
  for (let i = startScan; i < n; i++) {
    const gapUp = bars[i]!.low - bars[i - 2]!.high;
    const gapDown = bars[i - 2]!.low - bars[i]!.high;
    if (gapUp >= scale.minFvgGap) {
      if (sweepLow === undefined || bars[i - 2]!.high >= sweepLow - scale.sweepMargin) {
        rawBull.push({ low: bars[i - 2]!.high, high: bars[i]!.low, idx: i });
      }
    } else if (gapDown >= scale.minFvgGap) {
      if (sweepHigh === undefined || bars[i - 2]!.low <= sweepHigh + scale.sweepMargin) {
        rawBear.push({ low: bars[i]!.high, high: bars[i - 2]!.low, idx: i });
      }
    }
  }

  const activeBull: ZoneBox[] = [];
  const activeBear: ZoneBox[] = [];
  const bullIfvg: ZoneBox[] = [];
  const bearIfvg: ZoneBox[] = [];

  for (const f of rawBull) {
    let invIdx = -1;
    for (let j = f.idx + 1; j < n - 1; j++) {
      if (bars[j]!.close < f.low - scale.mitTol) {
        invIdx = j;
        break;
      }
    }
    const mid = (f.low + f.high) / 2;
    if (invIdx < 0 && Math.abs(mid - lastPrice) <= scale.maxZoneDist) {
      activeBull.push(f);
    } else if (invIdx >= 0 && Math.abs(mid - lastPrice) <= scale.maxZoneDist) {
      let reclaimed = false;
      for (let k = invIdx + 1; k < n; k++) {
        if (bars[k]!.close > f.high + scale.mitTol) {
          reclaimed = true;
          break;
        }
      }
      if (!reclaimed) bearIfvg.push(f);
    }
  }

  for (const f of rawBear) {
    let invIdx = -1;
    for (let j = f.idx + 1; j < n - 1; j++) {
      if (bars[j]!.close > f.high + scale.mitTol) {
        invIdx = j;
        break;
      }
    }
    const mid = (f.low + f.high) / 2;
    if (invIdx < 0 && Math.abs(mid - lastPrice) <= scale.maxZoneDist) {
      activeBear.push(f);
    } else if (invIdx >= 0 && Math.abs(mid - lastPrice) <= scale.maxZoneDist) {
      let broken = false;
      for (let k = invIdx + 1; k < n; k++) {
        if (bars[k]!.close < f.low - scale.mitTol) {
          broken = true;
          break;
        }
      }
      if (!broken) bullIfvg.push(f);
    }
  }

  const obs = detectOrderBlocksAndBreakers(bars, scale);
  return {
    bullFvg: activeBull.slice(-3),
    bearFvg: activeBear.slice(-3),
    bullIfvg: bullIfvg.slice(-2),
    bearIfvg: bearIfvg.slice(-2),
    ...obs,
  };
}

function checkFvgRetest(
  closedBar: OhlcBar,
  prevBar: OhlcBar,
  closedIdx: number,
  zones: ZoneBox[],
  isBullish: boolean,
  scale: CryptoScale
): ZoneBox | null {
  const prevIdx = closedIdx - 1;
  for (let k = zones.length - 1; k >= 0; k--) {
    const z = zones[k]!;
    if (closedIdx <= z.idx) continue;
    const canUsePrev = prevIdx > z.idx;
    const gap = Math.max(0, z.high - z.low);
    const penDepth = gap >= scale.minFvgGap * 2.1 ? 0.35 * gap : 0;

    if (isBullish) {
      const entryCeil = z.high - penDepth;
      const direct =
        closedBar.low <= entryCeil &&
        closedBar.low >= z.low - scale.wickBuf &&
        closedBar.close >= z.low - scale.closeTol;
      const twoBar =
        canUsePrev &&
        prevBar.low <= entryCeil &&
        prevBar.low >= z.low - scale.wickBuf &&
        prevBar.close >= z.low - scale.closeTol &&
        closedBar.close >= z.low &&
        closedBar.close >= closedBar.open;
      if (direct || twoBar) return z;
    } else {
      const entryFloor = z.low + penDepth;
      const direct =
        closedBar.high >= entryFloor &&
        closedBar.high <= z.high + scale.wickBuf &&
        closedBar.close <= z.high + scale.closeTol;
      const twoBar =
        canUsePrev &&
        prevBar.high >= entryFloor &&
        prevBar.high <= z.high + scale.wickBuf &&
        prevBar.close <= z.high + scale.closeTol &&
        closedBar.close <= z.high &&
        closedBar.close <= closedBar.open;
      if (direct || twoBar) return z;
    }
  }
  return null;
}

function computeM15OpposingTarget(
  isBuy: boolean,
  dfM15: OhlcBar[],
  entryPrice: number,
  slDist: number,
  minTargetRrr: number,
  scale: CryptoScale
): { tpPrice: number; rrr: number } {
  const n = dfM15.length;
  const unbrokenSwings: number[] = [];

  // Target ONLY unbroken M15 structural liquidity (Swing Highs/Lows not yet swept since formation)
  // so TP sits on an actual reachable M15 liquidity pool instead of dead levels or empty-space multiples.
  const collectUnbroken = (nLeft: number, nRight: number, minAmp: number) => {
    for (let i = nLeft; i < n - nRight; i++) {
      if (isBuy) {
        const hi = dfM15[i]!.high;
        let ok = true;
        for (let j = 1; j <= nLeft; j++) if (hi < dfM15[i - j]!.high) ok = false;
        for (let j = 1; j <= nRight; j++) if (hi <= dfM15[i + j]!.high) ok = false;
        if (!ok) continue;
        if (minAmp > 0) {
          let baseLow = Infinity;
          for (let k = i - nLeft; k <= i + nRight; k++) baseLow = Math.min(baseLow, dfM15[k]!.low);
          if (hi - baseLow < minAmp) continue;
        }
        if (hi <= entryPrice + scale.targetMinMove) continue;
        let broken = false;
        for (let k = i + 1; k < n; k++) {
          if (dfM15[k]!.high >= hi) {
            broken = true;
            break;
          }
        }
        if (!broken) unbrokenSwings.push(hi);
      } else {
        const lo = dfM15[i]!.low;
        let ok = true;
        for (let j = 1; j <= nLeft; j++) if (lo > dfM15[i - j]!.low) ok = false;
        for (let j = 1; j <= nRight; j++) if (lo >= dfM15[i + j]!.low) ok = false;
        if (!ok) continue;
        if (minAmp > 0) {
          let baseHigh = -Infinity;
          for (let k = i - nLeft; k <= i + nRight; k++) baseHigh = Math.max(baseHigh, dfM15[k]!.high);
          if (baseHigh - lo < minAmp) continue;
        }
        if (lo >= entryPrice - scale.targetMinMove) continue;
        let broken = false;
        for (let k = i + 1; k < n; k++) {
          if (dfM15[k]!.low <= lo) {
            broken = true;
            break;
          }
        }
        if (!broken) unbrokenSwings.push(lo);
      }
    }
  };

  collectUnbroken(3, 3, scale.m15TargetMinAmp);
  if (!unbrokenSwings.length) collectUnbroken(3, 3, 0);
  if (!unbrokenSwings.length) collectUnbroken(2, 2, scale.m15MinAmp);

  unbrokenSwings.sort((a, b) => (isBuy ? a - b : b - a));
  if (!unbrokenSwings.length || slDist <= 0) return { tpPrice: 0, rrr: 0 };

  // Evaluate the NEAREST unbroken M15 Draw-on-Liquidity first — never jump past a close wall
  // to invent an unachievable distant target or blind 3.0R/2.2R math price.
  const nearestLvl = unbrokenSwings[0]!;
  const frontRunTp = rndPrice(isBuy ? nearestLvl - scale.frontRunBuf : nearestLvl + scale.frontRunBuf, scale.digits);
  const nearestRrr = (isBuy ? frontRunTp - entryPrice : entryPrice - frontRunTp) / slDist;

  if (nearestRrr < minTargetRrr) {
    return { tpPrice: frontRunTp, rrr: Number(Math.max(0, nearestRrr).toFixed(2)) };
  }
  if (nearestRrr <= 3.5) {
    return { tpPrice: frontRunTp, rrr: Number(nearestRrr.toFixed(2)) };
  }

  // Only if the nearest unbroken swing is > 3.5R away, check a nearer unmitigated M15 OB/Breaker inside [minTargetRrr..3.5R]
  const m15Zones = detectSmcZones(dfM15, scale, 0);
  const oppZones = isBuy
    ? [...m15Zones.bearOb.map((z) => z.low), ...m15Zones.bearBreaker.map((z) => z.low)].filter(
        (p) => p > entryPrice + scale.targetMinMove
      )
    : [...m15Zones.bullOb.map((z) => z.high), ...m15Zones.bullBreaker.map((z) => z.high)].filter(
        (p) => p < entryPrice - scale.targetMinMove
      );
  oppZones.sort((a, b) => (isBuy ? a - b : b - a));
  for (const zl of oppZones) {
    const zTp = rndPrice(isBuy ? zl - scale.frontRunBuf : zl + scale.frontRunBuf, scale.digits);
    const zRrr = (isBuy ? zTp - entryPrice : entryPrice - zTp) / slDist;
    if (zRrr >= minTargetRrr && zRrr <= 3.5) {
      return { tpPrice: zTp, rrr: Number(zRrr.toFixed(2)) };
    }
  }

  return { tpPrice: frontRunTp, rrr: Number(nearestRrr.toFixed(2)) };
}

interface SmcClosedEvaluation {
  m15Bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  isBull: boolean;
  isBear: boolean;
  hasSweep: boolean;
  sw: SweepResult;
  chochOk: boolean;
  chochLvl: number;
  chochIdx: number;
  fvgOk: boolean;
  legFvgs: ZoneBox[];
  retestOk: boolean;
  s6Ok: boolean;
  s7Ok: boolean;
  s8Ok: boolean;
  s9Ok: boolean;
  slPrice: number;
  tpPrice: number;
  rrr: number;
  action: "BUY" | "SELL" | "NONE";
}

function isRejectionConfirmed(closedBar: OhlcBar, isBull: boolean, refPrice: number): boolean {
  const rng = Math.max(refPrice * 1e-5, closedBar.high - closedBar.low);
  const body = Math.abs(closedBar.close - closedBar.open);
  const uw = closedBar.high - Math.max(closedBar.open, closedBar.close);
  const lw = Math.min(closedBar.open, closedBar.close) - closedBar.low;
  if (isBull) {
    const strongBullBody = closedBar.close > closedBar.open && body / rng >= 0.3 && uw / rng <= 0.45;
    const bullPinbar = lw / rng >= 0.45 && closedBar.open - closedBar.close <= 0.2 * rng;
    return strongBullBody || bullPinbar;
  }
  const strongBearBody = closedBar.close < closedBar.open && body / rng >= 0.3 && lw / rng <= 0.45;
  const bearPinbar = uw / rng >= 0.45 && closedBar.close - closedBar.open <= 0.2 * rng;
  return strongBearBody || bearPinbar;
}

function computeProtectedSweepAnchor(
  closedBars: OhlcBar[],
  closedIdx: number,
  sweepExtreme: number,
  isBull: boolean,
  scale: CryptoScale
): number {
  let anchorExt = sweepExtreme;
  const swNearby = getSwingPoints(closedBars, 3, 3, scale.m5MinAmp);
  const nearbyDist = scale.refPrice * 0.0025;
  const levels = isBull ? swNearby.lows : swNearby.highs;

  for (const [lvl, idx] of levels) {
    if (idx >= closedIdx - 2) continue;
    const isBeyond = isBull ? lvl < anchorExt && anchorExt - lvl <= nearbyDist : lvl > anchorExt && lvl - anchorExt <= nearbyDist;
    if (!isBeyond) continue;

    let taken = false;
    for (let k = idx + 1; k < closedBars.length; k++) {
      if (isBull ? closedBars[k]!.low <= lvl - scale.minPenetration : closedBars[k]!.high >= lvl + scale.minPenetration) {
        taken = true;
        break;
      }
    }
    if (!taken) anchorExt = isBull ? Math.min(anchorExt, lvl) : Math.max(anchorExt, lvl);
  }
  return anchorExt;
}

/** Causal position of `price` within `[0..1]` of the last `lookback` closed M15 bars. */
function rangePosition(bars: OhlcBar[], lookback: number, price: number): number {
  const slice = bars.slice(-lookback);
  if (slice.length === 0) return 0.5;
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of slice) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  return hi > lo ? (price - lo) / (hi - lo) : 0.5;
}

/** ICT Discount/Premium alignment: avoid buying M15 overextended highs or selling M15 overextended lows. */
function isM15EquilibriumAligned(isBuy: boolean, m15Bars: OhlcBar[], entryPrice: number): boolean {
  const pos48 = rangePosition(m15Bars, 48, entryPrice);
  const pos24 = rangePosition(m15Bars, 24, entryPrice);
  return isBuy ? pos48 <= 0.60 && pos24 <= 0.72 : pos48 >= 0.40 && pos24 >= 0.28;
}

/** Shared SL/TP bracket & fee-adjusted RRR validation across Strict M5 and M1 LTF entries. */
function finalizeSmcBracket(
  isBull: boolean,
  slAnchor: number,
  entryPrice: number,
  m15Bars: OhlcBar[],
  maxSlPct: number,
  leverage: number,
  minTargetRrr: number,
  scale: CryptoScale,
  minRawSlPct: number
): { s8Ok: boolean; s9Ok: boolean; slPrice: number; tpPrice: number; rrr: number } {
  const rawSlPrice = rndPrice(isBull ? slAnchor - scale.slBuf : slAnchor + scale.slBuf, scale.digits);
  const rawSlDist = isBull ? entryPrice - rawSlPrice : rawSlPrice - entryPrice;
  const rawSlPct = entryPrice > 0 ? (rawSlDist / entryPrice) * 100 : 99;
  const liqSafe = Math.min(maxSlPct, 60 / Math.max(1, leverage));
  if (rawSlDist <= 0 || rawSlPct < minRawSlPct || rawSlPct > liqSafe) {
    return { s8Ok: false, s9Ok: false, slPrice: 0, tpPrice: 0, rrr: 0 };
  }

  // Widen cleanly to a 0.50% crypto noise breathing floor when maxSl allows (matching backtested edge)
  const minFloorDist = liqSafe >= 0.5 ? entryPrice * 0.005 : 0;
  const slPrice =
    rawSlDist < minFloorDist
      ? rndPrice(isBull ? entryPrice - minFloorDist : entryPrice + minFloorDist, scale.digits)
      : rawSlPrice;
  const slDist = isBull ? entryPrice - slPrice : slPrice - entryPrice;
  const s8Ok = slDist > 0;

  const targ = computeM15OpposingTarget(isBull, m15Bars, entryPrice, rawSlDist, minTargetRrr, scale);
  const rawTpDist = Math.abs(targ.tpPrice - entryPrice);
  const cappedTpDist = Math.min(rawTpDist, slDist * 1.75);
  const finalTpPrice = rndPrice(isBull ? entryPrice + cappedTpDist : entryPrice - cappedTpDist, scale.digits);
  const actualTpDist = Math.abs(finalTpPrice - entryPrice);
  const cappedRrr = slDist > 0 ? Number((actualTpDist / slDist).toFixed(2)) : 0;
  const feeEst = entryPrice * 0.0007; // 0.05% taker entry + 0.02% maker TP
  const netRrr = (actualTpDist - feeEst) / (slDist + feeEst);
  const minPostWidenRrr = Math.max(1.25, minTargetRrr - 0.1);
  const minNetRrr = Math.max(1.15, minTargetRrr - 0.2);

  const s9Ok =
    targ.tpPrice > 0 &&
    targ.rrr >= minTargetRrr &&
    targ.rrr <= 3.5 &&
    cappedRrr >= minPostWidenRrr &&
    netRrr >= minNetRrr;

  return { s8Ok, s9Ok, slPrice, tpPrice: finalTpPrice, rrr: cappedRrr };
}

interface M1LtfEvaluation {
  hasM1Choch: boolean;
  chochLvl: number;
  chochIdx: number;
  rejIdx: number;
  m1Fvgs: ZoneBox[];
  hasM1Retest: boolean;
  hasM1Rej: boolean;
  s7Ok: boolean;
  s8Ok: boolean;
  s9Ok: boolean;
  slPrice: number;
  tpPrice: number;
  rrr: number;
  action: "BUY" | "SELL" | "NONE";
  stepProgress: number;
  sliceStart: number;
}

/**
 * Evaluates M1 LTF Execution Refinement following a confirmed M5 Liquidity Sweep:
 * M15 Bias -> M5 Sweep -> M1 CHoCH -> M1 Displacement FVG -> Closed M1 FVG Retest & Rejection
 * -> 1m Rejection Follow-Through Hold -> 0.50% Crypto Sweep SL Floor -> M15 Opposing Unbroken Liquidity Target.
 */
function evaluateM1LtfRefinement(
  isBull: boolean,
  m5ClosedBars: OhlcBar[],
  m15Bars: OhlcBar[],
  m1ClosedBars: OhlcBar[],
  sw: SweepResult,
  entryPrice: number,
  maxSlPct: number,
  leverage: number,
  minTargetRrr: number,
  scale: CryptoScale
): M1LtfEvaluation | null {
  const n1 = m1ClosedBars.length;
  if (!sw.found || sw.sweepIdx < 0 || sw.sweepIdx >= m5ClosedBars.length || n1 < 26) return null;

  // Require 1 completed M1 follow-through bar after the Rejection bar before executing
  const m1Base = m1ClosedBars.slice(0, -1);
  const nBase = m1Base.length;
  const followBar = m1ClosedBars[n1 - 1]!;
  const swTime = m5ClosedBars[sw.sweepIdx]!.time;
  let anchorIdx = -1;
  let m1Extreme = isBull ? Infinity : -Infinity;
  for (let k = 0; k < nBase - 3; k++) {
    const t = m1Base[k]!.time;
    if (t >= swTime - 60_000 && t <= swTime + 5 * 60_000) {
      if (isBull && m1Base[k]!.low < m1Extreme) {
        m1Extreme = m1Base[k]!.low;
        anchorIdx = k;
      }
      if (!isBull && m1Base[k]!.high > m1Extreme) {
        m1Extreme = m1Base[k]!.high;
        anchorIdx = k;
      }
    }
  }
  if (anchorIdx < 2 || anchorIdx >= nBase - 3 || nBase - 1 - anchorIdx > 60) return null;

  const trueExtreme = isBull ? Math.min(sw.sweepExtreme, m1Extreme) : Math.max(sw.sweepExtreme, m1Extreme);
  for (let k = anchorIdx + 1; k < nBase; k++) {
    if ((isBull && m1Base[k]!.close < trueExtreme) || (!isBull && m1Base[k]!.close > trueExtreme)) {
      return null;
    }
  }

  const sliceStart = Math.max(0, anchorIdx - 25);
  const m1Slice = m1Base.slice(sliceStart);
  const aIdx = anchorIdx - sliceStart;
  const ns = m1Slice.length;
  if (aIdx < 2 || ns < 6) return null;

  const m1MinAmp = scale.refPrice * 0.00025;
  let { highs: sh, lows: sl } = getSwingPoints(m1Slice, 2, 2, m1MinAmp);
  let prior = (isBull ? sh : sl).filter(([, idx]) => idx < aIdx);
  if (!prior.length) {
    ({ highs: sh, lows: sl } = getSwingPoints(m1Slice, 2, 2, 0));
    prior = (isBull ? sh : sl).filter(([, idx]) => idx < aIdx);
  }
  let chochLvl = prior.length ? prior[prior.length - 1]![0] : isBull ? 0 : Infinity;
  if (!prior.length) {
    for (let k = Math.max(0, aIdx - 6); k < aIdx; k++) {
      chochLvl = isBull ? Math.max(chochLvl, m1Slice[k]!.high) : Math.min(chochLvl, m1Slice[k]!.low);
    }
  }

  let chochRelIdx = -1;
  for (let j = aIdx + 1; j < ns; j++) {
    if ((isBull && m1Slice[j]!.close > chochLvl) || (!isBull && m1Slice[j]!.close < chochLvl)) {
      chochRelIdx = j;
      break;
    }
  }
  const safeChochLvl = Number.isFinite(chochLvl) && chochLvl > 0 ? chochLvl : 0;
  const hasM1Choch = chochRelIdx >= 0 && ns - 1 - chochRelIdx <= 25;
  if (!hasM1Choch) {
    if (safeChochLvl <= 0) return null;
    return {
      hasM1Choch: false,
      chochLvl: safeChochLvl,
      chochIdx: -1,
      rejIdx: -1,
      m1Fvgs: [],
      hasM1Retest: false,
      hasM1Rej: false,
      s7Ok: false,
      s8Ok: false,
      s9Ok: false,
      slPrice: 0,
      tpPrice: 0,
      rrr: 0,
      action: "NONE",
      stepProgress: 2,
      sliceStart,
    };
  }

  const m1MinGap = scale.refPrice * 0.00018;
  const m1MitTol = scale.refPrice * 0.00008;
  const maxLeg = Math.min(ns - 1, chochRelIdx + 2);
  const m1Fvgs: ZoneBox[] = [];
  for (let k = Math.max(2, aIdx); k <= maxLeg; k++) {
    if (isBull) {
      const gap = m1Slice[k]!.low - m1Slice[k - 2]!.high;
      if (gap >= m1MinGap && m1Slice[k - 2]!.high >= trueExtreme - scale.sweepMargin) {
        let mit = false;
        for (let j = k + 1; j < ns - 1; j++) {
          if (m1Slice[j]!.close < m1Slice[k - 2]!.high - m1MitTol) {
            mit = true;
            break;
          }
        }
        if (!mit) m1Fvgs.push({ low: m1Slice[k - 2]!.high, high: m1Slice[k]!.low, idx: k });
      }
    } else {
      const gap = m1Slice[k - 2]!.low - m1Slice[k]!.high;
      if (gap >= m1MinGap && m1Slice[k - 2]!.low <= trueExtreme + scale.sweepMargin) {
        let mit = false;
        for (let j = k + 1; j < ns - 1; j++) {
          if (m1Slice[j]!.close > m1Slice[k - 2]!.low + m1MitTol) {
            mit = true;
            break;
          }
        }
        if (!mit) m1Fvgs.push({ low: m1Slice[k]!.high, high: m1Slice[k - 2]!.low, idx: k });
      }
    }
  }

  let hasM1Retest = false;
  let hasM1Rej = false;
  let s7Ok = false;
  let s8Ok = false;
  let s9Ok = false;
  let slPrice = 0;
  let tpPrice = 0;
  let rrr = 0;
  let action: "BUY" | "SELL" | "NONE" = "NONE";

  if (m1Fvgs.length > 0) {
    const closedM1 = m1Slice[ns - 1]!;
    const prevM1 = m1Slice[ns - 2]!;
    const m1CloseTol = scale.refPrice * 0.00012;
    const m1WickBuf = scale.refPrice * 0.00025;
    let matched: ZoneBox | null = null;
    for (let z = m1Fvgs.length - 1; z >= 0; z--) {
      const f = m1Fvgs[z]!;
      if (ns - 1 <= f.idx) continue;
      const gap = Math.max(0, f.high - f.low);
      const pen = gap >= m1MinGap * 2.1 ? 0.35 * gap : 0;
      const direct = isBull
        ? closedM1.low <= f.high - pen && closedM1.low >= f.low - m1WickBuf && closedM1.close >= f.low - m1CloseTol
        : closedM1.high >= f.low + pen && closedM1.high <= f.high + m1WickBuf && closedM1.close <= f.high + m1CloseTol;
      const twoBar =
        ns - 2 > f.idx &&
        (isBull
          ? prevM1.low <= f.high - pen &&
            prevM1.low >= f.low - m1WickBuf &&
            prevM1.close >= f.low - m1CloseTol &&
            closedM1.close >= f.low &&
            closedM1.close >= closedM1.open
          : prevM1.high >= f.low + pen &&
            prevM1.high <= f.high + m1WickBuf &&
            prevM1.close <= f.high + m1CloseTol &&
            closedM1.close <= f.high &&
            closedM1.close <= closedM1.open);
      if (direct || twoBar) {
        matched = f;
        break;
      }
    }

    if (matched) {
      hasM1Retest = true;
      const rng = Math.max(scale.refPrice * 1e-5, closedM1.high - closedM1.low);
      const body = Math.abs(closedM1.close - closedM1.open);
      const lw = Math.min(closedM1.open, closedM1.close) - closedM1.low;
      const uw = closedM1.high - Math.max(closedM1.open, closedM1.close);
      hasM1Rej = isBull
        ? (closedM1.close > closedM1.open && body / rng >= 0.25 && closedM1.close >= matched.low) ||
          (lw / rng >= 0.45 && closedM1.open - closedM1.close <= 0.2 * rng)
        : (closedM1.close < closedM1.open && body / rng >= 0.25 && closedM1.close <= matched.high) ||
          (uw / rng >= 0.45 && closedM1.close - closedM1.open <= 0.2 * rng);

      if (hasM1Rej) {
        const followHeld = isBull ? followBar.close >= trueExtreme : followBar.close <= trueExtreme;
        const notChasing = isBull
          ? entryPrice <= matched.high + scale.refPrice * 0.0022
          : entryPrice >= matched.low - scale.refPrice * 0.0022;
        s7Ok = followHeld && notChasing && isM15EquilibriumAligned(isBull, m15Bars, entryPrice);
      }

      if (s7Ok) {
        const slAnchor = computeProtectedSweepAnchor(
          m5ClosedBars,
          m5ClosedBars.length - 1,
          trueExtreme,
          isBull,
          scale
        );
        const bracket = finalizeSmcBracket(
          isBull,
          slAnchor,
          entryPrice,
          m15Bars,
          maxSlPct,
          leverage,
          minTargetRrr,
          scale,
          0.25
        );
        slPrice = bracket.slPrice;
        tpPrice = bracket.tpPrice;
        rrr = bracket.rrr;
        s8Ok = bracket.s8Ok;
        s9Ok = bracket.s9Ok;
        if (bracket.s8Ok && bracket.s9Ok) {
          action = isBull ? "BUY" : "SELL";
        }
      }
    }
  }

  const stepProgress = [
    true,
    true,
    hasM1Choch,
    m1Fvgs.length > 0,
    hasM1Retest,
    hasM1Rej,
    s7Ok,
    s8Ok,
    s9Ok,
  ].filter(Boolean).length;

  return {
    hasM1Choch,
    chochLvl,
    chochIdx: sliceStart + chochRelIdx,
    rejIdx: sliceStart + ns - 1,
    m1Fvgs,
    hasM1Retest,
    hasM1Rej,
    s7Ok,
    s8Ok,
    s9Ok,
    slPrice,
    tpPrice,
    rrr,
    action,
    stepProgress,
    sliceStart,
  };
}

function evaluateClosedSmcSetup(
  closedBars: OhlcBar[],
  m15Bars: OhlcBar[],
  entryPrice: number,
  maxSlPct: number,
  leverage: number,
  minTargetRrr: number,
  scale: CryptoScale
): SmcClosedEvaluation {
  const m15Bias = detectMarketStructure(m15Bars, scale);
  const isBull = m15Bias === "BULLISH";
  const isBear = m15Bias === "BEARISH";
  const sweeps = detectLiquiditySweep(closedBars, scale);
  const hasSweep = (isBull && sweeps.sellSweep.found) || (isBear && sweeps.buySweep.found);
  const sw = isBull ? sweeps.sellSweep : sweeps.buySweep;

  let chochOk = false;
  let chochLvl = 0;
  let chochIdx = -1;
  let fvgOk = false;
  let retestOk = false;
  let s6Ok = false;
  let s7Ok = false;
  let s8Ok = false;
  let s9Ok = false;
  let slPrice = 0;
  let tpPrice = 0;
  let rrr = 0;
  let action: "BUY" | "SELL" | "NONE" = "NONE";
  let legFvgs: ZoneBox[] = [];

  const closedIdx = closedBars.length - 1;
  const closedBar = closedBars[closedIdx]!;
  const prevBar = closedBars[Math.max(0, closedIdx - 1)]!;

  if (hasSweep && (isBull || isBear)) {
    const ch = detectChochBos(closedBars, sw.sweepIdx, isBull);
    if (ch.level > 0) chochLvl = ch.level;
    const reclaimOk = isBull ? closedBar.close >= sw.sweepExtreme : closedBar.close <= sw.sweepExtreme;
    if (ch.found && closedIdx - ch.idx <= 18 && reclaimOk) {
      chochOk = true;
      chochLvl = ch.level;
      chochIdx = ch.idx;

      // Step 4: Only FVGs created within the Sweep -> CHoCH impulse leg (+1 follow-through bar) qualify
      const maxLegIdx = Math.min(closedIdx, ch.idx + 1);
      const lz = detectSmcZones(
        closedBars,
        scale,
        sw.sweepIdx,
        isBull ? sw.sweepExtreme : undefined,
        isBull ? undefined : sw.sweepExtreme
      );
      legFvgs = (isBull ? lz.bullFvg : lz.bearFvg).filter((z) => z.idx >= sw.sweepIdx && z.idx <= maxLegIdx);

      if (legFvgs.length > 0) {
        fvgOk = true;
        const matched = checkFvgRetest(closedBar, prevBar, closedIdx, legFvgs, isBull, scale);
        if (matched) {
          retestOk = true;
          s6Ok = isRejectionConfirmed(closedBar, isBull, scale.refPrice);
          if (s6Ok) {
            const closeConfirmed = isBull
              ? closedBar.close >= matched.low && entryPrice <= matched.high + scale.maxChaseDist
              : closedBar.close <= matched.high && entryPrice >= matched.low - scale.maxChaseDist;
            s7Ok = closeConfirmed && isM15EquilibriumAligned(isBull, m15Bars, entryPrice);
          }
          if (s7Ok) {
            const slAnchor = computeProtectedSweepAnchor(closedBars, closedIdx, sw.sweepExtreme, isBull, scale);
            const bracket = finalizeSmcBracket(
              isBull,
              slAnchor,
              entryPrice,
              m15Bars,
              maxSlPct,
              leverage,
              minTargetRrr,
              scale,
              0.35
            );
            slPrice = bracket.slPrice;
            tpPrice = bracket.tpPrice;
            rrr = bracket.rrr;
            s8Ok = bracket.s8Ok;
            s9Ok = bracket.s9Ok;
            if (bracket.s8Ok && bracket.s9Ok) {
              action = isBull ? "BUY" : "SELL";
            }
          }
        }
      }
    }
  }

  return {
    m15Bias,
    isBull,
    isBear,
    hasSweep,
    sw,
    chochOk,
    chochLvl,
    chochIdx,
    fvgOk,
    legFvgs,
    retestOk,
    s6Ok,
    s7Ok,
    s8Ok,
    s9Ok,
    slPrice,
    tpPrice,
    rrr,
    action,
  };
}

/**
 * Computes real-time 9-Step Telemetry + M5/M1 Candlestick Feed + Active SMC Zones (FVG, iFVG, OB, BREAKER)
 * for ANY searched Binance coin on-the-fly, combining Strict M5 with Forex-style M1 LTF Refinement.
 */
export function analyzeLiveSmcTelemetry(
  symbol: string,
  m5Bars: OhlcBar[],
  m15Bars: OhlcBar[],
  maxSlPct = 1.2,
  leverage = 5,
  minTargetRrr = 1.35,
  m1Bars?: OhlcBar[]
) {
  const symUpper = resolveBinanceSymbol(symbol);
  if (!m5Bars.length || !m15Bars.length) {
    return {
      telemetry: { symbol: symUpper, m15_bias: "NEUTRAL ⚪", action: "NONE" },
      activeZones: [] as Array<{ type: string; label: string; range: string }>,
      rawZones: [] as Array<{ zoneType: string; low: number; high: number }>,
      livePrice: 0,
      slPrice: 0,
      tpPrice: 0,
      rrr: 0,
      stepProgress: 0,
      stepTotal: 7,
      executionMode: "M5_STRICT" as const,
      sweepKey: "",
    };
  }

  const closedBars = m5Bars.length > 20 ? m5Bars.slice(0, -1) : m5Bars;
  const closedIdx = closedBars.length - 1;
  const livePrice =
    m1Bars && m1Bars.length > 0 ? m1Bars[m1Bars.length - 1]!.close : m5Bars[m5Bars.length - 1]!.close;
  const scale = computeCryptoScale(livePrice);
  const allZones = detectSmcZones(m5Bars, scale, 0);

  const ev = evaluateClosedSmcSetup(closedBars, m15Bars, livePrice, maxSlPct, leverage, minTargetRrr, scale);
  const { m15Bias, isBull, isBear, hasSweep, sw } = ev;
  let { chochOk, chochLvl, chochIdx, fvgOk, legFvgs, retestOk, s6Ok, s7Ok, s8Ok, s9Ok, slPrice, tpPrice, rrr, action } = ev;

  const m5StreamlinedScore = [
    isBull || isBear,
    hasSweep,
    chochOk,
    fvgOk,
    retestOk && s6Ok && s7Ok,
    s8Ok,
    s9Ok,
  ].filter(Boolean).length;
  const m1ClosedBars = m1Bars && m1Bars.length > 25 ? m1Bars.slice(0, -1) : m1Bars ?? [];
  const m1Ev =
    ev.action === "NONE" && (isBull || isBear) && hasSweep && m1ClosedBars.length >= 25
      ? evaluateM1LtfRefinement(isBull, closedBars, m15Bars, m1ClosedBars, sw, livePrice, maxSlPct, leverage, minTargetRrr, scale)
      : null;

  const m1StreamlinedScore = m1Ev
    ? [
        true,
        true,
        m1Ev.hasM1Choch,
        m1Ev.m1Fvgs.length > 0,
        m1Ev.hasM1Retest && m1Ev.hasM1Rej && m1Ev.s7Ok,
        m1Ev.s8Ok && m1Ev.s9Ok,
      ].filter(Boolean).length
    : 0;

  const useM1Telemetry = Boolean(
    m1Ev && (m1Ev.action !== "NONE" || !ev.chochOk || m1StreamlinedScore / 6 >= m5StreamlinedScore / 7)
  );
  if (useM1Telemetry && m1Ev) {
    chochOk = m1Ev.hasM1Choch;
    chochLvl = m1Ev.chochLvl;
    chochIdx = m1Ev.chochIdx;
    fvgOk = m1Ev.m1Fvgs.length > 0;
    legFvgs = m1Ev.m1Fvgs;
    retestOk = m1Ev.hasM1Retest;
    s6Ok = m1Ev.hasM1Rej;
    s7Ok = m1Ev.s7Ok;
    s8Ok = m1Ev.s8Ok;
    s9Ok = m1Ev.s9Ok;
    if (m1Ev.slPrice > 0) slPrice = m1Ev.slPrice;
    if (m1Ev.tpPrice > 0) tpPrice = m1Ev.tpPrice;
    if (m1Ev.rrr > 0) rrr = m1Ev.rrr;
    action = m1Ev.action;
  }

  const executionMode: "M5_STRICT" | "M1_LTF" = useM1Telemetry ? "M1_LTF" : "M5_STRICT";
  const swTime = hasSweep && sw.sweepIdx >= 0 && sw.sweepIdx < closedBars.length ? closedBars[sw.sweepIdx]!.time : 0;
  const sweepKey = hasSweep && swTime > 0 ? `${isBull ? "B" : "S"}:${swTime}` : "";

  if (tpPrice <= 0 && (isBull || isBear)) {
    const estAnchor = hasSweep ? computeProtectedSweepAnchor(closedBars, closedIdx, sw.sweepExtreme, isBull, scale) : 0;
    const estSlDist = hasSweep ? Math.abs(livePrice - estAnchor) + scale.slBuf : livePrice * 0.005;
    if (estSlDist > 0) {
      const est = computeM15OpposingTarget(isBull, m15Bars, livePrice, estSlDist, minTargetRrr, scale);
      tpPrice = est.tpPrice;
      rrr = est.rrr;
    }
  }

  const recentStart = Math.max(0, m5Bars.length - 45);
  const candles = m5Bars.slice(recentStart).map((c, relIdx) => {
    const absIdx = recentStart + relIdx;
    return {
      time: formatPktHhMm(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 100,
      isSweep: Boolean(hasSweep && absIdx === sw.sweepIdx),
      isChoch: Boolean(!useM1Telemetry && chochOk && absIdx === chochIdx),
      isRetest: Boolean(!useM1Telemetry && retestOk && absIdx === closedIdx),
      isRejection: Boolean(!useM1Telemetry && s6Ok && absIdx === closedIdx),
    };
  });

  const m1List = m1Bars ?? [];
  const m1Start = Math.max(0, m1List.length - 60);
  const m1ClosedLastIdx = m1ClosedBars.length - 1;
  let m1SweepBarAbsIdx = -1;
  if (hasSweep && swTime > 0 && m1List.length > 0) {
    let bestExt = isBull ? Infinity : -Infinity;
    for (let k = m1Start; k < m1List.length; k++) {
      const t = m1List[k]!.time;
      if (t >= swTime - 60_000 && t <= swTime + 5 * 60_000) {
        if (isBull && m1List[k]!.low < bestExt) {
          bestExt = m1List[k]!.low;
          m1SweepBarAbsIdx = k;
        }
        if (!isBull && m1List[k]!.high > bestExt) {
          bestExt = m1List[k]!.high;
          m1SweepBarAbsIdx = k;
        }
      }
    }
  }
  const candlesM1 = m1List.slice(m1Start).map((c, relIdx) => {
    const absIdx = m1Start + relIdx;
    return {
      time: formatPktHhMm(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 100,
      isSweep: Boolean(m1SweepBarAbsIdx >= 0 && absIdx === m1SweepBarAbsIdx),
      isChoch: Boolean(m1Ev && m1Ev.hasM1Choch && absIdx === m1Ev.chochIdx),
      isRetest: Boolean(m1Ev && m1Ev.hasM1Retest && absIdx === m1Ev.rejIdx),
      isRejection: Boolean(m1Ev && m1Ev.hasM1Rej && absIdx === m1Ev.rejIdx),
    };
  });

  const bullFvgArr = (!useM1Telemetry && fvgOk && isBull ? legFvgs : allZones.bullFvg).map((z) => [z.low, z.high]);
  const bearFvgArr = (!useM1Telemetry && fvgOk && isBear ? legFvgs : allZones.bearFvg).map((z) => [z.low, z.high]);
  const m1BullFvgArr = m1Ev && isBull ? m1Ev.m1Fvgs.map((z) => [z.low, z.high]) : [];
  const m1BearFvgArr = m1Ev && isBear ? m1Ev.m1Fvgs.map((z) => [z.low, z.high]) : [];

  const activeZones: Array<{ type: string; label: string; range: string }> = [];
  const pushZones = (items: ZoneBox[], typeKey: string, title: string, bull: boolean) => {
    for (const item of items) {
      activeZones.push({
        type: typeKey,
        label: `${bull ? "🟢" : "🔴"} ${title} - ${symUpper}`,
        range: `${formatCryptoPrice(item.low)}-${formatCryptoPrice(item.high)}`,
      });
    }
  };
  pushZones(allZones.bullFvg, "BULLISH_FVG", "FVG", true);
  pushZones(allZones.bearFvg, "BEARISH_FVG", "FVG", false);
  pushZones(allZones.bullIfvg, "BULLISH_iFVG", "iFVG", true);
  pushZones(allZones.bearIfvg, "BEARISH_iFVG", "iFVG", false);
  pushZones(allZones.bullOb, "BULLISH_OB", "OB", true);
  pushZones(allZones.bearOb, "BEARISH_OB", "OB", false);
  pushZones(allZones.bullBreaker, "BULLISH_BREAKER", "BREAKER", true);
  pushZones(allZones.bearBreaker, "BEARISH_BREAKER", "BREAKER", false);

  const stepTotal = useM1Telemetry ? 6 : 7;
  const closedRejConfirmed = fvgOk && (s7Ok || (retestOk && s6Ok));
  const stepProgress = useM1Telemetry
    ? [isBull || isBear, hasSweep, chochOk, fvgOk, closedRejConfirmed, s8Ok && s9Ok].filter(Boolean).length
    : [isBull || isBear, hasSweep, chochOk, fvgOk, closedRejConfirmed, s8Ok, s9Ok].filter(Boolean).length;
  const rawZones: Array<{ zoneType: string; low: number; high: number }> = [];
  const pushRaw = (items: ZoneBox[], zoneType: string) => {
    for (const item of items) {
      if (item.high > item.low) rawZones.push({ zoneType, low: item.low, high: item.high });
    }
  };
  pushRaw(allZones.bullFvg, "bullish_fvg");
  pushRaw(allZones.bearFvg, "bearish_fvg");
  pushRaw(allZones.bullIfvg, "bullish_ifvg");
  pushRaw(allZones.bearIfvg, "bearish_ifvg");
  pushRaw(allZones.bullOb, "bullish_ob");
  pushRaw(allZones.bearOb, "bearish_ob");
  pushRaw(allZones.bullBreaker, "bullish_breaker");
  pushRaw(allZones.bearBreaker, "bearish_breaker");

  return {
    livePrice,
    slPrice,
    tpPrice,
    rrr,
    stepProgress,
    stepTotal,
    executionMode,
    sweepKey,
    rawZones,
    activeZones,
    telemetry: {
      symbol: symUpper,
      m15_bias: m15Bias === "BULLISH" ? "BULLISH 🟢" : m15Bias === "BEARISH" ? "BEARISH 🔴" : "NEUTRAL ⚪",
      sweep_status: hasSweep ? "PASS 🟢 (M5 Sweep)" : "FAIL ⚪",
      sweep_price: hasSweep ? rndPrice(sw.sweepExtreme, scale.digits) : 0,
      choch_status: chochOk
        ? useM1Telemetry
          ? "PASS 🟢 (M1 CHoCH)"
          : "PASS 🟢 (CHoCH)"
        : hasSweep && chochLvl > 0
        ? "WAITING ⚪ (Awaiting Break)"
        : "FAIL ⚪",
      choch_price: (chochOk || hasSweep) && chochLvl > 0 ? rndPrice(chochLvl, scale.digits) : 0,
      fvg_status: fvgOk ? `PASS 🟢 (${legFvgs.length} ${useM1Telemetry ? "M1 " : ""}FVG)` : "FAIL ⚪",
      retest_status: retestOk ? `PASS 🟢 (${useM1Telemetry ? "M1 " : ""}Retested)` : "FAIL ⚪",
      s6_status: s6Ok ? `PASS 🟢 (${useM1Telemetry ? "M1 " : ""}Rejection)` : "FAIL ⚪",
      s7_status: s7Ok ? "PASS 🟢 (Confirmed)" : "FAIL ⚪",
      s8_status: s8Ok ? `PASS 🟢 (SL Protected)` : "",
      s9_status: s9Ok ? `PASS 🟢 (${rrr}R M15 Target)` : "",
      action,
      fvg_bounds_json: JSON.stringify({
        bullish_fvg: bullFvgArr,
        bearish_fvg: bearFvgArr,
        m1_bullish_fvg: m1BullFvgArr,
        m1_bearish_fvg: m1BearFvgArr,
        opposing_tp: tpPrice,
        sl_price: slPrice,
        step_progress: stepProgress,
        step_total: stepTotal,
        execution_mode: executionMode,
        m1_active: useM1Telemetry,
        sweep_key: sweepKey,
        candles,
        candles_m1: candlesM1,
      }),
    },
  };
}

export interface CryptoBacktestParams {
  symbol: string;
  m5Bars: OhlcBar[];
  m15Bars: OhlcBar[];
  m1Bars?: OhlcBar[];
  startTimeMs: number;
  initialBalance: number;
  accountMode: "PROP_FIRM" | "PERSONAL";
  riskPercent: number;
  leverage: number;
  maxMarginPct: number;
  maxSlPct: number;
  minRrr: number;
  sessionFilterEnabled: boolean;
  breakevenEnabled: boolean;
}

export interface CryptoTradeSim {
  type: "BUY" | "SELL";
  symbol: string;
  qty: number;
  marginUsed: number;
  marginPct: number;
  entryPrice: number;
  exitPrice: number;
  slPrice: number;
  tpPrice: number;
  targetRrr: number;
  achievedRrr: number;
  profitUsd: number;
  profitPercent: number;
  breakevenTriggered: boolean;
  sessionLabel: string;
  entryTf?: "M5" | "M1";
  reason: "TP_HIT" | "BREAKEVEN_LOCKED" | "SL_HIT" | "OPEN_END";
  entryTime: string;
  exitTime: string;
}

export function computeFeeAdjustedRiskDist(entryPrice: number, slDist: number): number {
  if (entryPrice <= 0 || slDist <= 0) return Math.max(0, slDist);
  // Reserve 0.08%–0.10% round-trip Binance taker fees + ~0.03% STOP_MARKET slippage so total SL loss stays ~1.0x Risk%
  return slDist + entryPrice * 0.0012;
}

function sizeSimCryptoPosition(
  entryPrice: number,
  slPrice: number,
  balance: number,
  riskPercent: number,
  leverage: number,
  maxMarginPct: number,
  accountMode: "PROP_FIRM" | "PERSONAL"
): { qty: number; marginUsed: number; marginPct: number } {
  const slDist = Math.abs(entryPrice - slPrice);
  if (entryPrice <= 0 || slDist <= 0 || balance <= 0) return { qty: 0, marginUsed: 0, marginPct: 0 };
  const capMarginPct =
    accountMode === "PERSONAL" ? Math.min(98.5, Math.max(5, maxMarginPct)) : Math.min(80, Math.max(5, maxMarginPct));
  const effRiskPct = accountMode === "PROP_FIRM" ? Math.min(riskPercent, 1.75) : riskPercent;
  const riskUsd = balance * (effRiskPct / 100);
  const effSlRisk = computeFeeAdjustedRiskDist(entryPrice, slDist);
  const rawQtyRisk = riskUsd / effSlRisk;
  const maxNotional = balance * (capMarginPct / 100) * Math.max(1, leverage);
  const maxQtyMargin = maxNotional / entryPrice;
  const qty = Math.min(rawQtyRisk, maxQtyMargin);
  const notional = qty * entryPrice;
  if (notional < 5.0) return { qty: 0, marginUsed: 0, marginPct: 0 };
  const marginUsed = notional / Math.max(1, leverage);
  return {
    qty: Number(qty.toFixed(6)),
    marginUsed: Number(marginUsed.toFixed(2)),
    marginPct: Number(((marginUsed / balance) * 100).toFixed(2)),
  };
}

export function runCryptoSmcBacktest(params: CryptoBacktestParams) {
  const {
    symbol,
    m5Bars,
    m15Bars,
    m1Bars,
    startTimeMs,
    initialBalance,
    accountMode,
    riskPercent,
    leverage,
    maxMarginPct,
    maxSlPct,
    minRrr,
    sessionFilterEnabled,
    breakevenEnabled,
  } = params;

  const binSym = resolveBinanceSymbol(symbol);
  let balance = initialBalance;
  let peakEquity = initialBalance;
  let maxDrawdownPct = 0;

  let m15Ptr = 0;
  while (m15Ptr + 1 < m15Bars.length && m15Bars[m15Ptr + 1]!.time <= m5Bars[0]!.time) {
    m15Ptr++;
  }

  interface OpenPos {
    type: "BUY" | "SELL";
    qty: number;
    marginUsed: number;
    marginPct: number;
    entryPrice: number;
    slPrice: number;
    initialSlPrice: number;
    slDist: number;
    tpPrice: number;
    targetRrr: number;
    breakevenApplied: boolean;
    entryTimeMs: number;
    sessionLabel: string;
    entryTf: "M5" | "M1";
  }

  let openPos: OpenPos | null = null;
  let posInitialQty = 0;
  let posRemainingQty = 0;
  let posRealizedUsd = 0;
  let posRealizedGrossUsd = 0;
  let posPartialTaken = false;
  let lastTradeExitTimeMs = -Infinity;
  const usedSweeps = new Set<string>();
  const trades: CryptoTradeSim[] = [];
  const equityCurve: Array<{ time: string; balance: number }> = [
    { time: new Date(Math.max(startTimeMs, m5Bars[0]!.time)).toISOString(), balance },
  ];

  // Round-trip taker fee modeling (~0.08% total on USDT-M futures)
  const feeRate = 0.0004;

  const finalizePositionExit = (pos: OpenPos, exitPrice: number, exitTimeMs: number, reason: CryptoTradeSim["reason"]) => {
    const remDelta = pos.type === "BUY" ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const remGross = remDelta * posRemainingQty;
    const remFees = (pos.entryPrice + exitPrice) * posRemainingQty * feeRate;
    const profitUsd = Number((posRealizedUsd + remGross - remFees).toFixed(2));
    const profitPct = Number(((profitUsd / Math.max(1, balance)) * 100).toFixed(2));
    balance = Number((balance + profitUsd).toFixed(2));
    if (balance > peakEquity) peakEquity = balance;
    const dd = peakEquity > 0 ? ((peakEquity - balance) / peakEquity) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    const totalGross = posRealizedGrossUsd + remGross;
    const achievedRrr = pos.qty * pos.slDist > 0 ? Number((totalGross / (pos.qty * pos.slDist)).toFixed(2)) : 0;
    const digits = inferCryptoDigits(pos.entryPrice);
    trades.push({
      type: pos.type,
      symbol: binSym,
      qty: pos.qty,
      marginUsed: pos.marginUsed,
      marginPct: pos.marginPct,
      entryPrice: rndPrice(pos.entryPrice, digits),
      exitPrice: rndPrice(exitPrice, digits),
      slPrice: rndPrice(pos.initialSlPrice, digits),
      tpPrice: rndPrice(pos.tpPrice, digits),
      targetRrr: pos.targetRrr,
      achievedRrr,
      profitUsd,
      profitPercent: profitPct,
      breakevenTriggered: pos.breakevenApplied,
      sessionLabel: pos.sessionLabel,
      entryTf: pos.entryTf,
      reason,
      entryTime: new Date(pos.entryTimeMs).toISOString(),
      exitTime: new Date(exitTimeMs).toISOString(),
    });
    equityCurve.push({ time: new Date(exitTimeMs).toISOString(), balance });
  };

  const advanceOpenPosition = (currBar: OhlcBar): boolean => {
    if (!openPos) return false;
    let exitPrice: number | null = null;
    let reason: CryptoTradeSim["reason"] | null = null;
    const isLong = openPos.type === "BUY";

    const takePartialTp1 = (pos: OpenPos) => {
      const tp1Price = isLong ? pos.entryPrice + pos.slDist * 0.85 : pos.entryPrice - pos.slDist * 0.85;
      const partialQty = posInitialQty * 0.5;
      const pGross = (isLong ? tp1Price - pos.entryPrice : pos.entryPrice - tp1Price) * partialQty;
      const pFees = (pos.entryPrice + tp1Price) * partialQty * feeRate;
      posRealizedGrossUsd += pGross;
      posRealizedUsd += pGross - pFees;
      posRemainingQty = posInitialQty - partialQty;
      posPartialTaken = true;
      pos.slPrice = pos.entryPrice * (isLong ? 1.0005 : 0.9995);
      pos.breakevenApplied = true;
    };

    if (isLong ? currBar.low <= openPos.slPrice : currBar.high >= openPos.slPrice) {
      exitPrice = openPos.slPrice;
      reason = openPos.breakevenApplied ? "BREAKEVEN_LOCKED" : "SL_HIT";
    } else if (isLong ? currBar.high >= openPos.tpPrice : currBar.low <= openPos.tpPrice) {
      if (breakevenEnabled && !posPartialTaken) {
        takePartialTp1(openPos);
      }
      exitPrice = openPos.tpPrice;
      reason = "TP_HIT";
    } else if (breakevenEnabled && !posPartialTaken) {
      const bestFav = isLong ? currBar.high - openPos.entryPrice : openPos.entryPrice - currBar.low;
      if (bestFav >= openPos.slDist * 0.85) {
        takePartialTp1(openPos);
      }
    }

    if (exitPrice !== null && reason !== null) {
      finalizePositionExit(openPos, exitPrice, currBar.time, reason);
      openPos = null;
      lastTradeExitTimeMs = currBar.time;
    }
    return true;
  };

  const tryOpenSimPosition = (
    action: "BUY" | "SELL",
    slPrice: number,
    tpPrice: number,
    targetRrr: number,
    entryPrice: number,
    entryTimeMs: number,
    entryTf: "M5" | "M1",
    sweepKey?: string
  ): boolean => {
    const sz = sizeSimCryptoPosition(entryPrice, slPrice, balance, riskPercent, leverage, maxMarginPct, accountMode);
    if (sz.qty <= 0 || slPrice <= 0 || tpPrice <= 0) return false;
    const slDist = Math.abs(entryPrice - slPrice);
    if (slDist <= 0) return false;
    posInitialQty = sz.qty;
    posRemainingQty = sz.qty;
    posRealizedUsd = 0;
    posRealizedGrossUsd = 0;
    posPartialTaken = false;
    openPos = {
      type: action,
      ...sz,
      entryPrice,
      slPrice,
      initialSlPrice: slPrice,
      slDist,
      tpPrice,
      targetRrr,
      breakevenApplied: false,
      entryTimeMs,
      sessionLabel: getPktSessionLabel(entryTimeMs),
      entryTf,
    };
    if (sweepKey) usedSweeps.add(sweepKey);
    return true;
  };

  const useM1Hybrid = Boolean(m1Bars && m1Bars.length >= 160 && m5Bars.length >= 50);
  let handoffM1Idx = 120;
  let handoffTimeMs = Infinity;
  if (useM1Hybrid && m1Bars) {
    while (handoffM1Idx < m1Bars.length - 10 && m1Bars[handoffM1Idx]!.time < m5Bars[46]!.time) {
      handoffM1Idx++;
    }
    handoffTimeMs = m1Bars[handoffM1Idx]!.time;
  }

  // Phase 1: M5 Strict simulation up to M1 history handoff (or entire window when m1Bars omitted)
  for (let i = 45; i < m5Bars.length - 1 && (!useM1Hybrid || m5Bars[i + 1]!.time <= handoffTimeMs); i++) {
    const currBar = m5Bars[i]!;
    while (m15Ptr + 1 < m15Bars.length && m15Bars[m15Ptr + 1]!.time <= currBar.time) {
      m15Ptr++;
    }

    if (advanceOpenPosition(currBar)) continue;
    if (currBar.time < startTimeMs || currBar.time - lastTradeExitTimeMs < 10 * 60_000) continue;

    const entryBar = m5Bars[i + 1]!;
    if (sessionFilterEnabled && !isInPktKillzone(entryBar.time)) continue;

    const m5Slice = m5Bars.slice(Math.max(0, i - 119), i + 1);
    const m15Slice = m15Bars.slice(Math.max(0, m15Ptr - 99), m15Ptr + 1);
    if (m15Slice.length < 15 || m5Slice.length < 12) continue;

    const scale = computeCryptoScale(m5Slice[m5Slice.length - 1]!.close);
    const entryPrice = rndPrice(entryBar.open, scale.digits);
    const ev = evaluateClosedSmcSetup(m5Slice, m15Slice, entryPrice, maxSlPct, leverage, minRrr, scale);
    if (ev.action === "BUY" || ev.action === "SELL") {
      const swTime = ev.hasSweep && ev.sw.sweepIdx >= 0 && ev.sw.sweepIdx < m5Slice.length ? m5Slice[ev.sw.sweepIdx]!.time : 0;
      const sweepKey = swTime > 0 ? `${ev.isBull ? "B" : "S"}:${swTime}` : undefined;
      tryOpenSimPosition(ev.action, ev.slPrice, ev.tpPrice, ev.rrr, entryPrice, entryBar.time, "M5", sweepKey);
    }
  }

  // Phase 2: Bar-by-bar M5 Strict + Forex-style M1 LTF Refinement (zero lookahead)
  if (useM1Hybrid && m1Bars) {
    let m5ClosedEnd = 0;
    let m15ClosedEnd = 0;
    let cachedM5End = -1;
    let cachedM15End = -1;
    let cachedState: {
      isBull: boolean;
      isBear: boolean;
      hasSweep: boolean;
      sw: SweepResult;
      sweepKey: string;
      m5Slice: OhlcBar[];
      m15Slice: OhlcBar[];
      scale: CryptoScale;
    } | null = null;

    for (let j = handoffM1Idx; j < m1Bars.length - 1; j++) {
      const currM1 = m1Bars[j]!;
      const nextM1 = m1Bars[j + 1]!;
      const decisionTime = nextM1.time;

      while (m5ClosedEnd < m5Bars.length && m5Bars[m5ClosedEnd]!.time + 5 * 60_000 <= decisionTime) {
        m5ClosedEnd++;
      }
      while (m15ClosedEnd < m15Bars.length && m15Bars[m15ClosedEnd]!.time + 15 * 60_000 <= decisionTime) {
        m15ClosedEnd++;
      }

      if (advanceOpenPosition(currM1)) continue;
      if (currM1.time < startTimeMs || nextM1.time - lastTradeExitTimeMs < 10 * 60_000) continue;
      if (sessionFilterEnabled && !isInPktKillzone(nextM1.time)) continue;
      if (m5ClosedEnd < 12 || m15ClosedEnd < 15) continue;

      if (m5ClosedEnd !== cachedM5End || m15ClosedEnd !== cachedM15End) {
        cachedM5End = m5ClosedEnd;
        cachedM15End = m15ClosedEnd;
        const m5Slice = m5Bars.slice(Math.max(0, m5ClosedEnd - 120), m5ClosedEnd);
        const m15Slice = m15Bars.slice(Math.max(0, m15ClosedEnd - 100), m15ClosedEnd);
        const scale = computeCryptoScale(m5Slice[m5Slice.length - 1]!.close);
        const m15Bias = detectMarketStructure(m15Slice, scale);
        const isBull = m15Bias === "BULLISH";
        const isBear = m15Bias === "BEARISH";
        const sweeps = isBull || isBear ? detectLiquiditySweep(m5Slice, scale) : null;
        const sw: SweepResult = sweeps
          ? isBull
            ? sweeps.sellSweep
            : sweeps.buySweep
          : { found: false, sweepExtreme: 0, swingLevel: 0, sweepIdx: -1 };
        const hasSweep = Boolean((isBull || isBear) && sw.found);
        const swTime = hasSweep && sw.sweepIdx >= 0 && sw.sweepIdx < m5Slice.length ? m5Slice[sw.sweepIdx]!.time : 0;
        cachedState = {
          isBull,
          isBear,
          hasSweep,
          sw,
          sweepKey: hasSweep && swTime > 0 ? `${isBull ? "B" : "S"}:${swTime}` : "",
          m5Slice,
          m15Slice,
          scale,
        };
      }

      if (!cachedState || (!cachedState.isBull && !cachedState.isBear) || !cachedState.hasSweep) continue;
      if (cachedState.sweepKey && usedSweeps.has(cachedState.sweepKey)) continue;

      const entryPrice = rndPrice(nextM1.open, cachedState.scale.digits);
      const evM5 = evaluateClosedSmcSetup(
        cachedState.m5Slice,
        cachedState.m15Slice,
        entryPrice,
        maxSlPct,
        leverage,
        minRrr,
        cachedState.scale
      );
      if (evM5.action === "BUY" || evM5.action === "SELL") {
        if (tryOpenSimPosition(evM5.action, evM5.slPrice, evM5.tpPrice, evM5.rrr, entryPrice, nextM1.time, "M5", cachedState.sweepKey)) {
          continue;
        }
      }

      const m1Slice = m1Bars.slice(Math.max(0, j - 179), j + 1);
      const m1Ev = evaluateM1LtfRefinement(
        cachedState.isBull,
        cachedState.m5Slice,
        cachedState.m15Slice,
        m1Slice,
        cachedState.sw,
        entryPrice,
        maxSlPct,
        leverage,
        minRrr,
        cachedState.scale
      );
      if (m1Ev && (m1Ev.action === "BUY" || m1Ev.action === "SELL")) {
        tryOpenSimPosition(m1Ev.action, m1Ev.slPrice, m1Ev.tpPrice, m1Ev.rrr, entryPrice, nextM1.time, "M1", cachedState.sweepKey);
      }
    }
  }

  if (openPos) {
    const lastBar = useM1Hybrid && m1Bars && m1Bars.length > 0 ? m1Bars[m1Bars.length - 1]! : m5Bars[m5Bars.length - 1];
    if (lastBar) {
      finalizePositionExit(openPos, lastBar.close, lastBar.time, "OPEN_END");
    }
  }

  const wins = trades.filter((t) => t.profitUsd > 0).length;
  const losses = trades.filter((t) => t.profitUsd < 0).length;
  const breakevens = trades.filter((t) => t.reason === "BREAKEVEN_LOCKED").length;
  const m1TradesCount = trades.filter((t) => t.entryTf === "M1").length;
  const m5TradesCount = trades.length - m1TradesCount;
  const grossWin = trades.filter((t) => t.profitUsd > 0).reduce((s, t) => s + t.profitUsd, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.profitUsd < 0).reduce((s, t) => s + t.profitUsd, 0));
  const profitFactor = grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 9.99 : 0;
  const netProfit = Number((balance - initialBalance).toFixed(2));
  const winRate = trades.length > 0 ? Number(((wins / trades.length) * 100).toFixed(2)) : 0;
  const avgRrr =
    trades.length > 0
      ? Number((trades.reduce((s, t) => s + t.achievedRrr, 0) / trades.length).toFixed(2))
      : 0;

  return {
    symbol: binSym,
    accountMode,
    leverage,
    maxMarginPct: accountMode === "PERSONAL" ? Math.min(100, maxMarginPct) : Math.min(80, maxMarginPct),
    executionMode: useM1Hybrid ? "M15 + M5 + M1 LTF" : "M15 + M5 Strict",
    m1TradesCount,
    m5TradesCount,
    totalTrades: trades.length,
    wins,
    losses,
    breakevens,
    winRate,
    avgRrr,
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    initialBalance,
    finalBalance: Number(balance.toFixed(2)),
    netProfit,
    profitFactor,
    equityCurve: equityCurve.slice(-80),
    trades: [...trades].reverse().slice(0, 60),
  };
}

/**
 * Resolves displayed Floating Open P&L cleanly across WebSocket and REST payloads so a transient
 * zero on bot_state never flashes $0.00 while open positions carry active unrealized profit.
 */
export function resolveDashboardFloatingProfit(
  rawBotFloat: unknown,
  openPositions: Array<{ profit?: unknown }>
): number {
  if (!Array.isArray(openPositions) || openPositions.length === 0) return 0;
  const botVal = Number(rawBotFloat ?? 0);
  if (Math.abs(botVal) > 0.001) return botVal;
  return Number(openPositions.reduce((sum, p) => sum + Number(p.profit ?? 0), 0).toFixed(2));
}
