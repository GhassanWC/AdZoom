"use client";

/**
 * Framevo AI — the chat that edits the video.
 *
 * The user directs in their own words; every change lands on the SAME timeline
 * they can adjust by hand, as one undoable step per request.
 *
 * How a message is handled:
 *   1. Local commands (instant, free): "trim the first two seconds", "add
 *      captions", "add zooms on clicks", "make a calm walkthrough with
 *      captions"… When a request depends on footage understanding we don't
 *      have yet — a transcript, the clicks, the pauses — that step RUNS
 *      (useFootagePrep) and the request continues. It is never handed back to
 *      the user as homework.
 *   2. A plan from an earlier full AI edit can still be revised ("fewer zooms").
 *   3. Anything else goes to the model with the same editing tools; it can ask
 *      for footage preparation too, then edits.
 *
 * What it says:
 *   • One welcome line and at most two suggestions that fit this footage.
 *   • A green check ONLY when the timeline actually changed ("Added 3 zooms
 *     on clicks"), with Show and Undo. Questions and refusals are plain text.
 *   • If part of a request is blocked: what worked, and what stopped the rest.
 *
 * The conversation lives in the editor context, so closing and reopening the
 * chat keeps it; applied edits also persist on the project and survive reloads.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ArrowUp, Check, Crosshair, ListChecks, Loader2, Undo2, Wrench, X, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { serverTimestamp } from "@/lib/platform";
import { useEditorReal } from "./context";
import {
  approveProposal,
  describePlan,
  runChatTurn,
  transcriptFromState,
  type ChatMode,
} from "@/lib/director/chat";
import type { DirectorState } from "@/lib/director/types";
import { trackAssistantAction, trackAssistantRequest, trackDirectorPushback } from "@/lib/framevo-ai/telemetry";
import { useEditAssistant } from "./useEditAssistant";
import { useFootagePrep, type PreparedData } from "./useFootagePrep";
import { useEditorTools, type EditorToolId } from "./useEditorTools";
import { newRequestId } from "@/lib/edit-commands/log";
import { blockedLines, chatId, welcomeSuggestions, WELCOME, type ChatMessage } from "@/lib/edit-commands/chat";
import type { FootageNeed, UiAction } from "@/lib/edit-commands/parse";
import type { EditCommand } from "@/lib/edit-commands/types";
import { outputCanvasForAspect, resolveOutputCanvas } from "@/lib/timeline/canvas-layout";
import type { AssistantLogEntry } from "@/lib/firebase/schema";

/** Request latency for telemetry. Module-level: only ever called from event handlers. */
function clockMs(): number {
  return performance.now();
}
function msSince(t0: number): number {
  return performance.now() - t0;
}

const UI_TOOL: Record<Exclude<UiAction["kind"], "aspect">, EditorToolId> = {
  crop: "crop",
  canvas: "canvas",
  "captions-panel": "captions",
  presets: "presets",
  clips: "clips",
  insights: "insights",
  "full-edit": "full-edit",
};

