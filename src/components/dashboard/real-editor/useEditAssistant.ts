"use client";

/**
 * The chat's bridge to the editing command layer (lib/edit-commands).
 *
 * Builds the assistant input from the LIVE editor (selection, playhead, layers,
 * the request log for "it"/"that title"), runs the local parser, calls the
 * model route when the parser can't place a request, and applies commands
 * through `applyEditRequest` — one undo step, idempotent per request id.
 *
 * The model never writes: the route returns commands (or asks the client to
 * prepare footage first), and they are validated again here against whatever
 * the timeline is at the moment of applying.
 */

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { apiFetch } from "@/lib/platform/api";
import { useEditorReal } from "./context";
import { useClockRef } from "./playback-clock";
import { parseEditRequest, type FootageNeed, type ParseOutcome } from "@/lib/edit-commands/parse";
import { recentElementIds } from "@/lib/edit-commands/log";
import type { AssistantInput } from "@/lib/edit-commands/context";
import type { EditCommand, EditRequest, EditRequestOutcome } from "@/lib/edit-commands/types";
import type { PreparedData } from "./useFootagePrep";

/** Library records the model's turn created or changed (shown in the chat). */
export interface LibraryChange {
  id: string;
  name: string;
  version: number;
  origin: "created" | "saved";
}

export type ModelTurn =
  | { kind: "commands"; commands: EditCommand[]; reply: string | null; libraryChanges?: LibraryChange[] }
  | { kind: "prepare"; needs: FootageNeed[] }
  | { kind: "question"; question: string; options: string[] }
  | { kind: "reply"; reply: string; libraryChanges?: LibraryChange[] }
  | { kind: "unavailable"; reason: string; retryable: boolean };

export function useEditAssistant() {
  const {
    project,
    layers,
    duration,
    selectedClipId,
    selectedMomentId,
    applyEditRequest,
    cloudAvailable,
  } = useEditorReal();
  const clockRef = useClockRef();
  const { getIdToken } = useAuth();

  const inputFor = React.useCallback(
    (prepared: FootageNeed[] = [], data: PreparedData = {}): AssistantInput => {
      // Freshly prepared data wins over the document, whose echo may lag.
      const analysis = data.transcript
        ? { ...(project.analysis ?? {}), transcript: data.transcript }
        : project.analysis;
      return {
        project: { ...project, analysis: analysis as typeof project.analysis },
        moments: project.analysis?.detectedMoments ?? [],
        layers,
        sourceDuration: duration || project.duration || 0,
        playhead: clockRef.current ?? 0,
        selection: { clipId: selectedClipId, elementId: selectedMomentId },
        recentElementIds: recentElementIds(project.assistantLog),
        prepared,
        clicks: data.clicks ?? project.clickMarks,
      };
    },
    [project, layers, duration, clockRef, selectedClipId, selectedMomentId]
  );

  const parseLocal = React.useCallback(
    (message: string, prepared: FootageNeed[] = [], data: PreparedData = {}): ParseOutcome =>
      parseEditRequest(message, inputFor(prepared, data)),
    [inputFor]
  );

  const askModel = React.useCallback(
    async (message: string, requestId: string, prepared: FootageNeed[] = []): Promise<ModelTurn> => {
      if (!cloudAvailable) {
        return { kind: "unavailable", reason: "AI understanding needs a signed-in cloud project.", retryable: false };
      }
      const input = inputFor(prepared);
      try {
        const token = await getIdToken();
        if (!token) return { kind: "unavailable", reason: "Sign in to use AI editing.", retryable: false };
        const res = await apiFetch(`/api/projects/${project.id}/assistant`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            message,
            requestId,
            selection: input.selection,
            playhead: input.playhead,
            recentElementIds: input.recentElementIds,
            prepared,
          }),
        });
        if (!res.ok) return { kind: "unavailable", reason: `The AI request failed (${res.status}).`, retryable: res.status >= 500 };
        const body = (await res.json()) as ModelTurn & { reason?: string };
        if (body.kind === "unavailable") return { kind: "unavailable", reason: body.reason ?? "The AI model is unavailable.", retryable: true };
        return body;
      } catch {
        return { kind: "unavailable", reason: "Couldn't reach the AI — check your connection.", retryable: true };
      }
    },
    [cloudAvailable, inputFor, getIdToken, project.id]
  );

  const apply = React.useCallback(
    (req: EditRequest): Promise<EditRequestOutcome> => applyEditRequest(req),
    [applyEditRequest]
  );

  return { parseLocal, askModel, apply };
}
