/**
 * Shared Binance per-origin rate-limit & Retry-After cooldown coordinator.
 * Prevents HTTP 429 / 418 IP bans from being extended by blind retry polling.
 */

interface OriginCooldownEntry {
  untilMs: number;
  status: number;
  softUntilMs: number;
}

const originState = new Map<string, OriginCooldownEntry>();

export function getOriginKey(urlOrOrigin: string): string {
  try {
    return new URL(urlOrOrigin).origin.toLowerCase();
  } catch {
    return urlOrOrigin.trim().replace(/\/+$/, "").toLowerCase();
  }
}

export function parseRetryAfterMs(headerVal: string | null | undefined, status: number): number {
  const fallbackMs = status === 418 ? 180_000 : 60_000;
  if (!headerVal) return fallbackMs;
  const trimmed = headerVal.trim();
  const secs = Number(trimmed);
  if (Number.isFinite(secs) && secs > 0) {
    return Math.min(1_800_000, Math.max(15_000, Math.ceil(secs * 1000)));
  }
  const targetMs = Date.parse(trimmed);
  if (Number.isFinite(targetMs)) {
    const diff = targetMs - Date.now();
    if (diff > 0) return Math.min(1_800_000, Math.max(15_000, diff));
  }
  return fallbackMs;
}

export function recordBinanceResponse(
  urlOrOrigin: string,
  status: number,
  retryAfterHeader?: string | null,
  usedWeightHeader?: string | null
): void {
  const key = getOriginKey(urlOrOrigin);
  if (!key) return;
  const now = Date.now();
  const prev = originState.get(key) ?? { untilMs: 0, status: 200, softUntilMs: 0 };

  if (status === 429 || status === 418) {
    const delayMs = parseRetryAfterMs(retryAfterHeader, status);
    originState.set(key, {
      untilMs: Math.max(prev.untilMs, now + delayMs),
      status,
      softUntilMs: Math.max(prev.softUntilMs, now + delayMs),
    });
    return;
  }

  const usedWeight = Number(usedWeightHeader ?? 0);
  if (Number.isFinite(usedWeight) && usedWeight >= 1800) {
    originState.set(key, {
      untilMs: prev.untilMs,
      status: prev.status,
      softUntilMs: Math.max(prev.softUntilMs, now + 15_000),
    });
    return;
  }

  if (status >= 200 && status < 400) {
    originState.set(key, {
      untilMs: 0,
      status: 200,
      softUntilMs: usedWeight >= 1500 ? now + 5_000 : 0,
    });
  }
}

export function getHostCooldownState(urlOrOrigin: string): {
  coolingDown: boolean;
  softThrottled: boolean;
  remainingMs: number;
  status: number;
} {
  const key = getOriginKey(urlOrOrigin);
  const entry = originState.get(key);
  if (!entry) {
    return { coolingDown: false, softThrottled: false, remainingMs: 0, status: 200 };
  }
  const now = Date.now();
  const remainingMs = Math.max(0, entry.untilMs - now);
  const softRemaining = Math.max(0, entry.softUntilMs - now);
  if (remainingMs === 0 && softRemaining === 0) {
    originState.delete(key);
    return { coolingDown: false, softThrottled: false, remainingMs: 0, status: 200 };
  }
  return {
    coolingDown: remainingMs > 0,
    softThrottled: softRemaining > 0,
    remainingMs,
    status: remainingMs > 0 ? entry.status : 200,
  };
}

export function clearAllCooldownsForTest(): void {
  originState.clear();
}
