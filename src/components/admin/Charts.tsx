"use client";

/**
 * Admin chart primitives — dependency-free SVG.
 *
 * COLOR IS COMPUTED, NOT EYEBALLED
 * --------------------------------
 * `STATUS_COLORS` was validated with the dataviz palette validator against BOTH
 * surfaces (dark #0E1014, light #F8FAFC). All six checks pass — lightness band,
 * chroma floor, CVD separation, normal-vision floor, contrast.
 *
 * Two constraints are baked into these values and must survive any edit:
 *
 *  1. THE ORDER MATTERS. `ready` (emerald) and `failed` (rose) are deliberately
 *     NOT adjacent — `cancelled` sits between them. Emerald beside rose is the
 *     classic deutan/protan collision and measured ΔE 4.6, far below the floor.
 *     Reordering these keys re-introduces it.
 *  2. SECONDARY ENCODING IS REQUIRED. The worst adjacent pair
 *     (ready↔processing) measures ΔE 7.9 for protan — inside the 6–8 band,
 *     which is permissible ONLY when color is not the sole channel. Every
 *     status mark here ships with a text label, a legend entry and a gap.
 *     Do not reduce these to bare color swatches.
 *
 * Magnitude charts (BarList, AreaChart) use ONE hue, never a cycled rainbow:
 * ranking by length is the encoding, so color carries no extra information.
 */

import * as React from "react";
import { cn } from "@/lib/cn";
import { MicroLabel } from "./AdminCard";

/** Validated status palette order. Load-bearing — see the header note. */
export const STATUS_ORDER = ["queued", "processing", "ready", "cancelled", "failed"] as const;

export const STATUS_COLORS: Record<string, string> = {
  queued: "#2563EB",
  processing: "#D97706",
  ready: "#059669",
  cancelled: "#7C3AED",
  failed: "#E11D48",
  // Aliases so each collection's own vocabulary lands on the same swatch.
  complete: "#059669",
  completed: "#059669",
  running: "#D97706",
  analyzing: "#D97706",
  exporting: "#D97706",
  uploading: "#D97706",
  rendering: "#D97706",
  batch_submitted: "#2563EB",
  permitted: "#2563EB",
  canceled: "#7C3AED",
  active: "#059669",
  on_trial: "#2563EB",
  past_due: "#D97706",
  expired: "#7C3AED",
  paused: "#7C3AED",
  unpaid: "#E11D48",
  exported: "#059669",
};

/** The single hue used for magnitude (ranking / timeseries) charts. */
const SERIES_HUE = "#8B5CF6";

export function statusColor(key: string): string {
  return STATUS_COLORS[key] ?? SERIES_HUE;
}

