"use client";

/**
 * Local notification store — in-memory React context + localStorage
 * persistence per uid.
 *
 * Why local: the events we care about (export complete / failed,
 * analysis complete / failed, upload finished) all happen client-side
 * today. Toast emits surface them transiently; this store keeps a
 * permanent record the navbar bell can show even if the user missed
 * the toast.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Firestore-ready boundary
 * ─────────────────────────────────────────────────────────────────────
 *
 * The persistence path is intentionally a single `load()` / `save()`
 * pair below. To swap to Firestore-backed notifications:
 *
 *   1. Replace `load(uid)` with `onSnapshot(query(collection(db,
 *      "users", uid, "notifications"), orderBy("createdAt", "desc"),
 *      limit(50)))`. The provider already re-renders on every load
 *      result, so the live subscription drops in cleanly.
 *
 *   2. Replace `save(uid, notifications)` with a per-write
 *      `setDoc(doc(db, "users", uid, "notifications", n.id), n)` AND
 *      delete writes for `markRead` / `markAllRead` / `clearAll`.
 *      Don't batch the whole array — that's the localStorage shape;
 *      Firestore prefers per-doc writes.
 *
 *   3. Add firestore.rules for `users/{uid}/notifications/{id}`
 *      restricting reads + writes to the owning uid.
 *
 *   4. Drop the per-uid `localStorage.{uid}` keys — the Firestore
 *      subscription becomes the source of truth.
 *
 * Consumers (`useNotifications`, `NavbarNotifications`) need ZERO
 * changes. The whole swap is contained in this file.
 */

import * as React from "react";
import { useAuth } from "@/lib/firebase/AuthProvider";
import { useWorkspaceSettings } from "@/lib/firebase/workspace-settings";
import type { NotificationPreferences } from "@/lib/firebase/schema";

export type NotificationKind =
  | "export-completed"
  | "export-failed"
  | "analysis-completed"
  | "analysis-failed"
  | "upload-completed"
  | "system-warning";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  href?: string;
  createdAt: number;
  read: boolean;
}

export interface PushInput {
  /**
   * Deterministic id — set to something like `export-completed:{exportId}`
   * so re-renders / retries don't add duplicates. Omitted → random.
   */
  id?: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  href?: string;
}

interface NotificationStore {
  notifications: AppNotification[];
  unreadCount: number;
  push: (input: PushInput) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
}

const Ctx = React.createContext<NotificationStore | null>(null);

