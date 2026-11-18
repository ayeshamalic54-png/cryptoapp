import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCryptoPrice } from "@/lib/utils";
import { getApiUrl } from "@/lib/api";
import { TOP_10_CRYPTO_COINS } from "@/components/BinanceCoinSearch";
import { useToast } from "@/hooks/use-toast";
import { TrendingUp, TrendingDown, Search, Star } from "lucide-react";

export default function Markets() {
  const [search, setSearch] = useState("");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const topSet = new Set(TOP_10_CRYPTO_COINS);

  const { data: favData } = useQuery<{ favoritePairs: string[] }>({
    queryKey: ["favorites-list"],
    queryFn: async () => {
      const res = await fetch(getApiUrl("/api/favorites"));
      if (!res.ok) return { favoritePairs: [] };
      return res.json();
    },
    refetchInterval: 8000,
  });
  const favSet = new Set((favData?.favoritePairs ?? []).map((s) => s.toUpperCase()));

  const handleToggleFav = async (e: React.MouseEvent, sym: string) => {
    e.stopPropagation();
    try {
      const res = await fetch(getApiUrl("/api/favorites/toggle"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast({
        title: json.action === "added" ? `★ ${json.symbol} Added to Favorites` : `${json.symbol} Removed from Favorites`,
        description: json.action === "added" ? "Live M15+M5 SMC scanner & chart activated." : "Updated scanner watchlist.",
      });
      await queryClient.invalidateQueries({ queryKey: ["favorites-list"] });
    } catch {
      toast({ title: "Failed to update favorite", variant: "destructive" });
    }
  };

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
            const isFav = favSet.has(p.symbol.toUpperCase());
            return (
              <Card
                key={p.symbol}
                onClick={() => navigate(`/?symbol=${encodeURIComponent(p.symbol)}`)}
                className={cn(
                  "bg-card border-border cursor-pointer transition-colors hover:border-indigo-500/60",
                  isFav ? "border-amber-500/50" : isTop && "border-emerald-500/30"
                )}
              >
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-1">
                    <span className="font-mono font-bold text-sm">{p.symbol}</span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => void handleToggleFav(e, p.symbol)}
                        className={cn(
                          "p-0.5 rounded hover:bg-zinc-800 transition-colors",
                          isFav ? "text-amber-400" : "text-zinc-500 hover:text-amber-300"
                        )}
                        title={isFav ? "Remove from Favorites" : "Add to Favorites & Live Scanner"}
                      >
                        <Star className={cn("h-3.5 w-3.5", isFav && "fill-amber-400")} />
                      </button>
                      <Badge variant="outline" className={cn("text-[9px] font-mono", isTop ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20")}>
                        {isTop ? "TOP 10" : p.source}
                      </Badge>
                    </div>
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
