/** Formatting helpers for the admin UI. */

import { fmtBytes } from "@/lib/usage/plan";

export { fmtBytes };

/** Integer with thousands separators; em-dash for null/undefined. */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

/** Fraction (0..1) → "12.3%". */
export function fmtPct(frac: number | null | undefined): string {
  if (frac == null || Number.isNaN(frac)) return "—";
  return `${(frac * 100).toFixed(1)}%`;
}

/** USD amount → "$1,234". */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `$${n.toLocaleString("en-US")}`;
}

/** Absolute date+time, e.g. "Jun 15, 14:32". */
export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Relative time, e.g. "3m ago", "2d ago". */
export function fmtRelative(ms: number | null | undefined, now: number = Date.now()): string {
  if (!ms) return "—";
  const diff = Math.max(0, now - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/** Seconds → "1:23" / "1:02:03" (video duration). */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = m.toString().padStart(h ? 2 : 1, "0");
  const ss = sec.toString().padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Milliseconds elapsed → "1.2s" / "3m 4s" (processing time). */
export function fmtElapsed(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}

/** Truncate long ids/strings for table cells. */
export function truncateMiddle(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
