"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

export function BeforeAfter() {
  const [pos, setPos] = React.useState(50); // 0..100
  const ref = React.useRef<HTMLDivElement | null>(null);
  const dragging = React.useRef(false);

  const update = (clientX: number) => {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const p = ((clientX - r.left) / r.width) * 100;
    setPos(Math.min(98, Math.max(2, p)));
  };

  React.useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      if (!dragging.current) return;
      const x = "touches" in e ? e.touches[0].clientX : e.clientX;
      update(x);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
    };
  }, []);

  const startDrag = () => {
    dragging.current = true;
    document.body.style.cursor = "ew-resize";
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") setPos((p) => Math.max(2, p - 3));
    if (e.key === "ArrowRight") setPos((p) => Math.min(98, p + 3));
    if (e.key === "Home") setPos(2);
    if (e.key === "End") setPos(98);
  };

  return (
    <div
      ref={ref}
      className="relative aspect-[16/9] w-full overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-cinematic select-none"
      onClick={(e) => update(e.clientX)}
    >
      {/* AFTER — cinematic */}
      <FakeRecordingAfter />

      {/* BEFORE — plain, clipped to left side */}
      <div
        className="absolute inset-0"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      >
        <FakeRecordingBefore />
      </div>

      {/* labels */}
      <span className="pointer-events-none absolute left-4 top-4 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-fog backdrop-blur-md">
        Before
      </span>
      <span className="pointer-events-none absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-full border border-violet-400/40 bg-violet-500/20 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-200 backdrop-blur-md">
        <Sparkles size={10} /> After
      </span>

      {/* drag handle */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Before / after comparison"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        onKeyDown={onKey}
        onMouseDown={(e) => {
          e.preventDefault();
          startDrag();
        }}
        onTouchStart={startDrag}
        className="absolute inset-y-0 z-30 -ml-px w-0.5 cursor-ew-resize bg-white/80 shadow-[0_0_20px_rgba(139,92,246,0.5)]"
        style={{ left: `${pos}%` }}
      >
        <span className="absolute left-1/2 top-1/2 inline-flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-ink/90 shadow-cinematic backdrop-blur-md">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white">
            <polyline points="15 18 9 12 15 6" />
            <polyline points="9 6 15 12 9 18" />
          </svg>
        </span>
      </div>
    </div>
  );
}

function FakeRecordingBefore() {
  return (
    <div className="absolute inset-0 grid grid-cols-[20%_1fr] bg-gradient-to-br from-[#0B0D11] to-[#0E1218]">
      <div className="border-r border-white/[0.05] bg-white/[0.015] p-4">
        <div className="mb-3 h-3 w-2/3 rounded bg-white/10" />
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-2.5 rounded bg-white/[0.06]" />
          ))}
        </div>
      </div>
      <div className="p-6">
        <div className="mb-4 h-4 w-1/3 rounded bg-white/10" />
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]" />
          ))}
        </div>
      </div>

      {/* plain cursor — small, no glow */}
      <svg
        viewBox="0 0 20 20"
        width="14"
        height="14"
        className="absolute left-[55%] top-[42%]"
      >
        <path d="M3 2 L17 9 L10 11 L9 18 Z" fill="white" stroke="black" strokeWidth="0.6" />
      </svg>
    </div>
  );
}

function FakeRecordingAfter() {
  return (
    <div className="absolute inset-0 bg-gradient-to-br from-[#0B0D11] to-[#11141B]">
      {/* cinematic crop — slight zoom on the second tile */}
      <div className="absolute inset-0 grid grid-cols-[20%_1fr]">
        <div className="border-r border-white/[0.05] bg-white/[0.015] p-4">
          <div className="mb-3 h-3 w-2/3 rounded bg-white/10" />
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={`h-2.5 rounded ${i === 2 ? "bg-violet-500/60" : "bg-white/[0.06]"}`}
              />
            ))}
          </div>
        </div>
        <div className="p-6">
          <div className="mb-4 h-4 w-1/3 rounded bg-white/10" />
          <div
            className="grid grid-cols-3 gap-3"
            style={{ transform: "scale(1.14)", transformOrigin: "44% 56%" }}
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={
                  i === 4
                    ? "aspect-[4/3] rounded-lg border border-violet-400/50 bg-gradient-to-br from-violet-500/15 to-cyan-400/15 ring-1 ring-violet-400/30"
                    : "aspect-[4/3] rounded-lg border border-white/[0.06] bg-white/[0.03]"
                }
              >
                {i === 4 && (
                  <div className="m-3 space-y-1.5">
                    <div className="h-1.5 w-2/3 rounded bg-white/30" />
                    <div className="h-1.5 w-4/5 rounded bg-white/15" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* zoom rectangle */}
      <div className="pointer-events-none absolute left-[64%] top-[42%] h-[36%] w-[28%] rounded-md ring-2 ring-violet-400/70 shadow-[0_0_0_4px_rgba(139,92,246,0.15)]">
        <span className="absolute -left-0.5 -top-0.5 size-2.5 border-l-2 border-t-2 border-violet-300" />
        <span className="absolute -right-0.5 -top-0.5 size-2.5 border-r-2 border-t-2 border-violet-300" />
        <span className="absolute -bottom-0.5 -left-0.5 size-2.5 border-b-2 border-l-2 border-violet-300" />
        <span className="absolute -bottom-0.5 -right-0.5 size-2.5 border-b-2 border-r-2 border-violet-300" />
        <span className="absolute -top-6 left-0 inline-flex items-center gap-1 rounded-md bg-violet-500 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white shadow-violet-glow">
          <Sparkles size={9} /> Zoom
        </span>
      </div>

      {/* glowing cursor + click ring */}
      <div className="pointer-events-none absolute left-[71%] top-[55%]">
        <motion.span
          className="absolute -left-3 -top-3 inline-block size-6 rounded-full border border-violet-400/70"
          animate={{ scale: [0.6, 1.4, 0.6], opacity: [0.7, 0, 0.7] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }}
        />
        <svg
          viewBox="0 0 20 20"
          width="20"
          height="20"
          className="relative drop-shadow-[0_0_8px_rgba(139,92,246,0.7)]"
        >
          <path d="M3 2 L17 9 L10 11 L9 18 Z" fill="white" stroke="rgba(0,0,0,0.5)" strokeWidth="0.6" />
        </svg>
      </div>

      {/* cinematic letterbox bars */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-black/60" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-black/60" />
    </div>
  );
}
