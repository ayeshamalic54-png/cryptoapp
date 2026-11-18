import React, { useState, useEffect, useMemo, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, formatPktTime, formatCryptoPrice, formatUsdt, inferCryptoDecimals } from "@/lib/utils";
import {
  CheckCircle2,
  Clock,
  Shield,
  Target,
  Zap,
  Layers,
  Activity,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  BarChart2,
  Tv,
} from "lucide-react";

interface SmcChartOverlayProps {
  symbol: string;
  telemetry: any;
  currentPrice?: number;
  activePosition?: any;
  activeZones?: Array<{ type: string; label: string; range: string }>;
  accountMode?: string;
  leverage?: number;
}

let tvScriptLoadingPromise: Promise<void> | null = null;

function TradingViewEmbedded({ symbol }: { symbol: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  const mapSymbolToTV = (sym: string): string => {
    const s = sym.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const clean = s.endsWith("USDT") ? s : s.endsWith("USD") ? `${s}T` : `${s}USDT`;
    return `BINANCE:${clean}.P`;
  };

  const tvSymbol = mapSymbolToTV(symbol);

  useEffect(() => {
    if (!tvScriptLoadingPromise) {
      tvScriptLoadingPromise = new Promise((resolve) => {
        const existing = document.getElementById("tradingview-widget-loading-script");
        if (existing) {
          resolve();
          return;
        }
        const script = document.createElement("script");
        script.id = "tradingview-widget-loading-script";
        script.src = "https://s3.tradingview.com/tv.js";
        script.type = "text/javascript";
        script.onload = () => resolve();
        document.head.appendChild(script);
      });
    }

    tvScriptLoadingPromise.then(() => {
      if (containerRef.current && typeof (window as any).TradingView !== "undefined") {
        containerRef.current.innerHTML = "";
        const widgetId = `tv_crypto_embed_${symbol.replace(/[^a-zA-Z0-9]/g, "_")}`;
        const widgetEl = document.createElement("div");
        widgetEl.id = widgetId;
        widgetEl.style.height = "560px";
        widgetEl.style.width = "100%";
        containerRef.current.appendChild(widgetEl);

        new (window as any).TradingView.widget({
          autosize: true,
          symbol: tvSymbol,
          interval: "5",
          timezone: "Asia/Karachi",
          theme: "dark",
          style: "1",
          locale: "en",
          toolbar_bg: "#090d16",
          enable_publishing: false,
          hide_side_toolbar: false,
          allow_symbol_change: true,
          container_id: widgetId,
        });
      }
    });
  }, [symbol, tvSymbol]);

  return (
    <div className="w-full bg-[#070a12] overflow-hidden">
      <div ref={containerRef} className="h-[560px] w-full" />
    </div>
  );
}

interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  isBullish: boolean;
  volume: number;
  isSweep?: boolean;
  isChoch?: boolean;
  isRetest?: boolean;
  isRejection?: boolean;
}

