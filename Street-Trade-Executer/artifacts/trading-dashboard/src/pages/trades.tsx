import { useState } from "react";
import { useGetTrades, getGetTradesQueryKey } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCryptoPrice, formatUsdt, formatPktDateTime } from "@/lib/utils";

export default function Trades() {
  const [status, setStatus] = useState<"ALL" | "OPEN" | "CLOSED">("ALL");

  const { data: trades, isLoading } = useGetTrades(
    { limit: 100, status: status !== "ALL" ? status : undefined },
    { query: { queryKey: getGetTradesQueryKey({ limit: 100, status: status !== "ALL" ? status : undefined }) } }
  );

  return (
    <div className="flex flex-col h-full overflow-auto bg-background p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Futures Trade History</h2>
          <p className="text-sm text-muted-foreground">Single-order Pure SMC execution &amp; realized USDT logs (PKT Timezone)</p>
        </div>
        <Select value={status} onValueChange={(val: any) => setStatus(val)}>
          <SelectTrigger className="w-[150px] font-mono text-xs">
            <SelectValue placeholder="Filter Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL" className="font-mono text-xs">ALL STATUS</SelectItem>
            <SelectItem value="OPEN" className="font-mono text-xs">OPEN ONLY</SelectItem>
            <SelectItem value="CLOSED" className="font-mono text-xs">CLOSED ONLY</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="bg-card border-border">
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-6 space-y-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : !trades || trades.length === 0 ? (
            <div className="text-sm text-muted-foreground py-12 text-center font-mono">
              Clean post-SMC slate active — no closed or open trades since reset yet.
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow className="border-border">
                  <TableHead className="font-mono text-xs">TICKET</TableHead>
                  <TableHead className="font-mono text-xs">TIME (PKT)</TableHead>
                  <TableHead className="font-mono text-xs">COIN</TableHead>
                  <TableHead className="font-mono text-xs">SIDE</TableHead>
                  <TableHead className="font-mono text-xs text-right">QTY</TableHead>
                  <TableHead className="font-mono text-xs text-right">ENTRY</TableHead>
                  <TableHead className="font-mono text-xs text-right">EXIT</TableHead>
                  <TableHead className="font-mono text-xs text-right">SL / TP</TableHead>
                  <TableHead className="font-mono text-xs text-right">P&amp;L (USDT)</TableHead>
                  <TableHead className="font-mono text-xs text-center">STATUS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trades.map((trade: any) => (
                  <TableRow key={trade.ticket} className="border-border hover:bg-muted/30">
                    <TableCell className="font-mono text-xs text-muted-foreground">#{trade.ticket}</TableCell>
                    <TableCell className="font-mono text-xs">
                      <div className="flex flex-col">
                        <span>{formatPktDateTime(trade.entryTime)}</span>
                        {trade.closeTime && <span className="text-muted-foreground/70">{formatPktDateTime(trade.closeTime)}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono font-bold">{trade.symbol}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("rounded-sm text-[10px] font-mono", trade.orderType === "BUY" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-rose-500/10 text-rose-400 border-rose-500/30")}>
                        {trade.orderType === "BUY" ? "LONG" : "SHORT"}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-right">{Number(trade.lots)}</TableCell>
                    <TableCell className="font-mono text-right">${formatCryptoPrice(trade.entryPrice)}</TableCell>
                    <TableCell className="font-mono text-right">{trade.closePrice ? `$${formatCryptoPrice(trade.closePrice)}` : "-"}</TableCell>
                    <TableCell className="font-mono text-[10px] text-right">
                      <span className="text-rose-400">{trade.sl ? formatCryptoPrice(trade.sl) : "-"}</span>
                      {" / "}
                      <span className="text-emerald-400">{trade.tp ? formatCryptoPrice(trade.tp) : "-"}</span>
                    </TableCell>
                    <TableCell className={cn("font-mono text-right font-bold", (trade.profit ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {trade.profit != null ? formatUsdt(trade.profit, true) : "-"}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="outline" className={cn("rounded-sm text-[10px] font-mono", trade.status === "OPEN" ? "bg-blue-500/10 text-blue-400 border-blue-500/30" : "bg-zinc-500/10 text-zinc-400")}>
                        {trade.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
