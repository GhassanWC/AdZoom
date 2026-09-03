"use client";

/**
 * FRAMEVO AI — the one user-facing AI surface (approved rules 3–4).
 *
 * One persistent panel, three states:
 *   SETUP        → FramevoAISetup (outcome-first: Video · Style · Output ·
 *                  instruction · Edit video)
 *   WORKING      → FramevoAIWorking (inline progress; the pill covers a
 *                  closed panel)
 *   CONVERSATION → the existing chat engine (DirectorChatPanel — internal
 *                  name; the Director stays architecture vocabulary), led by
 *                  the completion narration + a "Edited as <style> — Change
 *                  setup" summary strip.
 *
 * The customer meets ONE intelligence: Framevo AI. Setup, progress and
 * conversation are the same surface, so "should I tell the Director here or
 * the chat there?" stops being a question that can exist.
 */
import * as React from "react";
import { Check, Pencil, Sparkles } from "lucide-react";
import { useEditorReal } from "./context";
import { DirectorChatPanel } from "./DirectorChatPanel";
import { FramevoAISetup } from "./FramevoAISetup";
import { FramevoAIWorking } from "./FramevoAIWorking";
import { deriveStage, selectedTemplateForProject } from "@/lib/framevo-ai/state";
import {
  buildCompletionNarration,
  omissionSentence,
} from "@/lib/framevo-ai/narration";
import type { ChatMode } from "@/lib/director/chat";

export function FramevoAIPanel({
  mode,
  onModeChange,
  canAnalyze = true,
  analyzeBlockedReason,
}: {
  mode: ChatMode;
  onModeChange: (m: ChatMode) => void;
  canAnalyze?: boolean;
  analyzeBlockedReason?: string;
}) {
  const { project, analyzing } = useEditorReal();
  const hasMoments = (project.analysis?.detectedMoments?.length ?? 0) > 0;
  const [setupRequested, setSetupRequested] = React.useState(false);

  const stage = deriveStage({
    hasMoments,
    analyzing,
    projectStatus: project.status,
    setupRequested,
  });

  // Leaving the working state (run finished) always lands on the result, not a
  // stale setup request. Adjusted during render (React's sanctioned pattern for
  // state derived from props/state) rather than in an effect.
  const [wasWorking, setWasWorking] = React.useState(stage === "working");
  if ((stage === "working") !== wasWorking) {
    setWasWorking(stage === "working");
    if (stage === "working" && setupRequested) setSetupRequested(false);
  }

  if (stage === "working") return <FramevoAIWorking />;

  if (stage === "setup") {
    return (
      <FramevoAISetup
        mode={mode}
        onModeChange={onModeChange}
        canAnalyze={canAnalyze}
        analyzeBlockedReason={analyzeBlockedReason}
        hasExistingEdits={hasMoments}
        onClose={hasMoments ? () => setSetupRequested(false) : undefined}
      />
    );
  }

  return (
    <DirectorChatPanel
      mode={mode}
      onModeChange={onModeChange}
      onOpenOptions={() => setSetupRequested(true)}
      canAnalyze={canAnalyze}
      analyzeBlockedReason={analyzeBlockedReason}
      lead={<ConversationLead onChangeSetup={() => setSetupRequested(true)} />}
    />
  );
}

/**
 * The top of the conversation: what Framevo AI did (REAL data — durations from
 * the timeline map, counts from the timeline, omissions from the run's
 * persisted editorial-policy digest) + the one-line setup summary.
 */
function ConversationLead({ onChangeSetup }: { onChangeSetup: () => void }) {
  const { project } = useEditorReal();
  const narration = React.useMemo(() => buildCompletionNarration(project), [project]);
  const template = selectedTemplateForProject(project);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5">
        <span className="truncate text-[11px] text-fog">
          Edited as <span className="text-white/85">{template.name}</span>
        </span>
        <button
          type="button"
          onClick={onChangeSetup}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-fog transition-colors hover:text-white"
        >
          <Pencil size={10} />
          Change setup
        </button>
      </div>

      {narration && (
        <div className="rounded-2xl rounded-bl-md border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
          <p className="flex items-center gap-2 text-[12.5px] font-semibold text-white">
            <Sparkles size={12} className="shrink-0 text-violet-300" />
            Your edit is ready.
            {narration.durationLine && (
              <span className="font-mono text-[11.5px] font-normal tabular-nums text-violet-200">
                {narration.durationLine}
              </span>
            )}
          </p>
          {narration.lines.length > 0 && (
            <ul className="mt-2 space-y-1">
              {narration.lines.map((line, i) => (
                <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-white/90">
                  <Check size={12} className="mt-1 shrink-0 text-emerald-300" />
                  <span className="min-w-0">{line}</span>
                </li>
              ))}
            </ul>
          )}
          {(() => {
            const s = omissionSentence(narration);
            return s ? (
              <p className="mt-2 border-t border-white/[0.06] pt-2 text-[11.5px] leading-relaxed text-fog">
                {s}
              </p>
            ) : null;
          })()}
        </div>
      )}
    </div>
  );
}

