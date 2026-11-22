import { useGetSignals, getGetSignalsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCryptoPrice, formatUsdt, formatPktDateTime } from "@/lib/utils";

export default function Signals() {
  const { data: signals, isLoading } = useGetSignals(
    { limit: 100 },
    { query: { queryKey: getGetSignalsQueryKey({ limit: 100 }) } }
  );

  return (
    <div className="flex flex-col h-full overflow-auto bg-background p-4 sm:p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">Pure SMC Signal History</h2>
        <p className="text-sm text-muted-foreground">Verified Binance Futures institutional signals (M15 Bias · Sweep · CHoCH · FVG · Opposing Liquidity Target)</p>
      </div>

      <Card className="bg-card border-border">
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-6 space-y-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : !signals || signals.length === 0 ? (
            <div className="text-sm text-muted-foreground py-12 text-center font-mono">
              Clean post-SMC slate active — awaiting next verified Futures signal.
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow className="border-border">
                  <TableHead className="font-mono text-xs">TIME (PKT)</TableHead>
                  <TableHead className="font-mono text-xs">COIN</TableHead>
                  <TableHead className="font-mono text-xs">SIDE</TableHead>
                  <TableHead className="font-mono text-xs text-right">ENTRY ($)</TableHead>
                  <TableHead className="font-mono text-xs text-right">SL ($)</TableHead>
                  <TableHead className="font-mono text-xs text-right">M15 TARGET TP ($)</TableHead>
                  <TableHead className="font-mono text-xs text-right">R:R</TableHead>
                  <TableHead className="font-mono text-xs text-right">MARGIN %</TableHead>
                  <TableHead className="font-mono text-xs text-right">P&amp;L (USDT)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {signals.map((sig: any) => {
                  const isLong = String(sig.action).toUpperCase().includes("BUY");
                  return (
                    <TableRow key={sig.id} className="border-border hover:bg-muted/30">
                      <TableCell className="font-mono text-xs text-zinc-400">{formatPktDateTime(sig.timestamp)}</TableCell>
                      <TableCell className="font-mono font-bold text-xs">{sig.symbolA}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("text-[10px] font-mono", isLong ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-rose-500/15 text-rose-400 border-rose-500/30")}>
                          {isLong ? "LONG (BUY)" : "SHORT (SELL)"}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-right">${formatCryptoPrice(sig.priceA)}</TableCell>
                      <TableCell className="font-mono text-xs text-right text-rose-400">${formatCryptoPrice(sig.beta)}</TableCell>
                      <TableCell className="font-mono text-xs text-right text-emerald-400">${formatCryptoPrice(sig.priceB)}</TableCell>
                      <TableCell className="font-mono text-xs text-right text-sky-400 font-bold">{Number(sig.zScore || 0).toFixed(2)}R</TableCell>
                      <TableCell className="font-mono text-xs text-right">{Number(sig.obi || 0).toFixed(1)}%</TableCell>
                      <TableCell className={cn("font-mono text-xs text-right font-bold", (sig.totalProfit ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                        {sig.totalProfit != null ? formatUsdt(sig.totalProfit, true) : "-"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
