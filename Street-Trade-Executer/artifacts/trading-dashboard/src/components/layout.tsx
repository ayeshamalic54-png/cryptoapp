import { Link, useLocation } from "wouter";
import { useState } from "react";
import {
  Activity,
  BarChart3,
  LayoutDashboard,
  Settings,
  ListOrdered,
  TrendingUp,
  Play,
  LogOut,
  Menu,
  X,
  Database,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/markets", label: "Markets", icon: TrendingUp },
    { href: "/trades", label: "Trades", icon: ListOrdered },
    { href: "/signals", label: "Signals", icon: Activity },
    { href: "/metrics", label: "Metrics", icon: BarChart3 },
    { href: "/backtest", label: "Backtesting", icon: Play },
    { href: "/config", label: "Config", icon: Settings },
    { href: "/backup", label: "Backup", icon: Database },
  ];

  const handleLogout = () => {
    localStorage.removeItem("wasee_auth");
    window.location.reload();
  };

  return (
    <div className="flex flex-col lg:flex-row min-h-screen bg-background text-foreground dark overflow-x-hidden">
      {/* Mobile Header */}
      <div className="lg:hidden flex items-center justify-between px-4 py-3 bg-zinc-950 border-b border-zinc-900 shrink-0 sticky top-0 z-30">
        <div>
          <h1 className="font-extrabold text-sm bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent tracking-tight">
            CRYPTO FUTURES SMC
          </h1>
          <div className="text-[9px] text-zinc-500 uppercase tracking-widest font-mono">Binance 9-Step Pure SMC</div>
        </div>
        <button
          onClick={() => setIsMobileMenuOpen(true)}
          className="p-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {/* Mobile Drawer */}
      {isMobileMenuOpen && (
        <>
          <div onClick={() => setIsMobileMenuOpen(false)} className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden" />
          <div className="fixed inset-y-0 left-0 w-64 bg-zinc-950 border-r border-zinc-800 z-50 flex flex-col">
            <div className="p-4 border-b border-zinc-900 flex items-center justify-between">
              <div>
                <h1 className="font-extrabold text-sm bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">CRYPTO FUTURES SMC</h1>
                <div className="text-[9px] text-zinc-500 uppercase font-mono">Binance USDT-M</div>
              </div>
              <button onClick={() => setIsMobileMenuOpen(false)} className="p-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1.5 overflow-y-auto">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md border-l-2",
                    location === item.href
                      ? "bg-primary/10 text-primary border-l-primary font-semibold"
                      : "text-zinc-400 border-l-transparent hover:text-foreground hover:bg-zinc-900/50"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="p-4 border-t border-zinc-900">
              <button onClick={handleLogout} className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold font-mono uppercase border border-red-500/30 rounded bg-red-500/10 text-red-400">
                <LogOut className="h-3.5 w-3.5" /> SIGN OUT
              </button>
            </div>
          </div>
        </>
      )}

      {/* Desktop Sidebar */}
      <div className="hidden lg:flex w-64 border-r border-zinc-800 bg-gradient-to-b from-zinc-950 to-black shrink-0 flex-col">
        <div className="p-4 border-b border-zinc-900">
          <h1 className="font-extrabold text-lg bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent tracking-tight">
            CRYPTO FUTURES SMC
          </h1>
          <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono mt-1">
            Binance 9-Step Pure SMC
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1.5">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 text-sm font-medium transition-all duration-200 rounded-md border-l-2",
                location === item.href
                  ? "bg-primary/10 text-primary border-l-primary font-semibold"
                  : "text-zinc-400 border-l-transparent hover:text-foreground hover:bg-zinc-900/50"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-4 border-t border-zinc-900 bg-zinc-950/40">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold font-mono uppercase border border-red-500/30 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20"
          >
            <LogOut className="h-3.5 w-3.5" />
            SIGN OUT TERMINAL
          </button>
        </div>
      </div>

      <main className="flex-1 flex flex-col min-w-0 overflow-x-hidden bg-zinc-950">{children}</main>
    </div>
  );
}
