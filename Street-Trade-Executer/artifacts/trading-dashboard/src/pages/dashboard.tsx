import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetDashboard,
  useExecuteTrade,
  getGetDashboardQueryKey,
  useGetSignals,
  useGetConfig,
} from "@workspace/api-client-react";
import { useLiveDashboard } from "@/hooks/use-ws";
import { SmcChartOverlay } from "@/components/SmcChartOverlay";
import { SessionGuardCard } from "@/components/SessionGuardCard";
import { BinanceCoinSearch } from "@/components/BinanceCoinSearch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, formatCryptoPrice, formatUsdt, formatPktDateTime } from "@/lib/utils";
import { getApiUrl } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  Activity,
  Wifi,
  WifiOff,
  Send,
  Zap,
  ZapOff,
  Play,
  Pause,
  Shield,
  Target,
  Layers,
  Star,
} from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";

function hasTelemetryCandles(t: any): boolean {
  if (!t) return false;
  if (Array.isArray(t.candles) && t.candles.length >= 8) return true;
  try {
    const raw = t.fvg_bounds_json ?? t.fvgBoundsJson;
    if (!raw) return false;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed?.candles) && parsed.candles.length >= 8;
  } catch {
    return false;
  }
}

export default function Dashboard() {
  const { toast } = useToast();
  const isReadOnly = localStorage.getItem("wasee_role")?.toLowerCase() === "user";
  const queryClient = useQueryClient();

  const initialQuerySym =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("symbol")?.trim().toUpperCase() : "";
  const [selectedChartSymbol, setSelectedChartSymbol] = useState(initialQuerySym || "BTCUSDT");
  const [manualSymbol, setManualSymbol] = useState(initialQuerySym || "BTCUSDT");
  const [manualLots, setManualLots] = useState("0.01");
  const [manualSlPct, setManualSlPct] = useState("1.2");
  const [manualTpPct, setManualTpPct] = useState("2.4");
  const [togglingBot, setTogglingBot] = useState(false);

  const { data: httpData, isLoading } = useGetDashboard({
    query: { queryKey: getGetDashboardQueryKey(), refetchInterval: 3000 },
  });
  const { data: config } = useGetConfig();
  const { data: wsData, wsConnected } = useLiveDashboard();
  const executeTrade = useExecuteTrade();
  const { data: signalsData } = useGetSignals({ limit: 30 });

  const [pnlHistory, setPnlHistory] = useState<{ t: number; pnl: number; eq: number }[]>([]);

  const dashboard = (wsData ?? httpData) as any;

  useEffect(() => {
    if (!dashboard) return;
    setPnlHistory((prev) => [...prev, { t: Date.now(), pnl: dashboard.floatingProfit ?? 0, eq: dashboard.equity ?? 0 }].slice(-90));
  }, [dashboard?.equity, dashboard?.floatingProfit]);

  useEffect(() => {
    if (config?.slPips) setManualSlPct(String(config.slPips));
    if (config?.tpPips) setManualTpPct(String(config.tpPips));
    if (!initialQuerySym && config?.activePair && selectedChartSymbol === "BTCUSDT") {
      setSelectedChartSymbol(String(config.activePair).split("/")[0] || "BTCUSDT");
    }
  }, [config?.activePair]);

  useEffect(() => {
    setManualSymbol(selectedChartSymbol);
  }, [selectedChartSymbol]);

  // Fetch live Binance SMC telemetry on demand whenever viewing ANY searched or favorited Binance coin
  const { data: onDemandSmc, isFetching: onDemandLoading } = useQuery({
    queryKey: ["smc-telemetry-live", selectedChartSymbol],
    queryFn: async () => {
      const res = await fetch(getApiUrl(`/api/smc_telemetry?symbol=${encodeURIComponent(selectedChartSymbol)}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 4000,
    enabled: Boolean(selectedChartSymbol),
  });

  const resolvedChartSymbol = String(onDemandSmc?.resolvedSymbol || selectedChartSymbol).toUpperCase();
  const dbTelemetryForCoin =
    dashboard?.smcTelemetryAll?.[selectedChartSymbol.toUpperCase()] ??
    dashboard?.smcTelemetryAll?.[resolvedChartSymbol];

  if (isLoading && !dashboard) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-[48px] w-full" />
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-[110px] w-full" />
          ))}
        </div>
      </div>
    );
  }
  if (!dashboard) return null;

  const {
    systemStatus = "BOT OFFLINE",
    currentPair = "BTCUSDT",
    equity = 0,
    drawdownPercent = 0,
    floatingProfit = 0,
    tradesToday = 0,
    maxTrades = 10,
    activePositions = [],
    activeZones = [],
    scannedAssets = [],
    botOnline = false,
    autoExecute = true,
    initialBalance = 10000,
    overallDrawdown = 0,
    maxEquityPeak = 10000,
    accountMode = "PROP_FIRM",
    leverage = 5,
    maxMarginPct = 80,
    riskPercent = 1.0,
    haltDrawdownLimit = 3.5,
    maxDrawdownLimit = 4.0,
    isBotRunning = true,
  } = dashboard;

  const baseInitial = initialBalance > 0 ? initialBalance : 10000;
  const overallGain = equity > 0 ? equity - baseInitial : 0;
  const overallGainPct = baseInitial > 0 ? (overallGain / baseInitial) * 100 : 0;

  const favoritePairs: string[] = Array.isArray(dashboard?.favoritePairs)
    ? dashboard.favoritePairs.map((s: any) => String(s).toUpperCase())
    : [];

  const liveHasCandles = hasTelemetryCandles(onDemandSmc?.telemetry);
  const dbHasCandles = hasTelemetryCandles(dbTelemetryForCoin);
  const effectiveTelemetry = liveHasCandles
    ? onDemandSmc.telemetry
    : dbHasCandles
    ? dbTelemetryForCoin
    : onDemandSmc?.telemetry ??
      dbTelemetryForCoin ??
      (resolvedChartSymbol === String(currentPair).toUpperCase() ? dashboard.smcTelemetry : null) ??
      null;

  const scannedMatch = scannedAssets.find(
    (a: any) =>
      String(a.symbolPair).toUpperCase() === selectedChartSymbol.toUpperCase() ||
      String(a.symbolPair).toUpperCase() === resolvedChartSymbol
  );
  const liveTickerPrice = Number(
    dashboard?.livePrices?.[resolvedChartSymbol] ??
      dashboard?.livePrices?.[selectedChartSymbol.toUpperCase()] ??
      0
  );
  const currentLivePrice = Number(liveTickerPrice || onDemandSmc?.livePrice || scannedMatch?.priceA || 0);

  const matchingPosition = activePositions.find(
    (p: any) =>
      String(p.symbol).toUpperCase() === resolvedChartSymbol ||
      String(p.symbol).toUpperCase() === selectedChartSymbol.toUpperCase()
  );

  // Merge live Binance zones first (matching visible M5 candles) with DB zones fallback
  const dbSymbolZones = activeZones.filter(
    (z: any) =>
      String(z.label).toUpperCase().includes(resolvedChartSymbol) ||
      String(z.label).toUpperCase().includes(selectedChartSymbol.toUpperCase())
  );
  const chartZones = onDemandSmc?.activeZones?.length ? onDemandSmc.activeZones : dbSymbolZones;

  const handleToggleBot = async () => {
    if (isReadOnly || togglingBot) return;
    setTogglingBot(true);
    try {
      const nextAction = isBotRunning ? "PAUSE" : "START";
      const res = await fetch(getApiUrl("/api/bot/control"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: nextAction }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({
        title: nextAction === "START" ? "Crypto SMC Bot STARTED 🟢" : "Crypto SMC Bot PAUSED ⏸️",
        description: nextAction === "START" ? "Scanning Top 10 & Favorite Binance pairs live." : "New entries paused; open SL/TP remains active.",
      });
      await queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    } catch {
      toast({ title: "Bot toggle failed", variant: "destructive" });
    } finally {
      setTogglingBot(false);
    }
  };

  const handlePinCustomSymbol = async () => {
    if (isReadOnly) return;
    try {
      const res = await fetch(getApiUrl("/api/config"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activePair: resolvedChartSymbol }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Priority Coin Pinned", description: `${resolvedChartSymbol} set as priority Binance bot coin.` });
      await queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    } catch {
      toast({ title: "Could not pin symbol", variant: "destructive" });
    }
  };

  const handleToggleFavorite = async (symToToggle: string) => {
    if (isReadOnly) return;
    try {
      const res = await fetch(getApiUrl("/api/favorites/toggle"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: symToToggle }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast({
        title: json.action === "added" ? `★ ${json.symbol} Added to Favorites` : `${json.symbol} Removed from Favorites`,
        description:
          json.action === "added"
            ? "Added to Favorites Watchlist, Live Scanner & Pure SMC Chart."
            : "Removed from Favorites Watchlist.",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
        queryClient.invalidateQueries({ queryKey: ["smc-telemetry-live"] }),
      ]);
    } catch {
      toast({ title: "Could not update favorite", variant: "destructive" });
    }
  };

  const handleManualTrade = (direction: "BUY" | "SELL") => {
    const sym = manualSymbol.trim().toUpperCase();
    const lots = parseFloat(manualLots);
    const slPct = parseFloat(manualSlPct);
    const tpPct = parseFloat(manualTpPct);

    if (!sym || sym.length < 4) {
      toast({ title: "Valid Binance symbol required", variant: "destructive" });
      return;
    }
    if (isNaN(lots) || lots <= 0) {
      toast({ title: "Valid contract quantity required", variant: "destructive" });
      return;
    }

    executeTrade.mutate(
      {
        data: {
          symbol: sym,
          direction,
          lots,
          slPips: isNaN(slPct) ? 1.2 : slPct,
          tpPips: isNaN(tpPct) ? 2.4 : tpPct,
          comment: `MANUAL_FUTURES_${accountMode}`,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: `${direction === "BUY" ? "LONG" : "SHORT"} Command Queued`,
            description: `${sym} · Qty: ${lots} · Single Direct Order (${leverage}x)`,
          });
          queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        },
        onError: () => {
          toast({ title: "Failed to queue Futures order", variant: "destructive" });
        },
      }
    );
  };

  const manualNotional = Number(manualLots || 0) * (currentLivePrice || 0);
  const manualMarginUsed = leverage > 0 ? manualNotional / leverage : manualNotional;
  const manualMarginPct = equity > 0 ? (manualMarginUsed / equity) * 100 : 0;

  return (
    <div className="flex flex-col h-full overflow-auto bg-zinc-950 text-foreground">
      {/* Top Status & Control Strip */}
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-2 px-4 sm:px-6 py-2.5 text-xs font-semibold tracking-wider border-b",
          botOnline ? "bg-green-500/10 text-green-400 border-green-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"
        )}
      >
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {botOnline ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
          <span>{botOnline ? "BINANCE FUTURES LIVE" : "BOT STANDBY"}</span>
          <span
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded-sm text-[10px] border",
              wsConnected ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" : "bg-zinc-900 text-zinc-400 border-zinc-800"
            )}
          >
            <Activity className="h-3 w-3" />
            {wsConnected ? "WS LIVE" : "POLL"}
          </span>
          <Badge variant="outline" className="font-mono text-[10px] bg-indigo-500/15 text-indigo-300 border-indigo-500/30">
            {accountMode === "PERSONAL" ? `PERSONAL FUND (${leverage}x · ${riskPercent}% Risk)` : `PROP FIRM · BLUE GUARDIAN (${leverage}x)`}
          </Badge>
          <Badge variant="outline" className="font-mono text-[10px] bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
            CAP: ≤ {accountMode === "PERSONAL" ? Math.min(100, maxMarginPct) : Math.min(80, maxMarginPct)}% MARGIN
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-[11px] font-mono">
            {autoExecute ? (
              <span className="text-emerald-400 flex items-center gap-1">
                <Zap className="h-3 w-3" /> AUTO SMC ON
              </span>
            ) : (
              <span className="text-amber-400 flex items-center gap-1">
                <ZapOff className="h-3 w-3" /> SIGNALS ONLY
              </span>
            )}
          </span>
          <span className="font-mono bg-zinc-900/80 border border-zinc-800 px-2 py-0.5 rounded text-[11px] text-zinc-200">
            {systemStatus}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleToggleBot}
            disabled={isReadOnly || togglingBot}
            className={cn(
              "h-7 px-2.5 font-mono text-[10px] font-bold",
              isBotRunning
                ? "border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                : "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
            )}
          >
            {isBotRunning ? <><Pause className="w-3 h-3 mr-1" /> PAUSE BOT</> : <><Play className="w-3 h-3 mr-1" /> START BOT</>}
          </Button>
          <Button
            onClick={() => {
              if (window.confirm("EMERGENCY CLOSE ALL OPEN BINANCE FUTURES POSITIONS?")) {
                executeTrade.mutate(
                  { data: { symbol: "ALL", direction: "CLOSE", lots: 0, comment: "CLOSE_ALL" } },
                  {
                    onSuccess: () => toast({ title: "Emergency Close All Queued" }),
                    onError: () => toast({ title: "Close All Failed", variant: "destructive" }),
                  }
                );
              }
            }}
            size="sm"
            variant="destructive"
            className="h-7 px-2.5 font-mono text-[10px] font-bold"
            disabled={executeTrade.isPending || !botOnline || isReadOnly}
          >
            CLOSE ALL
          </Button>
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-5">
        {/* 6 USDT KPI CARDS */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3.5">
          <Card className="bg-zinc-900 border-zinc-800 border-t-2 border-t-sky-500">
            <CardHeader className="pb-1.5">
              <CardTitle className="text-[11px] text-zinc-400 uppercase font-mono">Futures Equity (USDT)</CardTitle>
            </CardHeader>
            <CardContent className="pb-2">
              <div className="text-lg font-mono font-bold text-sky-400">{formatUsdt(equity)}</div>
              <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
                Wallet: <span className="text-zinc-200 font-semibold">{formatUsdt(equity - floatingProfit)}</span>
              </div>
              <div className="text-[10px] text-zinc-500 font-mono mb-1.5">Start: {formatUsdt(baseInitial)}</div>
              {pnlHistory.length > 2 && (
                <ResponsiveContainer width="100%" height={30}>
                  <AreaChart data={pnlHistory}>
                    <Area type="monotone" dataKey="eq" stroke="#0ea5e9" strokeWidth={1.5} fill="#0ea5e9" fillOpacity={0.15} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className={cn("bg-zinc-900 border-zinc-800 border-t-2", floatingProfit >= 0 ? "border-t-emerald-500" : "border-t-rose-500")}>
            <CardHeader className="pb-1.5">
              <CardTitle className="text-[11px] text-zinc-400 uppercase font-mono">Floating Open P&amp;L</CardTitle>
            </CardHeader>
            <CardContent className="pb-2">
              <div className={cn("text-lg font-mono font-bold", floatingProfit >= 0 ? "text-emerald-400" : "text-rose-400")}>
                {formatUsdt(floatingProfit, true)}
              </div>
              <div className="text-[10px] text-zinc-500 font-mono mt-0.5">
                {activePositions.length > 0 ? `${activePositions.length} Open Futures Trade` : "No active position (Lock Ready)"}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-zinc-900 border-zinc-800 border-t-2 border-t-amber-500">
            <CardHeader className="pb-1.5">
              <CardTitle className="text-[11px] text-zinc-400 uppercase font-mono">Daily Drawdown</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <div className="flex justify-between items-baseline">
                <span className="text-lg font-mono font-bold text-amber-400">{drawdownPercent.toFixed(2)}%</span>
                <span className="text-[10px] font-mono text-zinc-400">Halt {haltDrawdownLimit}% / Max {maxDrawdownLimit}%</span>
              </div>
              <Progress value={Math.min(100, (drawdownPercent / Math.max(1, maxDrawdownLimit)) * 100)} className="h-1.5 bg-zinc-800 [&>div]:bg-amber-500" />
              <div className="text-[10px] text-zinc-500 font-mono truncate">
                Capital: ${baseInitial.toFixed(0)} · Max Loss: -${((baseInitial * maxDrawdownLimit) / 100).toFixed(2)}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-zinc-900 border-zinc-800 border-t-2 border-t-emerald-500">
            <CardHeader className="pb-1.5">
              <CardTitle className="text-[11px] text-zinc-400 uppercase font-mono">Net Gain (USDT)</CardTitle>
            </CardHeader>
            <CardContent>
              <div className={cn("text-lg font-mono font-bold", overallGain >= 0 ? "text-emerald-400" : "text-rose-400")}>
                {formatUsdt(overallGain, true)}
              </div>
              <div className="text-[10px] text-zinc-500 font-mono mt-0.5">ROI: {overallGainPct >= 0 ? "+" : ""}{overallGainPct.toFixed(2)}%</div>
            </CardContent>
          </Card>

          <Card className="bg-zinc-900 border-zinc-800 border-t-2 border-t-rose-500">
            <CardHeader className="pb-1.5">
              <CardTitle className="text-[11px] text-zinc-400 uppercase font-mono">Overall Drawdown</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <div className="flex justify-between items-baseline">
                <span className="text-lg font-mono font-bold text-rose-400">{overallDrawdown.toFixed(2)}%</span>
                <span className="text-[10px] font-mono text-zinc-400 truncate">Peak: ${Number(maxEquityPeak).toFixed(0)}</span>
              </div>
              <Progress value={Math.min(100, (overallDrawdown / 8) * 100)} className="h-1.5 bg-zinc-800 [&>div]:bg-rose-500" />
            </CardContent>
          </Card>

          <Card className="bg-zinc-900 border-zinc-800 border-t-2 border-t-violet-500">
            <CardHeader className="pb-1.5">
              <CardTitle className="text-[11px] text-zinc-400 uppercase font-mono">Trades &amp; Margin</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-lg font-mono font-bold text-purple-400">
                {tradesToday} <span className="text-xs text-zinc-500">/ {maxTrades} today</span>
              </div>
              <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
                {leverage}x Lev · {riskPercent}% Risk/Trade
              </div>
            </CardContent>
          </Card>
        </div>

        {/* BINANCE COIN SELECTOR (TOP 10 + FAVORITES WATCHLIST + SEARCH ANY BINANCE COIN) */}
        <Card className="bg-zinc-900/70 border-zinc-800 p-3.5 sm:p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-zinc-300">
              <span>Chart Inspection: <strong className="text-sky-400">{resolvedChartSymbol}</strong> <span className="text-zinc-500">(View only — clicking coins never places trades)</span></span>
              <span className="text-zinc-600">|</span>
              <span>Pinned Priority: <strong className="text-emerald-400">{currentPair}</strong></span>
              {!isReadOnly && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleToggleFavorite(resolvedChartSymbol)}
                  className={cn(
                    "h-6 px-2 text-[10px] font-mono",
                    favoritePairs.includes(resolvedChartSymbol)
                      ? "border-amber-400/60 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                      : "border-zinc-700 text-zinc-300 hover:border-amber-400/50 hover:text-amber-300"
                  )}
                >
                  <Star className={cn("w-3 h-3 mr-1", favoritePairs.includes(resolvedChartSymbol) && "fill-amber-400 text-amber-400")} />
                  {favoritePairs.includes(resolvedChartSymbol) ? `Favorited (${resolvedChartSymbol})` : `Add ${resolvedChartSymbol} to Favorites`}
                </Button>
              )}
              {resolvedChartSymbol !== currentPair && !isReadOnly && (
                <Button size="sm" variant="outline" onClick={handlePinCustomSymbol} className="h-6 px-2 text-[10px] font-mono border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/10">
                  <Zap className="w-3 h-3 mr-1" /> Set {resolvedChartSymbol} Priority
                </Button>
              )}
            </div>
          </div>
          <BinanceCoinSearch
            selectedSymbol={resolvedChartSymbol}
            onSelectSymbol={(sym) => setSelectedChartSymbol(sym)}
            favoriteSymbols={favoritePairs}
            onToggleFavorite={(sym) => void handleToggleFavorite(sym)}
          />
        </Card>

        {/* FULL PURE SMC LIVE CHART & 6/7-STEP FOREX-ALIGNED HUD */}
        <SmcChartOverlay
          symbol={resolvedChartSymbol}
          telemetry={effectiveTelemetry}
          currentPrice={currentLivePrice}
          activePosition={matchingPosition}
          activeZones={chartZones}
          accountMode={accountMode}
          leverage={leverage}
          marketType={onDemandSmc?.marketType ?? "FUTURES"}
          telemetryLoading={onDemandLoading && !liveHasCandles && !dbHasCandles}
        />

        {/* OPTIONAL SESSION TIME GUARD (DEFAULT OFF = 24/7) */}
        <SessionGuardCard data={dashboard} isReadOnly={isReadOnly} />

        {/* ACTIVE POSITIONS & QUICK FUTURES EXECUTION + SMC ZONES */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Active Open Positions */}
          <Card className="lg:col-span-2 bg-card border-border">
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider font-mono">
                Active Binance Futures Positions (Single-Trade Lock)
              </CardTitle>
              <Badge variant="outline" className="font-mono text-[10px]">
                {activePositions.length} / 1 Open
              </Badge>
            </CardHeader>
            <CardContent>
              {activePositions.length === 0 ? (
                <div className="text-sm text-muted-foreground py-8 text-center border border-dashed border-border rounded font-mono">
                  No open Binance Futures position — scanning Top 10 coins for Pure M1/M5 SMC Confluence
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border">
                        <TableHead className="font-mono text-[10px]">COIN</TableHead>
                        <TableHead className="font-mono text-[10px]">SIDE</TableHead>
                        <TableHead className="font-mono text-[10px] text-right">QTY</TableHead>
                        <TableHead className="font-mono text-[10px] text-right">ENTRY</TableHead>
                        <TableHead className="font-mono text-[10px] text-right">MARK</TableHead>
                        <TableHead className="font-mono text-[10px] text-right">SL / TP</TableHead>
                        <TableHead className="font-mono text-[10px] text-right">PNL (USDT)</TableHead>
                        <TableHead className="font-mono text-[10px] text-center">CLOSE</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {activePositions.map((pos: any) => (
                        <TableRow key={pos.ticket} className="border-border">
                          <TableCell className="font-mono font-bold text-xs">{pos.symbol}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn("text-[10px] font-mono", pos.type === "BUY" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-rose-500/15 text-rose-400 border-rose-500/30")}>
                              {pos.type === "BUY" ? "LONG" : "SHORT"}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right">{Number(pos.lots)}</TableCell>
                          <TableCell className="font-mono text-xs text-right">{formatCryptoPrice(pos.entry)}</TableCell>
                          <TableCell className="font-mono text-xs text-right">{formatCryptoPrice(pos.current)}</TableCell>
                          <TableCell className="font-mono text-[10px] text-right">
                            <span className="text-rose-400">{pos.sl > 0 ? formatCryptoPrice(pos.sl) : "-"}</span>
                            {" / "}
                            <span className="text-emerald-400">{pos.tp > 0 ? formatCryptoPrice(pos.tp) : "-"}</span>
                          </TableCell>
                          <TableCell className={cn("font-mono text-xs text-right font-bold", pos.profit >= 0 ? "text-emerald-400" : "text-rose-400")}>
                            {formatUsdt(pos.profit, true)}
                          </TableCell>
                          <TableCell className="text-center">
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-6 px-2 text-[10px] font-mono"
                              disabled={!botOnline || isReadOnly || executeTrade.isPending}
                              onClick={() => executeTrade.mutate({ data: { symbol: pos.symbol, direction: "CLOSE", lots: pos.lots, comment: `CLOSE_${pos.ticket}` } })}
                            >
                              Close
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Detected SMC Zones + Direct Single-Order Manual Ticket */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider font-mono flex items-center justify-between">
                <span className="flex items-center gap-1.5"><Layers className="w-3.5 h-3.5 text-indigo-400" /> {selectedChartSymbol} Zones &amp; Manual Entry</span>
                <span className="text-[10px] text-indigo-400">{chartZones.length} Zones</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5 max-h-[145px] overflow-y-auto pr-1">
                {chartZones.length === 0 ? (
                  <div className="text-xs text-muted-foreground font-mono text-center py-4 border border-dashed border-border rounded">
                    Scanning {selectedChartSymbol} M5 zones...
                  </div>
                ) : (
                  chartZones.map((z: any, i: number) => {
                    const isBull = String(z.type).toUpperCase().includes("BULLISH");
                    return (
                      <div key={i} className="flex items-center justify-between px-2.5 py-1.5 rounded bg-zinc-950 border border-zinc-800 text-xs font-mono">
                        <Badge variant="outline" className={cn("text-[9px] font-bold", isBull ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-rose-500/10 text-rose-400 border-rose-500/30")}>
                          {String(z.type).replace("BULLISH_", "").replace("BEARISH_", "")}
                        </Badge>
                        <span className="text-zinc-300 text-[11px]">{z.range}</span>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Single-Order Futures Ticket */}
              <div className="pt-2 border-t border-border space-y-2.5">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">Coin</label>
                    <Input value={manualSymbol} onChange={(e) => setManualSymbol(e.target.value.toUpperCase())} className="h-8 font-mono text-xs uppercase bg-zinc-950" />
                  </div>
                  <div>
                    <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">Qty (Contracts)</label>
                    <Input type="number" step="0.001" value={manualLots} onChange={(e) => setManualLots(e.target.value)} className="h-8 font-mono text-xs bg-zinc-950" />
                  </div>
                  <div>
                    <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">SL (%)</label>
                    <Input type="number" step="0.1" value={manualSlPct} onChange={(e) => setManualSlPct(e.target.value)} className="h-8 font-mono text-xs bg-zinc-950" />
                  </div>
                  <div>
                    <label className="text-[10px] font-mono uppercase text-zinc-400 block mb-1">TP (%)</label>
                    <Input type="number" step="0.1" value={manualTpPct} onChange={(e) => setManualTpPct(e.target.value)} className="h-8 font-mono text-xs bg-zinc-950" />
                  </div>
                </div>
                {currentLivePrice > 0 && (
                  <div className="flex justify-between text-[10px] font-mono text-zinc-400 px-1">
                    <span>Notional: ${manualNotional.toFixed(2)}</span>
                    <span className={manualMarginPct > 80 ? "text-rose-400 font-bold" : "text-emerald-400"}>
                      Margin ({leverage}x): ${manualMarginUsed.toFixed(2)} ({manualMarginPct.toFixed(1)}%)
                    </span>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <Button size="sm" onClick={() => handleManualTrade("BUY")} disabled={executeTrade.isPending || !botOnline || isReadOnly} className="bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs font-bold">
                    <Send className="w-3 h-3 mr-1" /> LONG (BUY)
                  </Button>
                  <Button size="sm" onClick={() => handleManualTrade("SELL")} disabled={executeTrade.isPending || !botOnline || isReadOnly} className="bg-rose-600 hover:bg-rose-500 text-white font-mono text-xs font-bold">
                    <Send className="w-3 h-3 mr-1" /> SHORT (SELL)
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* TOP 10 + FAVORITE COINS LIVE PURE SMC AUTO-SCANNER TABLE (ZERO Z-SCORE!) */}
        <Card className="bg-card border-border border-t-2 border-t-blue-500/70">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider font-mono">
                Top 10 &amp; Favorite Coins Pure SMC Live Scanner
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Click any coin row to load its M5 candles, FVG, iFVG, OB, Breaker, SL, TP &amp; S1–S9 Pipeline
              </p>
            </div>
            <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-500/20 font-mono text-[10px]">
              {scannedAssets.length} COINS SCANNED
            </Badge>
          </CardHeader>
          <CardContent>
            {scannedAssets.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center border border-dashed border-border rounded font-mono">
                Waiting for Direct Cloud Crypto SMC Engine scan...
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border">
                      <TableHead className="font-mono text-xs">COIN (USDT-M)</TableHead>
                      <TableHead className="font-mono text-xs text-right">MARK PRICE</TableHead>
                      <TableHead className="font-mono text-xs text-right">M15 TARGET TP</TableHead>
                      <TableHead className="font-mono text-xs text-right">SMC SCORE</TableHead>
                      <TableHead className="font-mono text-xs text-right">R:R</TableHead>
                      <TableHead className="font-mono text-xs text-center">M15 BIAS / SIGNAL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {scannedAssets.map((a: any) => {
                      const sym = String(a.symbolPair);
                      const symU = sym.toUpperCase();
                      const isSelected = symU === selectedChartSymbol.toUpperCase() || symU === resolvedChartSymbol;
                      const isFav = favoritePairs.includes(symU);
                      const act = String(a.action || "NEUTRAL");
                      return (
                        <TableRow
                          key={sym}
                          onClick={() => setSelectedChartSymbol(sym)}
                          className={cn(
                            "cursor-pointer border-border transition-colors",
                            isSelected ? "bg-indigo-500/10 hover:bg-indigo-500/15" : "hover:bg-muted/30"
                          )}
                        >
                          <TableCell className="font-mono font-bold text-xs">
                            <div className="flex items-center gap-1.5">
                              {!isReadOnly && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleToggleFavorite(sym);
                                  }}
                                  className={cn(
                                    "p-0.5 rounded hover:bg-zinc-800",
                                    isFav ? "text-amber-400" : "text-zinc-600 hover:text-amber-300"
                                  )}
                                  title={isFav ? "Remove from Favorites" : "Add to Favorites"}
                                >
                                  <Star className={cn("w-3.5 h-3.5", isFav && "fill-amber-400")} />
                                </button>
                              )}
                              <span>{sym}</span>
                              {isFav && (
                                <Badge variant="outline" className="text-[9px] px-1 py-0 bg-amber-500/10 text-amber-300 border-amber-500/30">
                                  FAV
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right">${formatCryptoPrice(a.priceA)}</TableCell>
                          <TableCell className="font-mono text-xs text-right text-emerald-400">${formatCryptoPrice(a.priceB)}</TableCell>
                          <TableCell className="font-mono text-xs text-right">
                            {(() => {
                              const rTel = dashboard?.smcTelemetryAll?.[symU];
                              const rCho = String(rTel?.choch_status ?? "");
                              const rM1 = Boolean(rTel?.execution_mode === "M1_LTF" || rTel?.m1_active || rCho.includes("M1"));
                              const maxS = rM1 ? 6 : 7;
                              return `${Math.min(maxS, Math.round((Number(a.winRate || 0) / 100) * maxS))} / ${maxS} Steps`;
                            })()}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right text-sky-400 font-bold">
                            {Number(a.zScore || 0) > 0 ? `${Number(a.zScore).toFixed(2)}R` : "-"}
                          </TableCell>
                          <TableCell className="text-center">
                            <Badge
                              variant="outline"
                              className={cn(
                                "font-mono text-[10px]",
                                act === "BUY" || act === "BULL_BIAS"
                                  ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                                  : act === "SELL" || act === "BEAR_BIAS"
                                  ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
                                  : "bg-zinc-800 text-zinc-400 border-zinc-700"
                              )}
                            >
                              {act === "BUY" ? "LONG EXECUTE 🟢" : act === "SELL" ? "SHORT EXECUTE 🔴" : act}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
