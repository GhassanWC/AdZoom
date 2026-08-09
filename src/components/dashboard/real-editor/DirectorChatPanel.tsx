"use client";

/**
 * The AI panel — Framevo's AI editing surface, as a conversation.
 *
 * It replaced a dialog with eight groups of toggles. That dialog is still here
 * (the ⚙ button opens it) because the controls in it are real, but it is no
 * longer the way you ask for an edit: you say what you want, and the timeline
 * changes behind the panel while you watch.
 *
 * ── The two modes ────────────────────────────────────────────────────────────
 * Instant is the default and always the mode a new project opens in. A follow-up
 * is pure local maths (see `lib/director/chat.ts`) — it costs nothing, takes a
 * millisecond, and every message can be undone — so asking first would be
 * ceremony around a decision the user can simply reverse.
 *
 * Plan is for when you'd rather read it than reverse it. It shows the REAL
 * result of the change with the timeline left alone, and applies it on approve.
 *
 * ── What this component may assume ───────────────────────────────────────────
 * Almost nothing. The first message on an un-analyzed project has to go through
 * the analyze route (the model builds the first plan there); everything after
 * that is local. `runChatTurn` decides which case it is, and returns
 * `needs-analysis` rather than letting this file guess.
 */

import * as React from "react";
import {
  ArrowUp,
  Loader2,
  Undo2,
  Check,
  X,
  AlertTriangle,
  SlidersHorizontal,
  Zap,
  ListChecks,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { useEditorReal } from "./context";
import {
  CHAT_BRIEF_EXAMPLES,
  CHAT_EXAMPLES,
  approveProposal,
  describePlan,
  runChatTurn,
  transcriptFromState,
  undoLastChange,
  type ChatMode,
} from "@/lib/director/chat";
import type { DirectorState } from "@/lib/director/types";
import { DEFAULT_ANALYSIS_OPTIONS } from "@/lib/analysis/engine-layers";

/** A message this session produced that isn't part of the applied history. */
interface EphemeralMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  tone?: "normal" | "warn";
}

