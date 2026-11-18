import { formatCryptoPrice } from "./smcEngine";

function getPktNowStr(dateInput?: Date): string {
  const d = dateInput || new Date();
  const datePart = d.toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
  const timePart = d.toLocaleTimeString("en-US", {
    timeZone: "Asia/Karachi",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  return `${datePart} ${timePart} PKT`;
}

export function getCryptoDiscordWebhookUrl(): string {
  return (process.env.CRYPTO_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || "").trim();
}

export async function postDiscordPayload(
  content: string,
  embeds?: any[]
): Promise<{ ok: boolean; status: number; detail?: string }> {
  const url = getCryptoDiscordWebhookUrl();
  if (!url || !url.startsWith("http")) {
    return { ok: false, status: 0, detail: "CRYPTO_DISCORD_WEBHOOK_URL is not configured" };
  }
  try {
    const body: Record<string, any> = { content };
    if (embeds && embeds.length > 0) body.embeds = embeds;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    if (resp.status === 200 || resp.status === 204) {
      return { ok: true, status: resp.status };
    }
    const errText = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, detail: errText.slice(0, 200) };
  } catch (err: any) {
    return { ok: false, status: 0, detail: err?.message || "Discord request failed" };
  }
}

export interface CryptoSignalAlertInput {
  action: "BUY" | "SELL";
  symbol: string;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  rrr: number;
  qty: number;
  leverage: number;
  accountMode: string;
  riskUsdt: number;
  marginPct: number;
  maxMarginPct: number;
  ticketId?: number;
  isSignalOnly?: boolean;
  isTestPreview?: boolean;
}

export async function sendDiscordCryptoSignalAlert(input: CryptoSignalAlertInput) {
  const isLong = input.action === "BUY";
  const sideEmoji = isLong ? "🟢" : "🔴";
  const actStr = isLong ? "MARKET LONG (BUY)" : "MARKET SHORT (SELL)";
  const slPct = input.entryPrice > 0 ? (Math.abs(input.entryPrice - input.slPrice) / input.entryPrice) * 100 : 0;
  const tpPct = input.entryPrice > 0 ? (Math.abs(input.tpPrice - input.entryPrice) / input.entryPrice) * 100 : 0;

  const entryS = formatCryptoPrice(input.entryPrice);
  const slS = formatCryptoPrice(input.slPrice);
  const tpS = formatCryptoPrice(input.tpPrice);
  const nowStr = getPktNowStr();

  const title = input.isTestPreview
    ? `🧪 [TEST PREVIEW] CRYPTO FUTURES SMC SIGNAL · ${input.symbol}`
    : input.isSignalOnly
    ? `📢 NEW PURE SMC CRYPTO SIGNAL · ${input.symbol} (${input.leverage}x)`
    : `🚀 CRYPTO FUTURES POSITION OPENED · ${input.symbol} (#${input.ticketId || 0})`;

  const pushPrefix = input.isTestPreview
    ? "🧪 **[TEST CRYPTO SIGNAL PREVIEW]**"
    : input.isSignalOnly
    ? "📢 **[NEW CRYPTO SMC SIGNAL — SIGNALS ONLY]**"
    : "🚀 **[NEW CRYPTO FUTURES TRADE EXECUTED]**";

  const pushContent =
    `@everyone\n` +
    `${pushPrefix} ${sideEmoji} **${actStr}** | \`${input.symbol}\` (${input.leverage}x)\n` +
    `📥 **Entry:** \`$${entryS}\` | ⛔ **SL:** \`$${slS}\` (\`-${slPct.toFixed(2)}%\`) | 🎯 **TP:** \`$${tpS}\` (\`+${tpPct.toFixed(2)}%\` · \`${input.rrr.toFixed(2)}R\`)`;

  const embeds = [
    {
      title,
      description:
        `**Strategy:** \`Pure 9-Condition Institutional SMC (M15 Bias + M5 Sweep + CHoCH + FVG + Closed Retest & Rejection) 🟢\`\n` +
        `**Time (PKT):** \`${nowStr}\``,
      color: isLong ? 0x10b981 : 0xef4444,
      fields: [
        { name: "💱 Coin / Perpetual", value: `\`${input.symbol}\` (${input.leverage}x)`, inline: true },
        { name: `${sideEmoji} Direction`, value: `\`${actStr}\``, inline: true },
        { name: "💼 Account Mode", value: `\`${input.accountMode}\``, inline: true },
        { name: "📥 Entry Price", value: `\`$${entryS} USDT\``, inline: true },
        {
          name: "⛔ Stop Loss (SL)",
          value: `\`$${slS} USDT\`\n*(-${slPct.toFixed(2)}% | Sweep ${isLong ? "-" : "+"} 0.08% Buf)*`,
          inline: true,
        },
        {
          name: "🎯 Take Profit (TP)",
          value: `\`$${tpS} USDT\`\n*(+${tpPct.toFixed(2)}% | M15 Liquidity Target)*`,
          inline: true,
        },
        { name: "📐 Risk : Reward", value: `\`1 : ${input.rrr.toFixed(2)} R\` *(Min ≥ 1.85R)*`, inline: true },
        {
          name: "📦 Position & Risk",
          value: `\`${input.qty}\` units | Risk: \`$${input.riskUsdt.toFixed(2)} USDT\``,
          inline: true,
        },
        {
          name: "🛡️ Margin Usage",
          value: `\`${input.marginPct.toFixed(1)}%\` *(Cap ≤ ${input.maxMarginPct.toFixed(0)}%)*`,
          inline: true,
        },
      ],
      footer: {
        text: "Crypto Futures Quant Terminal · Direct Cloud 9-Step SMC Engine · Binance USDT-M",
      },
    },
  ];

  return postDiscordPayload(pushContent, embeds);
}

export async function sendDiscordCryptoCloseAlert(
  ticket: number,
  symbol: string,
  orderType: string,
  qty: number,
  closePrice: number,
  profitUsdt: number,
  reason = "Target / SL Hit"
) {
  const isWin = profitUsdt >= 0;
  const sideLabel = orderType.toUpperCase() === "BUY" ? "LONG" : "SHORT";
  const sign = isWin ? "+" : "";
  const msg =
    `🏁 **CRYPTO FUTURES POSITION CLOSED** ${isWin ? "🟢" : "🔴"}\n` +
    `🎫 **Ticket:** \`#${ticket}\` | **${symbol}** (\`${sideLabel}\` · \`${qty}\`)\n` +
    `💵 **Close Price:** \`$${formatCryptoPrice(closePrice)}\` | **Reason:** \`${reason}\`\n` +
    `💰 **Realized P&L:** \`${sign}$${profitUsdt.toFixed(2)} USDT\` ${isWin ? "🟢" : "🔴"}\n` +
    `⏱ **Close Time:** \`${getPktNowStr()}\``;
  return postDiscordPayload(msg);
}
