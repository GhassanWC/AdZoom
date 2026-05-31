"use client";

/**
 * Click-pipeline diagnostics panel — surfaces every stage the analyze
 * pipeline runs clicks through, with concrete counts and an in/out
 * delta per stage. Built in direct response to "AI created only 1
 * zoom for a video with 6 clicks" — when the panel disagrees with
 * what the timeline shows, the user can pinpoint exactly which stage
 * is dropping their clicks.
 *
 * Three buttons:
 *   • Re-run diagnose       — read-only inspection, no project mutation
 *   • Generate zooms from
 *     clicks only           — destructive bypass: replaces detectedMoments
 *                             with one zoom per click (no balancer)
 *   • Force re-analyze      — clear detectedMoments + rawMoments, then
 *                             re-run /analyze
 *
 * Lives in the editor UI under the timeline, not behind the dev hotkey.
 */

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Stethoscope,
  Zap,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { getFirebase } from "@/lib/firebase/client";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { useEditorReal } from "./context";
import type { ClickPipelineDiagnostics } from "@/lib/firebase/schema";

type DiagnoseResult = {
  storedClickPipeline: ClickPipelineDiagnostics | null;
  capture: {
    hasInteractionsPath: boolean;
    interactionsPath: string | null;
    scope: "tab" | "external" | null;
    duration: number;
  };
  load: {
    objectExists: boolean;
    parsedOk: boolean;
    error: string | null;
    totalInteractions: number;
    totalClicks: number;
    eventTypeCounts: Record<string, number>;
  };
  classify: {
    tiers: Record<string, number>;
    perClick: Array<{
      id: string;
      t: number;
      x: number;
      y: number;
      hasTargetRect: boolean;
      tier: string;
      confidence: number;
      signals: string[];
    }>;
  };
  eventsEmitted: {
    total: number;
    fromClicks: number;
    byEffectType: Record<string, number>;
  };
  currentTimeline: {
    totalMoments: number;
    eventProvenance: number;
    aiProvenance: number;
    cvProvenance: number;
    userProvenance: number;
  };
};