export function DirectorChatPanel({
  mode,
  onModeChange,
  onOpenOptions,
  canAnalyze = true,
  analyzeBlockedReason,
}: {
  /**
   * Instant / Plan. Owned by the editor page, not by this component: a run
   * started from the options dialog has to honour the same choice, or Plan mode
   * would silently not apply to the one change big enough to want it.
   */
  mode: ChatMode;
  onModeChange: (m: ChatMode) => void;
  /** Open the full analysis options dialog — the advanced surface. */
  onOpenOptions: () => void;
  /** False when the first run can't start (e.g. a local project not yet uploaded). */
  canAnalyze?: boolean;
  /** Why, when it can't. Shown verbatim instead of a generic failure. */
  analyzeBlockedReason?: string;
}) {
  const { project, writeProject, analyzing, saveDirectorBrief, startAnalyze } =
    useEditorReal();
  const director = project.director as DirectorState | undefined;
  // Read the timeline off the PROJECT, the same source the pipeline writes back
  // to, so a turn can never be computed against a different array than the one
  // it replaces.
  const moments = React.useMemo(
    () => project.analysis?.detectedMoments ?? [],
    [project.analysis?.detectedMoments]
  );

  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [ephemeral, setEphemeral] = React.useState<EphemeralMessage[]>([]);

  const history = React.useMemo(() => transcriptFromState(director), [director]);
  const proposal = director?.proposal;
  const hasPlan = !!director?.plan;

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  // Pin to the newest message. The transcript grows from the bottom, so a new
  // answer arriving off-screen would look like nothing happened.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, ephemeral.length, proposal?.createdAt, busy]);

  const say = (role: "user" | "assistant", text: string, tone?: "normal" | "warn") =>
    setEphemeral((prev) => [
      ...prev,
      { id: `${role}-${prev.length}-${text.slice(0, 12)}`, role, text, tone },
    ]);

  const send = async (raw: string) => {
    const command = raw.trim();
    if (!command || busy) return;
    setDraft("");
    say("user", command);
    setBusy(true);
    try {
      const result = runChatTurn({ project, moments, command, mode });

      switch (result.kind) {
        case "needs-analysis":
          // The FIRST message is the brief. There is no plan to patch yet, so
          // this one has to go through the model on the server — but the user
          // shouldn't have to learn that, or go and find a dialog to type the
          // same sentence into again. Save what they said as the brief and start
          // the run they clearly meant.
          if (!canAnalyze) {
            say("assistant", analyzeBlockedReason ?? "This video can't be analyzed yet.", "warn");
            break;
          }
          say(
            "assistant",
            mode === "plan"
              ? "On it — I'll watch the video and come back with a plan to approve before anything changes."
              : "On it — I'll watch the video and build your first edit. This one takes a few minutes; every change after it is instant."
          );
          await saveDirectorBrief(command, {});
          await startAnalyze({
            ...DEFAULT_ANALYSIS_OPTIONS,
            selectedVideoType: project.selectedVideoType ?? "auto",
            applyDirectorBrief: true,
            directorPlanOnly: mode === "plan",
          });
          break;

        case "not-understood":
        case "nothing-to-do":
        case "failed":
          say("assistant", result.reply, "warn");
          break;

        case "proposed":
          await writeProject({ director: result.state });
          break;

        case "applied":
          await writeProject({
            director: result.state,
            "analysis.detectedMoments": result.moments,
            ...(result.outputCanvas
              ? { "effectsSettings.outputCanvas": result.outputCanvas }
              : {}),
          });
          break;
      }
    } catch (err) {
      say("assistant", err instanceof Error ? err.message : "That change failed.", "warn");
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = approveProposal({ project, moments });
      if (result.kind !== "applied") {
        say("assistant", result.kind === "failed" ? result.reply : "Nothing to apply.", "warn");
        return;
      }
      await writeProject({
        director: result.state,
        "analysis.detectedMoments": result.moments,
        ...(result.outputCanvas
          ? { "effectsSettings.outputCanvas": result.outputCanvas }
          : {}),
      });
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!director || busy) return;
    setBusy(true);
    try {
      // Keep the plan history; drop only what was pending.
      const next: DirectorState = {
        ...director,
        proposal: undefined,
        status: director.revisions.length ? "complete" : "idle",
      };
      await writeProject({ director: next });
      say("assistant", "Discarded. The timeline is unchanged.");
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = undoLastChange({ project, moments });
      if (!result) {
        say("assistant", "There's nothing to undo.", "warn");
        return;
      }
      await writeProject({
        director: result.state,
        "analysis.detectedMoments": result.moments,
        ...(result.outputCanvas
          ? { "effectsSettings.outputCanvas": result.outputCanvas }
          : {}),
      });
      say("assistant", `Undid “${result.undoneCommand}”.`);
    } finally {
      setBusy(false);
    }
  };

  const empty = history.length === 0 && ephemeral.length === 0 && !proposal;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* No header here — the dock already renders one ("Edit with AI") and two
          stacked titles in a 340px column is the kind of chrome that makes a
          panel feel heavier than the thing it contains. */}

      {/* ── Transcript ──────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4">
        {empty && (
          <EmptyChat
            onPick={(t) => void send(t)}
            disabled={busy || analyzing}
            hasPlan={hasPlan}
          />
        )}

        {history.map((entry) => (
          <React.Fragment key={entry.id}>
            {entry.command ? (
              <UserBubble text={entry.command} />
            ) : (
              <Meta text="First pass from your brief" />
            )}
            <AssistantBubble
              lines={entry.lines}
              warnings={entry.warnings}
              onUndo={entry.undoable && !busy ? undo : undefined}
            />
          </React.Fragment>
        ))}

        {ephemeral.map((m) =>
          m.role === "user" ? (
            <UserBubble key={m.id} text={m.text} />
          ) : (
            <AssistantBubble key={m.id} lines={[m.text]} tone={m.tone} />
          )
        )}

        {proposal && (
          <ProposalCard
            title={describePlan(proposal.plan)}
            command={proposal.command}
            lines={proposal.summary.lines}
            warnings={proposal.review?.warnings ?? 0}
            busy={busy}
            onApprove={approve}
            onDiscard={discard}
          />
        )}

        {busy && (
          <div className="flex items-center gap-2 text-[12px] text-fog">
            <Loader2 size={13} className="animate-spin text-violet-300" />
            Working on it…
          </div>
        )}
      </div>

      {/* ── Composer ────────────────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-white/[0.06] p-3">
        <div className="flex items-center gap-2">
          <ModeSwitch mode={mode} onChange={onModeChange} />
          <button
            type="button"
            onClick={onOpenOptions}
            title="Analysis options"
            aria-label="Analysis options"
            className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-fog transition-colors duration-150 hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
          >
            <SlidersHorizontal size={13} />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
          className="mt-2 flex items-end gap-2"
        >
          <label htmlFor="director-chat-input" className="sr-only">
            Ask for a change
          </label>
          <textarea
            id="director-chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a newline — the convention every
              // chat uses, and the one people will try without being told.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={2}
            placeholder={
              hasPlan ? "Make it 30 seconds…" : "Describe the video you want…"
            }
            disabled={busy}
            className="min-h-[54px] flex-1 resize-none rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white placeholder:text-fog focus:border-violet-400/50 focus:outline-none focus:ring-2 focus:ring-violet-400/30 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label="Send"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-500 text-white transition-colors duration-150 hover:bg-violet-400 disabled:cursor-not-allowed disabled:bg-white/[0.06] disabled:text-fog"
          >
            <ArrowUp size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * Instant / Plan.
 *
 * Stated as a pair with their consequence spelled out, because the difference
 * between them is exactly "does my video change when I press enter" — the one
 * thing a user must never have to discover by pressing it.
 */
function ModeSwitch({ mode, onChange }: { mode: ChatMode; onChange: (m: ChatMode) => void }) {
  const options: { value: ChatMode; label: string; hint: string; icon: React.ReactNode }[] = [
    { value: "instant", label: "Instant", hint: "Applies right away · undoable", icon: <Zap size={12} /> },
    { value: "plan", label: "Plan", hint: "Shows the change first", icon: <ListChecks size={12} /> },
  ];
  const active = options.find((o) => o.value === mode);

  return (
    <div className="flex items-center gap-2">
      <div
        role="radiogroup"
        aria-label="How changes are applied"
        className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={mode === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-150",
              mode === o.value
                ? "bg-violet-500/20 text-violet-100"
                : "text-fog hover:text-white"
            )}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
      <span className="truncate text-[11px] text-fog">{active?.hint}</span>
    </div>
  );
}

