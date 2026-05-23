/** mm:ss formatter — shared across the timeline. */
export function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** mm:ss.s formatter for the playhead chip — finer-grained read-out. */
export function fmtPrecise(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00.0";
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

export type DragMode = "move" | "resize-l" | "resize-r";

export interface DragState {
  id: string;
  mode: DragMode;
  pointerStartX: number;
  origStart: number;
  origEnd: number;
  moved: boolean;
  /** Modifier keys held at pointer-down — drive multi-select vs single-select on click. */
  multiKey: boolean;
}

/** Hydrate a localStorage-backed boolean once on mount (SSR-safe). */
export function readPersistedBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* private mode etc. — fall through */
  }
  return fallback;
}

export function writePersistedBool(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}
