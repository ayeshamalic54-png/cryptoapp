import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { getApiUrl } from "@/lib/api";

export const TOP_10_CRYPTO_COINS = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "ADAUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "SUIUSDT",
];

interface SymbolMeta {
  symbol: string;
  baseAsset: string;
  minNotional: number;
  stepSize: number;
  marketType?: "FUTURES" | "SPOT";
  tradableOnActiveVenue?: boolean;
}

interface BinanceCoinSearchProps {
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  favoriteSymbols?: string[];
  onToggleFavorite?: (symbol: string) => void;
  title?: string;
}

export function BinanceCoinSearch({
  selectedSymbol,
  onSelectSymbol,
  favoriteSymbols = [],
  onToggleFavorite,
  title = "Top 10 High-Volatility Coins & Search Any Binance Coin",
}: BinanceCoinSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolMeta[]>([]);
  const [totalCoins, setTotalCoins] = useState<number>(560);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const favSet = new Set(favoriteSymbols.map((s) => s.toUpperCase()));

  useEffect(() => {
    const trimmed = query.trim().toUpperCase();
    if (!trimmed) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(getApiUrl(`/api/binance/symbols?q=${encodeURIComponent(trimmed)}&limit=30`));
        if (res.ok) {
          const json = await res.json();
          setTotalCoins(json.totalSymbols || 560);
          setResults(json.symbols || []);
          setDropdownOpen(true);
        }
      } catch {
        // silent fallback
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const handleChoose = (sym: string) => {
    const normalized = sym.trim().toUpperCase();
    onSelectSymbol(normalized);
    setQuery("");
    setDropdownOpen(false);
  };

  const handleEnterSubmit = async () => {
    const trimmed = query.trim().toUpperCase();
    if (!trimmed) return;
    if (results[0]?.symbol) {
      handleChoose(results[0].symbol);
      return;
    }
    try {
      const res = await fetch(getApiUrl(`/api/binance/symbols?q=${encodeURIComponent(trimmed)}&limit=5`));
      if (res.ok) {
        const json = await res.json();
        const exact = (json.symbols || []).find(
          (x: SymbolMeta) => x.symbol === trimmed || x.symbol === `${trimmed}USDT` || x.symbol === `1000${trimmed}USDT` || x.baseAsset === trimmed
        );
        if (exact?.symbol) {
          handleChoose(exact.symbol);
          return;
        }
        if (json.symbols?.[0]?.symbol) {
          handleChoose(json.symbols[0].symbol);
          return;
        }
      }
    } catch {}
    handleChoose(trimmed.endsWith("USDT") ? trimmed : `${trimmed}USDT`);
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-bold">
          {title}
        </div>
        <div className="relative w-full sm:w-80">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2.5 pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            onFocus={() => query.trim() && setDropdownOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim()) {
                e.preventDefault();
                void handleEnterSubmit();
              }
            }}
            placeholder={`Search all ${totalCoins}+ Binance coins (PEPE, ZKC, WIF...)`}
            className="pl-8 h-8 text-xs font-mono bg-zinc-950 border-zinc-700 text-zinc-100 uppercase"
          />
          {dropdownOpen && query.trim() && (
            <div className="absolute z-50 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-950 shadow-2xl">
              {searching ? (
                <div className="px-3 py-2 text-xs font-mono text-zinc-400">Searching Binance Markets...</div>
              ) : results.length === 0 ? (
                <div className="flex items-center justify-between px-3 py-2 text-xs font-mono hover:bg-zinc-900">
                  <button
                    type="button"
                    onClick={() => void handleEnterSubmit()}
                    className="text-left text-sky-400 flex-1"
                  >
                    Inspect {query.trim().endsWith("USDT") ? query.trim() : `${query.trim()}USDT`} Live
                  </button>
                  {onToggleFavorite && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        const s = query.trim().endsWith("USDT") ? query.trim() : `${query.trim()}USDT`;
                        onToggleFavorite(s);
                      }}
                      className="ml-2 p-1 rounded hover:bg-zinc-800 text-amber-400"
                      title="Add to Favorites"
                    >
                      <Star className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ) : (
                results.map((item) => {
                  const isFav = favSet.has(item.symbol.toUpperCase());
                  return (
                    <div
                      key={item.symbol}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono hover:bg-zinc-900 border-b border-zinc-900 last:border-b-0"
                    >
                      <button
                        type="button"
                        onClick={() => handleChoose(item.symbol)}
                        className="flex-1 flex items-center justify-between text-left"
                      >
                        <span className="font-bold text-white flex items-center gap-1.5">
                          {item.symbol}
                          {item.marketType === "SPOT" && (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30">SPOT</span>
                          )}
                        </span>
                        <span className="text-[10px] text-zinc-400 mr-2">Min ${item.minNotional}</span>
                      </button>
                      {onToggleFavorite && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleFavorite(item.symbol);
                            handleChoose(item.symbol);
                          }}
                          className={cn(
                            "p-1 rounded hover:bg-zinc-800 transition-colors",
                            isFav ? "text-amber-400" : "text-zinc-500 hover:text-amber-300"
                          )}
                          title={isFav ? "Remove from Favorites" : "Add to Favorites & Scanner"}
                        >
                          <Star className={cn("w-3.5 h-3.5", isFav && "fill-amber-400")} />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {/* Quick Top 10 Volatile Coins Strip */}
      <div className="flex flex-wrap items-center gap-1.5">
        {TOP_10_CRYPTO_COINS.map((sym) => {
          const active = selectedSymbol.toUpperCase() === sym;
          const isFav = favSet.has(sym);
          return (
            <button
              key={sym}
              type="button"
              onClick={() => handleChoose(sym)}
              className={cn(
                "px-2.5 py-1 rounded text-[11px] font-mono font-bold border transition-all flex items-center gap-1",
                active
                  ? "bg-emerald-600/20 text-emerald-300 border-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.2)]"
                  : "bg-zinc-900/70 text-zinc-400 border-zinc-800 hover:text-white hover:border-zinc-600"
              )}
            >
              {isFav && <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />}
              {sym.replace("USDT", "")}
            </button>
          );
        })}
        {selectedSymbol && !TOP_10_CRYPTO_COINS.includes(selectedSymbol.toUpperCase()) && !favSet.has(selectedSymbol.toUpperCase()) && (
          <Badge className="bg-indigo-600/20 text-indigo-300 border-indigo-500 font-mono text-[11px] px-2.5 py-1">
            {selectedSymbol.toUpperCase()}
          </Badge>
        )}
      </div>

      {/* Persistent User Favorites Strip */}
      {favoriteSymbols.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-zinc-800/80">
          <span className="text-[10px] font-mono uppercase tracking-wider text-amber-400 font-bold flex items-center gap-1 mr-1">
            <Star className="w-3 h-3 fill-amber-400" /> Favorites:
          </span>
          {favoriteSymbols.map((sym) => {
            const norm = sym.toUpperCase();
            const active = selectedSymbol.toUpperCase() === norm;
            return (
              <div
                key={norm}
                className={cn(
                  "flex items-center rounded border text-[11px] font-mono font-bold transition-all overflow-hidden",
                  active
                    ? "bg-amber-500/20 text-amber-200 border-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.2)]"
                    : "bg-zinc-900/80 text-zinc-300 border-zinc-700 hover:border-amber-500/60"
                )}
              >
                <button
                  type="button"
                  onClick={() => handleChoose(norm)}
                  className="px-2 py-0.5 hover:text-white"
                >
                  {norm.replace("USDT", "")}
                </button>
                {onToggleFavorite && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleFavorite(norm);
                    }}
                    className="px-1.5 py-0.5 text-amber-400 hover:text-rose-400 hover:bg-zinc-800/80 border-l border-zinc-800"
                    title={`Remove ${norm} from Favorites`}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