export function SmcChartOverlay({
  symbol,
  telemetry,
  currentPrice,
  activePosition,
  activeZones = [],
  accountMode = "PROP_FIRM",
  leverage = 5,
}: SmcChartOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(1000);
  const [activeTab, setActiveTab] = useState<"smc" | "tv">("smc");
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(1.0);

  useEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth;
        if (w > 0) setContainerWidth(w);
      }
    };
    updateSize();
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setContainerWidth(Math.round(entry.contentRect.width));
        }
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const isMobile = containerWidth < 640;

  // Extract 9-Step SMC telemetry cleanly
  const sweepPrice = Number(telemetry?.sweep_price ?? telemetry?.sweepPrice ?? 0);
  const chochPrice = Number(telemetry?.choch_price ?? telemetry?.chochPrice ?? 0);
  const rawM15Bias = String(telemetry?.m15_bias ?? telemetry?.m15Bias ?? "NEUTRAL ⚪").toUpperCase();
  const sweepStatus = String(telemetry?.sweep_status ?? telemetry?.sweepStatus ?? "FAIL ⚪");
  const chochStatus = String(telemetry?.choch_status ?? telemetry?.chochStatus ?? "FAIL ⚪");
  const fvgStatus = String(telemetry?.fvg_status ?? telemetry?.fvgStatus ?? "FAIL ⚪");
  const retestStatus = String(telemetry?.retest_status ?? telemetry?.retestStatus ?? "FAIL ⚪");
  const s6Status = String(telemetry?.s6_status ?? telemetry?.s6Status ?? "FAIL ⚪");
  const s7Status = String(telemetry?.s7_status ?? telemetry?.s7Status ?? "FAIL ⚪");
  const s8Status = String(telemetry?.s8_status ?? telemetry?.s8Status ?? "");
  const s9Status = String(telemetry?.s9_status ?? telemetry?.s9Status ?? "");
  const action = String(telemetry?.action ?? "NONE").toUpperCase();

  const isPassText = (val: string) =>
    typeof val === "string" && (val.includes("PASS") || val.includes("🟢"));

  const isM15Bullish = rawM15Bias.includes("BULLISH");
  const isM15Bearish = rawM15Bias.includes("BEARISH");
  const hasActivePosition = Boolean(activePosition && (activePosition.ticket || activePosition.entry || activePosition.entryPrice));
  const isActiveSmcTrade = hasActivePosition && String(activePosition?.comment ?? "SMC").toUpperCase().includes("SMC");

  const s1Pass = isActiveSmcTrade || ((isM15Bullish || isM15Bearish) && !rawM15Bias.includes("NEUTRAL"));
  const s2Pass = isActiveSmcTrade || (s1Pass && isPassText(sweepStatus));
  const s3Pass = isActiveSmcTrade || (s2Pass && isPassText(chochStatus));
  const s4Pass = isActiveSmcTrade || (s3Pass && isPassText(fvgStatus));
  const s5Pass = isActiveSmcTrade || (s4Pass && isPassText(retestStatus));
  const s6Pass = isActiveSmcTrade || (s5Pass && isPassText(s6Status));
  const s7Pass = isActiveSmcTrade || (s6Pass && isPassText(s7Status));
  const s8Pass = isPassText(s8Status) || (hasActivePosition && s2Pass);
  const s9Pass = isPassText(s9Status) || (hasActivePosition && s7Pass);
  const isSignalFired = (action === "BUY" || action === "SELL") && s7Pass && s8Pass && s9Pass;
  const isTradeActive = hasActivePosition || isSignalFired;

  const passedCount = [s1Pass, s2Pass, s3Pass, s4Pass, s5Pass, s6Pass, s7Pass, s8Pass, s9Pass].filter(Boolean).length;

  const tradeDirection = hasActivePosition
    ? String(activePosition.type || activePosition.orderType || "BUY").toUpperCase()
    : action !== "NONE"
    ? action
    : isM15Bullish
    ? "BUY"
    : isM15Bearish
    ? "SELL"
    : "NONE";

  const isBullishSetup = tradeDirection === "BUY" || isM15Bullish;
  const isBearishSetup = tradeDirection === "SELL" || isM15Bearish;

  // Resolve live coin price from prop or telemetry candles
  const livePrice = useMemo(() => {
    if (currentPrice && currentPrice > 0) return Number(currentPrice);
    try {
      const rawJson = telemetry?.fvg_bounds_json ?? telemetry?.fvgBoundsJson;
      if (rawJson) {
        const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
        if (Array.isArray(parsed?.candles) && parsed.candles.length > 0) {
          const c = Number(parsed.candles[parsed.candles.length - 1]?.close ?? 0);
          if (c > 0) return c;
        }
      }
    } catch {}
    if (sweepPrice > 0) return sweepPrice;
    return 0;
  }, [currentPrice, telemetry, sweepPrice]);

  // Dynamic coin-scaled geometry constants (identical ratios on BTC $64k & DOGE $0.059)
  const scaleRef = livePrice > 0 ? livePrice : 1;
  const defaultBuf = scaleRef * 0.0008; // 0.08% sweep buffer
  const frontRunBuf = scaleRef * 0.0006; // 0.06% opposing liquidity buffer
  const maxZoneDist = scaleRef * 0.04; // 4.0% proximity filter
  const dupTol = scaleRef * 0.00035;
  const digits = inferCryptoDecimals(scaleRef);
  const fmtP = (v: number) => Number(v || 0).toFixed(digits);

  const effectiveEntryPrice = useMemo(() => {
    if (hasActivePosition && (activePosition.entry || activePosition.entryPrice)) {
      return Number(activePosition.entry || activePosition.entryPrice);
    }
    return livePrice;
  }, [hasActivePosition, activePosition, livePrice]);

  const effectiveSlPrice = useMemo(() => {
    if (hasActivePosition && activePosition && (Number(activePosition.sl) > 0 || Number(activePosition.slPrice) > 0)) {
      return Number(activePosition.sl || activePosition.slPrice);
    }
    try {
      const rawJson = telemetry?.fvg_bounds_json ?? telemetry?.fvgBoundsJson;
      if (rawJson) {
        const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
        if (parsed?.sl_price && Number(parsed.sl_price) > 0) return Number(parsed.sl_price);
      }
    } catch {}
    if (sweepPrice > 0 && Math.abs(effectiveEntryPrice - sweepPrice) >= scaleRef * 0.0005) {
      return isBearishSetup ? sweepPrice + defaultBuf : sweepPrice - defaultBuf;
    }
    const estSlDist = scaleRef * 0.006;
    return isBearishSetup ? effectiveEntryPrice + estSlDist : effectiveEntryPrice - estSlDist;
  }, [hasActivePosition, activePosition, telemetry, sweepPrice, effectiveEntryPrice, scaleRef, isBearishSetup, defaultBuf]);

  const effectiveTpPrice = useMemo(() => {
    if (hasActivePosition && activePosition && (Number(activePosition.tp) > 0 || Number(activePosition.tpPrice) > 0)) {
      return Number(activePosition.tp || activePosition.tpPrice);
    }
    try {
      const rawJson = telemetry?.fvg_bounds_json ?? telemetry?.fvgBoundsJson;
      if (rawJson) {
        const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
        if (parsed?.opposing_tp && Number(parsed.opposing_tp) > 0) return Number(parsed.opposing_tp);
        if (parsed?.tp_price && Number(parsed.tp_price) > 0) return Number(parsed.tp_price);
      }
    } catch {}

    let swLo = 0;
    let swHi = 0;
    try {
      const rawJson = telemetry?.fvg_bounds_json ?? telemetry?.fvgBoundsJson;
      const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
      const cArr = Array.isArray(telemetry?.candles) ? telemetry.candles : parsed?.candles;
      if (Array.isArray(cArr) && cArr.length > 2) {
        const slc = cArr.slice(0, -1);
        swHi = Math.max(...slc.map((c: any) => Number(c.high || 0)));
        swLo = Math.min(...slc.filter((c: any) => Number(c.low) > 0).map((c: any) => Number(c.low)));
      }
    } catch {}
    if (isBearishSetup && swLo > 0 && swLo < effectiveEntryPrice) {
      return swLo + frontRunBuf;
    }
    if (isBullishSetup && swHi > 0 && swHi > effectiveEntryPrice) {
      return swHi - frontRunBuf;
    }
    const slDist = Math.max(scaleRef * 0.003, Math.abs(effectiveEntryPrice - effectiveSlPrice));
    return isBearishSetup ? effectiveEntryPrice - 2.0 * slDist : effectiveEntryPrice + 2.0 * slDist;
  }, [hasActivePosition, activePosition, telemetry, isBearishSetup, isBullishSetup, effectiveEntryPrice, effectiveSlPrice, frontRunBuf, scaleRef]);

  const effectiveRrr = useMemo(() => {
    const slDist = Math.abs(effectiveEntryPrice - effectiveSlPrice);
    if (slDist <= scaleRef * 1e-6) return 2.0;
    const tpDist = Math.abs(effectiveTpPrice - effectiveEntryPrice);
    return Number((tpDist / slDist).toFixed(2));
  }, [effectiveEntryPrice, effectiveSlPrice, effectiveTpPrice, scaleRef]);

  const entryPrice = effectiveEntryPrice;
  const slPrice = effectiveSlPrice;
  const tpPrice = effectiveTpPrice;

  // Wheel Zoom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const zoomStep = 0.25;
      if (e.deltaY < 0) setZoomLevel((prev) => Math.min(3.5, Number((prev + zoomStep).toFixed(2))));
      else setZoomLevel((prev) => Math.max(0.4, Number((prev - zoomStep).toFixed(2))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Extract Live Binance M5 Candlesticks from Telemetry
  const realCandles = useMemo<Candle[] | null>(() => {
    try {
      let rawList: any[] | null = null;
      if (Array.isArray(telemetry?.candles) && telemetry.candles.length >= 8) {
        rawList = telemetry.candles;
      } else {
        const rawJson = telemetry?.fvg_bounds_json ?? telemetry?.fvgBoundsJson;
        if (rawJson) {
          const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
          if (Array.isArray(parsed?.candles) && parsed.candles.length >= 8) {
            rawList = parsed.candles;
          }
        }
      }
      if (!rawList || rawList.length < 8) return null;

      const maxCount = isMobile
        ? Math.max(12, Math.min(36, Math.round(18 / zoomLevel)))
        : Math.max(16, Math.min(50, Math.round(34 / zoomLevel)));
      const sliced = rawList.slice(-maxCount);

      const mapped: Candle[] = sliced.map((c, i) => {
        const isLast = i === sliced.length - 1;
        const openP = Number(c.open);
        const closeP = isLast && livePrice > 0 ? livePrice : Number(c.close);
        const highP = isLast && livePrice > 0 ? Math.max(Number(c.high), livePrice) : Number(c.high);
        const lowP = isLast && livePrice > 0 ? Math.min(Number(c.low), livePrice) : Number(c.low);
        return {
          time: c.time || "",
          open: openP,
          high: highP,
          low: lowP,
          close: closeP,
          isBullish: closeP >= openP,
          volume: Number(c.volume || 100),
          isSweep: Boolean(c.isSweep),
          isChoch: Boolean(c.isChoch),
          isRetest: Boolean(c.isRetest),
          isRejection: Boolean(c.isRejection),
        };
      });

      const matchTol = scaleRef * 0.005;
      if (s2Pass && sweepPrice > 0 && !mapped.some((c) => c.isSweep)) {
        let bestIdx = -1;
        let bestDiff = Infinity;
        mapped.forEach((c, idx) => {
          const diff = Math.abs((isBullishSetup ? c.low : c.high) - sweepPrice);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = idx;
          }
        });
        if (bestIdx >= 0 && bestDiff < matchTol) mapped[bestIdx]!.isSweep = true;
      }
      if (s3Pass && chochPrice > 0 && !mapped.some((c) => c.isChoch)) {
        let bestIdx = -1;
        let bestDiff = Infinity;
        mapped.forEach((c, idx) => {
          const diff = Math.abs((isBullishSetup ? c.high : c.low) - chochPrice);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = idx;
          }
        });
        if (bestIdx >= 0 && bestDiff < matchTol) mapped[bestIdx]!.isChoch = true;
      }

      return mapped;
    } catch {
      return null;
    }
  }, [telemetry, livePrice, zoomLevel, isMobile, s2Pass, s3Pass, sweepPrice, chochPrice, isBullishSetup, scaleRef]);

  // Strictly real Binance Futures M5 candlesticks ONLY (never synthetic/fake fallback bars)
  const candles = useMemo<Candle[]>(() => {
    return realCandles ?? [];
  }, [realCandles]);

  const shouldShowTradeLevels = isTradeActive || s7Pass;

  // Parse ALL 4 Crypto SMC Zone Types (FVG, iFVG, OB, BREAKER) cleanly without dropping USDT coins!
  const parsedActiveZones = useMemo(() => {
    if (!activeZones || activeZones.length === 0) return [];
    const list: Array<{ type: string; name: string; isBullish: boolean; low: number; high: number; label: string }> = [];
    const seenRanges: string[] = [];

    const getCategory = (typeStr: string, labelStr: string) => {
      const u = `${typeStr} ${labelStr}`.toUpperCase();
      if (u.includes("IFVG")) return "IFVG";
      if (u.includes("BREAKER")) return "BREAKER";
      if (u.includes("OB")) return "OB";
      return "FVG";
    };

    for (const z of activeZones) {
      if (!z.range) continue;
      // Only match zones belonging to currently viewed symbol if label specifies a coin
      const uLabel = String(z.label || "").toUpperCase();
      const symU = symbol.toUpperCase();
      if (uLabel.includes("USDT") && !uLabel.includes(symU)) continue;

      const parts = z.range.split(/[\u2013\-]/);
      if (parts.length >= 2) {
        const low = parseFloat(parts[0]!.replace(/,/g, "").trim());
        const high = parseFloat(parts[1]!.replace(/,/g, "").trim());
        if (!isNaN(low) && !isNaN(high) && high > low) {
          const mid = (low + high) / 2;
          if (livePrice > 0 && Math.abs(mid - livePrice) > maxZoneDist) continue;

          const cat = getCategory(z.type || "", z.label || "");
          const isDup = seenRanges.some((r) => {
            const [rCat, rL, rH] = r.split(":");
            return rCat === cat && Math.abs(Number(rL) - low) < dupTol && Math.abs(Number(rH) - high) < dupTol;
          });
          if (isDup) continue;
          seenRanges.push(`${cat}:${low}:${high}`);

          const isBullish = z.type.toUpperCase().includes("BULLISH") || uLabel.includes("🟢");
          const name = z.type.replace("BULLISH_", "").replace("BEARISH_", "");
          list.push({ type: z.type, name, isBullish, low, high, label: z.label });
        }
      }
    }

    // Prioritize closest zones to live price so on-chart FVG/iFVG/OB/BREAKER are always visible
    if (livePrice > 0) {
      list.sort((a, b) => Math.abs((a.low + a.high) / 2 - livePrice) - Math.abs((b.low + b.high) / 2 - livePrice));
    }

    const picked: typeof list = [];
    const pickedKeys = new Set<string>();
    for (const cat of ["IFVG", "BREAKER", "OB", "FVG"]) {
      const match = list.find((item) => getCategory(item.type, item.label) === cat);
      if (match) {
        const key = `${match.type}:${match.low}:${match.high}`;
        picked.push(match);
        pickedKeys.add(key);
      }
    }
    for (const item of list) {
      if (picked.length >= 5) break;
      const key = `${item.type}:${item.low}:${item.high}`;
      if (!pickedKeys.has(key)) {
        picked.push(item);
        pickedKeys.add(key);
      }
    }
    return picked;
  }, [activeZones, symbol, livePrice, maxZoneDist, dupTol]);

  const fvgBounds = useMemo(() => {
    try {
      const rawJson = telemetry?.fvg_bounds_json ?? telemetry?.fvgBoundsJson;
      if (rawJson) {
        const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
        if (typeof parsed === "object" && parsed !== null) {
          const list = isBullishSetup ? parsed.bullish_fvg || [] : parsed.bearish_fvg || [];
          for (const item of [...list].reverse()) {
            if (Array.isArray(item) && item.length >= 2) {
              const l = Number(item[0]);
              const h = Number(item[1]);
              if (h > l && Math.abs((l + h) / 2 - livePrice) <= maxZoneDist) {
                return { low: l, high: h, label: "DISPLACEMENT FVG" };
              }
            }
          }
        }
      }
    } catch {}
    const fvgZ = parsedActiveZones.find((z) => z.type.toUpperCase().includes("FVG") && !z.type.toUpperCase().includes("IFVG"));
    if (fvgZ) return { low: fvgZ.low, high: fvgZ.high, label: fvgZ.label };
    return null;
  }, [telemetry, parsedActiveZones, livePrice, isBullishSetup, maxZoneDist]);

  const swingStructure = useMemo(() => {
    if (!candles || candles.length < 5) return { swingHigh: 0, swingLow: 0, chochLvl: 0 };
    const completed = candles.slice(0, -1);
    const highest = Math.max(...completed.map((c) => c.high));
    const lowest = Math.min(...completed.map((c) => c.low));
    const swingHigh = sweepPrice > 0 && isBearishSetup ? sweepPrice : highest;
    const swingLow = sweepPrice > 0 && isBullishSetup ? sweepPrice : lowest;
    const chochLvl =
      chochPrice > 0
        ? chochPrice
        : isBullishSetup
        ? swingLow + (highest - swingLow) * 0.45
        : swingHigh - (swingHigh - lowest) * 0.45;
    return { swingHigh, swingLow, chochLvl };
  }, [candles, sweepPrice, chochPrice, isBullishSetup, isBearishSetup]);

  const svgWidth = Math.max(320, containerWidth);
  const svgHeight = isMobile ? 440 : 475;
  const chartLeft = isMobile ? 6 : 20;
  const rightTagWidth = isMobile ? 112 : 160;
  const chartRight = svgWidth - (rightTagWidth + 6);
  const zoneDockWidth = isMobile ? 114 : 168;
  // Reserve dedicated right margin lane between latest candle & price axis so FVG/iFVG/OB/BREAKER labels NEVER cover candlesticks
  const candlesRight = Math.max(chartLeft + 140, chartRight - zoneDockWidth - 10);
  const chartTop = isMobile ? 16 : 25;
  const chartBottom = svgHeight - (isMobile ? 26 : 35);
  const plotWidth = Math.max(100, candlesRight - chartLeft);
  const plotHeight = Math.max(100, chartBottom - chartTop);

  const showSlLevel = isTradeActive;
  const showTpLevel = isTradeActive;
  const showEntryLevel = isTradeActive;

  const candleMin =
    candles.length > 0 ? Math.min(...candles.map((c) => c.low), ...(livePrice > 0 ? [livePrice] : [])) : 0;
  const candleMax =
    candles.length > 0 ? Math.max(...candles.map((c) => c.high), ...(livePrice > 0 ? [livePrice] : [])) : 1;
  const candleSpan = Math.max(scaleRef * 0.0005, candleMax - candleMin);
  const vertPad = candleSpan * 0.16;

  const minPrice = useMemo(() => {
    let min = candleMin - vertPad;
    const pad = candleSpan * 0.08;
    if (isTradeActive && effectiveEntryPrice > 0) min = Math.min(min, effectiveEntryPrice - pad);
    if (showSlLevel && effectiveSlPrice > 0 && candleMin - effectiveSlPrice <= candleSpan * 4.0) min = Math.min(min, effectiveSlPrice - pad);
    if (showTpLevel && effectiveTpPrice > 0 && candleMin - effectiveTpPrice <= candleSpan * 4.0) min = Math.min(min, effectiveTpPrice - pad);
    if (swingStructure.swingLow > 0 && candleMin - swingStructure.swingLow <= candleSpan * 1.3) min = Math.min(min, swingStructure.swingLow - pad);
    return min;
  }, [candleMin, vertPad, candleSpan, isTradeActive, effectiveEntryPrice, showSlLevel, effectiveSlPrice, showTpLevel, effectiveTpPrice, swingStructure.swingLow]);

  const maxPrice = useMemo(() => {
    let max = candleMax + vertPad;
    const pad = candleSpan * 0.08;
    if (isTradeActive && effectiveEntryPrice > 0) max = Math.max(max, effectiveEntryPrice + pad);
    if (showTpLevel && effectiveTpPrice > 0 && effectiveTpPrice - candleMax <= candleSpan * 4.0) max = Math.max(max, effectiveTpPrice + pad);
    if (showSlLevel && effectiveSlPrice > 0 && effectiveSlPrice - candleMax <= candleSpan * 4.0) max = Math.max(max, effectiveSlPrice + pad);
    if (swingStructure.swingHigh > 0 && swingStructure.swingHigh - candleMax <= candleSpan * 1.3) max = Math.max(max, swingStructure.swingHigh + pad);
    return max;
  }, [candleMax, vertPad, candleSpan, isTradeActive, effectiveEntryPrice, showTpLevel, effectiveTpPrice, showSlLevel, effectiveSlPrice, swingStructure.swingHigh]);

  const priceRange = Math.max(scaleRef * 1e-6, maxPrice - minPrice);

  const getY = (priceVal: number) => {
    const clamped = Math.max(minPrice, Math.min(maxPrice, priceVal));
    return chartBottom - ((clamped - minPrice) / priceRange) * plotHeight;
  };

  const candleSpacing = plotWidth / Math.max(1, candles.length);
  const candleBodyWidth = Math.max(isMobile ? 9 : 13, Math.min(isMobile ? 24 : 38, candleSpacing * 0.74));

  // Structural Zigzag HH / HL / LH / LL
  const marketStructure = useMemo(() => {
    if (!candles || candles.length < 5) return { swings: [], path: "" };
    const swings: Array<{ idx: number; price: number; type: "HH" | "HL" | "LH" | "LL"; x: number; y: number; isHigh: boolean }> = [];
    const minAmp = scaleRef * 0.0012;

    for (let i = 2; i < candles.length - 2; i++) {
      const curr = candles[i]!;
      const cx = chartLeft + (i + 0.5) * candleSpacing;
      let isHigh = true;
      let isLow = true;
      for (let j = 1; j <= 2; j++) {
        if (candles[i - j]!.high > curr.high || candles[i + j]!.high > curr.high) isHigh = false;
        if (candles[i - j]!.low < curr.low || candles[i + j]!.low < curr.low) isLow = false;
      }
      if (isHigh) {
        const localMin = Math.min(...candles.slice(Math.max(0, i - 4), Math.min(candles.length, i + 5)).map((c) => c.low));
        if (curr.high - localMin < minAmp) isHigh = false;
      }
      if (isLow) {
        const localMax = Math.max(...candles.slice(Math.max(0, i - 4), Math.min(candles.length, i + 5)).map((c) => c.high));
        if (localMax - curr.low < minAmp) isLow = false;
      }
      if (isHigh && !isLow) {
        const prevH = [...swings].reverse().find((s) => s.isHigh);
        const tag: "HH" | "LH" = prevH ? (curr.high >= prevH.price ? "HH" : "LH") : isBullishSetup ? "HH" : "LH";
        const last = swings[swings.length - 1];
        if (last && last.isHigh) {
          if (curr.high > last.price) swings[swings.length - 1] = { idx: i, price: curr.high, type: tag, x: cx, y: getY(curr.high), isHigh: true };
        } else {
          swings.push({ idx: i, price: curr.high, type: tag, x: cx, y: getY(curr.high), isHigh: true });
        }
      } else if (isLow && !isHigh) {
        const prevL = [...swings].reverse().find((s) => !s.isHigh);
        const tag: "HL" | "LL" = prevL ? (curr.low <= prevL.price ? "LL" : "HL") : isBullishSetup ? "HL" : "LL";
        const last = swings[swings.length - 1];
        if (last && !last.isHigh) {
          if (curr.low < last.price) swings[swings.length - 1] = { idx: i, price: curr.low, type: tag, x: cx, y: getY(curr.low), isHigh: false };
        } else {
          swings.push({ idx: i, price: curr.low, type: tag, x: cx, y: getY(curr.low), isHigh: false });
        }
      }
    }
    const path = swings.length >= 2 ? swings.map((s, idx) => `${idx === 0 ? "M" : "L"} ${s.x.toFixed(1)} ${s.y.toFixed(1)}`).join(" ") : "";
    return { swings, path };
  }, [candles, candleSpacing, chartLeft, scaleRef, isBullishSetup, minPrice, maxPrice, priceRange, plotHeight, chartBottom]);

  const candleMilestones = useMemo(() => {
    const count = candles.length;
    const dSw = Math.max(2, Math.floor(count * 0.35));
    const dCh = Math.max(dSw + 2, Math.floor(count * 0.55));
    const dRe = Math.max(dCh + 2, Math.floor(count * 0.72));
    const dRj = Math.max(dRe + 1, Math.min(count - 2, Math.floor(count * 0.86)));
    const sIdx = candles.findIndex((c) => c.isSweep);
    const cIdx = candles.findIndex((c) => c.isChoch);
    const rIdx = candles.findIndex((c) => c.isRetest);
    const jIdx = candles.findIndex((c) => c.isRejection);
    const sweep = sIdx >= 0 ? sIdx : dSw;
    const choch = cIdx >= 0 ? cIdx : dCh;
    const retest = rIdx >= 0 ? rIdx : dRe;
    const rejection = jIdx >= 0 ? jIdx : dRj;
    const entry = isTradeActive || s7Pass ? rejection : s5Pass ? retest : choch;
    return { sweep, choch, retest, rejection, entry };
  }, [candles, isTradeActive, s7Pass, s5Pass]);

  const renderedSmcZones = useMemo(() => {
    const rawList: any[] = [];
    const findOrigin = (zLow: number, zHigh: number, type: string) => {
      const u = type.toUpperCase();
      if (u.includes("OB")) {
        for (let k = Math.max(0, candleMilestones.sweep - 3); k <= candleMilestones.sweep; k++) {
          if (candles[k] && candles[k]!.high >= zLow && candles[k]!.low <= zHigh) return k;
        }
      }
      for (let k = 0; k < candles.length - 1; k++) {
        if (candles[k]!.high >= zLow && candles[k]!.low <= zHigh) return k;
      }
      return Math.max(0, Math.min(candles.length - 2, candleMilestones.choch));
    };

    const isVisibleInPlot = (low: number, high: number) =>
      high >= minPrice - candleSpan * 0.15 && low <= maxPrice + candleSpan * 0.15;

    const badgeW = Math.max(96, chartRight - candlesRight - 14);
    const badgeH = 18;
    const zoneDockX = candlesRight + 10;

    if (fvgBounds && fvgBounds.high > fvgBounds.low && isVisibleInPlot(fvgBounds.low, fvgBounds.high)) {
      const originIdx = findOrigin(fvgBounds.low, fvgBounds.high, "FVG");
      const originX = chartLeft + (originIdx + 0.5) * candleSpacing;
      const topY = Math.max(chartTop + 2, getY(fvgBounds.high));
      const botY = Math.min(chartBottom - 2, getY(fvgBounds.low));
      const boxHeight = Math.max(10, Math.abs(botY - topY));
      const centerY = Math.max(chartTop + badgeH / 2 + 4, Math.min(chartBottom - badgeH / 2 - 4, (topY + botY) / 2));
      rawList.push({
        id: "fvg-primary",
        type: "FVG",
        low: fvgBounds.low,
        high: fvgBounds.high,
        originIdx,
        originX,
        topY,
        botY,
        centerY,
        boxHeight,
        boxWidth: Math.max(candleSpacing * 2, candlesRight + 4 - originX),
        badgeX: zoneDockX,
        badgeY: centerY - badgeH / 2,
        badgeWidth: badgeW,
        badgeHeight: badgeH,
        badgeBg: s5Pass ? "#064e3b" : "#0f172a",
        badgeStroke: s5Pass ? "#10b981" : isBullishSetup ? "#10b981" : "#f43f5e",
        badgeTextColor: "#ffffff",
        boxFill: "url(#fvgGradientZone)",
        boxStroke: s5Pass ? "#10b981" : isBullishSetup ? "#10b981" : "#f43f5e",
        strokeDash: s5Pass ? "none" : "4 4",
        strokeWidth: s5Pass ? 1.8 : 1.1,
        badgeTitle: s5Pass ? "S5 FVG" : s4Pass ? "S4 FVG" : "FVG",
        badgeSub: `${fmtP(fvgBounds.low)}-${fmtP(fvgBounds.high)}`,
        isPrimaryFvg: true,
      });
    }

    parsedActiveZones.forEach((z, idx) => {
      if (rawList.length >= 5) return;
      if (!isVisibleInPlot(z.low, z.high)) return;
      const isOB = z.type.toUpperCase().includes("OB");
      const isBreaker = z.type.toUpperCase().includes("BREAKER");
      const isIFVG = z.type.toUpperCase().includes("IFVG");
      if (!isOB && !isBreaker && !isIFVG && fvgBounds && Math.abs(fvgBounds.low - z.low) < dupTol) return;

      const originIdx = findOrigin(z.low, z.high, z.type);
      const originX = chartLeft + (originIdx + 0.5) * candleSpacing;
      const topY = Math.max(chartTop + 2, getY(z.high));
      const botY = Math.min(chartBottom - 2, getY(z.low));
      const boxHeight = Math.max(8, Math.abs(botY - topY));
      const centerY = Math.max(chartTop + badgeH / 2 + 4, Math.min(chartBottom - badgeH / 2 - 4, (topY + botY) / 2));

      let boxFill = "rgba(6, 182, 212, 0.05)";
      let boxStroke = "#06b6d4";
      let badgeBg = "#083344";
      let strokeDash = "4 3";
      if (isOB) {
        boxFill = z.isBullish ? "rgba(59, 130, 246, 0.05)" : "rgba(168, 85, 247, 0.05)";
        boxStroke = z.isBullish ? "#3b82f6" : "#a855f7";
        badgeBg = z.isBullish ? "#172554" : "#3b0764";
        strokeDash = "none";
      } else if (isBreaker) {
        boxFill = "rgba(245, 158, 11, 0.05)";
        boxStroke = "#f59e0b";
        badgeBg = "#451a03";
        strokeDash = "5 3";
      } else if (isIFVG) {
        boxFill = "rgba(34, 211, 238, 0.05)";
        boxStroke = "#22d3ee";
        badgeBg = "#083344";
        strokeDash = "3 3";
      }

      const shortName = isOB ? "OB" : isBreaker ? "BREAKER" : isIFVG ? "iFVG" : "FVG";
      rawList.push({
        id: `pz-${idx}`,
        low: z.low,
        high: z.high,
        originIdx,
        originX,
        topY,
        botY,
        centerY,
        boxHeight,
        boxWidth: Math.max(candleSpacing * 2, candlesRight + 4 - originX),
        badgeX: zoneDockX,
        badgeY: centerY - badgeH / 2,
        badgeWidth: badgeW,
        badgeHeight: badgeH,
        badgeBg,
        badgeStroke: boxStroke,
        badgeTextColor: "#ffffff",
        boxFill,
        boxStroke,
        strokeDash,
        strokeWidth: 1.1,
        badgeTitle: shortName,
        badgeSub: `${fmtP(z.low)}-${fmtP(z.high)}`,
        isPrimaryFvg: false,
      });
    });

    // Strict bidirectional vertical anti-overlap pass so NO two zone badges ever collide or hide
    rawList.sort((a, b) => a.badgeY - b.badgeY);
    const minZoneBadgeGap = badgeH + 6;
    for (let i = 1; i < rawList.length; i++) {
      const prev = rawList[i - 1]!;
      const curr = rawList[i]!;
      if (curr.badgeY < prev.badgeY + minZoneBadgeGap) {
        curr.badgeY = prev.badgeY + minZoneBadgeGap;
      }
    }
    const maxYLimit = chartBottom - badgeH - 6;
    const minYLimit = chartTop + 6;
    if (rawList.length > 0 && rawList[rawList.length - 1]!.badgeY > maxYLimit) {
      rawList[rawList.length - 1]!.badgeY = maxYLimit;
      for (let i = rawList.length - 2; i >= 0; i--) {
        if (rawList[i]!.badgeY > rawList[i + 1]!.badgeY - minZoneBadgeGap) {
          rawList[i]!.badgeY = Math.max(minYLimit, rawList[i + 1]!.badgeY - minZoneBadgeGap);
        }
      }
    }
    return rawList;
  }, [candles, candleMilestones, fvgBounds, parsedActiveZones, chartLeft, chartRight, candlesRight, chartTop, chartBottom, candleSpacing, isMobile, isBullishSetup, s4Pass, s5Pass, dupTol, digits, minPrice, maxPrice, candleSpan]);

  const tagHeight = isMobile ? 16 : 18;
  const minTagGap = tagHeight + 2;

  const stackedTags = useMemo(() => {
    const list: Array<{ id: string; price: number; targetY: number; renderedY: number; bgFill: string; borderStroke: string; textColor: string; fontSize: string; label: string; priority: number }> = [];

    list.push({
      id: "live",
      price: livePrice,
      targetY: getY(livePrice),
      renderedY: getY(livePrice),
      bgFill: "#ffffff",
      borderStroke: "#94a3b8",
      textColor: "#000000",
      fontSize: isMobile ? "9" : "10.5",
      label: `LIVE $${fmtP(livePrice)}`,
      priority: 100,
    });

    if (showEntryLevel && effectiveEntryPrice > 0 && (isTradeActive || Math.abs(effectiveEntryPrice - livePrice) > scaleRef * 0.0005)) {
      list.push({
        id: "entry",
        price: effectiveEntryPrice,
        targetY: getY(effectiveEntryPrice),
        renderedY: getY(effectiveEntryPrice),
        bgFill: "#0284c7",
        borderStroke: "#38bdf8",
        textColor: "#ffffff",
        fontSize: isMobile ? "8.5" : "10",
        label: `ENTRY $${fmtP(effectiveEntryPrice)}`,
        priority: 92,
      });
    }

    if (swingStructure.chochLvl > 0) {
      list.push({
        id: "choch",
        price: swingStructure.chochLvl,
        targetY: getY(swingStructure.chochLvl),
        renderedY: getY(swingStructure.chochLvl),
        bgFill: s3Pass ? "#d97706" : "#78350f",
        borderStroke: s3Pass ? "#fde68a" : "#d97706",
        textColor: "#ffffff",
        fontSize: isMobile ? "8.5" : "10",
        label: `CHOCH $${fmtP(swingStructure.chochLvl)}`,
        priority: 95,
      });
    }

    if (showSlLevel && effectiveSlPrice > 0) {
      const isBe = isTradeActive && Math.abs(effectiveSlPrice - effectiveEntryPrice) <= effectiveEntryPrice * 0.002;
      list.push({
        id: "sl",
        price: effectiveSlPrice,
        targetY: getY(effectiveSlPrice),
        renderedY: getY(effectiveSlPrice),
        bgFill: isTradeActive ? "#dc2626" : "#7f1d1d",
        borderStroke: isTradeActive ? "#fca5a5" : "#b91c1c",
        textColor: "#ffffff",
        fontSize: isMobile ? "8.5" : "10",
        label: isBe ? `BE $${fmtP(effectiveSlPrice)}` : `SL $${fmtP(effectiveSlPrice)}`,
        priority: 88,
      });
    }

    if (showTpLevel && effectiveTpPrice > 0) {
      list.push({
        id: "tp",
        price: effectiveTpPrice,
        targetY: getY(effectiveTpPrice),
        renderedY: getY(effectiveTpPrice),
        bgFill: isTradeActive ? "#059669" : "#064e3b",
        borderStroke: isTradeActive ? "#6ee7b7" : "#059669",
        textColor: "#ffffff",
        fontSize: isMobile ? "8.5" : "10",
        label: `TP $${fmtP(effectiveTpPrice)}`,
        priority: 86,
      });
    }

    if (swingStructure.swingHigh > 0 && !list.some((t) => Math.abs(t.targetY - getY(swingStructure.swingHigh)) < minTagGap)) {
      const swept = s2Pass && isBearishSetup;
      list.push({
        id: "swHi",
        price: swingStructure.swingHigh,
        targetY: getY(swingStructure.swingHigh),
        renderedY: getY(swingStructure.swingHigh),
        bgFill: swept ? "#0891b2" : "#164e63",
        borderStroke: swept ? "#a5f3fc" : "#0891b2",
        textColor: "#ffffff",
        fontSize: isMobile ? "8.5" : "9.5",
        label: `${swept ? "SWEPT" : "SW HI"} $${fmtP(swingStructure.swingHigh)}`,
        priority: 50,
      });
    }

    if (swingStructure.swingLow > 0 && !list.some((t) => Math.abs(t.targetY - getY(swingStructure.swingLow)) < minTagGap)) {
      const swept = s2Pass && isBullishSetup;
      list.push({
        id: "swLo",
        price: swingStructure.swingLow,
        targetY: getY(swingStructure.swingLow),
        renderedY: getY(swingStructure.swingLow),
        bgFill: swept ? "#0891b2" : "#164e63",
        borderStroke: swept ? "#a5f3fc" : "#0891b2",
        textColor: "#ffffff",
        fontSize: isMobile ? "8.5" : "9.5",
        label: `${swept ? "SWEPT" : "SW LO"} $${fmtP(swingStructure.swingLow)}`,
        priority: 50,
      });
    }

    list.sort((a, b) => a.targetY - b.targetY);
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.renderedY < list[i - 1]!.renderedY + minTagGap) {
        list[i]!.renderedY = list[i - 1]!.renderedY + minTagGap;
      }
    }
    const botLimit = chartBottom - tagHeight / 2 - 2;
    const topLimit = chartTop + tagHeight / 2 + 2;
    if (list.length > 0 && list[list.length - 1]!.renderedY > botLimit) {
      const ov = list[list.length - 1]!.renderedY - botLimit;
      list.forEach((t) => (t.renderedY -= ov));
    }
    if (list.length > 0 && list[0]!.renderedY < topLimit) {
      const un = topLimit - list[0]!.renderedY;
      list.forEach((t) => (t.renderedY += un));
    }
    return list;
  }, [livePrice, showEntryLevel, effectiveEntryPrice, showSlLevel, effectiveSlPrice, showTpLevel, effectiveTpPrice, swingStructure, s2Pass, s3Pass, isTradeActive, isBullishSetup, isBearishSetup, isMobile, tagHeight, minTagGap, chartTop, chartBottom, digits, scaleRef]);

  const gridTicks = useMemo(() => {
    const ticks = [];
    const step = priceRange / 5;
    for (let i = 0; i <= 5; i++) {
      const p = minPrice + step * i;
      ticks.push({ price: p, y: getY(p) });
    }
    return ticks;
  }, [minPrice, priceRange]);

  const cursorPrice = useMemo(() => {
    if (!mousePos || mousePos.y < chartTop || mousePos.y > chartBottom) return null;
    return minPrice + ((chartBottom - mousePos.y) / plotHeight) * priceRange;
  }, [mousePos, minPrice, priceRange, plotHeight, chartTop, chartBottom]);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * svgWidth;
    const y = ((e.clientY - rect.top) / rect.height) * svgHeight;
    setMousePos({ x, y });
    if (x >= chartLeft && x <= candlesRight) {
      const idx = Math.floor((x - chartLeft) / candleSpacing);
      setHoveredCandle(candles[idx] ?? null);
    } else {
      setHoveredCandle(null);
    }
  };

  return (
    <div className="w-full space-y-4 font-sans select-none">
      {/* 1. MASTER CRYPTO FUTURES SMC HUD */}
      <div
        className={cn(
          "px-4 py-3 rounded-xl border transition-all duration-300 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-xl",
          isTradeActive
            ? "bg-emerald-950/40 border-emerald-500 text-emerald-100 shadow-[0_0_24px_rgba(16,185,129,0.3)]"
            : s1Pass
            ? "bg-[#101726] border-indigo-500/50 text-indigo-100"
            : "bg-[#0b0e14] border-zinc-800 text-zinc-300"
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-md shrink-0",
              isTradeActive ? "bg-emerald-500 text-black animate-pulse" : s1Pass ? "bg-amber-500 text-black" : "bg-zinc-800 text-zinc-300"
            )}
          >
            {isTradeActive ? <Zap className="w-5 h-5 text-black" /> : <Activity className="w-5 h-5" />}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-black uppercase tracking-wider text-white">
                {isTradeActive
                  ? `⚡ FUTURES ${tradeDirection === "BUY" ? "LONG" : "SHORT"} ACTIVE @ $${fmtP(entryPrice)}`
                  : s1Pass
                  ? `🔍 ${symbol} SETUP SCANNING — ${passedCount} / 9 SMC STEPS`
                  : `⚪ ${symbol} ORDER FLOW MONITORING`}
              </span>
              <Badge variant="outline" className="font-mono text-[10px] px-2 py-0.5 bg-sky-500/15 text-sky-300 border-sky-500/40">
                {accountMode === "PERSONAL" ? `PERSONAL ${leverage}x` : `BLUE GUARDIAN ${leverage}x`}
              </Badge>
            </div>
            <p className="text-xs text-zinc-300 mt-0.5">
              {isTradeActive
                ? `${tradeDirection === "BUY" ? "LONG" : "SHORT"} ${symbol} | SL: $${fmtP(slPrice)} | TP: $${fmtP(tpPrice)} (${effectiveRrr}R) ${
                    hasActivePosition && activePosition.profit !== undefined ? `| Float: ${formatUsdt(activePosition.profit, true)}` : ""
                  }`
                : !s1Pass
                ? "Step 1 PENDING ⚪: M15 Market Structure Neutral (Waiting for HH/HL or LH/LL)"
                : !s2Pass
                ? "Step 1 PASS 🟢 — Step 2 PENDING ⚪: Waiting for M5 Liquidity Sweep wick"
                : !s3Pass
                ? "Step 1-2 PASS 🟢 — Step 3 PENDING ⚪: Waiting for M5 CHoCH candle close break"
                : !s4Pass
                ? "Step 1-3 PASS 🟢 — Step 4 PENDING ⚪: Waiting for 3-Candle Displacement FVG"
                : !s5Pass
                ? "Step 1-4 PASS 🟢 — Step 5 PENDING ⚪: Waiting for Closed-Candle FVG Retest"
                : !s6Pass
                ? "Step 1-5 PASS 🟢 — Step 6 PENDING ⚪: Waiting for FVG Rejection Candle"
                : !s7Pass
                ? "Step 1-6 PASS 🟢 — Step 7 PENDING ⚪: Waiting for Closed Candle Confirmation"
                : !s8Pass
                ? "Step 1-7 PASS 🟢 — Step 8 PENDING 🔴: Structural SL cap / Liquidation safety guard"
                : !s9Pass
                ? "Step 1-8 PASS 🟢 — Step 9 BLOCKED 🔴: M15 Opposing Target < 1.85R"
                : "Steps 1-9 VERIFIED 🟢 — All Pure SMC Conditions Aligned!"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-end md:self-center font-mono text-xs">
          <div className="px-3 py-1 rounded bg-zinc-900 border border-zinc-700 text-white font-bold shadow-sm">
            Binance Futures: <span className="text-emerald-400 font-black">${fmtP(livePrice)}</span>
          </div>
          {sweepPrice > 0 && (
            <div className="px-3 py-1 rounded bg-cyan-950 border border-cyan-500 text-cyan-300 font-bold">
              Sweep: ${fmtP(sweepPrice)}
            </div>
          )}
          {chochPrice > 0 && (
            <div className="px-3 py-1 rounded bg-amber-950 border border-amber-500 text-amber-300 font-bold">
              CHoCH: ${fmtP(chochPrice)}
            </div>
          )}
          {isTradeActive ? (
            <>
              <div className="px-3 py-1 rounded font-black text-xs font-mono border bg-sky-950 border-sky-400 text-sky-200">
                Entry: ${fmtP(entryPrice)}
              </div>
              <div className="px-3 py-1 rounded font-black text-xs font-mono border bg-rose-950 border-rose-500 text-rose-200">
                SL: ${fmtP(slPrice)}
              </div>
              <div className="px-3 py-1 rounded font-black text-xs font-mono border bg-emerald-950 border-emerald-500 text-emerald-200">
                TP: ${fmtP(tpPrice)} ({effectiveRrr}R)
              </div>
            </>
          ) : (
            <div className="px-3 py-1 rounded font-bold text-xs font-mono border bg-zinc-900/70 border-zinc-700 text-zinc-400">
              Entry / SL / TP: Waiting 9/9 Steps ({passedCount}/9)
            </div>
          )}
        </div>
      </div>

      {/* 2. CHART MODE SWITCH & ZOOM */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-1">
        <div className="grid grid-cols-2 gap-1.5 sm:flex sm:items-center sm:gap-2">
          <Button
            size="sm"
            variant={activeTab === "smc" ? "default" : "outline"}
            className={cn("h-8 px-3 text-xs font-mono font-bold", activeTab === "smc" ? "bg-emerald-600 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-300")}
            onClick={() => setActiveTab("smc")}
          >
            <BarChart2 className="w-3.5 h-3.5 mr-1.5" /> 🎯 Pure SMC Canvas ({symbol})
          </Button>
          <Button
            size="sm"
            variant={activeTab === "tv" ? "default" : "outline"}
            className={cn("h-8 px-3 text-xs font-mono font-bold", activeTab === "tv" ? "bg-indigo-600 text-white" : "bg-zinc-900 border-zinc-700 text-zinc-300")}
            onClick={() => setActiveTab("tv")}
          >
            <Tv className="w-3.5 h-3.5 mr-1.5" /> 📈 TradingView Live (PKT)
          </Button>
        </div>

        {activeTab === "smc" && (
          <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg p-1 self-start sm:self-auto">
            <span className="text-xs font-mono font-bold text-zinc-300 px-2">Zoom: {Math.round(zoomLevel * 100)}%</span>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setZoomLevel((z) => Math.min(3.5, Number((z + 0.35).toFixed(2))))}>
              <ZoomIn className="w-4 h-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setZoomLevel((z) => Math.max(0.4, Number((z - 0.35).toFixed(2))))}>
              <ZoomOut className="w-4 h-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setZoomLevel(1.0)}>
              <RotateCcw className="w-3.5 h-3.5" />
            </Button>
          </div>
        )}
      </div>

      {/* 3. MAIN INTERACTIVE CHART CONTAINER */}
      <div ref={containerRef} className="relative w-full bg-[#070a12] border border-zinc-800 rounded-xl overflow-hidden shadow-2xl">
        {/* TOP 9-STEP SEQUENCE STRIP */}
        <div className="px-3 py-2.5 bg-[#090d18] border-b border-zinc-800 text-xs font-mono space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="font-bold text-white flex items-center gap-1.5 text-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                {symbol} PERPETUAL <span className="text-zinc-400 font-normal">Pure 9-Step SMC Sequence</span>
              </span>
              <Badge variant="outline" className={cn("text-[10px] px-2 py-0.5 font-bold", s1Pass && isM15Bullish ? "bg-emerald-500/20 text-emerald-300 border-emerald-500" : s1Pass && isM15Bearish ? "bg-rose-500/20 text-rose-300 border-rose-500" : "bg-zinc-800 text-zinc-300 border-zinc-700")}>
                M15 Bias: {rawM15Bias}
              </Badge>
              <Badge variant="outline" className="text-[10px] px-2 py-0.5 font-bold bg-cyan-500/20 text-cyan-300 border-cyan-500">
                {realCandles && realCandles.length >= 8 ? "⚡ BINANCE M5 LIVE" : "⏳ CONNECTING BINANCE M5"}
              </Badge>
            </div>
            <span className="font-black px-2 py-0.5 rounded bg-zinc-800 text-emerald-400 border border-zinc-700 text-[11px]">
              {isTradeActive ? "FUTURES TRADE ACTIVE 🟢" : `${passedCount} / 9 Verified`}
            </span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-1.5">
            {[
              { title: "1. M15 Bias", val: s1Pass ? (isM15Bullish ? "BULL 🟢" : "BEAR 🔴") : "NEUT ⚪", active: s1Pass, rose: s1Pass && isM15Bearish },
              { title: "2. Sweep", val: s2Pass ? "PASS 🟢" : s1Pass ? "SCAN ⏳" : "WAIT ⚪", active: s2Pass },
              { title: "3. CHoCH", val: s3Pass ? "PASS 🟢" : s2Pass ? "SCAN ⏳" : "WAIT ⚪", active: s3Pass },
              { title: "4. FVG", val: s4Pass ? "PASS 🟢" : s3Pass ? "SCAN ⏳" : "WAIT ⚪", active: s4Pass },
              { title: "5. Retest", val: s5Pass ? "PASS 🟢" : s4Pass ? "WAIT ⏳" : "WAIT ⚪", active: s5Pass },
              { title: "6. Reject", val: s6Pass ? "PASS 🟢" : s5Pass ? "WAIT ⏳" : "WAIT ⚪", active: s6Pass },
              { title: "7. Close", val: s7Pass ? "PASS 🟢" : s6Pass ? "WAIT ⏳" : "WAIT ⚪", active: s7Pass },
              { title: "8. SL Guard", val: s8Pass ? "LOCK 🟢" : s8Status.includes("FAIL") ? "FAIL 🔴" : "WAIT ⚪", active: s8Pass, rose: s8Status.includes("FAIL") },
              { title: "9. M15 TP", val: s9Pass ? "SET 🟢" : s9Status.includes("FAIL") ? "FAIL 🔴" : "WAIT ⚪", active: s9Pass, rose: s9Status.includes("FAIL") },
            ].map((st) => (
              <div
                key={st.title}
                className={cn(
                  "min-h-[44px] px-1 py-1 rounded-lg border flex flex-col items-center justify-center text-center",
                  st.rose
                    ? "bg-rose-950/70 border-rose-500 text-rose-200"
                    : st.active
                    ? "bg-emerald-950/70 border-emerald-400 text-emerald-200"
                    : "bg-slate-900 border-slate-700 text-slate-300"
                )}
              >
                <div className="text-[10px] text-slate-300 uppercase font-bold whitespace-nowrap">{st.title}</div>
                <div className="text-[11px] font-black whitespace-nowrap mt-0.5">{st.val}</div>
              </div>
            ))}
          </div>
        </div>

        {activeTab === "tv" ? (
          <TradingViewEmbedded symbol={symbol} />
        ) : (
          <div className="relative w-full h-[440px] sm:h-[475px]">
            {candles.length === 0 ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 font-mono text-xs text-zinc-400">
                <Activity className="h-5 w-5 text-cyan-400 animate-spin" />
                <span>Fetching live Binance Futures M5 candles for {symbol} (zero mock bars)...</span>
              </div>
            ) : (
              <>
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              preserveAspectRatio="none"
              className="w-full h-full cursor-crosshair select-none"
              onMouseMove={handleMouseMove}
              onMouseLeave={() => {
                setMousePos(null);
                setHoveredCandle(null);
              }}
            >
              <defs>
                <linearGradient id="fvgGradientZone" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={isBullishSetup ? "#10b981" : "#f43f5e"} stopOpacity="0.08" />
                  <stop offset="100%" stopColor={isBullishSetup ? "#10b981" : "#f43f5e"} stopOpacity="0.02" />
                </linearGradient>
              </defs>

              <rect x={candlesRight + 4} y={chartTop} width={Math.max(0, chartRight - candlesRight - 4)} height={plotHeight} fill="rgba(15, 23, 42, 0.25)" />
              <line x1={candlesRight + 4} y1={chartTop} x2={candlesRight + 4} y2={chartBottom} stroke="#1e293b" strokeWidth="1" strokeDasharray="3 3" />
              <rect x={chartRight} y={chartTop} width={svgWidth - chartRight} height={plotHeight} fill="#080c16" />
              <line x1={chartRight} y1={chartTop} x2={chartRight} y2={chartBottom} stroke="#1e293b" strokeWidth="1.5" />

              {gridTicks.map((tick, idx) => (
                <g key={idx}>
                  <line x1={chartLeft} y1={tick.y} x2={chartRight} y2={tick.y} stroke="#1e293b" strokeWidth="1" strokeDasharray="4 4" />
                  <text x={chartRight + (isMobile ? 6 : 10)} y={tick.y + 4} fill="#64748b" fontSize={isMobile ? "10" : "11"} fontFamily="monospace" fontWeight="700">
                    ${fmtP(tick.price)}
                  </text>
                </g>
              ))}

              {/* LAYER 1: Active FVG, iFVG, OB, BREAKER boxes (rendered cleanly behind candles) */}
              {renderedSmcZones.map((zone) => {
                const originCandle = candles[zone.originIdx];
                const candleCenterY = originCandle ? getY((originCandle.open + originCandle.close) / 2) : zone.centerY;
                return (
                  <g key={zone.id}>
                    <rect
                      x={zone.originX}
                      y={zone.topY}
                      width={zone.boxWidth}
                      height={zone.boxHeight}
                      fill={zone.boxFill}
                      stroke={zone.boxStroke}
                      strokeWidth={zone.strokeWidth}
                      strokeDasharray={zone.strokeDash}
                      opacity="0.88"
                      rx="2"
                    />
                    <rect x={zone.originX} y={zone.topY} width="3" height={zone.boxHeight} fill={zone.boxStroke} rx="1" />
                    <circle cx={zone.originX} cy={candleCenterY} r="3" fill={zone.boxStroke} stroke="#ffffff" strokeWidth="1" />
                  </g>
                );
              })}

              {swingStructure.swingHigh > 0 && (
                <line x1={chartLeft} y1={getY(swingStructure.swingHigh)} x2={chartRight} y2={getY(swingStructure.swingHigh)} stroke="#0891b2" strokeWidth={s2Pass && isBearishSetup ? 2.2 : 1.3} strokeDasharray={s2Pass && isBearishSetup ? "none" : "6 4"} />
              )}
              {swingStructure.swingLow > 0 && (
                <line x1={chartLeft} y1={getY(swingStructure.swingLow)} x2={chartRight} y2={getY(swingStructure.swingLow)} stroke="#0891b2" strokeWidth={s2Pass && isBullishSetup ? 2.2 : 1.3} strokeDasharray={s2Pass && isBullishSetup ? "none" : "6 4"} />
              )}
              {swingStructure.chochLvl > 0 && (
                <line x1={chartLeft} y1={getY(swingStructure.chochLvl)} x2={chartRight} y2={getY(swingStructure.chochLvl)} stroke="#f59e0b" strokeWidth={s3Pass ? 2.2 : 1.3} strokeDasharray={s3Pass ? "none" : "6 4"} />
              )}

              {/* ENTRY, SL, TP BRACKET */}
              {(() => {
                const entryX = chartLeft + (candleMilestones.entry + 0.5) * candleSpacing;
                const sweepX = chartLeft + (candleMilestones.sweep + 0.5) * candleSpacing;
                const chochX = chartLeft + (candleMilestones.choch + 0.5) * candleSpacing;
                const hasBracket = isTradeActive || (s7Pass && s9Pass);
                return (
                  <g>
                    {hasBracket && effectiveEntryPrice > 0 && effectiveTpPrice > 0 && effectiveSlPrice > 0 && (
                      <>
                        <rect
                          x={entryX}
                          y={Math.min(getY(effectiveEntryPrice), getY(effectiveTpPrice))}
                          width={Math.max(candleSpacing * 2, chartRight - entryX)}
                          height={Math.max(4, Math.abs(getY(effectiveTpPrice) - getY(effectiveEntryPrice)))}
                          fill="rgba(16, 185, 129, 0.09)"
                          stroke="#10b981"
                          strokeWidth="1"
                          strokeDasharray="4 3"
                        />
                        <rect
                          x={entryX}
                          y={Math.min(getY(effectiveEntryPrice), getY(effectiveSlPrice))}
                          width={Math.max(candleSpacing * 2, chartRight - entryX)}
                          height={Math.max(4, Math.abs(getY(effectiveSlPrice) - getY(effectiveEntryPrice)))}
                          fill="rgba(239, 68, 68, 0.09)"
                          stroke="#ef4444"
                          strokeWidth="1"
                          strokeDasharray="4 3"
                        />
                      </>
                    )}
                    {showEntryLevel && effectiveEntryPrice > 0 && (
                      <line x1={hasBracket ? entryX : chartLeft} y1={getY(effectiveEntryPrice)} x2={chartRight} y2={getY(effectiveEntryPrice)} stroke="#38bdf8" strokeWidth="2.2" />
                    )}
                    {showSlLevel && effectiveSlPrice > 0 && (
                      <line x1={s2Pass ? sweepX : chartLeft} y1={getY(effectiveSlPrice)} x2={chartRight} y2={getY(effectiveSlPrice)} stroke="#ef4444" strokeWidth={isTradeActive ? 2.5 : 1.6} strokeDasharray={isTradeActive ? "none" : "5 5"} />
                    )}
                    {showTpLevel && effectiveTpPrice > 0 && (
                      <line x1={s4Pass ? chochX : chartLeft} y1={getY(effectiveTpPrice)} x2={chartRight} y2={getY(effectiveTpPrice)} stroke="#10b981" strokeWidth={isTradeActive ? 2.5 : 1.6} strokeDasharray={isTradeActive ? "none" : "5 5"} />
                    )}
                  </g>
                );
              })()}

              {marketStructure.path && (
                <path d={marketStructure.path} fill="none" stroke="#818cf8" strokeWidth="2" strokeDasharray="5 3" opacity="0.8" />
              )}

              <line x1={chartLeft} y1={getY(livePrice)} x2={chartRight} y2={getY(livePrice)} stroke="#ffffff" strokeWidth="1.5" strokeDasharray="4 3" />

              {candles.map((c, idx) => {
                const cx = chartLeft + (idx + 0.5) * candleSpacing;
                const yHigh = getY(c.high);
                const yLow = getY(c.low);
                const yOpen = getY(c.open);
                const yClose = getY(c.close);
                const bodyFill = c.isBullish ? "#00c076" : "#ff3b69";
                const strokeColor = c.isBullish ? "#00e68c" : "#ff5c85";
                return (
                  <g key={idx}>
                    <line x1={cx} y1={yHigh} x2={cx} y2={yLow} stroke={strokeColor} strokeWidth="1.8" />
                    <rect x={cx - candleBodyWidth / 2} y={Math.min(yOpen, yClose)} width={candleBodyWidth} height={Math.max(3, Math.abs(yClose - yOpen))} fill={bodyFill} stroke={strokeColor} strokeWidth="1.2" rx="1" />
                    {c.isSweep && (
                      <g>
                        <rect x={cx - 24} y={isBullishSetup ? yLow + 12 : yHigh - 28} width="48" height="16" fill="#0891b2" rx="3" stroke="#22d3ee" />
                        <text x={cx} y={isBullishSetup ? yLow + 23 : yHigh - 17} fill="#ffffff" fontSize="8.5" fontFamily="monospace" fontWeight="900" textAnchor="middle">SWEEP</text>
                      </g>
                    )}
                    {c.isChoch && (
                      <g>
                        <rect x={cx - 24} y={isBullishSetup ? yHigh - 26 : yLow + 10} width="48" height="16" fill="#d97706" rx="3" stroke="#fde68a" />
                        <text x={cx} y={isBullishSetup ? yHigh - 15 : yLow + 21} fill="#ffffff" fontSize="8.5" fontFamily="monospace" fontWeight="900" textAnchor="middle">CHOCH</text>
                      </g>
                    )}
                    {idx % (isMobile ? 5 : 4) === 0 && (
                      <text x={cx} y={chartBottom + 20} fill="#cbd5e1" fontSize="10" fontFamily="monospace" fontWeight="700" textAnchor="middle">
                        {c.time}
                      </text>
                    )}
                  </g>
                );
              })}

              {marketStructure.swings.map((swing, sIdx) => {
                const isBullTag = swing.type === "HH" || swing.type === "HL";
                const tagY = swing.isHigh ? Math.max(chartTop + 4, swing.y - 18) : Math.min(chartBottom - 18, swing.y + 6);
                return (
                  <g key={`sw-${sIdx}`}>
                    <circle cx={swing.x} cy={swing.y} r="3" fill={isBullTag ? "#10b981" : "#ef4444"} stroke="#ffffff" strokeWidth="1" />
                    <rect x={swing.x - 13} y={tagY} width="26" height="14" rx="3" fill={isBullTag ? "#064e3b" : "#450a0a"} stroke={isBullTag ? "#10b981" : "#ef4444"} />
                    <text x={swing.x} y={tagY + 10} fill={isBullTag ? "#34d399" : "#f87171"} fontSize="8.5" fontFamily="monospace" fontWeight="900" textAnchor="middle">
                      {swing.type}
                    </text>
                  </g>
                );
              })}

              {/* LAYER 3: De-overlapped Zone Pill Labels in Dedicated Right Dock Lane (zero overlap on candles!) */}
              {renderedSmcZones.map((zone) => {
                const badgeMidY = zone.badgeY + zone.badgeHeight / 2;
                const leaderStartX = candlesRight + 2;
                return (
                  <g key={`lbl-${zone.id}`} pointerEvents="none">
                    {Math.abs(badgeMidY - zone.centerY) > 2 && (
                      <>
                        <path
                          d={`M ${leaderStartX} ${zone.centerY} L ${zone.badgeX} ${badgeMidY}`}
                          stroke={zone.badgeStroke}
                          strokeWidth="1.2"
                          strokeDasharray="3 2"
                          fill="none"
                        />
                        <circle cx={leaderStartX} cy={zone.centerY} r="2.5" fill={zone.badgeStroke} stroke="#070a12" strokeWidth="1" />
                      </>
                    )}
                    <rect
                      x={zone.badgeX}
                      y={zone.badgeY}
                      width={zone.badgeWidth}
                      height={zone.badgeHeight}
                      fill={zone.badgeBg}
                      fillOpacity="0.96"
                      rx="4"
                      stroke={zone.badgeStroke}
                      strokeWidth="1.3"
                    />
                    <text
                      x={zone.badgeX + 7}
                      y={zone.badgeY + 12.5}
                      fill="#ffffff"
                      fontSize={isMobile ? "8.5" : "9.5"}
                      fontFamily="monospace"
                      fontWeight="900"
                    >
                      {zone.badgeTitle} {zone.badgeSub}
                    </text>
                  </g>
                );
              })}

              {stackedTags.map((tag) => {
                const badgeX = chartRight + 5;
                return (
                  <g key={tag.id}>
                    {Math.abs(tag.renderedY - tag.targetY) > 2 && (
                      <path d={`M ${chartRight} ${tag.targetY} L ${badgeX} ${tag.renderedY}`} stroke={tag.borderStroke} strokeWidth="1" strokeDasharray="2 2" />
                    )}
                    <rect x={badgeX} y={tag.renderedY - tagHeight / 2} width={rightTagWidth} height={tagHeight} fill={tag.bgFill} rx="4" stroke={tag.borderStroke} />
                    <text x={badgeX + 6} y={tag.renderedY + 4} fill={tag.textColor} fontSize={tag.fontSize} fontFamily="monospace" fontWeight="900">
                      {tag.label}
                    </text>
                  </g>
                );
              })}

              {mousePos && mousePos.x >= chartLeft && mousePos.x <= chartRight && cursorPrice !== null && (
                <g pointerEvents="none">
                  <line x1={mousePos.x} y1={chartTop} x2={mousePos.x} y2={chartBottom} stroke="#94a3b8" strokeDasharray="4 4" />
                  <line x1={chartLeft} y1={mousePos.y} x2={chartRight} y2={mousePos.y} stroke="#94a3b8" strokeDasharray="4 4" />
                  <rect x={chartRight + 5} y={mousePos.y - tagHeight / 2} width={rightTagWidth} height={tagHeight} fill="#2563eb" rx="4" stroke="#bfdbfe" />
                  <text x={chartRight + 9} y={mousePos.y + 4} fill="#ffffff" fontSize="10.5" fontFamily="monospace" fontWeight="900">
                    ${fmtP(cursorPrice)}
                  </text>
                </g>
              )}
            </svg>

            {hoveredCandle && (
              <div className="absolute top-2 left-3 bg-[#0d121f]/95 border border-zinc-700 px-3 py-1.5 rounded-lg text-[10px] sm:text-xs font-mono text-zinc-100 shadow-2xl pointer-events-none flex flex-wrap gap-3">
                <span>Time: <strong>{hoveredCandle.time} PKT</strong></span>
                <span>O: <strong className={hoveredCandle.isBullish ? "text-emerald-400" : "text-rose-400"}>${formatCryptoPrice(hoveredCandle.open)}</strong></span>
                <span>H: <strong>${formatCryptoPrice(hoveredCandle.high)}</strong></span>
                <span>L: <strong>${formatCryptoPrice(hoveredCandle.low)}</strong></span>
                <span>C: <strong className={hoveredCandle.isBullish ? "text-emerald-400" : "text-rose-400"}>${formatCryptoPrice(hoveredCandle.close)}</strong></span>
              </div>
            )}
              </>
            )}
          </div>
        )}
      </div>

      {/* 4. 9-CONDITION PIPELINE CARDS */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-mono font-bold text-white uppercase tracking-wider flex items-center gap-2">
            <Layers className="w-4 h-4 text-indigo-400" /> Pure 9-Condition Crypto Futures SMC Pipeline
          </h4>
          <span className="text-[11px] font-mono text-zinc-400">Zero Z-Score · M15 + M5 Live Confluence</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 font-mono text-xs">
          {[
            { label: "S1: M15 Structural Bias", pass: s1Pass, badge: s1Pass ? rawM15Bias : "NEUTRAL ⚪", desc: s1Pass ? `M15 order flow confirmed ${isM15Bullish ? "Bullish (HH/HL -> LONG)" : "Bearish (LH/LL -> SHORT)"}.` : "Waiting for clear M15 swing trend." },
            { label: "S2: M5 Liquidity Sweep", pass: s2Pass, badge: s2Pass ? sweepStatus : "PENDING ⚪", desc: s2Pass ? `Swept M5 stops at $${fmtP(sweepPrice)} via closed wick reclaim.` : "Waiting for M5 sweep wick beyond prior swing." },
            { label: "S3: M5 CHoCH / BOS", pass: s3Pass, badge: s3Pass ? chochStatus : "PENDING ⚪", desc: s3Pass ? `Closed past $${fmtP(chochPrice)} confirming shift.` : "Waiting for closed-candle break past minor pivot." },
            { label: "S4: Displacement FVG", pass: s4Pass, badge: s4Pass ? fvgStatus : "PENDING ⚪", desc: s4Pass ? "3-candle displacement FVG active in impulse leg." : "Waiting for sweep-to-CHoCH displacement imbalance." },
            { label: "S5: Closed FVG Retest", pass: s5Pass, badge: s5Pass ? retestStatus : "PENDING ⚪", desc: s5Pass ? "Closed M5 bar tapped & respected Displacement FVG." : "Waiting for closed pullback into FVG zone." },
            { label: "S6: Rejection Candle", pass: s6Pass, badge: s6Pass ? s6Status : "PENDING ⚪", desc: s6Pass ? "Confirmed rejection candle / pin off FVG." : "Waiting for closed rejection close or hammer/star." },
            { label: "S7: Close & Anti-Chase", pass: s7Pass, badge: s7Pass ? s7Status : "PENDING ⚪", desc: s7Pass ? "Closed confirmation without chasing past FVG." : "Entry waits strictly for candle close & chase guard." },
            { label: "S8: SL Guard (0.08% Buf)", pass: s8Pass, badge: s8Status || (s8Pass ? "PASS 🟢" : "PENDING ⚪"), desc: s8Pass ? `SL anchored $${fmtP(slPrice)} behind sweep (Liq-Safe).` : "Locks 0.08% beyond sweep wick + max SL/liq cap." },
            { label: "S9: M15 Opposing Target", pass: s9Pass, badge: s9Status || (s9Pass ? `PASS 🟢 (${effectiveRrr}R)` : "PENDING ⚪"), desc: s9Pass ? `M15 liquidity TP at $${fmtP(tpPrice)} (${effectiveRrr}R).` : "Requires >= 1.85R clear room to M15 liquidity." },
          ].map((c) => (
            <div key={c.label} className={cn("p-3 rounded-lg border transition-all", c.pass ? "bg-emerald-950/30 border-emerald-500/50 text-white" : "bg-[#0d121f] border-zinc-800 text-zinc-400")}>
              <div className="flex items-center justify-between mb-1 gap-1">
                <span className="font-bold flex items-center gap-1.5 text-white">
                  {c.pass ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : c.label.includes("S8") ? <Shield className="w-4 h-4 text-zinc-500 shrink-0" /> : c.label.includes("S9") ? <Target className="w-4 h-4 text-zinc-500 shrink-0" /> : <Clock className="w-4 h-4 text-zinc-500 shrink-0" />}
                  {c.label}
                </span>
                <Badge variant="outline" className={cn("text-[9px] px-1.5 font-bold", c.pass ? "bg-emerald-500/20 text-emerald-300 border-emerald-400" : "bg-zinc-800 text-zinc-400 border-zinc-700")}>
                  {c.badge}
                </Badge>
              </div>
              <p className="text-[11px] text-zinc-300 leading-snug">{c.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
