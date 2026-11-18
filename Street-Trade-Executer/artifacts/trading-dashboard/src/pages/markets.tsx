import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCryptoPrice } from "@/lib/utils";
import { getApiUrl } from "@/lib/api";
import { TOP_10_CRYPTO_COINS } from "@/components/BinanceCoinSearch";
import { TrendingUp, TrendingDown, Search } from "lucide-react";

export default function Markets() {
  const [search, setSearch] = useState("");
  const topSet = new Set(TOP_10_CRYPTO_COINS);

  const { data: prices, isLoading, dataUpdatedAt } = useQuery<any[]>({
    queryKey: ["binance-futures-markets", search],
    queryFn: async () => {
      const url = search.trim()
        ? `/api/prices?q=${encodeURIComponent(search.trim().toUpperCase())}&limit=100`
        : `/api/prices?limit=60`;
      const res = await fetch(getApiUrl(url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 8000,
  });

  return (
    <div className="flex flex-col h-full overflow-auto bg-background p-4 sm:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Binance USDT-M Futures Markets</h2>
          <p className="text-sm text-muted-foreground">
            Top 10 high-volatility coins pinned first + search all 560+ Binance perpetuals
            {dataUpdatedAt ? ` · Updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ""}
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-zinc-400 absolute left-2.5 top-2.5" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value.toUpperCase())}
            placeholder="Search coin (BTC, SOL, PEPE...)"
            className="pl-8 font-mono text-xs bg-zinc-950 uppercase"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : !prices?.length ? (
        <div className="text-center text-muted-foreground py-12 font-mono">No matching Binance USDT-M coins found</div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {prices.map((p) => {
            const pct = p.changePct24h ?? 0;
            const up = pct > 0;
            const down = pct < 0;
            const isTop = topSet.has(p.symbol);
            return (
              <Card key={p.symbol} className={cn("bg-card border-border", isTop && "border-emerald-500/30")}>
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-1">
                    <span className="font-mono font-bold text-sm">{p.symbol}</span>
                    <Badge variant="outline" className={cn("text-[9px] font-mono", isTop ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20")}>
                      {isTop ? "TOP 10" : p.source}
                    </Badge>
                  </div>
                  <div className={cn("text-lg font-mono font-bold", up ? "text-emerald-400" : down ? "text-rose-400" : "text-foreground")}>
                    ${formatCryptoPrice(p.price)}
                  </div>
                  <div className={cn("flex items-center gap-1 text-xs font-mono", up ? "text-emerald-400" : down ? "text-rose-400" : "text-muted-foreground")}>
                    {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {up ? "+" : ""}
                    {Number(pct).toFixed(2)}% (24h)
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