export function DirectorChatPanel({
  canAnalyze = true,
  analyzeBlockedReason,
}: {
  /** False when a full AI edit can't start (e.g. a local project not yet uploaded). */
  canAnalyze?: boolean;
  analyzeBlockedReason?: string;
}) {
  const {
    project,
    writeProject,
    analyzing,
    undo: undoTimeline,
    latestEditRequestId,
    seek,
    playing,
    togglePlay,
    setSelectedMomentId,
    cloudAvailable,
    assistantChat: messages,
    setAssistantChat: setMessages,
    updateEffects,
    clearOutputCanvas,
  } = useEditorReal();
  const assistant = useEditAssistant();
  const { prepare } = useFootagePrep();
  const tools = useEditorTools();

  const director = project.director as DirectorState | undefined;
  const moments = React.useMemo(() => project.analysis?.detectedMoments ?? [], [project.analysis?.detectedMoments]);
  const history = React.useMemo(() => transcriptFromState(director), [director]);
  const proposal = director?.proposal;

  // Applied requests from earlier sessions (persisted on the project). This
  // session's requests are already in `messages`, with their notes.
  const shownRequestIds = React.useMemo(
    () => new Set(messages.filter((m) => m.edit).map((m) => m.edit!.requestId)),
    [messages]
  );
  const pastEdits = React.useMemo(
    () => (project.assistantLog ?? []).filter((e) => !shownRequestIds.has(e.requestId)),
    [project.assistantLog, shownRequestIds]
  );

  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, history.length, busy]);

  const push = (m: Omit<ChatMessage, "id">) => setMessages((prev) => [...prev, { ...m, id: chatId(m.role) }]);
  const progressIdRef = React.useRef<string | null>(null);
  const setProgress = (text: string) => {
    setMessages((prev) => {
      const id = progressIdRef.current;
      if (id && prev.some((m) => m.id === id)) return prev.map((m) => (m.id === id ? { ...m, text } : m));
      const nid = chatId("progress");
      progressIdRef.current = nid;
      return [...prev, { id: nid, role: "assistant", kind: "progress", text }];
    });
  };
  const clearProgress = () => {
    const id = progressIdRef.current;
    progressIdRef.current = null;
    if (id) setMessages((prev) => prev.filter((m) => m.id !== id));
  };

  const showEdit = (entry: AssistantLogEntry) => {
    if (entry.jumpTo != null) seek(entry.jumpTo);
    const target = entry.changedIds.find((id) => moments.some((m) => m.id === id && m.effectType !== "cut"));
    if (target) setSelectedMomentId(target);
    trackAssistantAction("jump", project.id);
  };
  const undoEdit = async () => {
    await undoTimeline();
    trackAssistantAction("undo", project.id);
    push({ role: "assistant", kind: "text", text: "Undone." });
  };

  /** A former right-toolbar action, by name. Opening a tool is not an edit: plain reply. */
  const runUi = async (action: UiAction): Promise<string> => {
    if (action.kind === "aspect") {
      if (action.aspect === "source") {
        await clearOutputCanvas();
        return "Back to the original frame size.";
      }
      const w = project.width || 1920;
      const h = project.height || 1080;
      await updateEffects("outputCanvas", outputCanvasForAspect(resolveOutputCanvas(project.effectsSettings), action.aspect, w, h));
      return `Changed the frame to ${action.aspect}.`;
    }
    const tool = tools.find((t) => t.id === UI_TOOL[action.kind]);
    tool?.run();
    return tool ? `Opened ${tool.label}.` : "Opened it.";
  };

  const send = async (raw: string, retryRequestId?: string) => {
    const command = raw.trim();
    if (!command || busy) return;
    setDraft("");
    if (!retryRequestId) push({ role: "user", kind: "text", text: command });
    setBusy(true);
    // ONE id per user request, reused by Retry — a retry can never apply twice.
    const requestId = retryRequestId ?? newRequestId();
    // The revision this request is composed against: a manual edit made while
    // the model thinks is detected at apply time (conflicts are reported).
    const baseRev = project.timelineRev ?? 0;
    const t0 = clockMs();
    let prepared: FootageNeed[] = [];
    let data: PreparedData = {};
    const prepFailures: { need: FootageNeed; note: string }[] = [];
    const prepNotes: string[] = [];

    const runPrep = async (needs: FootageNeed[]) => {
      const todo = needs.filter((n) => !prepared.includes(n));
      if (!todo.length) return;
      const { results, data: d } = await prepare(todo, setProgress);
      prepared = [...prepared, ...todo];
      data = { ...data, ...d };
      for (const r of results) {
        if (!r.ok) prepFailures.push({ need: r.need, note: r.note });
        else if (r.note) prepNotes.push(`${r.note}.`);
      }
    };

    const applyAndReport = async (source: "local" | "model", commands: EditCommand[], notes: string[], approvals: string[] = []) => {
      const ops = commands.map((c) => c.op);
      const memory = approvals.map((text) => ({ kind: "approved" as const, text, at: Date.now() }));
      const out = await assistant.apply({ requestId, message: command, source, commands, partial: true, data, baseRev, ...(memory.length ? { memory } : {}) });
      clearProgress();
      if (out.status === "applied") {
        push({
          role: "assistant",
          kind: "edit",
          edit: out.entry,
          blocked: blockedLines(out.blocked, prepFailures),
          notes: [...prepNotes, ...notes],
        });
        // A visual change is SHOWN, not just described: replay the section from
        // just before it, so the follow-up question is about what they just saw.
        const visual = out.changes.find((c) => c.kind !== "removed" && (c.effectType === "fx" || c.effectType === "graphic" || c.effectType === "zoom" || c.effectType === "clip" || c.effectType === "audio-track"));
        if (visual) {
          seek(Math.max(0, visual.at - 0.8));
          if (!playing) togglePlay();
        } else if (out.entry.jumpTo != null) seek(out.entry.jumpTo);
        trackAssistantRequest({ source, outcome: "applied", ops, changes: out.changes.length, errorCodes: out.blocked.map((e) => e.code), latencyMs: msSince(t0) }, project.id);
      } else if (out.status === "duplicate") {
        push({ role: "assistant", kind: "text", text: "That's already done — nothing changed." });
        trackAssistantRequest({ source, outcome: "duplicate", ops }, project.id);
      } else {
        push({ role: "assistant", kind: "blocked", text: blockedLines(out.errors, prepFailures).join(" ") });
        trackAssistantRequest({ source, outcome: "rejected", ops, errorCodes: out.errors.map((e) => e.code), latencyMs: msSince(t0) }, project.id);
      }
    };

    try {
      // 1. Local commands, preparing footage they depend on.
      let local = assistant.parseLocal(command, prepared, data);
      if (local.kind === "needs") {
        await runPrep(local.needs);
        local = assistant.parseLocal(command, prepared, data);
      }
      if (local.kind === "question") {
        clearProgress();
        push({ role: "assistant", kind: "text", text: local.question, options: local.options });
        trackAssistantRequest({ source: "local", outcome: "question" }, project.id);
        return;
      }
      if (local.kind === "ui") {
        const text = await runUi(local.action);
        push({ role: "assistant", kind: local.action.kind === "aspect" ? "edit" : "text", text });
        trackAssistantRequest({ source: "local", outcome: local.action.kind === "aspect" ? "applied" : "reply", ops: [`ui:${local.action.kind}`] }, project.id);
        return;
      }
      if (local.kind === "commands") {
        await applyAndReport("local", local.commands, local.notes, local.approvals);
        return;
      }
      if (local.kind === "needs") {
        clearProgress();
        push({ role: "assistant", kind: "blocked", text: blockedLines([], prepFailures).join(" ") || "I couldn't prepare the footage for that." });
        trackAssistantRequest({ source: "local", outcome: "failed" }, project.id);
        return;
      }

      // 2. Revise the plan of an earlier full AI edit ("fewer zooms").
      if (director?.plan) {
        const r = runChatTurn({ project, moments, command, mode: "instant" });
        if (r.kind === "applied") {
          trackDirectorPushback(command, project.editingTemplateId);
          await writeProject({
            director: r.state,
            "analysis.detectedMoments": r.moments,
            ...(r.outputCanvas ? { "effectsSettings.outputCanvas": r.outputCanvas } : {}),
            updatedAt: serverTimestamp(),
          });
          return;
        }
      }

      // 3. The model, with the same tools — it may ask us to prepare footage.
      if (!cloudAvailable) {
        push({
          role: "assistant",
          kind: "text",
          text: "I can't work that one out offline. Try a direct request like “add a title at 0:05” or “trim the first two seconds”, or use Tools.",
        });
        trackAssistantRequest({ source: "none", outcome: "failed" }, project.id);
        return;
      }
      let turn = await assistant.askModel(command, requestId, prepared);
      for (let i = 0; i < 2 && turn.kind === "prepare"; i++) {
        await runPrep(turn.needs);
        turn = await assistant.askModel(command, requestId, prepared);
      }
      const saved = (turn.kind === "commands" || turn.kind === "reply") && turn.libraryChanges?.length
        ? [`Effect library: ${turn.libraryChanges.map((c) => `${c.name} v${c.version}`).join(", ")}.`]
        : [];
      if (turn.kind === "commands") {
        await applyAndReport("model", turn.commands, [...(turn.reply ? [turn.reply] : []), ...saved]);
        return;
      }
      clearProgress();
      if (turn.kind === "question") {
        push({ role: "assistant", kind: "text", text: turn.question, options: turn.options });
        trackAssistantRequest({ source: "model", outcome: "question", latencyMs: msSince(t0) }, project.id);
      } else if (turn.kind === "reply") {
        const blocked = blockedLines([], prepFailures);
        push({ role: "assistant", kind: blocked.length ? "blocked" : "text", text: [turn.reply, ...saved, ...blocked].join(" ") });
        trackAssistantRequest({ source: "model", outcome: "reply", latencyMs: msSince(t0) }, project.id);
      } else if (turn.kind === "prepare") {
        push({ role: "assistant", kind: "blocked", text: blockedLines([], prepFailures).join(" ") || "I couldn't prepare the footage for that." });
        trackAssistantRequest({ source: "model", outcome: "failed", latencyMs: msSince(t0) }, project.id);
      } else {
        push({ role: "assistant", kind: "blocked", text: turn.reason });
        trackAssistantRequest({ source: "model", outcome: "failed", latencyMs: msSince(t0) }, project.id);
        if (turn.retryable) {
          push({ role: "assistant", kind: "text", text: "", options: ["Retry"] });
          retryRef.current = { command, requestId };
        }
      }
    } catch (err) {
      clearProgress();
      push({ role: "assistant", kind: "blocked", text: err instanceof Error ? err.message : "That change failed." });
    } finally {
      clearProgress();
      setBusy(false);
    }
  };

  // A Retry reuses the SAME request id, so it can never apply twice.
  const retryRef = React.useRef<{ command: string; requestId: string } | null>(null);
  const pickOption = (option: string) => {
    if (option === "Retry" && retryRef.current) {
      const r = retryRef.current;
      retryRef.current = null;
      void send(r.command, r.requestId);
      return;
    }
    setDraft(option);
  };

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = approveProposal({ project, moments });
      if (result.kind !== "applied") return;
      await writeProject({
        director: result.state,
        "analysis.detectedMoments": result.moments,
        ...(result.outputCanvas ? { "effectsSettings.outputCanvas": result.outputCanvas } : {}),
      });
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!director || busy) return;
    await writeProject({ director: { ...director, proposal: undefined, status: director.revisions.length ? "complete" : "idle" } });
  };

  const empty = history.length === 0 && messages.length === 0 && pastEdits.length === 0 && !proposal;
  const suggestions = React.useMemo(() => welcomeSuggestions(project), [project]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4" data-testid="assistant-transcript">
        {empty && (
          <div className="space-y-3" data-testid="assistant-welcome">
            <p className="rounded-2xl rounded-bl-md border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-[13px] text-white">
              {WELCOME}
            </p>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busy || analyzing}
                    onClick={() => void send(s)}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[12px] text-white/85 transition-colors hover:border-violet-400/40 hover:text-white disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {history.map((entry) => (
          <React.Fragment key={entry.id}>
            {entry.command && <UserBubble text={entry.command} />}
            <ResultBubble lines={entry.lines} />
          </React.Fragment>
        ))}

        {pastEdits.map((e) => (
          <React.Fragment key={`past-${e.requestId}`}>
            <UserBubble text={e.message} />
            <EditBubble
              entry={e}
              onShow={() => showEdit(e)}
              onUndo={latestEditRequestId === e.requestId && !busy ? undoEdit : undefined}
            />
          </React.Fragment>
        ))}

        {messages.map((m) =>
          m.role === "user" ? (
            <UserBubble key={m.id} text={m.text ?? ""} />
          ) : m.kind === "edit" && m.edit ? (
            <EditBubble
              key={m.id}
              entry={m.edit}
              blocked={m.blocked}
              notes={m.notes}
              onShow={() => showEdit(m.edit!)}
              onUndo={latestEditRequestId === m.edit.requestId && !busy ? undoEdit : undefined}
            />
          ) : m.kind === "edit" ? (
            <ResultBubble key={m.id} lines={[m.text ?? ""]} />
          ) : m.kind === "progress" ? (
            <div key={m.id} className="flex items-center gap-2 text-[12px] text-fog" data-testid="assistant-progress">
              <Loader2 size={13} className="animate-spin text-violet-300" />
              {m.text}
            </div>
          ) : (
            <React.Fragment key={m.id}>
              {m.text && <TextBubble text={m.text} warn={m.kind === "blocked"} />}
              {m.options && m.options.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pl-1">
                  {m.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      onClick={() => pickOption(o)}
                      className="max-w-full truncate rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-left text-[11.5px] text-fog transition-colors hover:border-violet-400/40 hover:text-white"
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
            </React.Fragment>
          )
        )}

        {proposal && (
          <ProposalCard
            title={describePlan(proposal.plan)}
            command={proposal.command}
            lines={proposal.summary.lines}
            busy={busy}
            onApprove={approve}
            onDiscard={discard}
          />
        )}

        {busy && !messages.some((m) => m.kind === "progress") && (
          <div className="flex items-center gap-2 text-[12px] text-fog">
            <Loader2 size={13} className="animate-spin text-violet-300" />
            Working on it…
          </div>
        )}
      </div>

      {/* ── Composer: Tools + message box ─────────────────────────────── */}
      <div className="shrink-0 border-t border-white/[0.06] p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
          className="flex items-end gap-2"
        >
          <ToolsMenu tools={tools} disabled={busy} />
          <label htmlFor="director-chat-input" className="sr-only">
            Ask Framevo
          </label>
          <textarea
            id="director-chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={2}
            placeholder="Tell Framevo what to change…"
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
        {!canAnalyze && analyzeBlockedReason && (
          <p className="mt-1.5 text-[11px] text-fog">{analyzeBlockedReason}</p>
        )}
      </div>
    </div>
  );
}

/**
 * One compact Tools menu beside the message box — the former right-toolbar
 * actions, grouped so the chat stays uncluttered. Same `run` as the timeline
 * menus (useEditorTools).
 */
function ToolsMenu({ tools, disabled }: { tools: ReturnType<typeof useEditorTools>; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<{ left: number; bottom: number } | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 268)), bottom: window.innerHeight - r.top + 6 });
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = ["Frame", "Add", "Review", "Framevo AI"] as const;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Tools"
        title="Tools"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-fog transition-colors hover:border-white/25 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:opacity-50"
      >
        <Wrench size={15} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Tools"
            data-editor-dialog-hold
            style={{ position: "fixed", left: pos.left, bottom: pos.bottom, width: 260 }}
            className="z-[200] max-h-[70vh] overflow-y-auto rounded-xl border border-white/10 bg-surface p-1.5 shadow-2xl"
          >
            {groups.map((g) => {
              const items = tools.filter((t) => t.chatGroup === g);
              if (!items.length) return null;
              return (
                <div key={g} className="py-0.5">
                  <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-fog">{g}</p>
                  {items.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpen(false);
                        t.run();
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-white/[0.05] focus-visible:bg-white/[0.05] focus-visible:outline-none"
                    >
                      <t.Icon size={14} className="shrink-0 text-violet-200" />
                      <span className="min-w-0">
                        <span className="block text-[12px] font-medium text-white">{t.label}</span>
                        <span className="block truncate text-[11px] text-fog">{t.hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

/**
 * Instant / Plan — still used by the full-AI-edit setup (Tools → "Full AI edit
 * in a style…"). Not shown in the chat's default view.
 */
export function ModeSwitch({ mode, onChange }: { mode: ChatMode; onChange: (m: ChatMode) => void }) {
  const options: { value: ChatMode; label: string; hint: string; icon: React.ReactNode }[] = [
    { value: "instant", label: "Instant", hint: "Applies right away · undoable", icon: <Zap size={12} /> },
    { value: "plan", label: "Plan", hint: "Shows the change first", icon: <ListChecks size={12} /> },
  ];
  const active = options.find((o) => o.value === mode);
  return (
    <div className="flex items-center gap-2">
      <div role="radiogroup" aria-label="How changes are applied" className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={mode === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-150",
              mode === o.value ? "bg-violet-500/20 text-violet-100" : "text-fog hover:text-white"
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

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-violet-500/20 px-3 py-2 text-[12.5px] leading-relaxed text-violet-50">{text}</p>
    </div>
  );
}

/** A neutral reply. No check mark — nothing on the timeline changed. */
function TextBubble({ text, warn }: { text: string; warn?: boolean }) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-2xl rounded-bl-md border px-3 py-2.5 text-[12.5px] leading-relaxed",
        warn ? "border-amber-400/25 bg-amber-500/[0.07] text-amber-100" : "border-white/[0.07] bg-white/[0.03] text-white/90"
      )}
      data-testid={warn ? "assistant-blocked" : "assistant-text"}
    >
      {warn && <AlertTriangle size={12} className="mt-1 shrink-0 text-amber-300" />}
      <span className="min-w-0">{text}</span>
    </div>
  );
}

/** A change that happened (earlier full-AI-edit revisions, a canvas change). */
function ResultBubble({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <ul className="space-y-1 rounded-2xl rounded-bl-md border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-white/90" data-testid="assistant-result">
      {lines.map((line, i) => (
        <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed">
          <Check size={12} className="mt-1 shrink-0 text-emerald-300" />
          <span className="min-w-0">{line}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * An applied request: what changed (green checks — earned), what was blocked
 * (amber), Show (jump to the change) and Undo while it's the newest history
 * step — the same ⌘Z stack manual edits use.
 */
function EditBubble({
  entry,
  blocked = [],
  notes = [],
  onShow,
  onUndo,
}: {
  entry: AssistantLogEntry;
  blocked?: string[];
  notes?: string[];
  onShow: () => void;
  onUndo?: () => void;
}) {
  return (
    <div className="rounded-2xl rounded-bl-md border border-white/[0.07] bg-white/[0.03] px-3 py-2.5" data-testid="assistant-edit" data-request-id={entry.requestId}>
      <ul className="space-y-1 text-white/90">
        {entry.lines.map((line, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed">
            <Check size={12} className="mt-1 shrink-0 text-emerald-300" />
            <span className="min-w-0">{line}</span>
          </li>
        ))}
        {blocked.map((line, i) => (
          <li key={`b${i}`} className="flex gap-2 text-[12.5px] leading-relaxed text-amber-100" data-testid="assistant-edit-blocked">
            <AlertTriangle size={12} className="mt-1 shrink-0 text-amber-300" />
            <span className="min-w-0">{line}</span>
          </li>
        ))}
      </ul>
      {notes.length > 0 && <p className="mt-1.5 text-[11.5px] leading-relaxed text-fog">{notes.join(" ")}</p>}
      <div className="mt-2 flex items-center gap-1 border-t border-white/[0.06] pt-2">
        {entry.jumpTo != null && (
          <button type="button" onClick={onShow} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fog transition-colors hover:text-white">
            <Crosshair size={11} />
            Show
          </button>
        )}
        <span className="ml-auto" />
        {onUndo && (
          <button type="button" onClick={onUndo} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fog transition-colors hover:text-white">
            <Undo2 size={11} />
            Undo
          </button>
        )}
      </div>
    </div>
  );
}

/** A pending plan from an earlier full AI edit run in Plan mode. */
function ProposalCard({
  title,
  command,
  lines,
  busy,
  onApprove,
  onDiscard,
}: {
  title: string;
  command: string;
  lines: string[];
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
      <p className="mt-1 truncate text-[11px] text-fog" title={title}>{title}</p>
      <ul className="mt-2.5 space-y-1">
        {lines.map((line, i) => (
          <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-white/90">
            <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-violet-300" />
            <span className="min-w-0">{line}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[11px] text-fog">Your timeline hasn&apos;t changed yet.</p>
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
