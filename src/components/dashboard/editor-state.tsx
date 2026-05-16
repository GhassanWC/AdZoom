"use client";

import * as React from "react";

export interface EffectsState {
  autoZoom: number;
  cursorSize: number;
  cursorSmoothing: number;
  zoomSpeed: number;
  motionSensitivity: number;
  clickHighlightSize: number;
  clickHighlightStyle: "ring" | "pulse" | "burst";
  verticalExport: boolean;
  clickHighlights: boolean;
  motionTracking: boolean;
}

export const DEFAULT_EFFECTS: EffectsState = {
  autoZoom: 72,
  cursorSize: 50,
  cursorSmoothing: 65,
  zoomSpeed: 55,
  motionSensitivity: 70,
  clickHighlightSize: 60,
  clickHighlightStyle: "ring",
  verticalExport: false,
  clickHighlights: true,
  motionTracking: true,
};

export interface ExportState {
  resolution: "1080p" | "4K";
  fps: 30 | 60;
  format: "TikTok 9:16" | "YouTube 16:9" | "Custom";
}

export const DEFAULT_EXPORT: ExportState = {
  resolution: "4K",
  fps: 60,
  format: "YouTube 16:9",
};

export const PRESET_TUNINGS: Record<string, Partial<EffectsState>> = {
  MrBeast: {
    autoZoom: 92,
    cursorSize: 70,
    cursorSmoothing: 50,
    zoomSpeed: 80,
    clickHighlightStyle: "burst",
    clickHighlightSize: 85,
  },
  Cinematic: {
    autoZoom: 65,
    cursorSize: 45,
    cursorSmoothing: 90,
    zoomSpeed: 30,
    clickHighlightStyle: "ring",
    clickHighlightSize: 50,
  },
  Tutorial: {
    autoZoom: 78,
    cursorSize: 60,
    cursorSmoothing: 70,
    zoomSpeed: 55,
    clickHighlightStyle: "ring",
    clickHighlightSize: 70,
  },
  TikTok: {
    autoZoom: 88,
    cursorSize: 65,
    cursorSmoothing: 60,
    zoomSpeed: 70,
    clickHighlightStyle: "pulse",
    clickHighlightSize: 75,
    verticalExport: true,
  },
  Coding: {
    autoZoom: 70,
    cursorSize: 40,
    cursorSmoothing: 80,
    zoomSpeed: 40,
    clickHighlightStyle: "ring",
    clickHighlightSize: 45,
  },
};

interface EditorContextValue {
  effects: EffectsState;
  updateEffect: <K extends keyof EffectsState>(key: K, value: EffectsState[K]) => void;
  exportSettings: ExportState;
  updateExport: <K extends keyof ExportState>(key: K, value: ExportState[K]) => void;
  preset: string;
  applyPreset: (name: string) => void;
  exporting: boolean;
  startExport: () => void;
  cancelExport: () => void;
}

const EditorContext = React.createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: React.ReactNode }) {
  const [effects, setEffects] = React.useState(DEFAULT_EFFECTS);
  const [exportSettings, setExportSettings] = React.useState(DEFAULT_EXPORT);
  const [preset, setPreset] = React.useState("Tutorial");
  const [exporting, setExporting] = React.useState(false);

  const updateEffect: EditorContextValue["updateEffect"] = (key, value) => {
    setEffects((s) => ({ ...s, [key]: value }));
  };

  const updateExport: EditorContextValue["updateExport"] = (key, value) => {
    setExportSettings((s) => ({ ...s, [key]: value }));
  };

  const applyPreset = (name: string) => {
    setPreset(name);
    const tuning = PRESET_TUNINGS[name];
    if (tuning) setEffects((s) => ({ ...s, ...tuning }));
  };

  const startExport = () => setExporting(true);
  const cancelExport = () => setExporting(false);

  const value: EditorContextValue = {
    effects,
    updateEffect,
    exportSettings,
    updateExport,
    preset,
    applyPreset,
    exporting,
    startExport,
    cancelExport,
  };

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor() {
  const ctx = React.useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used inside EditorProvider");
  return ctx;
}
