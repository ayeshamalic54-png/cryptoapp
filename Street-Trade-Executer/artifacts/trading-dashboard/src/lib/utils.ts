import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function inferCryptoDecimals(price: number): number {
  const n = Math.abs(Number(price) || 0);
  if (n <= 0) return 2;
  if (n >= 1000) return 2;
  if (n >= 10) return 3;
  if (n >= 1) return 4;
  if (n >= 0.05) return 5;
  if (n >= 0.001) return 6;
  return 8;
}

export function formatCryptoPrice(price: number | null | undefined, symbolHint?: string): string {
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return "-";
  const num = Number(price);
  if (num === 0) return "0.00";
  const decimals = inferCryptoDecimals(num);
  return num.toFixed(decimals);
}

export function formatUsdt(val: number | null | undefined, showSign = false): string {
  const num = Number(val ?? 0);
  if (!Number.isFinite(num)) return "0.00 USDT";
  const absFormatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(num));
  const prefix = num < 0 ? "-" : showSign && num > 0 ? "+" : "";
  return `${prefix}$${absFormatted} USDT`;
}

export function formatPktTime(
  input: Date | string | number,
  options?: { withSeconds?: boolean; hour12?: boolean; suffix?: boolean }
): string {
  const { withSeconds = false, hour12 = true, suffix = false } = options ?? {};
  try {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return String(input);
    const out = d.toLocaleTimeString("en-US", {
      timeZone: "Asia/Karachi",
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" } : {}),
      hour12,
    });
    return suffix ? `${out} PKT` : out;
  } catch {
    return "";
  }
}

export function formatPktDateTime(input: Date | string | number): string {
  try {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return String(input);
    const datePart = d.toLocaleDateString("en-GB", {
      timeZone: "Asia/Karachi",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const timePart = formatPktTime(d, { withSeconds: true, hour12: true, suffix: false });
    return `${datePart}, ${timePart} PKT`;
  } catch {
    return String(input);
  }
}
