import {
  Sparkles,
  RefreshCcw,
  Crosshair,
  SlidersHorizontal,
  Download,
} from "lucide-react";
import { Section } from "@/components/ui/Section";

/**
 * Static, hand-built mock of the editor — chapters band, attention
 * waveform, two tracks of moment pills, ruler, and a docked inspector
 * card. No live JS state. The goal is visual fidelity to the actual
 * editor so this page feels like a product page, not a marketing one.
 */
export function TimelineShowcase() {
  return (
    <Section
      eyebrow="The editor"
      title={
        <>
          A timeline made for{" "}
          <span className="text-gradient-violet">refining, not building.</span>
        </>
      }
      subtitle="AI hands you the draft. You drag, retime, reframe — at the level of a single click or the whole pacing curve."
      size="wide"
    >
      <div className="glass relative overflow-hidden rounded-3xl">
        {/* ── Editor toolbar row ────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="font-display text-[15px] font-semibold tracking-tight text-white">
              SaaS demo — onboarding flow
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-100">
              <Sparkles size={10} />
              SaaS demo
            </span>
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-fog">
              4-act narrative
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <PillButton Icon={RefreshCcw}>Re-analyze</PillButton>
            <PillButton Icon={Crosshair}>Refine framing</PillButton>
            <PillButton Icon={SlidersHorizontal}>Effects</PillButton>
            <PillButton Icon={Download} primary>
              Export
            </PillButton>
          </div>
        </div>

        {/* ── Chapters band ─────────────────────────────────────────── */}
        <div className="border-b border-white/[0.04] px-6 py-4">
          <div className="flex h-10 w-full overflow-hidden rounded-lg border border-white/10">
            <Chapter label="DISCOVER" tone="slate" width="7%" />
            <Chapter label="ACTION" tone="violet" width="13%" subtitle="Setup" />
            <Chapter
              label="ACTION"
              tone="violet"
              width="29%"
              subtitle="Navigating creator channels"
            />
            <Chapter
              label="ACTION"
              tone="violet"
              width="36%"
              subtitle="Engaging with YouTube Shorts"
            />
            <Chapter label="RESULT" tone="emerald" width="15%" subtitle="Save" />
          </div>
        </div>

        {/* ── Attention waveform ────────────────────────────────────── */}
        <div className="border-b border-white/[0.04] px-6 py-4">
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.18em] text-fog">
            <span>Attention</span>
            <span className="text-fog/60">8-bit / 60s</span>
          </div>
          <AttentionWaveform />
        </div>

        {/* ── Ruler + tracks ────────────────────────────────────────── */}
        <div className="px-6 pb-6 pt-4">
          <Ruler />

          {/* track: AI edits */}
          <div className="mt-3 flex items-center gap-3">
            <TrackLabel n="AI" sub="Edits · 7" />
            <div className="relative h-12 flex-1 rounded-lg bg-white/[0.02]">
              <MomentPill
                left="6%"
                width="6%"
                effect="zoom"
                label="CTA click"
                tone="violet"
              />
              <MomentPill
                left="16%"
                width="7%"
                effect="cursor-focus"
                label="Cursor follow"
                tone="cyan"
              />
              <MomentPill
                left="29%"
                width="9%"
                effect="zoom"
                label="Nav click"
                tone="violet"
              />
              <MomentPill
                left="44%"
                width="8%"
                effect="click-highlight"
                label="Icon"
                tone="amber"
              />
              <MomentPill
                left="58%"
                width="10%"
                effect="zoom"
                label="Primary CTA"
                tone="violet"
                selected
              />
              <MomentPill
                left="74%"
                width="7%"
                effect="cursor-focus"
                label="Form"
                tone="cyan"
              />
              <MomentPill
                left="86%"
                width="9%"
                effect="zoom"
                label="Result"
                tone="emerald"
              />
              {/* playhead */}
              <span className="absolute left-[60%] top-0 h-full w-px bg-violet-300" />
              <span className="absolute -top-1 left-[60%] size-2 -translate-x-1/2 rounded-full bg-violet-300" />
            </div>
          </div>

          {/* track: user edits */}
          <div className="mt-2 flex items-center gap-3">
            <TrackLabel n="YOU" sub="Edits · 1" />
            <div className="relative h-8 flex-1 rounded-lg bg-white/[0.02]">
              <MomentPill
                left="40%"
                width="6%"
                effect="zoom"
                label="Custom"
                tone="white"
                small
              />
            </div>
          </div>
        </div>

        {/* ── Inspector preview ─────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-px bg-white/[0.05] lg:grid-cols-[1.4fr_1fr]">
          <FrameInspector />
          <MomentInspector />
        </div>
      </div>
    </Section>
  );
}

function PillButton({
  Icon,
  children,
  primary,
}: {
  Icon: React.ComponentType<{ size?: number }>;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <span
      className={
        primary
          ? "inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-500 px-3 text-[11.5px] font-medium text-white shadow-[0_6px_18px_-8px_rgba(139,92,246,0.7)]"
          : "inline-flex h-8 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.02] px-3 text-[11.5px] font-medium text-white/85"
      }
    >
      <Icon size={11} />
      {children}
    </span>
  );
}

function Chapter({
  label,
  tone,
  width,
  subtitle,
}: {
  label: string;
  tone: "slate" | "violet" | "emerald";
  width: string;
  subtitle?: string;
}) {
  const toneClass =
    tone === "violet"
      ? "from-violet-500/55 via-violet-500/30 to-violet-500/15"
      : tone === "emerald"
      ? "from-emerald-500/55 via-emerald-500/25 to-emerald-500/15"
      : "from-slate-500/45 via-slate-500/20 to-slate-500/10";
  return (
    <div
      className={`relative flex h-full flex-col justify-center border-r border-white/[0.06] bg-gradient-to-b px-3 ${toneClass}`}
      style={{ width }}
    >
      <span className="text-[9px] font-semibold uppercase tracking-[0.22em] text-white/85">
        {label}
      </span>
      {subtitle && (
        <span className="truncate text-[10.5px] text-white/65">{subtitle}</span>
      )}
    </div>
  );
}

function AttentionWaveform() {
  // 36 deterministic bars — visual rhythm, no randomness so SSR is stable.
  const bars = [
    0.2, 0.32, 0.45, 0.6, 0.78, 0.65, 0.48, 0.42, 0.55, 0.7, 0.82, 0.9, 0.78,
    0.6, 0.48, 0.36, 0.55, 0.72, 0.85, 0.92, 0.75, 0.58, 0.42, 0.5, 0.65, 0.78,
    0.88, 0.7, 0.55, 0.4, 0.32, 0.45, 0.58, 0.72, 0.86, 0.65,
  ];
  return (
    <div className="flex h-12 w-full items-end gap-[3px] rounded-lg bg-white/[0.02] px-2 py-1.5">
      {bars.map((h, i) => (
        <span
          key={i}
          className="flex-1 rounded-sm bg-gradient-to-t from-violet-500/45 to-violet-300/85"
          style={{ height: `${Math.round(h * 100)}%` }}
        />
      ))}
    </div>
  );
}

function Ruler() {
  return (
    <div className="flex items-end justify-between text-[10px] text-fog">
      {["0:00", "0:10", "0:20", "0:30", "0:40", "0:50", "1:00", "1:09"].map(
        (t, i) => (
          <span key={i} className="flex flex-col items-center gap-1">
            <span className="h-1.5 w-px bg-white/15" />
            {t}
          </span>
        )
      )}
    </div>
  );
}

function TrackLabel({ n, sub }: { n: string; sub: string }) {
  return (
    <div className="w-16 shrink-0 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5 text-[10px]">
      <div className="font-display font-semibold tracking-[0.18em] text-white/85">
        {n}
      </div>
      <div className="text-fog">{sub}</div>
    </div>
  );
}

function MomentPill({
  left,
  width,
  effect,
  label,
  tone,
  selected,
  small,
}: {
  left: string;
  width: string;
  effect: string;
  label: string;
  tone: "violet" | "cyan" | "amber" | "emerald" | "white";
  selected?: boolean;
  small?: boolean;
}) {
  const toneStyles =
    tone === "violet"
      ? "from-violet-500/85 to-violet-500/45 ring-violet-300/70"
      : tone === "cyan"
      ? "from-cyan-400/80 to-cyan-400/40 ring-cyan-300/70"
      : tone === "amber"
      ? "from-amber-400/85 to-amber-400/45 ring-amber-300/70"
      : tone === "emerald"
      ? "from-emerald-400/85 to-emerald-400/45 ring-emerald-300/70"
      : "from-white/40 to-white/15 ring-white/40";
  return (
    <div
      className={`absolute top-1.5 ${
        small ? "h-5" : "h-9"
      } rounded-md bg-gradient-to-b ${toneStyles} ${
        selected
          ? "ring-2 shadow-[0_0_0_3px_rgba(139,92,246,0.25)]"
          : "ring-1"
      } px-1.5 text-[9.5px] font-medium text-white/95 overflow-hidden`}
      style={{ left, width }}
    >
      {!small && (
        <>
          <div className="truncate font-semibold">{label}</div>
          <div className="font-mono text-[8.5px] text-white/70">{effect}</div>
        </>
      )}
    </div>
  );
}

function FrameInspector() {
  // Static "preview" pane — a mocked SaaS UI with a focus rect, like the editor's live preview.
  return (
    <div className="relative aspect-[16/10] bg-gradient-to-br from-[#0B0D11] to-[#0E1218]">
      <div className="absolute inset-y-0 left-0 w-[18%] border-r border-white/[0.05] bg-white/[0.015] p-3">
        <div className="h-2.5 w-2/3 rounded bg-white/10" />
        <div className="mt-3 space-y-1.5">
          <div className="h-2 rounded bg-white/[0.06]" />
          <div className="h-2 w-4/5 rounded bg-violet-500/40" />
          <div className="h-2 w-3/4 rounded bg-white/[0.06]" />
          <div className="h-2 w-2/3 rounded bg-white/[0.06]" />
        </div>
      </div>
      <div className="absolute inset-y-0 left-[18%] right-0 p-5">
        <div className="mb-4 h-3.5 w-2/5 rounded bg-white/10" />
        <div className="grid grid-cols-3 gap-2.5">
          <div className="aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]" />
          <div className="aspect-[4/3] rounded-lg border border-violet-400/40 bg-gradient-to-br from-violet-500/15 to-cyan-400/10 ring-1 ring-inset ring-violet-400/30" />
          <div className="aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]" />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <div className="h-7 w-28 rounded-md bg-violet-500/85" />
          <div className="h-7 w-20 rounded-md border border-white/10 bg-white/[0.03]" />
        </div>
      </div>

      {/* focus rect highlighting the primary CTA */}
      <div className="absolute left-[50%] top-[44%] h-[30%] w-[26%] rounded-md ring-2 ring-violet-400/85">
        <span className="absolute -left-0.5 -top-0.5 size-2.5 border-l-2 border-t-2 border-violet-300" />
        <span className="absolute -right-0.5 -top-0.5 size-2.5 border-r-2 border-t-2 border-violet-300" />
        <span className="absolute -bottom-0.5 -left-0.5 size-2.5 border-b-2 border-l-2 border-violet-300" />
        <span className="absolute -bottom-0.5 -right-0.5 size-2.5 border-b-2 border-r-2 border-violet-300" />
        <span className="absolute -top-6 left-0 inline-flex items-center gap-1 rounded-md bg-violet-500 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-violet-glow">
          <Sparkles size={9} /> Primary CTA · zoom 2.4×
        </span>
      </div>
    </div>
  );
}

