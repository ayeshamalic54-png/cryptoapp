import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Activity, RefreshCw, RotateCcw } from "lucide-react";
import { cn, formatPktDateTime, formatUsdt } from "@/lib/utils";
import { getApiUrl } from "@/lib/api";
import { useLiveDashboard } from "@/hooks/use-ws";
import { useToast } from "@/hooks/use-toast";

interface DailyMetricRow {
  tradingDate: string;
  startEquity: number;
  currentEquity: number;
  maxDrawdownPercent: number;
  tradesToday: number;
  wins?: number;
  losses?: number;
  pnl: number;
}

interface EquityCurvePoint {
  label: string;
  pktTime: string;
  tradePnl: number;
  cumPnl: number;
  symbol: string;
  orderType: string;
}

interface RecentClosedTrade {
  symbol: string;
  orderType: string;
  lots: number;
  profit: number;
  closeTime: string;
  pktDate: string;
  comment: string;
}

interface LiveMetricsSummary {
  days: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  bestTrade: number;
  worstTrade: number;
  profitFactor: number;
  maxDrawdown: number;
  liveEquity: number;
  initialBalance?: number;
  overallDrawdown?: number;
  accountNetProfit?: number;
  accountNetPct?: number;
  dailyDrawdown?: number;
  floatingProfit: number;
  accountMode?: string;
  leverage?: number;
  metricsResetAt?: string | null;
  equityCurve?: EquityCurvePoint[];
  recentTrades: RecentClosedTrade[];
}

function formatShortPktDate(dateStr: string): string {
  const parts = String(dateStr).slice(0, 10).split("-");
  return parts.length === 3 ? `${parts[2]}/${parts[1]}` : dateStr;
}

const CurveTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const pt = payload[0]?.payload as EquityCurvePoint | undefined;
    if (!pt) return null;
    const isPos = pt.cumPnl >= 0;
    return (
      <div className="bg-background/95 border border-border p-3 rounded-lg shadow-2xl font-mono text-xs space-y-1">
        <p className="text-muted-foreground">
          {pt.label} {pt.symbol !== "BASELINE" ? `· ${pt.symbol} (${pt.orderType})` : ""}
        </p>
        {pt.pktTime && <p className="text-[10px] text-zinc-400">{pt.pktTime} PKT</p>}
        <p className={cn("font-bold text-sm", isPos ? "text-emerald-400" : "text-rose-400")}>
          Cumulative: {formatUsdt(pt.cumPnl, true)}
        </p>
        {pt.symbol !== "BASELINE" && (
          <p className={cn("text-[11px]", pt.tradePnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
            Trade: {formatUsdt(pt.tradePnl, true)}
          </p>
        )}
      </div>
    );
  }
  return null;
};

const BarTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const row = payload[0]?.payload as DailyMetricRow | undefined;
    if (!row) return null;
    return (
      <div className="bg-background/95 border border-border p-3 rounded-lg shadow-2xl font-mono text-xs space-y-1">
        <p className="text-muted-foreground">{String(label)} (PKT)</p>
        <p className={cn("font-bold text-sm", row.pnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
          Realized P&amp;L: {formatUsdt(row.pnl, true)}
        </p>
        <p className="text-[11px] text-zinc-400">
          Trades: {row.tradesToday} ({row.wins ?? 0}W / {row.losses ?? 0}L) · DD: {row.maxDrawdownPercent.toFixed(2)}%
        </p>
      </div>
    );
  }
  return null;
};

const PERIOD_OPTIONS = [
  { label: "7D", days: 7 },
  { label: "14D", days: 14 },
  { label: "30D", days: 30 },
  { label: "ALL", days: 0 },
];

