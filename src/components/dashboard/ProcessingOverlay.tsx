"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Check, X } from "lucide-react";
import { useEditor } from "./editor-state";

const stages = [
  "Analyzing motion",
  "Detecting focus regions",
  "Generating zooms",
  "Rendering export",
  "Done",
] as const;

export function ProcessingOverlay() {
  const { exporting, cancelExport } = useEditor();
  const [stage, setStage] = React.useState(0);

  React.useEffect(() => {
    if (!exporting) {
      setStage(0);
      return;
    }
    const t = setInterval(() => {
      setStage((s) => {
        if (s >= stages.length - 1) {
          clearInterval(t);
          setTimeout(cancelExport, 900);
          return s;
        }
        return s + 1;
      });
    }, 1200);
    return () => clearInterval(t);
  }, [exporting, cancelExport]);

  React.useEffect(() => {
    if (!exporting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelExport();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exporting, cancelExport]);

  return (
    <AnimatePresence>
      {exporting && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-ink/85 backdrop-blur-2xl"
        >
          <button
            aria-label="Cancel export"
            onClick={cancelExport}
            className="absolute right-6 top-6 inline-flex size-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white"
          >
            <X size={15} />
          </button>

          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="relative w-full max-w-md"
          >
            {/* concentric arcs */}
            <div className="relative mx-auto mb-8 h-44 w-44">
              <ArcSpinner size={176} duration={4} dash="220 80" />
              <ArcSpinner size={140} duration={3} dash="180 60" reverse />
              <ArcSpinner size={104} duration={2.2} dash="120 40" />

              {/* center disc */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="glass-strong flex size-20 items-center justify-center rounded-full">
                  <AnimatePresence mode="wait">
                    {stage < stages.length - 1 ? (
                      <motion.div
                        key="dots"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="flex gap-1"
                      >
                        {[0, 1, 2].map((i) => (
                          <motion.span
                            key={i}
                            animate={{ opacity: [0.3, 1, 0.3] }}
                            transition={{
                              duration: 1.1,
                              repeat: Infinity,
                              delay: i * 0.2,
                            }}
                            className="size-1.5 rounded-full bg-violet-300"
                          />
                        ))}
                      </motion.div>
                    ) : (
                      <motion.span
                        key="done"
                        initial={{ scale: 0.6, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 500, damping: 25 }}
                        className="inline-flex size-9 items-center justify-center rounded-full bg-violet-500 text-white"
                      >
                        <Check size={16} />
                      </motion.span>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </div>

            <div className="text-center">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-violet-300">
                Framevo AI
              </div>
              <AnimatePresence mode="wait">
                <motion.h3
                  key={stages[stage]}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.3 }}
                  className="font-display text-2xl font-semibold tracking-tight text-white"
                >
                  {stages[stage]}…
                </motion.h3>
              </AnimatePresence>
              <p className="mt-2 text-sm text-fog">
                Crafting your cinematic export. This usually takes under a minute.
              </p>

              {/* progress bar */}
              <div className="mx-auto mt-7 h-1 w-72 overflow-hidden rounded-full bg-white/[0.06]">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{
                    width: `${((stage + 1) / stages.length) * 100}%`,
                  }}
                  transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 shadow-[0_0_16px_rgba(139,92,246,0.6)]"
                />
              </div>

              {/* stage list */}
              <ul className="mt-7 inline-flex flex-col gap-2 text-left">
                {stages.slice(0, -1).map((s, i) => {
                  const done = i < stage;
                  const active = i === stage;
                  return (
                    <li
                      key={s}
                      className="flex items-center gap-2.5 text-xs"
                    >
                      <span
                        className={
                          done
                            ? "inline-flex size-4 items-center justify-center rounded-full bg-violet-500 text-white"
                            : active
                              ? "inline-flex size-4 items-center justify-center rounded-full border border-violet-400/60 bg-violet-500/15"
                              : "inline-flex size-4 items-center justify-center rounded-full border border-white/10"
                        }
                      >
                        {done && <Check size={9} />}
                        {active && (
                          <span className="size-1 animate-pulse rounded-full bg-violet-300" />
                        )}
                      </span>
                      <span
                        className={
                          done || active ? "text-white/90" : "text-fog/70"
                        }
                      >
                        {s}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ArcSpinner({
  size,
  duration,
  dash,
  reverse = false,
}: {
  size: number;
  duration: number;
  dash: string;
  reverse?: boolean;
}) {
  return (
    <motion.svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      animate={{ rotate: reverse ? -360 : 360 }}
      transition={{ duration, repeat: Infinity, ease: "linear" }}
    >
      <defs>
        <linearGradient id={`g-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#22D3EE" stopOpacity="0.3" />
        </linearGradient>
      </defs>
      <circle
        cx="50"
        cy="50"
        r="46"
        fill="none"
        stroke={`url(#g-${size})`}
        strokeWidth="1.2"
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </motion.svg>
  );
}
