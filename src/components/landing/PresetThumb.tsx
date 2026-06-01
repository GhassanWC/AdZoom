import type { PresetVibe } from "@/lib/types";

// Synthetic CSS-rendered thumbnail for each preset vibe
export function PresetThumb({ vibe }: { vibe: PresetVibe }) {
  switch (vibe) {
    case "mrbeast":
      return (
        <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-rose-500/20 via-amber-400/10 to-amber-500/20">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_60%,rgba(255,255,255,0.08),transparent_50%)]" />
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
            <div className="font-display text-2xl font-bold text-white drop-shadow-[0_4px_12px_rgba(0,0,0,0.6)]">
              $1,000,000
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-amber-200">
              CHALLENGE
            </div>
          </div>
          <div className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-rose-500 px-2 py-0.5 text-[9px] font-bold uppercase text-white">
            REC
          </div>
        </div>
      );

    case "cinematic":
      return (
        <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-[#1a1410] via-[#0d0d0d] to-[#1a0f15]">
          <div className="absolute inset-x-0 top-0 h-3 bg-black" />
          <div className="absolute inset-x-0 bottom-0 h-3 bg-black" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_50%,rgba(251,146,60,0.18),transparent_60%)]" />
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="size-16 rounded-full border-2 border-amber-200/60 bg-amber-100/5 backdrop-blur-md" />
          </div>
          <span className="absolute bottom-5 left-1/2 -translate-x-1/2 font-display text-[10px] uppercase tracking-[0.2em] text-amber-100/80">
            scene 04
          </span>
        </div>
      );

    case "tutorial":
      return (
        <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-[#0B0D11] to-[#11141B]">
          <div className="absolute inset-3 rounded-md border border-white/10 bg-white/[0.02] p-2">
            <div className="mb-1.5 h-1.5 w-1/3 rounded bg-white/15" />
            <div className="grid grid-cols-2 gap-1.5">
              <div className="h-8 rounded bg-white/[0.05]" />
              <div className="h-8 rounded border border-violet-400/40 bg-violet-500/15" />
            </div>
          </div>
          {/* annotation arrow */}
          <svg className="absolute right-3 top-5 text-violet-300" width="46" height="30" viewBox="0 0 46 30" fill="none">
            <path d="M2 28 C 14 10, 28 6, 42 8" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2" />
            <path d="M38 4 L 42 8 L 38 12" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
          <span className="absolute right-3 top-2 rounded-md bg-violet-500/90 px-1.5 py-0.5 text-[9px] font-semibold text-white">
            click here
          </span>
        </div>
      );

    case "tiktok":
      return (
        <div className="relative flex h-full w-full items-center justify-center bg-gradient-to-br from-fuchsia-500/15 via-rose-500/10 to-violet-500/15">
          <div className="relative h-full aspect-[9/16] max-h-[90%] overflow-hidden rounded-md border border-white/10 bg-black">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_70%,rgba(217,70,239,0.18),transparent_60%)]" />
            <span className="absolute left-1/2 top-1/3 -translate-x-1/2 rounded bg-white px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-black">
              POV: you ship
            </span>
            <span className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[8px] font-medium text-white/80">
              @framevo
            </span>
            <div className="absolute right-1.5 bottom-3 flex flex-col items-center gap-1.5">
              <span className="size-3 rounded-full bg-white/20" />
              <span className="size-3 rounded-full bg-white/20" />
              <span className="size-3 rounded-full bg-white/20" />
            </div>
          </div>
        </div>
      );

    case "coding":
      return (
        <div className="relative h-full w-full overflow-hidden bg-[#0B0D11] p-3 font-mono text-[8px] leading-relaxed">
          <div className="space-y-0.5">
            <div><span className="text-violet-300">const</span> <span className="text-cyan-400">video</span> = <span className="text-amber-200">await</span> loadFile();</div>
            <div><span className="text-violet-300">function</span> <span className="text-emerald-300">enhance</span>(<span className="text-cyan-400">clip</span>) {`{`}</div>
            <div className="pl-2"><span className="text-rose-300">if</span> (clip.cursor) {`{`}</div>
            <div className="rounded bg-violet-500/15 pl-4 ring-1 ring-violet-400/40">  <span className="text-amber-200">return</span> ai.zoom(clip);</div>
            <div className="pl-2">{`}`}</div>
            <div>{`}`}</div>
          </div>
          <span className="absolute right-2 top-2 rounded bg-violet-500/90 px-1.5 py-0.5 text-[9px] font-semibold text-white">
            zoom
          </span>
        </div>
      );

    case "product":
    case "saas":
      return (
        <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-[#0B0D11] to-[#11141B]">
          <div className="absolute inset-3 rounded-md border border-white/10 bg-white/[0.02]">
            <div className="flex h-4 items-center gap-1 border-b border-white/[0.05] px-2">
              <span className="size-1 rounded-full bg-rose-400/80" />
              <span className="size-1 rounded-full bg-amber-400/80" />
              <span className="size-1 rounded-full bg-emerald-400/80" />
            </div>
            <div className="p-2">
              <div className="mb-1.5 h-1.5 w-1/2 rounded bg-white/15" />
              <div className="grid grid-cols-3 gap-1">
                <div className="h-5 rounded bg-white/[0.05]" />
                <div className="h-5 rounded bg-white/[0.05]" />
                <div className="h-5 rounded bg-violet-500/40" />
              </div>
            </div>
          </div>
          <svg viewBox="0 0 20 20" width="11" height="11" className="absolute right-6 bottom-4 drop-shadow-[0_0_6px_rgba(139,92,246,0.7)]">
            <path d="M3 2 L17 9 L10 11 L9 18 Z" fill="white" />
          </svg>
        </div>
      );

    case "youtube":
      return (
        <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-rose-500/15 to-rose-700/15">
          <div className="absolute inset-2 rounded-md bg-black/60">
            <div className="absolute inset-x-2 bottom-2 h-1 rounded-full bg-white/15">
              <div className="h-full w-1/2 rounded-full bg-rose-500" />
            </div>
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 size-7 rounded-full bg-rose-500" />
          </div>
        </div>
      );

    case "vlog":
      return (
        <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-amber-500/15 to-rose-500/15">
          <div className="absolute inset-3 rounded-md border border-white/10 bg-black/40" />
          <span className="absolute left-3 top-3 rounded bg-white px-1.5 py-0.5 text-[8px] font-bold uppercase text-black">
            day 042
          </span>
        </div>
      );

    case "podcast":
      return (
        <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-indigo-500/15 to-violet-500/15">
          <div className="absolute inset-x-3 bottom-3 flex h-8 items-end gap-0.5">
            {Array.from({ length: 32 }).map((_, i) => (
              <span
                key={i}
                className="flex-1 rounded-sm bg-violet-300/60"
                style={{ height: `${20 + Math.abs(Math.sin(i * 0.6)) * 80}%` }}
              />
            ))}
          </div>
        </div>
      );

    case "demo":
      return (
        <div className="relative h-full w-full overflow-hidden bg-gradient-to-br from-cyan-500/15 to-violet-500/15">
          <div className="absolute inset-3 rounded-md border border-white/10 bg-white/[0.02]" />
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-rose-500 px-1.5 py-0.5 text-[8px] font-bold uppercase text-white">
            <span className="size-1 rounded-full bg-white animate-pulse" />
            live
          </span>
        </div>
      );

    case "shorts":
      return (
        <div className="relative flex h-full w-full items-center justify-center bg-gradient-to-br from-rose-500/15 to-violet-500/15">
          <div className="relative h-full aspect-[9/16] max-h-[90%] overflow-hidden rounded-md border border-white/10 bg-black">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_40%,rgba(139,92,246,0.3),transparent_60%)]" />
            <span className="absolute left-1/2 top-1/4 -translate-x-1/2 rounded bg-violet-500 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
              hook
            </span>
          </div>
        </div>
      );

    default:
      return <div className="h-full w-full bg-white/[0.02]" />;
  }
}
