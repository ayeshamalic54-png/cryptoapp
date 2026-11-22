import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetConfig,
  useUpdateConfig,
  getGetConfigQueryKey,
  getGetDashboardQueryKey,
} from "@workspace/api-client-react";
import { SessionGuardCard } from "@/components/SessionGuardCard";
import { BinanceCoinSearch } from "@/components/BinanceCoinSearch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { getApiUrl } from "@/lib/api";
import { ShieldAlert, Zap, ZapOff, Shield, Lock, Bell, Send } from "lucide-react";

const configSchema = z.object({
  activePair: z.string().min(2, "Coin symbol is required"),
  accountMode: z.enum(["PROP_FIRM", "PERSONAL"]),
  leverage: z.coerce.number().min(1).max(50),
  riskPercent: z.coerce.number().min(0.1).max(15),
  maxMarginPct: z.coerce.number().min(10).max(100),
  maxSlPct: z.coerce.number().min(0.2).max(10),
  haltDrawdownLimit: z.coerce.number().min(0.5).max(15),
  maxDrawdownLimit: z.coerce.number().min(1).max(20),
  guardianShieldPct: z.coerce.number().min(0.5).max(10),
  initialBalance: z.coerce.number().min(10),
  autoExecute: z.boolean(),
  riskLimitsEnabled: z.boolean(),
  maxDailyTrades: z.coerce.number().min(1).max(100),
});

type ConfigFormValues = z.infer<typeof configSchema>;

const BLUE_GUARDIAN_CRYPTO_RULES = [
  { rule: "Max Daily Loss", value: "4% Eval / 3% Instant Funded (5 PM EST reset)", botValue: "Bot Halts @ 3.5% Buffer (Safe)", safe: true },
  { rule: "Max Overall Drawdown", value: "8% Static Eval / 6% Trailing Instant", botValue: "Bot Static Guard Halts @ 7.2%", safe: true },
  { rule: "Guardian Shield Floating", value: "2% Eval / 1% Instant single-trade cut", botValue: "Bot Risk/Shield Capped <= 1.8% Floating", safe: true },
  { rule: "Minimum Hold Duration", value: ">= 120 Seconds (2-Min Proscribed HFT Rule)", botValue: "Bot Enforces 140s Min Hold on Discretionary Exits", safe: true },
  { rule: "Capital Margin Cap", value: "Prop Firm <= 80% / Personal Full Capital", botValue: "Prop <= 80% Cap | Personal up to 100%", safe: true },
  { rule: "Weekend Crypto Holding", value: "Allowed 24/7 on Crypto Perpetuals", botValue: "Supported 24/7 (Optional PKT Session Guard)", safe: true },
  { rule: "EA / Automated Bot", value: "Pure Non-Martingale / Non-Grid Single Order", botValue: "Pure 9-Step SMC Single Order + One-Time BE", safe: true },
];