export function ClickPipelinePanel() {
  const { project, uid, startAnalyze, analyzing } = useEditorReal();
  const { getIdToken } = useAuth();
  const toast = useToast();
  const [open, setOpen] = React.useState(true);
  const [diagnose, setDiagnose] = React.useState<DiagnoseResult | null>(null);
  const [diagnoseLoading, setDiagnoseLoading] = React.useState(false);
  const [bypassLoading, setBypassLoading] = React.useState(false);
  const [forceLoading, setForceLoading] = React.useState(false);

  const stored = project.analysis?.clickPipeline;

  const runDiagnose = async () => {
    setDiagnoseLoading(true);
    try {
      const token = await getIdToken();
      if (!token) throw new Error("Not signed in");
      const res = await fetch(`/api/projects/${project.id}/diagnose`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setDiagnose(body as DiagnoseResult);
      toast.success(
        "Diagnose complete",
        `${body.load.totalClicks} click${body.load.totalClicks === 1 ? "" : "s"} in interactions.json → ${body.eventsEmitted.fromClicks} would emit · ${body.currentTimeline.eventProvenance} on timeline now`
      );
    } catch (err) {
      toast.error("Diagnose failed", err instanceof Error ? err.message : String(err));
    } finally {
      setDiagnoseLoading(false);
    }
  };

  const runBypass = async () => {
    if (!confirm(
      "This will REPLACE all current edits on this project with one zoom per real click " +
      "from interactions.json. No balancer, no AI. Use Re-analyze afterwards to restore " +
      "the normal pipeline. Continue?"
    )) {
      return;
    }
    setBypassLoading(true);
    try {
      const token = await getIdToken();
      if (!token) throw new Error("Not signed in");
      const res = await fetch(`/api/projects/${project.id}/zooms-from-clicks`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      toast.success(
        "Bypass written",
        `${body.momentsWritten} zoom${body.momentsWritten === 1 ? "" : "s"} from ${body.totalClicks} click${body.totalClicks === 1 ? "" : "s"}. Timeline updated.`
      );
    } catch (err) {
      toast.error("Bypass failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBypassLoading(false);
    }
  };

  const runForceReanalyze = async () => {
    if (!confirm(
      "This will CLEAR the current edits, rejected pool, and clickPipeline diagnostics, " +
      "then re-run the full analysis from interactions.json. Continue?"
    )) {
      return;
    }
    setForceLoading(true);
    try {
      const { db } = getFirebase();
      const projectRef = doc(db, "users", uid, "projects", project.id);
      await setDoc(
        projectRef,
        {
          analysis: {
            detectedMoments: [],
            rawMoments: [],
            rejectedPool: [],
            clickPipeline: null,
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      await startAnalyze();
    } catch (err) {
      toast.error("Force re-analyze failed", err instanceof Error ? err.message : String(err));
    } finally {
      setForceLoading(false);
    }
  };

  // Pull the most relevant fields from `stored` for the compact header.
  const headerStatus = (() => {
    if (!stored) return "no-data";
    if (!stored.attemptedLoad) return "skipped";
    if (!stored.interactionsLoaded) return "load-failed";
    if (stored.totalClicks === 0) return "zero-clicks";
    if (stored.eventKept === 0) return "all-dropped";
    if (stored.totalClicks > 0 && stored.eventKept < stored.totalClicks) return "partial-dropped";
    return "ok";
  })();

  return (
    <section className="glass rounded-2xl border border-white/10 bg-ink/40 p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2">
          <Stethoscope size={14} className="text-violet-300" />
          <h3 className="font-display text-[15px] font-semibold text-white">
            Analysis Debug
          </h3>
          <StatusBadge status={headerStatus} stored={stored} />
        </div>
        {open ? (
          <ChevronUp size={16} className="text-fog" />
        ) : (
          <ChevronDown size={16} className="text-fog" />
        )}
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          {!stored && (
            <p className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-fog">
              No click-pipeline diagnostics on this project yet. Run analyze
              to populate, or click <strong>Diagnose now</strong> below to
              read the recording fresh.
            </p>
          )}

          {stored && <StoredStages diag={stored} />}

          {diagnose && <FreshDiagnose result={diagnose} />}

          <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-4">
            <Button
              size="sm"
              variant="ghost"
              leftIcon={
                diagnoseLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Stethoscope size={12} />
                )
              }
              onClick={runDiagnose}
              disabled={diagnoseLoading}
            >
              {diagnoseLoading ? "Diagnosing…" : "Diagnose now (read-only)"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={
                bypassLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Zap size={12} />
                )
              }
              onClick={runBypass}
              disabled={bypassLoading || analyzing}
              title="Replace the timeline with one zoom per click, bypassing the AI and balancer entirely."
            >
              {bypassLoading ? "Writing…" : "Generate zooms from clicks only"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={
                forceLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Trash2 size={12} />
                )
              }
              onClick={runForceReanalyze}
              disabled={forceLoading || analyzing}
              title="Clear all cached analysis fields and re-run /analyze from scratch."
            >
              {forceLoading ? "Clearing…" : "Force re-analyze from interactions"}
            </Button>
          </div>

          <div className="text-[11px] leading-relaxed text-fog/70">
            Looking for: capture → load → momentsFromEvents → balancer.
            If a click disappears, it disappeared in the stage whose
            in-count beats its out-count above.
          </div>
        </div>
      )}
    </section>
  );
}

function StatusBadge({
  status,
  stored,
}: {
  status: string;
  stored: ClickPipelineDiagnostics | undefined;
}) {
  if (status === "no-data") {
    return (
      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-wider text-fog">
        no data
      </span>
    );
  }
  if (status === "skipped") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-200">
        <AlertTriangle size={10} />
        load skipped
      </span>
    );
  }
  if (status === "load-failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-200">
        <AlertTriangle size={10} />
        load failed
      </span>
    );
  }
  if (status === "zero-clicks") {
    return (
      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] uppercase tracking-wider text-fog">
        0 clicks
      </span>
    );
  }
  if (status === "all-dropped") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-rose-200">
        <AlertTriangle size={10} />
        all dropped
      </span>
    );
  }
  if (status === "partial-dropped") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-200">
        <AlertTriangle size={10} />
        {stored?.eventKept ?? 0}/{stored?.totalClicks ?? 0}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-200">
      <CheckCircle2 size={10} />
      ok
    </span>
  );
}

