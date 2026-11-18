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
    frontRunBuf: ref * 0.0006,
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
  }
  return { found: false, level: 0, idx: -1 };
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
  const sh3 = getSwingPoints(dfM15, 3, 3, 0);
  const sw2 = getSwingPoints(dfM15, 2, 2, scale.m15TargetMinAmp);
  if ((isBuy && !sw2.highs.length) || (!isBuy && !sw2.lows.length)) {
    const fb = getSwingPoints(dfM15, 2, 2, 0);
    if (isBuy && !sw2.highs.length) sw2.highs = fb.highs;
    if (!isBuy && !sw2.lows.length) sw2.lows = fb.lows;
  }

  const m15Zones = detectSmcZones(dfM15, scale, 0);

  if (isBuy) {
    const cands = [
      ...sh3.highs.map(([p]) => p),
      ...sw2.highs.map(([p]) => p),
      ...m15Zones.bearOb.map((z) => z.low),
      ...m15Zones.bearBreaker.map((z) => z.low),
    ]
      .filter((p) => p > entryPrice + scale.targetMinMove)
      .sort((a, b) => a - b);

    for (const lvl of cands) {
      const frontRunTp = lvl - scale.frontRunBuf;
      const candRrr = (frontRunTp - entryPrice) / slDist;
      if (candRrr >= minTargetRrr) {
        if (candRrr > 3.0) return { tpPrice: rndPrice(entryPrice + 3.0 * slDist, scale.digits), rrr: 3.0 };
        return { tpPrice: rndPrice(frontRunTp, scale.digits), rrr: Number(candRrr.toFixed(2)) };
      }
    }
    return { tpPrice: rndPrice(entryPrice + 2.2 * slDist, scale.digits), rrr: 2.2 };
  }

  const cands = [
    ...sh3.lows.map(([p]) => p),
    ...sw2.lows.map(([p]) => p),
    ...m15Zones.bullOb.map((z) => z.high),
    ...m15Zones.bullBreaker.map((z) => z.high),
  ]
    .filter((p) => p < entryPrice - scale.targetMinMove)
    .sort((a, b) => b - a);

  for (const lvl of cands) {
    const frontRunTp = lvl + scale.frontRunBuf;
    const candRrr = (entryPrice - frontRunTp) / slDist;
    if (candRrr >= minTargetRrr) {
      if (candRrr > 3.0) return { tpPrice: rndPrice(entryPrice - 3.0 * slDist, scale.digits), rrr: 3.0 };
      return { tpPrice: rndPrice(frontRunTp, scale.digits), rrr: Number(candRrr.toFixed(2)) };
    }
  }
  return { tpPrice: rndPrice(entryPrice - 2.2 * slDist, scale.digits), rrr: 2.2 };
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
            s7Ok = isBull
              ? closedBar.close >= matched.low && entryPrice <= matched.high + scale.maxChaseDist
              : closedBar.close <= matched.high && entryPrice >= matched.low - scale.maxChaseDist;
          }
          if (s7Ok) {
            slPrice = rndPrice(isBull ? sw.sweepExtreme - scale.slBuf : sw.sweepExtreme + scale.slBuf, scale.digits);
            const slDist = isBull ? entryPrice - slPrice : slPrice - entryPrice;
            const slPct = entryPrice > 0 ? (slDist / entryPrice) * 100 : 99;
            const liqSafe = Math.min(maxSlPct, 60 / Math.max(1, leverage));
            // Fee-safe minimum structural stop (>= 0.35%) so Binance commissions never eat profit edge
            if (slDist > 0 && slPct >= 0.35 && slPct <= liqSafe) {
              s8Ok = true;
              const targ = computeM15OpposingTarget(isBull, m15Bars, entryPrice, slDist, minTargetRrr, scale);
              tpPrice = targ.tpPrice;
              rrr = targ.rrr;
              const tpDist = Math.abs(tpPrice - entryPrice);
              const feeEst = entryPrice * 0.0007; // 0.05% taker entry + 0.02% maker TP
              const netRrr = (tpDist - feeEst) / (slDist + feeEst);
              if (rrr >= minTargetRrr && netRrr >= 1.75) {
                s9Ok = true;
                action = isBull ? "BUY" : "SELL";
              }
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
 * Computes real-time 9-Step Telemetry + M5 Candlestick Feed + Active SMC Zones (FVG, iFVG, OB, BREAKER)
 * for ANY searched Binance coin on-the-fly.
 */
export function analyzeLiveSmcTelemetry(
  symbol: string,
  m5Bars: OhlcBar[],
  m15Bars: OhlcBar[],
  maxSlPct = 1.2,
  leverage = 5,
  minTargetRrr = 1.85
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
    };
  }

  const closedBars = m5Bars.length > 20 ? m5Bars.slice(0, -1) : m5Bars;
  const closedIdx = closedBars.length - 1;
  const livePrice = m5Bars[m5Bars.length - 1]!.close;
  const scale = computeCryptoScale(livePrice);
  const allZones = detectSmcZones(m5Bars, scale, 0);

  const ev = evaluateClosedSmcSetup(closedBars, m15Bars, livePrice, maxSlPct, leverage, minTargetRrr, scale);
  const { m15Bias, isBull, isBear, hasSweep, sw, chochOk, chochLvl, chochIdx, fvgOk, legFvgs, retestOk, s6Ok, s7Ok, s8Ok, s9Ok, slPrice, action } = ev;
  let { tpPrice, rrr } = ev;

  if (tpPrice <= 0 && (isBull || isBear)) {
    const estSlDist = hasSweep ? Math.abs(livePrice - sw.sweepExtreme) + scale.slBuf : livePrice * 0.005;
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
      isChoch: Boolean(chochOk && absIdx === chochIdx),
      isRetest: Boolean(retestOk && absIdx === closedIdx),
      isRejection: Boolean(s6Ok && absIdx === closedIdx),
    };
  });

  const bullFvgArr = (fvgOk && isBull ? legFvgs : allZones.bullFvg).map((z) => [z.low, z.high]);
  const bearFvgArr = (fvgOk && isBear ? legFvgs : allZones.bearFvg).map((z) => [z.low, z.high]);

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

  const stepProgress = [isBull || isBear, hasSweep, chochOk, fvgOk, retestOk, s6Ok, s7Ok, s8Ok, s9Ok].filter(Boolean).length;
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
    rawZones,
    activeZones,
    telemetry: {
      symbol: symUpper,
      m15_bias: m15Bias === "BULLISH" ? "BULLISH 🟢" : m15Bias === "BEARISH" ? "BEARISH 🔴" : "NEUTRAL ⚪",
      sweep_status: hasSweep ? "PASS 🟢 (M5 Sweep)" : "FAIL ⚪",
      sweep_price: hasSweep ? rndPrice(sw.sweepExtreme, scale.digits) : 0,
      choch_status: chochOk ? "PASS 🟢 (CHoCH)" : "FAIL ⚪",
      choch_price: chochOk ? rndPrice(chochLvl, scale.digits) : 0,
      fvg_status: fvgOk ? `PASS 🟢 (${legFvgs.length} FVG)` : "FAIL ⚪",
      retest_status: retestOk ? "PASS 🟢 (Retested)" : "FAIL ⚪",
      s6_status: s6Ok ? "PASS 🟢 (Rejection)" : "FAIL ⚪",
      s7_status: s7Ok ? "PASS 🟢 (Confirmed)" : "FAIL ⚪",
      s8_status: s8Ok ? `PASS 🟢 (SL Protected)` : "",
      s9_status: s9Ok ? `PASS 🟢 (${rrr}R M15 Target)` : "",
      action,
      fvg_bounds_json: JSON.stringify({
        bullish_fvg: bullFvgArr,
        bearish_fvg: bearFvgArr,
        opposing_tp: tpPrice,
        sl_price: slPrice,
        step_progress: stepProgress,
        candles,
      }),
    },
  };
}