/**
 * A line the user didn't say. The first pass comes from the brief rather than
 * from a typed message, and rendering it as if they'd sent it would put words
 * in their mouth.
 */
function Meta({ text }: { text: string }) {
  return (
    <p className="text-center text-[11px] uppercase tracking-[0.16em] text-fog">{text}</p>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-violet-500/20 px-3 py-2 text-[12.5px] leading-relaxed text-violet-50">
        {text}
      </p>
    </div>
  );
}

function AssistantBubble({
  lines,
  warnings = 0,
  tone = "normal",
  onUndo,
}: {
  lines: string[];
  warnings?: number;
  tone?: "normal" | "warn";
  onUndo?: () => void;
}) {
  if (!lines.length) return null;
  return (
    <div
      className={cn(
        "rounded-2xl rounded-bl-md border px-3 py-2.5",
        tone === "warn"
          ? "border-amber-400/25 bg-amber-500/[0.07]"
          : "border-white/[0.07] bg-white/[0.03]"
      )}
    >
      <ul className={cn("space-y-1", tone === "warn" ? "text-amber-100" : "text-white/90")}>
        {lines.map((line, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed">
            {tone === "warn" ? (
              <AlertTriangle size={12} className="mt-1 shrink-0 text-amber-300" />
            ) : (
              <Check size={12} className="mt-1 shrink-0 text-emerald-300" />
            )}
            <span className="min-w-0">{line}</span>
          </li>
        ))}
      </ul>

      {(warnings > 0 || onUndo) && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
          <span className="text-[11px] text-fog">
            {warnings > 0
              ? `${warnings} thing${warnings === 1 ? "" : "s"} worth checking`
              : ""}
          </span>
          {onUndo && (
            <button
              type="button"
              onClick={onUndo}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fog transition-colors hover:text-white"
            >
              <Undo2 size={11} />
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A change waiting for approval.
 *
 * The bullets are the real result, not a forecast — the pipeline already ran and
 * its output was thrown away. The banner says the timeline is untouched because
 * that is the one fact a proposal has to make unmistakable.
 */
function ProposalCard({
  title,
  command,
  lines,
  warnings,
  busy,
  onApprove,
  onDiscard,
}: {
  title: string;
  command: string;
  lines: string[];
  warnings: number;
  busy: boolean;
  onApprove: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="rounded-2xl border border-violet-400/30 bg-violet-500/[0.07] p-3">
      <div className="flex items-center gap-2">
        <ListChecks size={13} className="shrink-0 text-violet-300" />
        <span className="text-[12px] font-medium text-white">Plan ready to apply</span>
      </div>
      {command && <p className="mt-1 text-[11.5px] text-fog">for “{command}”</p>}
      <p className="mt-1 truncate text-[11px] text-fog" title={title}>
        {title}
      </p>

      <ul className="mt-2.5 space-y-1">
        {lines.map((line, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-white/90">
            <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-violet-300" />
            <span className="min-w-0">{line}</span>
          </li>
        ))}
      </ul>

      {warnings > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-[11.5px] text-amber-200">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {warnings} thing{warnings === 1 ? "" : "s"} worth checking after you apply this.
        </p>
      )}

      <p className="mt-2.5 text-[11px] text-fog">
        Your timeline hasn&apos;t changed yet.
      </p>

      <div className="mt-2.5 flex gap-2">
        <Button size="sm" variant="primary" onClick={onApprove} disabled={busy} leftIcon={<Check size={13} />}>
          Apply this
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={busy} leftIcon={<X size={13} />}>
          Discard
        </Button>
      </div>
    </div>
  );
}

/**
 * The opening state.
 *
 * Examples rather than instructions: the fastest way to learn what a text box
 * accepts is to send something that works, so every one of these is a real
 * command the parser understands.
 */
function EmptyChat({
  onPick,
  disabled,
  hasPlan,
}: {
  onPick: (t: string) => void;
  disabled: boolean;
  hasPlan: boolean;
}) {
  return (
    <div className="py-2">
      <p className="text-[12.5px] leading-relaxed text-fog">
        {hasPlan
          ? "Tell me what you want and I'll change the timeline. Every edit is undoable, so it's safe to try one."
          : "Describe the video you want. I'll watch this recording and build the first edit — after that, changes are instant."}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(hasPlan ? CHAT_EXAMPLES : CHAT_BRIEF_EXAMPLES).map((example) => (
          <button
            key={example}
            type="button"
            disabled={disabled}
            onClick={() => onPick(example)}
            className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11.5px] text-fog transition-colors duration-150 hover:border-violet-400/40 hover:text-white disabled:opacity-50"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