function StoredStages({ diag }: { diag: ClickPipelineDiagnostics }) {
  return (
    <div className="space-y-3">
      <Stage
        n={1}
        title="Capture"
        right={diag.scope ?? "—"}
      >
        <Field
          label="interactions.json path"
          value={diag.interactionsPath ?? "(not set on project)"}
          mono
        />
      </Stage>

      <Stage
        n={2}
        title="Load"
        right={
          diag.attemptedLoad
            ? diag.interactionsLoaded
              ? "loaded"
              : "failed"
            : "skipped"
        }
        tone={
          diag.attemptedLoad
            ? diag.interactionsLoaded
              ? "ok"
              : "error"
            : "warn"
        }
      >
        <Field label="attempted load" value={diag.attemptedLoad ? "yes" : "no"} />
        <Field
          label="loaded ok"
          value={diag.interactionsLoaded ? "yes" : "no"}
        />
        {diag.loadReason && <Field label="reason" value={diag.loadReason} mono />}
        <Field label="total interactions" value={String(diag.totalInteractions)} />
        <Field label="total clicks" value={String(diag.totalClicks)} />
      </Stage>

      <Stage
        n={3}
        title="momentsFromEvents (pre-balancer)"
      >
        <Field
          label="event moments emitted"
          value={String(diag.eventMomentsEmitted)}
        />
        <Field
          label="click moments emitted"
          value={`${diag.clickMomentsEmitted} / ${diag.totalClicks}`}
        />
        <div className="mt-2 grid grid-cols-5 gap-1.5">
          {(["primary-cta", "icon", "nav", "form", "background"] as const).map(
            (t) => (
              <div
                key={t}
                className="rounded border border-white/10 bg-white/[0.02] px-2 py-1 text-center"
              >
                <div className="text-[9px] uppercase tracking-wider text-fog/80">
                  {t}
                </div>
                <div className="text-[13px] font-semibold text-white">
                  {diag.clickMomentsByTier[t]}
                </div>
              </div>
            )
          )}
        </div>
      </Stage>

      <Stage
        n={4}
        title="Balancer"
        right={`${diag.eventKept} kept`}
        tone={
          diag.eventKept === 0 && diag.eventCandidatesIn > 0
            ? "error"
            : diag.eventKept < diag.eventCandidatesIn
            ? "warn"
            : "ok"
        }
      >
        <Field
          label="events entering balancer"
          value={String(diag.eventCandidatesIn)}
        />
        <Field
          label="dropped — same-target overlap"
          value={String(diag.eventDroppedByOverlap)}
        />
        <Field
          label="dropped — too close (<0.8s)"
          value={String(diag.eventDroppedTooClose)}
        />
        <Field
          label="dropped — zoom cooldown"
          value={String(diag.eventDroppedTooManyZooms)}
          tone={diag.eventDroppedTooManyZooms > 0 ? "warn" : undefined}
        />
        <Field
          label="dropped — quartile / target cap"
          value={String(diag.eventDroppedTooDense)}
        />
        <Field
          label="events kept on timeline"
          value={String(diag.eventKept)}
          tone={
            diag.eventKept === 0 && diag.eventCandidatesIn > 0
              ? "error"
              : "ok"
          }
        />
      </Stage>
    </div>
  );
}

