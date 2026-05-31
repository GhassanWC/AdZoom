/**
 * Lightweight in-memory IP rate limiter for the public chat route.
 *
 * Sliding window: 20 requests per IP per 10 minutes. Each new window
 * resets when the previous one's start time falls outside the window.
 *
 * Cold-start trade-off: each new serverless instance starts with an
 * empty map. A determined attacker hitting many instances bypasses
 * this — but Gemini's own per-key quota is the real backstop. If
 * traffic grows enough to need durable rate-limiting, swap the Map
 * for an Upstash Redis bucket without changing the call site.
 */

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 20;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets. Only set when ok === false. */
  retryInSeconds?: number;
  /** Remaining budget for this IP. Always set. */
  remaining: number;
}

export function checkRateLimit(ip: string): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(ip);

  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(ip, { count: 1, windowStart: now });
    return { ok: true, remaining: MAX_REQUESTS - 1 };
  }

  if (bucket.count >= MAX_REQUESTS) {
    const retryInSeconds = Math.ceil(
      (WINDOW_MS - (now - bucket.windowStart)) / 1000
    );
    return { ok: false, retryInSeconds, remaining: 0 };
  }

  bucket.count += 1;
  return { ok: true, remaining: MAX_REQUESTS - bucket.count };
}

/**
 * Extracts a client IP from a Next.js request. Trusts standard proxy
 * headers in order, falls back to "unknown" so the limiter still
 * applies (every "unknown" caller shares one bucket — defensive).
 */
export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    // x-forwarded-for can be "client, proxy1, proxy2" — take the first.
    const first = xff.split(",")[0]?.trim();
    if (first) return stripPort(first);
  }
  const real = headers.get("x-real-ip");
  if (real) return stripPort(real.trim());
  return "unknown";
}

function stripPort(addr: string): string {
  // IPv4 "1.2.3.4:5678" → "1.2.3.4". Leave IPv6 (with brackets) alone.
  if (addr.includes(".") && addr.includes(":")) {
    return addr.split(":")[0] ?? addr;
  }
  return addr;
}