const MAX_PERSISTED = 50;

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  // User notification preferences live on the same settings doc the
  // Settings page edits — consult them in `push` so disabled channels
  // are dropped at the producer side instead of cluttering the bell.
  const { settings } = useWorkspaceSettings();
  const prefs = settings.notifications;
  // `prefs` is recomputed every settings-doc render; mirror to a ref
  // so the `push` callback identity stays stable across pref edits.
  const prefsRef = React.useRef(prefs);
  React.useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  // Initial state hydrates on mount once the uid is known. Until then,
  // an empty list — the bell stays quiet for anonymous / loading users.
  const [notifications, setNotifications] = React.useState<AppNotification[]>([]);

  // Per-uid storage key. Sign-out doesn't clear the bucket but a fresh
  // sign-in reads the new uid's bucket, so cross-account leak is avoided.
  React.useEffect(() => {
    if (!uid) {
      setNotifications([]);
      return;
    }
    setNotifications(load(uid));
  }, [uid]);

  // Mirror to storage on every change.
  React.useEffect(() => {
    if (!uid) return;
    save(uid, notifications);
  }, [uid, notifications]);

  const push = React.useCallback<NotificationStore["push"]>((input) => {
    if (!uid) return;
    // Respect the user's per-channel preferences. Producers fire
    // unconditionally; the store filters here so the policy lives in
    // ONE place. Unknown kinds (future producers) default to allowed.
    if (!isKindAllowed(input.kind, prefsRef.current)) return;
    const id =
      input.id ??
      `${input.kind}:${Date.now().toString(36)}:${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    setNotifications((prev) => {
      // Dedupe on id — most callers pass a deterministic id so retries
      // (e.g. an export listener firing twice) don't double-notify.
      if (prev.some((n) => n.id === id)) return prev;
      const next: AppNotification = {
        id,
        kind: input.kind,
        title: input.title,
        body: input.body,
        href: input.href,
        createdAt: Date.now(),
        read: false,
      };
      return trimToCap([next, ...prev]);
    });
  }, [uid]);

  const markRead = React.useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
  }, []);

  const markAllRead = React.useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearAll = React.useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = React.useMemo(
    () => notifications.reduce((sum, n) => sum + (n.read ? 0 : 1), 0),
    [notifications]
  );

  const value: NotificationStore = React.useMemo(
    () => ({
      notifications,
      unreadCount,
      push,
      markRead,
      markAllRead,
      clearAll,
    }),
    [notifications, unreadCount, push, markRead, markAllRead, clearAll]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Consume the notification store from a component. Returns a no-op
 * store when there's no provider (so non-dashboard surfaces that
 * accidentally import this don't crash). The bell is the canonical
 * consumer.
 */
export function useNotifications(): NotificationStore {
  const ctx = React.useContext(Ctx);
  if (ctx) return ctx;
  return FALLBACK_STORE;
}

const FALLBACK_STORE: NotificationStore = {
  notifications: [],
  unreadCount: 0,
  push: () => {},
  markRead: () => {},
  markAllRead: () => {},
  clearAll: () => {},
};

// ── Preference mapping ─────────────────────────────────────────────

/**
 * Map a notification `kind` to a user preference field. The store
 * skips `push` when the corresponding preference is explicitly off.
 * Kinds without a preference field are always allowed — that's how
 * upload completion + system warnings stay non-suppressible
 * (operational signals, not marketing).
 */
function isKindAllowed(
  kind: NotificationKind,
  prefs: Required<NotificationPreferences>
): boolean {
  switch (kind) {
    case "export-completed":
    case "export-failed":
    case "analysis-completed":
    case "analysis-failed":
      return prefs.renderComplete !== false;
    case "upload-completed":
    case "system-warning":
      // Operational — always show. The user opted into them by
      // recording / uploading / etc; they're not promotional.
      return true;
    default:
      return true;
  }
}

// ── Persistence (the entire Firestore-swap surface) ─────────────────

function storageKey(uid: string): string {
  return `adzoom.notifications.${uid}`;
}

function load(uid: string): AppNotification[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAppNotification).slice(0, MAX_PERSISTED);
  } catch {
    return [];
  }
}

function save(uid: string, notifications: AppNotification[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(uid),
      JSON.stringify(trimToCap(notifications))
    );
  } catch {
    // Storage quota / private mode — silent. Notifications are best-effort.
  }
}

/**
 * Cap the persisted list at `MAX_PERSISTED`. Drops oldest READ entries
 * first so unread always survives; unread are dropped last by age only
 * when the cap is hit with all-unread.
 */
function trimToCap(list: AppNotification[]): AppNotification[] {
  if (list.length <= MAX_PERSISTED) return list;
  const sortedByAge = [...list].sort((a, b) => b.createdAt - a.createdAt);
  const keep: AppNotification[] = [];
  // Pass 1: keep all unread up to cap.
  for (const n of sortedByAge) {
    if (!n.read && keep.length < MAX_PERSISTED) keep.push(n);
  }
  // Pass 2: top up with newest read.
  for (const n of sortedByAge) {
    if (n.read && keep.length < MAX_PERSISTED) keep.push(n);
  }
  return keep.sort((a, b) => b.createdAt - a.createdAt);
}

function isAppNotification(v: unknown): v is AppNotification {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.kind === "string" &&
    typeof o.title === "string" &&
    typeof o.createdAt === "number" &&
    typeof o.read === "boolean"
  );
}