export interface CryptoBacktestParams {
  symbol: string;
  m5Bars: OhlcBar[];
  m15Bars: OhlcBar[];
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
  reason: "TP_HIT" | "BREAKEVEN_LOCKED" | "SL_HIT" | "OPEN_END";
  entryTime: string;
  exitTime: string;
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
  const rawQtyRisk = riskUsd / slDist;
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
  }

  let openPos: OpenPos | null = null;
  let lastTradeExitBar = -10;
  const trades: CryptoTradeSim[] = [];
  const equityCurve: Array<{ time: string; balance: number }> = [
    { time: new Date(Math.max(startTimeMs, m5Bars[0]!.time)).toISOString(), balance },
  ];

  // Round-trip taker fee modeling (~0.08% total on USDT-M futures)
  const feeRate = 0.0004;

  for (let i = 45; i < m5Bars.length - 1; i++) {
    const currBar = m5Bars[i]!;
    while (m15Ptr + 1 < m15Bars.length && m15Bars[m15Ptr + 1]!.time <= currBar.time) {
      m15Ptr++;
    }

    if (openPos) {
      let exitPrice: number | null = null;
      let reason: CryptoTradeSim["reason"] | null = null;

      if (openPos.type === "BUY") {
        if (currBar.low <= openPos.slPrice) {
          exitPrice = openPos.slPrice;
          reason = openPos.breakevenApplied ? "BREAKEVEN_LOCKED" : "SL_HIT";
        } else if (currBar.high >= openPos.tpPrice) {
          exitPrice = openPos.tpPrice;
          reason = "TP_HIT";
        } else if (breakevenEnabled && !openPos.breakevenApplied) {
          const bestFav = currBar.high - openPos.entryPrice;
          const ageMs = currBar.time - openPos.entryTimeMs;
          if (bestFav >= openPos.slDist || (ageMs >= 3600 * 1000 && currBar.close >= openPos.entryPrice * 1.0015)) {
            openPos.slPrice = openPos.entryPrice * 1.0012;
            openPos.breakevenApplied = true;
          }
        }
      } else {
        if (currBar.high >= openPos.slPrice) {
          exitPrice = openPos.slPrice;
          reason = openPos.breakevenApplied ? "BREAKEVEN_LOCKED" : "SL_HIT";
        } else if (currBar.low <= openPos.tpPrice) {
          exitPrice = openPos.tpPrice;
          reason = "TP_HIT";
        } else if (breakevenEnabled && !openPos.breakevenApplied) {
          const bestFav = openPos.entryPrice - currBar.low;
          const ageMs = currBar.time - openPos.entryTimeMs;
          if (bestFav >= openPos.slDist || (ageMs >= 3600 * 1000 && currBar.close <= openPos.entryPrice * 0.9985)) {
            openPos.slPrice = openPos.entryPrice * 0.9988;
            openPos.breakevenApplied = true;
          }
        }
      }

      if (exitPrice !== null && reason !== null) {
        const delta = openPos.type === "BUY" ? exitPrice - openPos.entryPrice : openPos.entryPrice - exitPrice;
        const fees = (openPos.entryPrice + exitPrice) * openPos.qty * feeRate;
        const profitUsd = Number((delta * openPos.qty - fees).toFixed(2));
        const profitPct = Number(((profitUsd / Math.max(1, balance)) * 100).toFixed(2));
        balance = Number((balance + profitUsd).toFixed(2));
        if (balance > peakEquity) peakEquity = balance;
        const dd = peakEquity > 0 ? ((peakEquity - balance) / peakEquity) * 100 : 0;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;

        const digits = inferCryptoDigits(openPos.entryPrice);
        trades.push({
          type: openPos.type,
          symbol: binSym,
          qty: openPos.qty,
          marginUsed: openPos.marginUsed,
          marginPct: openPos.marginPct,
          entryPrice: rndPrice(openPos.entryPrice, digits),
          exitPrice: rndPrice(exitPrice, digits),
          slPrice: rndPrice(openPos.initialSlPrice, digits),
          tpPrice: rndPrice(openPos.tpPrice, digits),
          targetRrr: openPos.targetRrr,
          achievedRrr: Number((delta / openPos.slDist).toFixed(2)),
          profitUsd,
          profitPercent: profitPct,
          breakevenTriggered: openPos.breakevenApplied,
          sessionLabel: openPos.sessionLabel,
          reason,
          entryTime: new Date(openPos.entryTimeMs).toISOString(),
          exitTime: new Date(currBar.time).toISOString(),
        });
        equityCurve.push({ time: new Date(currBar.time).toISOString(), balance });
        openPos = null;
        lastTradeExitBar = i;
      }
      continue;
    }

    if (currBar.time < startTimeMs || i - lastTradeExitBar < 2) continue;

    const entryBar = m5Bars[i + 1]!;
    if (sessionFilterEnabled && !isInPktKillzone(entryBar.time)) continue;

    const m5Slice = m5Bars.slice(Math.max(0, i - 119), i + 1);
    const m15Slice = m15Bars.slice(Math.max(0, m15Ptr - 99), m15Ptr + 1);
    if (m15Slice.length < 15 || m5Slice.length < 12) continue;

    const scale = computeCryptoScale(m5Slice[m5Slice.length - 1]!.close);
    const entryPrice = rndPrice(entryBar.open, scale.digits);
    const ev = evaluateClosedSmcSetup(m5Slice, m15Slice, entryPrice, maxSlPct, leverage, minRrr, scale);
    if (ev.action === "BUY" || ev.action === "SELL") {
      const sz = sizeSimCryptoPosition(entryPrice, ev.slPrice, balance, riskPercent, leverage, maxMarginPct, accountMode);
      if (sz.qty > 0) {
        const slDist = Math.abs(entryPrice - ev.slPrice);
        openPos = {
          type: ev.action,
          ...sz,
          entryPrice,
          slPrice: ev.slPrice,
          initialSlPrice: ev.slPrice,
          slDist,
          tpPrice: ev.tpPrice,
          targetRrr: ev.rrr,
          breakevenApplied: false,
          entryTimeMs: entryBar.time,
          sessionLabel: getPktSessionLabel(entryBar.time),
        };
      }
    }
  }

  if (openPos && m5Bars.length > 0) {
    const lastBar = m5Bars[m5Bars.length - 1]!;
    const exitPrice = lastBar.close;
    const delta = openPos.type === "BUY" ? exitPrice - openPos.entryPrice : openPos.entryPrice - exitPrice;
    const fees = (openPos.entryPrice + exitPrice) * openPos.qty * feeRate;
    const profitUsd = Number((delta * openPos.qty - fees).toFixed(2));
    const profitPct = Number(((profitUsd / Math.max(1, balance)) * 100).toFixed(2));
    balance = Number((balance + profitUsd).toFixed(2));
    if (balance > peakEquity) peakEquity = balance;
    const dd = peakEquity > 0 ? ((peakEquity - balance) / peakEquity) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;

    const digits = inferCryptoDigits(openPos.entryPrice);
    trades.push({
      type: openPos.type,
      symbol: binSym,
      qty: openPos.qty,
      marginUsed: openPos.marginUsed,
      marginPct: openPos.marginPct,
      entryPrice: rndPrice(openPos.entryPrice, digits),
      exitPrice: rndPrice(exitPrice, digits),
      slPrice: rndPrice(openPos.initialSlPrice, digits),
      tpPrice: rndPrice(openPos.tpPrice, digits),
      targetRrr: openPos.targetRrr,
      achievedRrr: Number((delta / openPos.slDist).toFixed(2)),
      profitUsd,
      profitPercent: profitPct,
      breakevenTriggered: openPos.breakevenApplied,
      sessionLabel: openPos.sessionLabel,
      reason: "OPEN_END",
      entryTime: new Date(openPos.entryTimeMs).toISOString(),
      exitTime: new Date(lastBar.time).toISOString(),
    });
    equityCurve.push({ time: new Date(lastBar.time).toISOString(), balance });
  }

  const wins = trades.filter((t) => t.profitUsd > 0).length;
  const losses = trades.filter((t) => t.profitUsd < 0).length;
  const breakevens = trades.filter((t) => t.reason === "BREAKEVEN_LOCKED").length;
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