/** Measure a container so chart geometry is true rather than stretched. */
function useElementWidth<T extends HTMLElement>() {
  const ref = React.useRef<T | null>(null);
  const [width, setWidth] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface Slice {
  label: string;
  value: number;
}

/**
 * Ranked horizontal bars — the workhorse for "which category is biggest".
 * One hue, count AND share shown, so the bar is a comparison aid rather than a
 * decorative progress meter.
 */
export function BarList({
  data,
  total,
  formatValue,
  colorByStatus = false,
}: {
  data: Slice[];
  /** Denominator for the share column. Defaults to the sum of `data`. */
  total?: number;
  formatValue?: (n: number) => string;
  /** Use the validated status palette instead of the single series hue. */
  colorByStatus?: boolean;
}) {
  const sum = total ?? data.reduce((a, b) => a + b.value, 0);
  const max = Math.max(1, ...data.map((d) => d.value));
  const fmt = formatValue ?? ((n: number) => n.toLocaleString("en-US"));

  if (!data.length) {
    return (
      <div className="grid h-32 place-items-center rounded-lg border border-dashed border-border-soft text-xs text-text-muted">
        No data in this range.
      </div>
    );
  }

  return (
    <ul className="space-y-2.5">
      {data.map((d) => {
        const pct = sum > 0 ? (d.value / sum) * 100 : 0;
        return (
          <li key={d.label}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              {/* Text wears text tokens — never the series color. */}
              <span className="truncate capitalize text-text-secondary" title={d.label}>
                {d.label.replace(/_/g, " ")}
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="text-text-primary">{fmt(d.value)}</span>
                {sum > 0 && <span className="ml-1.5 text-text-muted">{pct.toFixed(0)}%</span>}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-button-bg-soft">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(1.5, (d.value / max) * 100)}%`,
                  backgroundColor: colorByStatus ? statusColor(d.label) : SERIES_HUE,
                  transition: "width var(--dur-enter) var(--ease-out)",
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Segmented distribution bar with a labelled legend.
 *
 * The gaps between segments and the always-present text legend ARE the
 * secondary encoding the palette's CVD warning requires. Never reduce this to
 * color-only segments.
 */
export function StatusBar({
  counts,
  order = STATUS_ORDER as readonly string[],
}: {
  counts: Record<string, number>;
  order?: readonly string[];
}) {
  const keys = order.length ? order : Object.keys(counts);
  const entries = keys
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => ({ label: k, value: counts[k] ?? 0 }));
  const total = entries.reduce((a, b) => a + b.value, 0);

  if (total === 0) {
    return (
      <div className="grid h-32 place-items-center rounded-lg border border-dashed border-border-soft text-xs text-text-muted">
        No records in this range.
      </div>
    );
  }

  return (
    <div>
      <div
        className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full"
        role="img"
        aria-label={entries.map((e) => `${e.label}: ${e.value}`).join(", ")}
      >
        {entries.map((e) => (
          <div
            key={e.label}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(e.value / total) * 100}%`,
              backgroundColor: statusColor(e.label),
            }}
            title={`${e.label}: ${e.value.toLocaleString("en-US")}`}
          />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {entries.map((e) => (
          <li key={e.label} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: statusColor(e.label) }}
            />
            <span className="truncate capitalize text-text-secondary">
              {e.label.replace(/_/g, " ")}
            </span>
            <span className="ml-auto tabular-nums text-text-primary">
              {e.value.toLocaleString("en-US")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface DayPoint {
  day: string;
  count: number;
}

/**
 * Single-series area chart over day buckets, with crosshair + tooltip.
 *
 * One series ⇒ no legend box (the card title names it). Geometry is MEASURED,
 * not stretched: the previous chart used `preserveAspectRatio="none"` on a fixed
 * 600×200 viewBox, so the curve was non-uniformly squashed at narrow widths.
 */
export function AreaChart({
  data,
  height = 180,
  label,
}: {
  data: DayPoint[];
  height?: number;
  label: string;
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hover, setHover] = React.useState<number | null>(null);
  const gradientId = React.useId();

  const PAD = { top: 10, right: 6, bottom: 4, left: 6 };
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = Math.max(0, height - PAD.top - PAD.bottom);
  const max = Math.max(1, ...data.map((d) => d.count));

  const x = (i: number) =>
    PAD.left + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.count)}`).join(" ");
  const areaPath = data.length
    ? `${linePath} L${x(data.length - 1)},${PAD.top + plotH} L${x(0)},${PAD.top + plotH} Z`
    : "";

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!data.length || plotW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - rect.left - PAD.left) / plotW) * (data.length - 1));
    setHover(Math.min(data.length - 1, Math.max(0, i)));
  };

  const active = hover != null ? data[hover] : null;

  if (!data.length) {
    return (
      <div
        className="grid place-items-center rounded-lg border border-dashed border-border-soft text-xs text-text-muted"
        style={{ height }}
      >
        No activity in this range.
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${Math.max(width, 1)} ${height}`}
        role="img"
        aria-label={`${label}: ${data.length} days, peak ${max.toLocaleString("en-US")} on ${
          data.reduce((a, b) => (b.count > a.count ? b : a), data[0]).day
        }.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        className="touch-none"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={SERIES_HUE} stopOpacity="0.28" />
            <stop offset="100%" stopColor={SERIES_HUE} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Recessive baseline — the only rule this chart needs. */}
        <line
          x1={PAD.left}
          y1={PAD.top + plotH}
          x2={PAD.left + plotW}
          y2={PAD.top + plotH}
          className="text-border-soft"
          stroke="currentColor"
          strokeWidth="1"
        />

        {width > 0 && (
          <>
            <path d={areaPath} fill={`url(#${gradientId})`} />
            <path
              d={linePath}
              fill="none"
              stroke={SERIES_HUE}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}

        {active && hover != null && (
          <>
            <line
              x1={x(hover)}
              y1={PAD.top}
              x2={x(hover)}
              y2={PAD.top + plotH}
              stroke={SERIES_HUE}
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.5"
            />
            {/* 2px surface ring so the marker reads on top of the fill. */}
            <circle
              cx={x(hover)}
              cy={y(active.count)}
              r="4.5"
              fill={SERIES_HUE}
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
          </>
        )}
      </svg>

      {/* First/last day only — a label on every point is noise. */}
      <div className="mt-1 flex justify-between px-1 text-[10px] tabular-nums text-text-muted">
        <span>{formatDayShort(data[0].day)}</span>
        <span>{formatDayShort(data[data.length - 1].day)}</span>
      </div>

      {active && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border-strong bg-surface px-2 py-1 text-[11px] shadow-lg"
          style={{
            left: `${Math.min(Math.max(x(hover ?? 0), 48), Math.max(width - 48, 48))}px`,
            transform: "translateX(-50%)",
          }}
          role="status"
        >
          <span className="tabular-nums text-text-primary">
            {active.count.toLocaleString("en-US")}
          </span>
          <span className="ml-1.5 text-text-muted">{formatDayShort(active.day)}</span>
        </div>
      )}
    </div>
  );
}

function formatDayShort(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Compact label/value grid for secondary stats inside a card. */
export function StatRow({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt>
            <MicroLabel>{it.label}</MicroLabel>
          </dt>
          <dd className="mt-1 truncate text-sm font-medium tabular-nums text-text-primary">
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Colored dot + text label — the shared status marker for table cells. */
export function StatusDot({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", className)}>
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: statusColor(status) }}
      />
      <span className="capitalize text-text-secondary">{status.replace(/_/g, " ")}</span>
    </span>
  );
}
