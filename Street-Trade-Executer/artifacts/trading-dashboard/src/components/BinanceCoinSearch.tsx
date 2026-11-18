import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search } from "lucide-react";
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
}

interface BinanceCoinSearchProps {
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  title?: string;
}

export function BinanceCoinSearch({
  selectedSymbol,
  onSelectSymbol,
  title = "Top 10 High-Volatility Coins & Search Any Binance Coin",
}: BinanceCoinSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolMeta[]>([]);
  const [totalCoins, setTotalCoins] = useState<number>(560);
  const [searching, setSearching] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

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

  return (
    <div className="space-y-2.5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-400 font-bold">
          {title}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-2.5 pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value.toUpperCase())}
            onFocus={() => query.trim() && setDropdownOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim()) {
                e.preventDefault();
                const first = results[0]?.symbol || (query.trim().endsWith("USDT") ? query.trim() : `${query.trim()}USDT`);
                handleChoose(first);
              }
            }}
            placeholder={`Search all ${totalCoins}+ Binance coins (PEPE, WIF...)`}
            className="pl-8 h-8 text-xs font-mono bg-zinc-950 border-zinc-700 text-zinc-100 uppercase"
          />
          {dropdownOpen && query.trim() && (
            <div className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-md border border-zinc-700 bg-zinc-950 shadow-2xl">
              {searching ? (
                <div className="px-3 py-2 text-xs font-mono text-zinc-400">Searching Binance Futures...</div>
              ) : results.length === 0 ? (
                <button
                  type="button"
                  onClick={() => handleChoose(query.trim().endsWith("USDT") ? query.trim() : `${query.trim()}USDT`)}
                  className="w-full text-left px-3 py-2 text-xs font-mono text-sky-400 hover:bg-zinc-900"
                >
                  Inspect {query.trim().endsWith("USDT") ? query.trim() : `${query.trim()}USDT`} on Binance Futures
                </button>
              ) : (
                results.map((item) => (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => handleChoose(item.symbol)}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-mono hover:bg-zinc-900 border-b border-zinc-900 last:border-b-0"
                  >
                    <span className="font-bold text-white">{item.symbol}</span>
                    <span className="text-[10px] text-zinc-400">Min ${item.minNotional} USDT</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Quick Top 10 Volatile Coins Strip + Custom Selected Badge */}
      <div className="flex flex-wrap gap-1.5">
        {TOP_10_CRYPTO_COINS.map((sym) => {
          const active = selectedSymbol.toUpperCase() === sym;
          return (
            <button
              key={sym}
              type="button"
              onClick={() => handleChoose(sym)}
              className={cn(
                "px-2.5 py-1 rounded text-[11px] font-mono font-bold border transition-all",
                active
                  ? "bg-emerald-600/20 text-emerald-300 border-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.2)]"
                  : "bg-zinc-900/70 text-zinc-400 border-zinc-800 hover:text-white hover:border-zinc-600"
              )}
            >
              {sym.replace("USDT", "")}
            </button>
          );
        })}
        {selectedSymbol && !TOP_10_CRYPTO_COINS.includes(selectedSymbol.toUpperCase()) && (
          <Badge className="bg-indigo-600/20 text-indigo-300 border-indigo-500 font-mono text-[11px] px-2.5 py-1">
            ★ {selectedSymbol.toUpperCase()}
          </Badge>
        )}
      </div>
    </div>
  );
}