export default function Metrics() {
  const [days, setDays] = useState<number>(30);
  const [chartView, setChartView] = useState<"curve" | "bars">("curve");
  const [isResetting, setIsResetting] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: wsData, wsConnected } = useLiveDashboard();
  const isReadOnly = localStorage.getItem("wasee_role")?.toLowerCase() === "user";

  const { data: metrics, isLoading: loadingMetrics, refetch: refetchMetrics } = useQuery<DailyMetricRow[]>({
    queryKey: ["crypto-metrics", days],
    queryFn: async () => {
      const res = await fetch(getApiUrl(`/api/metrics?days=${days}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 2500,
  });

  const { data: summary, isLoading: loadingSummary, refetch: refetchSummary } = useQuery<LiveMetricsSummary>({
    queryKey: ["crypto-metrics-summary", days],
    queryFn: async () => {
      const res = await fetch(getApiUrl(`/api/metrics/summary?days=${days}`));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 2500,
  });

  const firstTicket = wsData?.recentTrades?.[0]?.ticket;
  useEffect(() => {
    if (!wsData) return;
    void queryClient.invalidateQueries({ queryKey: ["crypto-metrics"] });
    void queryClient.invalidateQueries({ queryKey: ["crypto-metrics-summary"] });
  }, [wsData?.tradesToday, wsData?.activePositions?.length, firstTicket, queryClient]);

  const handleResetMetrics = async () => {
    if (isReadOnly || isResetting) return;
    if (!window.confirm("Reset Metrics & P&L Curve cleanly from next closed trade?")) return;
    setIsResetting(true);
    try {
      const res = await fetch(getApiUrl("/api/metrics/reset"), { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["crypto-metrics"] }),
        queryClient.invalidateQueries({ queryKey: ["crypto-metrics-summary"] }),
      ]);
      toast({ title: "Metrics Blanked Cleanly", description: "Tracking fresh from the next Crypto Futures trade." });
    } catch {
      toast({ title: "Reset failed", variant: "destructive" });
    } finally {
      setIsResetting(false);
    }
  };

  const liveEq = wsData?.equity ?? summary?.liveEquity ?? 0;
  const liveInitial = wsData?.initialBalance ?? summary?.initialBalance ?? 10000;
  const liveAccountNetProfit = liveInitial > 0 ? Number((liveEq - liveInitial).toFixed(2)) : summary?.accountNetProfit ?? 0;
  const liveAccountNetPct = liveInitial > 0 ? Number(((liveAccountNetProfit / liveInitial) * 100).toFixed(2)) : summary?.accountNetPct ?? 0;
  const liveOverallDd = wsData?.overallDrawdown ?? summary?.overallDrawdown ?? 0;
  const liveDailyDd = wsData?.drawdownPercent ?? summary?.dailyDrawdown ?? 0;
  const liveFloat = wsData?.floatingProfit ?? summary?.floatingProfit ?? 0;

  const rawCurve = summary?.equityCurve ?? [];
  const hasRealTrades = rawCurve.length > 0;
  const curveData: EquityCurvePoint[] = hasRealTrades
    ? rawCurve
    : [
        { label: "Baseline", pktTime: "", tradePnl: 0, cumPnl: 0, symbol: "BASELINE", orderType: "BASE" },
        { label: "Next Trade", pktTime: "", tradePnl: 0, cumPnl: 0, symbol: "BASELINE", orderType: "BASE" },
      ];
  const curveStroke = (summary?.totalPnl ?? 0) >= 0 ? "#10B981" : "#F43F5E";
  const barData = (metrics ? [...metrics].reverse() : []).map((d) => ({
    ...d,
    winPnl: d.pnl >= 0 ? d.pnl : 0,
    lossPnl: d.pnl < 0 ? d.pnl : 0,
  }));

  return (
    <div className="flex flex-col h-full overflow-auto bg-background p-4 sm:p-6 space-y-5 w-full max-w-[1600px] mx-auto">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Binance Futures Performance Metrics</h2>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Real-time USDT realized P&amp;L curve, win rate &amp; drawdown (PKT Timezone · Clean Post-SMC Isolation)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px] px-2.5 py-1 flex items-center gap-1.5 bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
            <Activity className="h-3 w-3 animate-pulse" />
            {wsConnected ? "LIVE WS + 2.5s SYNC" : "2.5s POLL"}
          </Badge>

          {summary?.metricsResetAt && (
            <Badge variant="outline" className="font-mono text-[10px] px-2 py-1 border-zinc-700 text-zinc-400">
              Clean From: {formatPktDateTime(summary.metricsResetAt)}
            </Badge>
          )}

          <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-md p-0.5">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                onClick={() => setDays(opt.days)}
                className={cn(
                  "px-2.5 py-1 rounded-sm font-mono text-[11px] font-bold transition-colors",
                  days === opt.days ? "bg-primary text-primary-foreground" : "text-zinc-400 hover:text-foreground"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {!isReadOnly && (
            <Button type="button" variant="outline" size="sm" disabled={isResetting} onClick={handleResetMetrics} className="h-7 px-2.5 font-mono text-[11px] border-rose-500/30 text-rose-300 hover:bg-rose-500/15">
              <RotateCcw className="h-3 w-3 mr-1" /> Reset / Blank
            </Button>
          )}

          <button type="button" onClick={() => { void refetchMetrics(); void refetchSummary(); }} className="p-1.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-foreground">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Live Snapshot Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Card className="bg-zinc-900/60 border-zinc-800">
          <CardContent className="p-3 sm:p-4 space-y-1">
            <div className="text-[10px] text-zinc-500 uppercase font-mono">Binance Futures Equity</div>
            <div className="text-lg font-mono font-bold text-sky-400">{formatUsdt(liveEq)}</div>
            <div className="text-[10px] text-zinc-500 font-mono">Base: {formatUsdt(liveInitial)}</div>
          </CardContent>
        </Card>
        <Card className="bg-zinc-900/60 border-zinc-800">
          <CardContent className="p-3 sm:p-4 space-y-1">
            <div className="text-[10px] text-zinc-500 uppercase font-mono">Account Net / DD</div>
            <div className={cn("text-base font-mono font-bold", liveAccountNetProfit >= 0 ? "text-emerald-400" : "text-amber-400")}>
              {formatUsdt(liveAccountNetProfit, true)} ({liveAccountNetPct.toFixed(2)}%)
            </div>
            <div className="text-[10px] text-zinc-400 font-mono">Daily DD: {liveDailyDd.toFixed(2)}% · Static: {liveOverallDd.toFixed(2)}%</div>
          </CardContent>
        </Card>
        <Card className="bg-zinc-900/60 border-zinc-800">
          <CardContent className="p-3 sm:p-4 space-y-1">
            <div className="text-[10px] text-zinc-500 uppercase font-mono">Floating P&amp;L</div>
            <div className={cn("text-lg font-mono font-bold", liveFloat >= 0 ? "text-emerald-400" : "text-rose-400")}>
              {formatUsdt(liveFloat, true)}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-zinc-900/60 border-zinc-800">
          <CardContent className="p-3 sm:p-4 space-y-1">
            <div className="text-[10px] text-zinc-500 uppercase font-mono">Profit Factor</div>
            <div className="text-lg font-mono font-bold text-cyan-400">{summary ? summary.profitFactor.toFixed(2) : "—"}</div>
          </CardContent>
        </Card>
        <Card className="col-span-2 sm:col-span-1 bg-zinc-900/60 border-zinc-800">
          <CardContent className="p-3 sm:p-4 space-y-1">
            <div className="text-[10px] text-zinc-500 uppercase font-mono">Avg Trade P&amp;L</div>
            <div className={cn("text-lg font-mono font-bold", (summary?.avgPnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
              {summary ? formatUsdt(summary.avgPnl, true) : "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Period Realized KPIs */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="bg-card/40 border-border">
            <CardContent className="p-3 sm:p-4 space-y-1">
              <div className="text-[10px] text-muted-foreground uppercase font-mono">Realized P&amp;L</div>
              <div className={cn("text-lg font-mono font-bold", summary.totalPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>{formatUsdt(summary.totalPnl, true)}</div>
            </CardContent>
          </Card>
          <Card className="bg-card/40 border-border">
            <CardContent className="p-3 sm:p-4 space-y-1">
              <div className="text-[10px] text-muted-foreground uppercase font-mono">Win Rate</div>
              <div className="text-lg font-mono font-bold text-indigo-400">{summary.winRate.toFixed(1)}%</div>
            </CardContent>
          </Card>
          <Card className="bg-card/40 border-border">
            <CardContent className="p-3 sm:p-4 space-y-1">
              <div className="text-[10px] text-muted-foreground uppercase font-mono">Max Realized DD</div>
              <div className="text-lg font-mono font-bold text-rose-400">{summary.maxDrawdown.toFixed(2)}%</div>
            </CardContent>
          </Card>
          <Card className="bg-card/40 border-border">
            <CardContent className="p-3 sm:p-4 space-y-1">
              <div className="text-[10px] text-muted-foreground uppercase font-mono">Best / Worst</div>
              <div className="text-sm font-mono font-bold text-emerald-400 truncate">
                {formatUsdt(summary.bestTrade, true)} <span className="text-rose-400 text-xs">/ {formatUsdt(summary.worstTrade)}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="col-span-2 md:col-span-1 bg-card/40 border-border">
            <CardContent className="p-3 sm:p-4 space-y-1">
              <div className="text-[10px] text-muted-foreground uppercase font-mono">Trades (W/L)</div>
              <div className="text-lg font-mono font-bold">{summary.totalTrades} <span className="text-xs text-muted-foreground">({summary.winningTrades}W / {summary.losingTrades}L)</span></div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* P&L Curve + Daily Bars + Days Table */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        <Card className="lg:col-span-2 bg-card/30 border-border/80">
          <CardHeader className="pb-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <CardTitle className="text-xs font-mono uppercase text-muted-foreground">
                {chartView === "curve" ? "Realized Cumulative P&L Curve (USDT)" : "Daily P&L Bars (PKT)"}
              </CardTitle>
              <CardDescription className="text-[11px]">
                {hasRealTrades ? `Showing ${summary?.totalTrades ?? 0} real closed Futures trades` : "Clean baseline active ($0.00 USDT) — updates automatically on next close"}
              </CardDescription>
            </div>
            <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-md p-0.5 self-start">
              <button type="button" onClick={() => setChartView("curve")} className={cn("px-2.5 py-1 rounded-sm font-mono text-[10px] font-bold", chartView === "curve" ? "bg-emerald-600 text-white" : "text-zinc-400")}>P&amp;L Curve</button>
              <button type="button" onClick={() => setChartView("bars")} className={cn("px-2.5 py-1 rounded-sm font-mono text-[10px] font-bold", chartView === "bars" ? "bg-sky-600 text-white" : "text-zinc-400")}>Daily Bars</button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {loadingMetrics || loadingSummary ? (
              <Skeleton className="h-[280px] w-full" />
            ) : chartView === "curve" ? (
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={curveData} margin={{ top: 14, right: 16, left: -8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="label" stroke="#71717a" fontSize={11} fontFamily="monospace" />
                    <YAxis stroke="#71717a" fontSize={11} fontFamily="monospace" domain={hasRealTrades ? ["auto", "auto"] : [-50, 50]} tickFormatter={(v) => `$${v}`} />
                    <RechartsTooltip content={<CurveTooltip />} />
                    <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
                    <Area type="monotone" dataKey="cumPnl" stroke={hasRealTrades ? curveStroke : "#38bdf8"} strokeWidth={2.5} fill={hasRealTrades ? curveStroke : "#38bdf8"} fillOpacity={0.16} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : barData.length === 0 ? (
              <div className="h-[280px] flex items-center justify-center text-xs font-mono text-muted-foreground">
                No closed trades since clean reset yet.
              </div>
            ) : (
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={barData} margin={{ top: 14, right: 16, left: -8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="tradingDate" tickFormatter={formatShortPktDate} stroke="#71717a" fontSize={11} fontFamily="monospace" />
                    <YAxis stroke="#71717a" fontSize={11} fontFamily="monospace" tickFormatter={(v) => `$${v}`} />
                    <RechartsTooltip content={<BarTooltip />} />
                    <ReferenceLine y={0} stroke="#52525b" strokeDasharray="3 3" />
                    <Bar dataKey="winPnl" fill="#10B981" radius={[4, 4, 0, 0]} maxBarSize={42} isAnimationActive={false} />
                    <Bar dataKey="lossPnl" fill="#F43F5E" radius={[0, 0, 4, 4]} maxBarSize={42} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-card/30 border-border/80">
          <CardHeader><CardTitle className="text-xs font-mono uppercase text-muted-foreground">Recent PKT Trading Days</CardTitle></CardHeader>
          <CardContent className="p-0 max-h-[320px] overflow-y-auto">
            {!metrics || metrics.length === 0 ? (
              <div className="p-6 text-center text-xs font-mono text-muted-foreground">Clean baseline active — waiting for next closed Futures trade.</div>
            ) : (
              <Table>
                <TableHeader className="bg-muted/40 sticky top-0">
                  <TableRow>
                    <TableHead className="font-mono text-[10px]">DATE (PKT)</TableHead>
                    <TableHead className="font-mono text-[10px] text-center">TRADES</TableHead>
                    <TableHead className="font-mono text-[10px] text-right">DD%</TableHead>
                    <TableHead className="font-mono text-[10px] text-right">P&amp;L</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {metrics.map((m) => (
                    <TableRow key={m.tradingDate}>
                      <TableCell className="font-mono text-xs text-muted-foreground">{formatShortPktDate(m.tradingDate)}</TableCell>
                      <TableCell className="font-mono text-xs text-center">{m.tradesToday}</TableCell>
                      <TableCell className="font-mono text-xs text-right text-amber-400">{m.maxDrawdownPercent.toFixed(2)}%</TableCell>
                      <TableCell className={cn("font-mono text-xs text-right font-bold", m.pnl >= 0 ? "text-emerald-400" : "text-rose-400")}>{formatUsdt(m.pnl, true)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
