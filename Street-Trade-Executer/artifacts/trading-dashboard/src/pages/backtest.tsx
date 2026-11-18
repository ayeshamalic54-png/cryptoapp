import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Play, TrendingUp, Award, DollarSign, Activity, Shield } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn, formatCryptoPrice, formatUsdt, formatPktDateTime } from "@/lib/utils";
import { getApiUrl } from "@/lib/api";
import { BinanceCoinSearch } from "@/components/BinanceCoinSearch";

interface CryptoTradeSim {
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
  reason: string;
  entryTime: string;
  exitTime: string;
}

interface CryptoBacktestResponse {
  symbol: string;
  accountMode: string;
  leverage: number;
  maxMarginPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  avgRrr: number;
  maxDrawdownPct: number;
  initialBalance: number;
  finalBalance: number;
  netProfit: number;
  profitFactor: number;
  equityCurve: Array<{ time: string; balance: number }>;
  trades: CryptoTradeSim[];
}

export default function Backtest() {
  const { toast } = useToast();
  const isReadOnly = localStorage.getItem("wasee_role")?.toLowerCase() === "user";

  const [symbol, setSymbol] = useState("BTCUSDT");
  const [accountMode, setAccountMode] = useState<"PROP_FIRM" | "PERSONAL">("PROP_FIRM");
  const [initialBalance, setInitialBalance] = useState("10000");
  const [leverage, setLeverage] = useState("5");
  const [riskPercent, setRiskPercent] = useState("1.0");
  const [maxMarginPct, setMaxMarginPct] = useState("80");
  const [maxSlPct, setMaxSlPct] = useState("1.2");
  const [minRrr, setMinRrr] = useState("1.85");
  const [days, setDays] = useState("14");
  const [sessionFilterEnabled, setSessionFilterEnabled] = useState(false);
  const [breakevenEnabled, setBreakevenEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<CryptoBacktestResponse | null>(null);

  const applyMode = (mode: "PROP_FIRM" | "PERSONAL", bal?: string) => {
    setAccountMode(mode);
    if (mode === "PROP_FIRM") {
      setInitialBalance("10000");
      setRiskPercent("1.0");
      setLeverage("5");
    } else {
      setInitialBalance(bal || "100");
      setRiskPercent(bal === "300" ? "2.0" : "3.0");
      setLeverage("5");
    }
  };

  const handleRunBacktest = async () => {
    setLoading(true);
    try {
      const res = await fetch(getApiUrl("/api/backtest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          accountMode,
          initialBalance: parseFloat(initialBalance) || 10000,
          leverage: parseInt(leverage, 10) || 5,
          riskPercent: parseFloat(riskPercent) || 1.0,
          maxMarginPct: Math.min(80, parseFloat(maxMarginPct) || 80),
          maxSlPct: parseFloat(maxSlPct) || 1.2,
          minRrr: parseFloat(minRrr) || 1.85,
          days: parseInt(days, 10) || 14,
          sessionFilterEnabled,
          breakevenEnabled,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Backtest failed");
      }
      const data = (await res.json()) as CryptoBacktestResponse;
      setResults(data);
      toast({
        title: `9-Step SMC Simulation Complete`,
        description: `${data.symbol}: ${data.totalTrades} trades | Win Rate ${data.winRate}% | Net ${formatUsdt(data.netProfit, true)}`,
      });
    } catch (err: any) {
      toast({ title: "Backtest Failed", description: err?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-auto bg-background p-4 sm:p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Crypto Futures Pure 9-Condition SMC Backtester
        </h2>
        <p className="text-sm text-muted-foreground">
          Zero lookahead M15 + M5 Binance Futures simulation · Test Top 10 coins OR search any Binance perpetual
        </p>
      </div>

      {/* Control Panel */}
      <Card className="bg-card border-border border-t-2 border-t-indigo-500/70">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-muted-foreground uppercase tracking-wider font-mono">
            Strategy &amp; Capital Configuration
          </CardTitle>
          <CardDescription className="text-xs">
            S1 M15 Bias → S2 M5 Sweep → S3 CHoCH → S4 Displacement FVG → S5 Closed Retest → S6 Rejection → S7 Close → S8 Sweep SL → S9 Opposing M15 Target (≥1.85R)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <BinanceCoinSearch
            selectedSymbol={symbol}
            onSelectSymbol={(sym) => setSymbol(sym)}
            title="Select Backtest Coin (Top 10 or Search All Binance Perpetuals)"
          />

          {/* Account Mode Pills */}
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
            <span className="text-xs font-mono text-zinc-400">Account Simulation Mode:</span>
            <Button type="button" size="sm" variant={accountMode === "PROP_FIRM" ? "default" : "outline"} onClick={() => applyMode("PROP_FIRM")} className="h-7 text-xs font-mono">
              Blue Guardian Prop ($10k)
            </Button>
            <Button type="button" size="sm" variant={accountMode === "PERSONAL" && initialBalance === "50" ? "default" : "outline"} onClick={() => applyMode("PERSONAL", "50")} className="h-7 text-xs font-mono">
              Personal $50 USDT
            </Button>
            <Button type="button" size="sm" variant={accountMode === "PERSONAL" && initialBalance === "100" ? "default" : "outline"} onClick={() => applyMode("PERSONAL", "100")} className="h-7 text-xs font-mono">
              Personal $100 USDT
            </Button>
            <Button type="button" size="sm" variant={accountMode === "PERSONAL" && initialBalance === "300" ? "default" : "outline"} onClick={() => applyMode("PERSONAL", "300")} className="h-7 text-xs font-mono">
              Personal $300 USDT
            </Button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 items-end">
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-mono block mb-1">Capital (USDT)</label>
              <Input value={initialBalance} onChange={(e) => setInitialBalance(e.target.value)} className="font-mono text-xs bg-zinc-950" />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-mono block mb-1">Leverage (x)</label>
              <Input value={leverage} onChange={(e) => setLeverage(e.target.value)} className="font-mono text-xs bg-zinc-950" />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-mono block mb-1">Risk / Trade (%)</label>
              <Input value={riskPercent} onChange={(e) => setRiskPercent(e.target.value)} className="font-mono text-xs bg-zinc-950" />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-mono block mb-1">Max Margin Cap %</label>
              <Input value={maxMarginPct} onChange={(e) => setMaxMarginPct(e.target.value)} className="font-mono text-xs bg-zinc-950" />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-mono block mb-1">Max SL (%)</label>
              <Input value={maxSlPct} onChange={(e) => setMaxSlPct(e.target.value)} className="font-mono text-xs bg-zinc-950" />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-mono block mb-1">Min R:R</label>
              <Input value={minRrr} onChange={(e) => setMinRrr(e.target.value)} className="font-mono text-xs bg-zinc-950" />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400 uppercase font-mono block mb-1">Lookback Days</label>
              <select value={days} onChange={(e) => setDays(e.target.value)} className="w-full h-9 rounded-md border border-input bg-zinc-950 px-2.5 text-xs font-mono">
                <option value="3">3 Days</option>
                <option value="7">7 Days</option>
                <option value="14">14 Days</option>
                <option value="30">30 Days</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-border">
            <div className="flex flex-wrap items-center gap-6">
              <label className="flex items-center gap-2 text-xs font-mono cursor-pointer">
                <Switch checked={sessionFilterEnabled} onCheckedChange={setSessionFilterEnabled} />
                <span>PKT Session Guard (12-4 PM &amp; 6-10 PM)</span>
              </label>
              <label className="flex items-center gap-2 text-xs font-mono cursor-pointer">
                <Switch checked={breakevenEnabled} onCheckedChange={setBreakevenEnabled} />
                <span>One-Time Risk-Free Breakeven (+1.0R / 60m)</span>
              </label>
            </div>
            <Button onClick={handleRunBacktest} disabled={loading || isReadOnly} className="bg-indigo-600 hover:bg-indigo-500 font-mono text-xs font-bold gap-2">
              <Play className="w-3.5 h-3.5 fill-current" />
              {loading ? `SIMULATING ${symbol}...` : `RUN 9-STEP SMC BACKTEST (${symbol})`}
            </Button>
          </div>
        </CardContent>
      </Card>

      {results && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            <Card className="bg-card border-border border-t-2 border-t-blue-500">
              <CardHeader className="pb-1"><CardTitle className="text-[10px] text-muted-foreground uppercase font-mono">Total Trades</CardTitle></CardHeader>
              <CardContent>
                <div className="text-xl font-mono font-bold text-blue-400">{results.totalTrades}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{results.wins}W / {results.losses}L · {results.breakevens} BE</div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border border-t-2 border-t-green-500">
              <CardHeader className="pb-1"><CardTitle className="text-[10px] text-muted-foreground uppercase font-mono">Win Rate</CardTitle></CardHeader>
              <CardContent>
                <div className="text-xl font-mono font-bold text-emerald-400">{results.winRate}%</div>
                <div className="text-[10px] text-muted-foreground font-mono">Avg R:R: {results.avgRrr}R</div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border border-t-2 border-t-emerald-500">
              <CardHeader className="pb-1"><CardTitle className="text-[10px] text-muted-foreground uppercase font-mono">Net Profit</CardTitle></CardHeader>
              <CardContent>
                <div className={cn("text-xl font-mono font-bold", results.netProfit >= 0 ? "text-emerald-400" : "text-rose-400")}>
                  {formatUsdt(results.netProfit, true)}
                </div>
                <div className="text-[10px] text-muted-foreground font-mono">After taker fees</div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border border-t-2 border-t-purple-500">
              <CardHeader className="pb-1"><CardTitle className="text-[10px] text-muted-foreground uppercase font-mono">Final Balance</CardTitle></CardHeader>
              <CardContent>
                <div className="text-xl font-mono font-bold text-purple-400">{formatUsdt(results.finalBalance)}</div>
                <div className="text-[10px] text-muted-foreground font-mono">Profit Factor: {results.profitFactor}</div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border border-t-2 border-t-rose-500">
              <CardHeader className="pb-1"><CardTitle className="text-[10px] text-muted-foreground uppercase font-mono">Max Drawdown</CardTitle></CardHeader>
              <CardContent>
                <div className="text-xl font-mono font-bold text-rose-400">{results.maxDrawdownPct}%</div>
                <div className="text-[10px] text-muted-foreground font-mono">Cap ≤ {results.maxMarginPct}% Margin</div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border border-t-2 border-t-cyan-500">
              <CardHeader className="pb-1"><CardTitle className="text-[10px] text-muted-foreground uppercase font-mono">Config Mode</CardTitle></CardHeader>
              <CardContent>
                <div className="text-sm font-mono font-bold text-cyan-400">{results.accountMode}</div>
                <div className="text-[10px] text-muted-foreground font-mono">{results.leverage}x · Start ${results.initialBalance}</div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="bg-card border-border">
              <CardHeader><CardTitle className="text-xs text-muted-foreground uppercase font-mono">Equity Curve (USDT)</CardTitle></CardHeader>
              <CardContent className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={results.equityCurve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                    <XAxis dataKey="time" tickFormatter={(v) => new Date(v).toLocaleDateString("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "2-digit" })} stroke="#71717a" fontSize={10} />
                    <YAxis stroke="#71717a" fontSize={10} domain={["auto", "auto"]} />
                    <Tooltip labelFormatter={(v) => formatPktDateTime(String(v))} contentStyle={{ backgroundColor: "#090d16", borderColor: "#27272a", fontFamily: "monospace", fontSize: 11 }} />
                    <Line type="monotone" dataKey="balance" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2 bg-card border-border">
              <CardHeader><CardTitle className="text-xs text-muted-foreground uppercase font-mono">Simulated Futures Trades (PKT Timezone)</CardTitle></CardHeader>
              <CardContent className="p-0 max-h-[300px] overflow-y-auto">
                <Table>
                  <TableHeader className="bg-muted/40 sticky top-0">
                    <TableRow>
                      <TableHead className="font-mono text-[10px]">ENTRY (PKT)</TableHead>
                      <TableHead className="font-mono text-[10px]">SIDE</TableHead>
                      <TableHead className="font-mono text-[10px] text-right">ENTRY / EXIT</TableHead>
                      <TableHead className="font-mono text-[10px] text-right">MARGIN %</TableHead>
                      <TableHead className="font-mono text-[10px] text-right">R:R</TableHead>
                      <TableHead className="font-mono text-[10px] text-right">PNL (USDT)</TableHead>
                      <TableHead className="font-mono text-[10px] text-center">RESULT</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.trades.map((t, idx) => (
                      <TableRow key={idx} className="border-border">
                        <TableCell className="font-mono text-[10px] text-zinc-400 whitespace-nowrap">{formatPktDateTime(t.entryTime)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn("text-[9px] font-mono", t.type === "BUY" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-rose-500/15 text-rose-400 border-rose-500/30")}>
                            {t.type === "BUY" ? "LONG" : "SHORT"}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-[10px] text-right">
                          {formatCryptoPrice(t.entryPrice)} → {formatCryptoPrice(t.exitPrice)}
                        </TableCell>
                        <TableCell className="font-mono text-[10px] text-right text-sky-400">{t.marginPct}%</TableCell>
                        <TableCell className="font-mono text-[10px] text-right">{t.achievedRrr}R</TableCell>
                        <TableCell className={cn("font-mono text-[10px] text-right font-bold", t.profitUsd >= 0 ? "text-emerald-400" : "text-rose-400")}>
                          {formatUsdt(t.profitUsd, true)}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="outline" className={cn("text-[9px] font-mono", t.reason === "TP_HIT" ? "bg-emerald-500/10 text-emerald-400" : t.reason === "BREAKEVEN_LOCKED" ? "bg-cyan-500/10 text-cyan-400" : "bg-rose-500/10 text-rose-400")}>
                            {t.reason}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