function FreshDiagnose({ result }: { result: DiagnoseResult }) {
  return (
    <details className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-[12px]">
      <summary className="cursor-pointer text-[12px] text-white">
        Fresh diagnose result (read live from interactions.json)
      </summary>
      <div className="mt-3 space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="clicks in JSON"
            value={String(result.load.totalClicks)}
            tone={result.load.totalClicks > 0 ? "ok" : "warn"}
          />
          <Stat
            label="momentsFromEvents would emit"
            value={String(result.eventsEmitted.fromClicks)}
            tone={
              result.eventsEmitted.fromClicks >= result.load.totalClicks
                ? "ok"
                : "warn"
            }
          />
          <Stat
            label="event moments on timeline NOW"
            value={String(result.currentTimeline.eventProvenance)}
            tone={
              result.currentTimeline.eventProvenance > 0 ? "ok" : "error"
            }
          />
          <Stat
            label="total moments on timeline"
            value={String(result.currentTimeline.totalMoments)}
          />
        </div>
        <details>
          <summary className="cursor-pointer text-[11px] text-fog hover:text-white">
            Per-click classification ({result.classify.perClick.length} clicks)
          </summary>
          <div className="mt-2 max-h-64 overflow-y-auto rounded border border-white/10">
            <table className="w-full text-left text-[11px]">
              <thead className="sticky top-0 bg-ink/95 text-fog">
                <tr>
                  <th className="px-2 py-1.5">t</th>
                  <th className="px-2 py-1.5">tier</th>
                  <th className="px-2 py-1.5">rect?</th>
                  <th className="px-2 py-1.5">conf</th>
                  <th className="px-2 py-1.5">signals</th>
                </tr>
              </thead>
              <tbody className="text-white/85">
                {result.classify.perClick.map((c) => (
                  <tr key={c.id} className="border-t border-white/5">
                    <td className="px-2 py-1.5 font-mono">{c.t.toFixed(2)}</td>
                    <td className="px-2 py-1.5">{c.tier}</td>
                    <td className="px-2 py-1.5">{c.hasTargetRect ? "yes" : "no"}</td>
                    <td className="px-2 py-1.5">{c.confidence.toFixed(2)}</td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-fog">
                      {c.signals.join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <details>
          <summary className="cursor-pointer text-[11px] text-fog hover:text-white">
            Raw JSON
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded border border-white/10 bg-black/50 p-2 text-[10px] text-white/80">
            {JSON.stringify(result, null, 2)}
          </pre>
        </details>
      </div>
    </details>
  );
}

function Stage({
  n,
  title,
  right,
  tone,
  children,
}: {
  n: number;
  title: string;
  right?: string;
  tone?: "ok" | "warn" | "error";
  children: React.ReactNode;
}) {
  const toneColor =
    tone === "error"
      ? "text-rose-300"
      : tone === "warn"
      ? "text-amber-300"
      : tone === "ok"
      ? "text-emerald-300"
      : "text-fog";
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-5 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-[10px] font-semibold text-fog">
            {n}
          </span>
          <h4 className="text-[13px] font-semibold text-white">{title}</h4>
        </div>
        {right && (
          <span className={`text-[11px] uppercase tracking-wider ${toneColor}`}>
            {right}
          </span>
        )}
      </div>
      <div className="mt-2 space-y-1.5">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "ok" | "warn" | "error";
}) {
  const toneColor =
    tone === "error"
      ? "text-rose-300"
      : tone === "warn"
      ? "text-amber-300"
      : tone === "ok"
      ? "text-emerald-300"
      : "text-white/85";
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] text-fog">{label}</span>
      <span
        className={`text-[12px] ${toneColor} ${
          mono ? "font-mono text-[11px]" : ""
        } break-all text-right`}
      >
        {value}
      </span>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "error";
}) {
  const toneBg =
    tone === "error"
      ? "border-rose-400/30 bg-rose-500/10"
      : tone === "warn"
      ? "border-amber-400/30 bg-amber-500/10"
      : tone === "ok"
      ? "border-emerald-400/30 bg-emerald-500/10"
      : "border-white/10 bg-white/[0.03]";
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneBg}`}>
      <div className="text-[10px] uppercase tracking-wider text-fog">
        {label}
      </div>
      <div className="text-[18px] font-semibold text-white">{value}</div>
    </div>
  );
}
