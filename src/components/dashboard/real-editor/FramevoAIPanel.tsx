"use client";

/**
 * FRAMEVO AI — the one user-facing AI surface, and the main way to edit.
 *
 * The default view is the CHAT: one welcome line, at most two suggestions that
 * fit this footage, the message box. Editing starts when the user sends a
 * request. No setup wizard, no style cards, no Instant/Plan choice up front.
 *
 * Two other views, never the default:
 *   WORKING — a full AI edit is running (progress, inline).
 *   SETUP   — the full-AI-edit style setup, reached on purpose from the chat's
 *             Tools menu ("Full AI edit in a style…").
 */
import * as React from "react";
import { useEditorReal } from "./context";
import { DirectorChatPanel } from "./DirectorChatPanel";
import { FramevoAISetup } from "./FramevoAISetup";
import { FramevoAIWorking } from "./FramevoAIWorking";
import { deriveStage } from "@/lib/framevo-ai/state";
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
  const { project, analyzing, aiSetupOpen, setAiSetupOpen } = useEditorReal();
  const hasMoments = (project.analysis?.detectedMoments?.length ?? 0) > 0;

  // Only "working" matters from the stage model now: setup is opt-in.
  const working = deriveStage({ hasMoments: true, analyzing, projectStatus: project.status }) === "working";
  if (working) return <FramevoAIWorking />;

  if (aiSetupOpen) {
    return (
      <FramevoAISetup
        mode={mode}
        onModeChange={onModeChange}
        canAnalyze={canAnalyze}
        analyzeBlockedReason={analyzeBlockedReason}
        hasExistingEdits={hasMoments}
        onClose={() => setAiSetupOpen(false)}
      />
    );
  }

  return <DirectorChatPanel canAnalyze={canAnalyze} analyzeBlockedReason={analyzeBlockedReason} />;
}