function MomentInspector() {
  return (
    <div className="space-y-4 bg-ink/30 p-6">
      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-fog">
          Inspector
        </div>
        <div className="mt-1 font-display text-[16px] font-semibold tracking-tight text-white">
          Primary CTA click
        </div>
        <div className="text-[12px] text-fog">0:33.4 → 0:35.2</div>
      </div>

      <div className="space-y-2.5">
        <Row label="Effect" value="zoom" mono />
        <Row label="Provenance" value="event · classified primary-cta" mono />
        <Row label="Confidence" value="0.95" mono />
        <Row label="Focus" value="30% box · 2.4× scale" mono />
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-fog">
          AI reasoning
        </div>
        <ul className="mt-2 space-y-1 font-mono text-[10.5px] text-fog">
          <li>· click@33.42,(0.71,0.38)</li>
          <li>· rect-area=0.062</li>
          <li>· tier=primary-cta</li>
          <li>· cursor-hesitation=0.74</li>
          <li>· cv-region-overlap=button(0.81)</li>
        </ul>
      </div>

      <div className="border-t border-white/[0.06] pt-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-fog">
          Intensity
        </div>
        <div className="mt-2 flex h-1.5 w-full rounded-full bg-white/[0.06]">
          <span className="h-full w-[78%] rounded-full bg-violet-400" />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-fog">
          <span>subtle</span>
          <span>cinematic</span>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] text-fog">{label}</span>
      <span
        className={`text-[12.5px] text-white/90 ${
          mono ? "font-mono text-[11px]" : ""
        } text-right`}
      >
        {value}
      </span>
    </div>
  );
}