export default function Config() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isReadOnly = localStorage.getItem("wasee_role")?.toLowerCase() === "user";

  const [currentPass, setCurrentPass] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [discordTesting, setDiscordTesting] = useState(false);
  const [togglingAutoExec, setTogglingAutoExec] = useState(false);

  const { data: config, isLoading } = useGetConfig({ query: { queryKey: getGetConfigQueryKey() } });
  const updateConfig = useUpdateConfig();

  const form = useForm<ConfigFormValues>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      activePair: "BTCUSDT",
      accountMode: "PROP_FIRM",
      leverage: 5,
      riskPercent: 1.0,
      maxMarginPct: 80,
      maxSlPct: 1.2,
      haltDrawdownLimit: 3.5,
      maxDrawdownLimit: 4.0,
      guardianShieldPct: 1.8,
      initialBalance: 10000,
      autoExecute: true,
      riskLimitsEnabled: true,
      maxDailyTrades: 10,
    },
    values: config
      ? {
          activePair: config.activePair || "BTCUSDT",
          accountMode: (config.accountMode === "PERSONAL" ? "PERSONAL" : "PROP_FIRM") as "PROP_FIRM" | "PERSONAL",
          leverage: Number(config.leverage ?? 5),
          riskPercent: Number(config.riskPercent ?? 1.0),
          maxMarginPct:
            config.accountMode === "PERSONAL"
              ? Math.min(100, Number(config.maxMarginPct ?? 100))
              : Math.min(80, Number(config.maxMarginPct ?? 80)),
          maxSlPct: Number(config.maxSlPct ?? config.slPips ?? 1.2),
          haltDrawdownLimit: Number(config.haltDrawdownLimit ?? 3.5),
          maxDrawdownLimit: Number(config.maxDrawdownLimit ?? 4.0),
          guardianShieldPct: Number(config.guardianShieldPct ?? 1.8),
          initialBalance: Number(config.initialBalance ?? 10000),
          autoExecute: Boolean(config.autoExecute ?? true),
          riskLimitsEnabled: Boolean(config.riskLimitsEnabled ?? true),
          maxDailyTrades: Number(config.maxDailyTrades ?? 10),
        }
      : undefined,
  });

  const activeMode = form.watch("accountMode");
  const activePair = form.watch("activePair");

  const applyModePreset = (
    mode: "PROP_FIRM" | "PERSONAL",
    bal: number,
    riskPct: number,
    lev: number,
    haltDd: number,
    maxDd: number,
    label: string
  ) => {
    form.setValue("accountMode", mode, { shouldDirty: true });
    form.setValue("initialBalance", bal, { shouldDirty: true });
    form.setValue("riskPercent", riskPct, { shouldDirty: true });
    form.setValue("leverage", lev, { shouldDirty: true });
    form.setValue("maxMarginPct", mode === "PERSONAL" ? 100 : 80, { shouldDirty: true });
    form.setValue("haltDrawdownLimit", haltDd, { shouldDirty: true });
    form.setValue("maxDrawdownLimit", maxDd, { shouldDirty: true });
    form.setValue("guardianShieldPct", mode === "PROP_FIRM" ? 1.8 : 5.0, { shouldDirty: true });
    toast({ title: `Preset Applied: ${label}`, description: "Click SAVE CONFIGURATION below to lock into Neon DB & Binance bot." });
  };

  const onSubmit = (data: ConfigFormValues) => {
    updateConfig.mutate(
      {
        data: {
          ...data,
          slPips: data.maxSlPct,
          tpPips: Number((data.maxSlPct * 2).toFixed(2)),
          smcEnabled: true,
          cryptoEnabled: true,
          metalsEnabled: false,
          forexEnabled: false,
          indicesEnabled: false,
          knifeProtectionEnabled: false,
          obiEnabled: false,
          volatilityFilterEnabled: false,
        } as any,
      },
      {
        onSuccess: () => {
          toast({
            title: "Configuration Saved 🟢",
            description: `Mode: ${data.accountMode} | Coin: ${data.activePair} | Leverage: ${data.leverage}x | Cap <= ${data.maxMarginPct}%`,
          });
          queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
        },
        onError: () => {
          toast({ title: "Save Failed", variant: "destructive" });
        },
      }
    );
  };

  const handleChangePassword = async () => {
    if (newPass !== confirmPass) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    try {
      const res = await fetch(getApiUrl("/api/config/password"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: currentPass, newPassword: newPass }),
      });
      if (res.ok) {
        toast({ title: "Admin Password Updated" });
        setCurrentPass("");
        setNewPass("");
        setConfirmPass("");
      } else {
        const d = await res.json();
        toast({ title: "Password Update Failed", description: d.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Connection Error", variant: "destructive" });
    }
  };

  const handleSendDiscordTest = async () => {
    if (isReadOnly || discordTesting) return;
    setDiscordTesting(true);
    try {
      const res = await fetch(getApiUrl("/api/discord/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: activePair || "BTCUSDT" }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        toast({
          title: "Test Crypto Signal Sent 🟢",
          description: `Delivered rich Entry/SL/TP SMC preview for ${data.symbol} to your Crypto Discord channel.`,
        });
      } else {
        toast({
          title: "Discord Test Failed",
          description: data?.detail || data?.error || `HTTP ${res.status}`,
          variant: "destructive",
        });
      }
    } catch {
      toast({ title: "Connection Error", description: "Could not reach API server.", variant: "destructive" });
    } finally {
      setDiscordTesting(false);
    }
  };

  if (isLoading || !config) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[450px] w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto bg-background p-4 sm:p-6 space-y-6">
      {isReadOnly && (
        <Alert className="bg-red-500/5 text-red-400 border-red-500/20 py-2.5">
          <div className="flex gap-2 items-center">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <AlertDescription className="text-xs font-mono font-bold">
              VIEWER MODE: Configuration changes are disabled.
            </AlertDescription>
          </div>
        </Alert>
      )}

      <div>
        <h2 className="text-2xl font-bold tracking-tight">Crypto Futures Configuration</h2>
        <p className="text-sm text-muted-foreground">
          Pure 9-Condition SMC · Dual Mode (Prop Firm ≤ 80% Cap vs Personal up to 100% Full Capital) · Low-Fee Maker TP (0.02%)
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          <fieldset disabled={isReadOnly} className="space-y-6">
            {/* ACCOUNT MODE SELECTOR: PROP FIRM VS PERSONAL BINANCE */}
            <Card className="bg-card border-border border-t-2 border-t-indigo-500">
              <CardHeader>
                <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <Shield className="w-4 h-4 text-indigo-400" /> Account &amp; Capital Mode (Separate Prop vs Personal)
                </CardTitle>
                <CardDescription className="text-xs">
                  Choose Blue Guardian Prop Firm (strict ≤ 80% max margin) OR Personal Binance Futures (uses up to 100% full capital + 0.02% Maker TP fee-saver).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => applyModePreset("PROP_FIRM", 10000, 1.0, 5, 3.5, 4.0, "Blue Guardian Prop ($10k)")}
                    className={cn(
                      "p-4 rounded-lg border text-left transition-all space-y-1.5",
                      activeMode === "PROP_FIRM"
                        ? "bg-indigo-600/15 border-indigo-400 shadow-[0_0_20px_rgba(99,102,241,0.18)]"
                        : "bg-zinc-900/60 border-zinc-800 hover:border-zinc-600"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-sm text-white">🏛️ PROP FIRM (Blue Guardian)</span>
                      {activeMode === "PROP_FIRM" && <Badge className="bg-indigo-600 text-white text-[10px]">SELECTED</Badge>}
                    </div>
                    <p className="text-xs text-zinc-400 font-mono">
                      1.0% Risk · 5x Lev · 3.5%/4% Daily Halt · 1.8% Shield · ≥140s Min Hold · ≤80% Max Margin
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => applyModePreset("PERSONAL", 100, 5.0, 5, 10.0, 15.0, "Personal Binance ($100 USDT)")}
                    className={cn(
                      "p-4 rounded-lg border text-left transition-all space-y-1.5",
                      activeMode === "PERSONAL"
                        ? "bg-emerald-600/15 border-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.18)]"
                        : "bg-zinc-900/60 border-zinc-800 hover:border-zinc-600"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold text-sm text-white">💳 PERSONAL BINANCE FUTURES</span>
                      {activeMode === "PERSONAL" && <Badge className="bg-emerald-600 text-white text-[10px]">SELECTED</Badge>}
                    </div>
                    <p className="text-xs text-zinc-400 font-mono">
                      Self-Funded ($50 / $100 / $300+ USDT) · Up to 100% Full Capital · Maker TP Low-Fee
                    </p>
                  </button>
                </div>

                {/* Personal Capital Quick Buttons */}
                {activeMode === "PERSONAL" && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-xs font-mono text-zinc-400">Personal Presets:</span>
                    <Button type="button" size="sm" variant="outline" onClick={() => applyModePreset("PERSONAL", 50, 3.0, 5, 10, 15, "$50 USDT (5x)")} className="h-7 text-xs font-mono">
                      $50 USDT · 5x
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => applyModePreset("PERSONAL", 100, 3.0, 5, 10, 15, "$100 USDT (5x)")} className="h-7 text-xs font-mono">
                      $100 USDT · 5x
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => applyModePreset("PERSONAL", 300, 2.0, 5, 8, 12, "$300 USDT (5x)")} className="h-7 text-xs font-mono">
                      $300 USDT · 5x
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => applyModePreset("PERSONAL", 100, 2.5, 10, 10, 15, "$100 USDT (10x)")} className="h-7 text-xs font-mono">
                      $100 USDT · 10x
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              {/* Left: Top 10 Coins + Custom Search */}
              <Card className="bg-card border-border xl:col-span-2">
                <CardHeader>
                  <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
                    Priority Coin &amp; 10-Coin Binance Scanner
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Bot automatically scans all Top 10 volatile coins plus your searched priority coin:{" "}
                    <span className="font-mono text-emerald-400 font-bold">{activePair}</span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <BinanceCoinSearch
                    selectedSymbol={activePair}
                    onSelectSymbol={(sym) => form.setValue("activePair", sym, { shouldDirty: true })}
                    title="Select From Top 10 Or Search Any Binance Futures Perpetual"
                  />

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-2 border-t border-border">
                    <FormField
                      control={form.control}
                      name="initialBalance"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono uppercase text-zinc-400">Starting Capital (USDT)</FormLabel>
                          <FormControl>
                            <Input type="number" step="10" {...field} className="font-mono bg-zinc-950" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="leverage"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono uppercase text-zinc-400">Leverage (x)</FormLabel>
                          <FormControl>
                            <Input type="number" min="1" max="50" {...field} className="font-mono bg-zinc-950" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="maxMarginPct"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono uppercase text-zinc-400">Max Margin Cap (%)</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min="10"
                              max={activeMode === "PERSONAL" ? 100 : 80}
                              {...field}
                              className="font-mono bg-zinc-950"
                            />
                          </FormControl>
                          <FormDescription className="text-[10px]">
                            {activeMode === "PERSONAL"
                              ? "Personal Mode: up to 100% full capital (1.5% fee buffer)"
                              : "Prop Firm Mode: strictly capped ≤ 80%"}
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="riskPercent"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono uppercase text-zinc-400">Risk Per Trade (%)</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" min="0.1" max="15" {...field} className="font-mono bg-zinc-950" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="maxSlPct"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono uppercase text-zinc-400">Max Structural SL (%)</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" min="0.2" max="10" {...field} className="font-mono bg-zinc-950" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="haltDrawdownLimit"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono uppercase text-zinc-400">Daily Halt DD (%)</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" min="0.5" max="15" {...field} className="font-mono bg-zinc-950" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Right: Execution & Locked Filters */}
              <div className="space-y-4">
                <Card className="bg-card border-border">
                  <CardHeader>
                    <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Execution &amp; SMC Controls</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="autoExecute"
                      render={({ field }) => (
                        <FormItem>
                          <div className={cn("flex items-center justify-between p-3 rounded border", field.value ? "bg-emerald-500/5 border-emerald-500/30" : "bg-amber-500/5 border-amber-500/30")}>
                            <div>
                              <FormLabel className="text-xs uppercase font-mono flex items-center gap-1.5">
                                {field.value ? <Zap className="w-3.5 h-3.5 text-emerald-400" /> : <ZapOff className="w-3.5 h-3.5 text-amber-400" />}
                                Auto Execute (Pure SMC)
                              </FormLabel>
                              <FormDescription className="text-[11px]">Scans Top 10 coins &amp; auto-executes on 9/9 steps</FormDescription>
                            </div>
                            <FormControl>
                              <Switch
                                checked={field.value}
                                disabled={isReadOnly || togglingAutoExec}
                                onCheckedChange={async (checked) => {
                                  field.onChange(checked);
                                  setTogglingAutoExec(true);
                                  try {
                                    const res = await fetch(getApiUrl("/api/toggle-auto-execute"), {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ autoExecute: checked }),
                                    });
                                    if (!res.ok) throw new Error("Failed to toggle Auto Execute");
                                    queryClient.invalidateQueries({ queryKey: getGetConfigQueryKey() });
                                    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
                                    toast({
                                      title: checked ? "Auto Execute ENABLED" : "Auto Execute DISABLED (Signal-Only)",
                                      description: checked
                                        ? "Top 10 Crypto SMC scanner will execute live Futures orders."
                                        : "Top 10 scanner will send Discord signals only.",
                                    });
                                  } catch (err: any) {
                                    field.onChange(!checked);
                                    toast({ title: "Toggle Error", description: err?.message, variant: "destructive" });
                                  } finally {
                                    setTogglingAutoExec(false);
                                  }
                                }}
                              />
                            </FormControl>
                          </div>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="riskLimitsEnabled"
                      render={({ field }) => (
                        <FormItem>
                          <div className="flex items-center justify-between p-3 rounded border border-border bg-zinc-950/60">
                            <div>
                              <FormLabel className="text-xs uppercase font-mono">Drawdown &amp; Shield Protection</FormLabel>
                              <FormDescription className="text-[11px]">Halt trading on daily/static/shield DD</FormDescription>
                            </div>
                            <FormControl>
                              <Switch checked={field.value} onCheckedChange={field.onChange} />
                            </FormControl>
                          </div>
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="maxDailyTrades"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono uppercase text-zinc-400">Max Daily Trades</FormLabel>
                          <FormControl>
                            <Input type="number" min="1" max="100" {...field} className="font-mono bg-zinc-950" />
                          </FormControl>
                        </FormItem>
                      )}
                    />

                    {/* Disabled Legacy Filters Explicitly Kept OFF (Matching Forex Architecture) */}
                    <div className="pt-3 border-t border-border space-y-2">
                      <div className="text-[11px] font-mono font-bold uppercase text-zinc-400 flex items-center gap-1.5">
                        <Lock className="w-3 h-3 text-rose-400" /> Retired / Disabled Filters (Kept OFF)
                      </div>
                      {[
                        "Kalman / Z-Score Strategy — RETIRED (OFF)",
                        "3-Part TP1/TP2/TP3 Split — REPLACED BY SINGLE M15 TP (OFF)",
                        "Knife / Velocity Filter — DISABLED (OFF)",
                        "Order Book Imbalance (OBI) — DISABLED (OFF)",
                        "Volatility Threshold Expansion — DISABLED (OFF)",
                        "Trailing Stop & Adverse Exit — DISABLED (One-Time BE Only)",
                      ].map((txt) => (
                        <div key={txt} className="flex items-center justify-between text-[11px] font-mono px-2.5 py-1.5 rounded bg-zinc-950 border border-zinc-800/80 text-zinc-500">
                          <span>{txt.split(" — ")[0]}</span>
                          <Badge variant="outline" className="text-[9px] bg-rose-500/10 text-rose-400 border-rose-500/20">OFF</Badge>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                <Button type="submit" disabled={updateConfig.isPending} className="w-full font-mono text-xs font-bold bg-primary text-primary-foreground">
                  {updateConfig.isPending ? "SAVING..." : "SAVE CONFIGURATION"}
                </Button>
              </div>
            </div>
          </fieldset>
        </form>
      </Form>

      {/* SESSION TIME GUARD (DEFAULT OFF, USER TOGGLES ANYTIME) */}
      <SessionGuardCard data={config} isReadOnly={isReadOnly} />

      {/* BLUE GUARDIAN CRYPTO FUTURES RULES MATRIX */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
              Blue Guardian Crypto Prop Rules Compliance
            </CardTitle>
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-xs">COMPLIANT</Badge>
          </div>
          <CardDescription className="text-xs">
            Enforced strictly in Blue Guardian Prop Firm mode (≤ 80% max margin); Personal Mode unlocks up to 100% full capital + Maker TP low-fee sizing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {BLUE_GUARDIAN_CRYPTO_RULES.map((r) => (
              <div key={r.rule} className="p-3 rounded border border-border bg-muted/20 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400 font-semibold">{r.rule}</span>
                  <Badge variant="outline" className="text-[9px] font-mono bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                    SAFE
                  </Badge>
                </div>
                <div className="text-xs font-mono text-foreground">{r.value}</div>
                <div className="text-[10px] text-emerald-400/90 font-mono">{r.botValue}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* DISCORD CRYPTO SIGNAL ALERTS */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-indigo-400" />
              <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
                Crypto Discord Signal Channel (Direct Cloud Bot)
              </CardTitle>
            </div>
            <Badge variant="outline" className="text-[10px] font-mono bg-indigo-500/10 text-indigo-300 border-indigo-500/30">
              CRYPTO_DISCORD_WEBHOOK_URL
            </Badge>
          </div>
          <CardDescription className="text-xs">
            Sends instant @everyone mobile push notifications + Entry / SL / TP / RRR / Leverage / PKT Time cards directly from Render (isolated from your Forex Discord channel).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded border border-border bg-zinc-950/70 p-3 font-mono text-[11px] text-zinc-300 space-y-1">
            <div className="text-indigo-400 font-bold">Sample Signal Pattern Preview:</div>
            <div>@everyone 🟢 [BTCUSDT] MARKET LONG (BUY) · 5x ISOLATED USDT-M</div>
            <div>📌 Entry: Market Price | 🛑 SL (-0.80%) | 🎯 TP (+2.40% · 1:3.0 RRR)</div>
            <div>⚙️ Pure 9-Step SMC + M15 Structure + One-Time Fee-Safe Breakeven + Close PnL Card (PKT)</div>
          </div>
          <Button
            type="button"
            onClick={handleSendDiscordTest}
            disabled={isReadOnly || discordTesting}
            className="bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-bold flex items-center gap-2"
          >
            <Send className="w-3.5 h-3.5" />
            {discordTesting ? "SENDING TEST SIGNAL..." : "SEND TEST DISCORD SIGNAL PREVIEW"}
          </Button>
        </CardContent>
      </Card>

      {/* ADMIN PASSWORD CHANGE */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Admin Security Settings</CardTitle>
        </CardHeader>
        <CardContent className="max-w-md space-y-3">
          <Input type="password" placeholder="Current Password" value={currentPass} onChange={(e) => setCurrentPass(e.target.value)} disabled={isReadOnly} className="font-mono text-xs bg-zinc-950" />
          <Input type="password" placeholder="New Password" value={newPass} onChange={(e) => setNewPass(e.target.value)} disabled={isReadOnly} className="font-mono text-xs bg-zinc-950" />
          <Input type="password" placeholder="Confirm New Password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} disabled={isReadOnly} className="font-mono text-xs bg-zinc-950" />
          <Button type="button" onClick={handleChangePassword} disabled={isReadOnly || !currentPass || !newPass || !confirmPass} className="bg-indigo-600 hover:bg-indigo-500 text-white font-mono text-xs font-bold">
            CHANGE ADMIN PASSWORD
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
