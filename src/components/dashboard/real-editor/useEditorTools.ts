"use client";

/**
 * The editor's tool actions — what the old right-hand tool rail did — as ONE
 * list rendered in two places: the timeline's Add / Edit menus and the chat's
 * Tools menu. The chat also reaches each one by name ("crop the frame",
 * "show suggestions") through the same `run`. One definition, so the three
 * entry points can never disagree about what a tool does.
 */

import * as React from "react";
import {
  Captions,
  Crop,
  Frame,
  LayoutTemplate,
  Lightbulb,
  Scissors,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useEditorReal } from "./context";

export type EditorToolId = "crop" | "canvas" | "captions" | "presets" | "looks" | "clips" | "insights" | "full-edit";

export interface EditorTool {
  id: EditorToolId;
  label: string;
  hint: string;
  Icon: LucideIcon;
  /** Which timeline menu lists it. `null` = chat Tools menu only. */
  timelineMenu: "add" | "edit" | null;
  /** Group heading inside the chat Tools menu. */
  chatGroup: "Frame" | "Add" | "Review" | "Framevo AI";
  run: () => void;
}

export function useEditorTools(): EditorTool[] {
  const { setActiveTool, openCropEditor, closeCropEditor, cropEditing, setAiSetupOpen } = useEditorReal();

  return React.useMemo<EditorTool[]>(() => {
    // A dock panel and the crop overlay never show together (same rule the rail had).
    const panel = (id: Parameters<typeof setActiveTool>[0]) => () => {
      if (cropEditing) closeCropEditor();
      setActiveTool(id);
    };
    return [
      {
        id: "crop",
        label: "Crop frame",
        hint: "Trim the source edges — applies everywhere",
        Icon: Crop,
        timelineMenu: "edit",
        chatGroup: "Frame",
        run: () => {
          setActiveTool(null);
          openCropEditor();
        },
      },
      {
        id: "canvas",
        label: "Canvas & aspect ratio",
        hint: "9:16, 1:1, fit, background",
        Icon: Frame,
        timelineMenu: "edit",
        chatGroup: "Frame",
        run: panel("canvas"),
      },
      {
        id: "captions",
        label: "AI captions",
        hint: "Transcribe, language, style",
        Icon: Captions,
        timelineMenu: "add",
        chatGroup: "Add",
        run: panel("captions"),
      },
      {
        id: "presets",
        label: "Presets & looks",
        hint: "Titles, hooks, CTAs, one-click looks",
        Icon: LayoutTemplate,
        timelineMenu: "add",
        chatGroup: "Add",
        run: panel("presets-library"),
      },
      {
        id: "clips",
        label: "Short clips",
        hint: "AI clips cut from this video",
        Icon: Scissors,
        timelineMenu: "add",
        chatGroup: "Add",
        run: panel("clips"),
      },
      {
        id: "insights",
        label: "Suggestions & insights",
        hint: "What Framevo would improve",
        Icon: Lightbulb,
        timelineMenu: "edit",
        chatGroup: "Review",
        run: panel("insights"),
      },
      {
        id: "full-edit",
        label: "Full AI edit in a style…",
        hint: "Let Framevo AI re-edit the whole video",
        Icon: Sparkles,
        timelineMenu: null,
        chatGroup: "Framevo AI",
        run: () => {
          if (cropEditing) closeCropEditor();
          setAiSetupOpen(true);
          setActiveTool("ai-chat");
        },
      },
    ];
  }, [setActiveTool, openCropEditor, closeCropEditor, cropEditing, setAiSetupOpen]);
}
