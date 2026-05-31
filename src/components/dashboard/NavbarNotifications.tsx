"use client";

import * as React from "react";
import Link from "next/link";
import {
  Bell,
  Check,
  CheckCheck,
  AlertTriangle,
  Download as DownloadIcon,
  Sparkles,
  Upload as UploadIcon,
  Info,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  useNotifications,
  type AppNotification,
  type NotificationKind,
} from "@/lib/notifications/store";

/**
 * Navbar notification bell. Opens a dropdown listing recent
 * notifications from the local store. The unread-dot only renders
 * when `unreadCount > 0` — no more hardcoded "always on" dot.
 *
 * Dropdown pattern mirrors the Account Menu in Topbar (useRef +
 * mousedown listener for outside-click). Keeps the navbar consistent
 * with itself.
 */
export function NavbarNotifications() {
  const { notifications, unreadCount, markRead, markAllRead, clearAll } =
    useNotifications();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Cap visible rows so the dropdown stays manageable; the store
  // already caps the underlying list.
  const visible = notifications.slice(0, 30);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : "Notifications"
        }
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.02] text-fog transition-colors duration-200 hover:text-white"
      >
        <Bell size={15} />
        {unreadCount > 0 && (
          <span
            aria-hidden
            className="absolute right-2 top-2 size-1.5 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(139,92,246,0.6)]"
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-40 w-80 max-w-[90vw] overflow-hidden rounded-xl border border-white/10 bg-surface/95 shadow-cinematic backdrop-blur-xl">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-2.5">
            <span className="text-[12px] font-semibold text-white">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-1.5 text-fog">({unreadCount})</span>
              )}
            </span>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] font-medium transition-colors duration-150",
                unreadCount === 0
                  ? "cursor-not-allowed text-fog/50"
                  : "text-fog hover:bg-white/[0.04] hover:text-white"
              )}
            >
              <CheckCheck size={11} />
              Mark all read
            </button>
          </div>

          {/* List or empty state */}
          {visible.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-fog">
              You&apos;re all caught up.
            </div>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {visible.map((n) => (
                <NotificationRow
                  key={n.id}
                  n={n}
                  onActivate={() => {
                    markRead(n.id);
                    setOpen(false);
                  }}
                />
              ))}
            </ul>
          )}

          {/* Footer — only when there's anything to clear */}
          {visible.length > 0 && (
            <div className="flex items-center justify-end border-t border-white/[0.06] px-3 py-1.5">
              <button
                type="button"
                onClick={clearAll}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] font-medium text-fog transition-colors duration-150 hover:bg-white/[0.04] hover:text-white"
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  n,
  onActivate,
}: {
  n: AppNotification;
  onActivate: () => void;
}) {
  const meta = KIND_META[n.kind];
  const inner = (
    <div className="flex items-start gap-3">
      <span className={cn("mt-0.5 shrink-0", meta.tone)}>
        <meta.Icon size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-[13px] font-medium",
              n.read ? "text-white/70" : "text-white"
            )}
          >
            {n.title}
          </span>
          {!n.read && (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-violet-400"
            />
          )}
        </div>
        {n.body && (
          <p
            className={cn(
              "mt-0.5 truncate text-[11.5px]",
              n.read ? "text-fog/70" : "text-fog"
            )}
          >
            {n.body}
          </p>
        )}
        <p className="mt-0.5 font-mono text-[10px] text-fog/60">
          {relTime(n.createdAt)}
        </p>
      </div>
      {n.read && (
        <Check size={11} className="mt-1 shrink-0 text-fog/40" aria-hidden />
      )}
    </div>
  );

  const rowCls =
    "block w-full border-b border-white/[0.04] px-4 py-2.5 text-left transition-colors duration-100 hover:bg-white/[0.04] last:border-b-0";

  if (n.href) {
    return (
      <li>
        <Link href={n.href} onClick={onActivate} className={rowCls}>
          {inner}
        </Link>
      </li>
    );
  }

  return (
    <li>
      <button type="button" onClick={onActivate} className={cn(rowCls)}>
        {inner}
      </button>
    </li>
  );
}

interface KindMeta {
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  tone: string;
}

const KIND_META: Record<NotificationKind, KindMeta> = {
  "export-completed": { Icon: DownloadIcon, tone: "text-emerald-300" },
  "export-failed": { Icon: AlertTriangle, tone: "text-rose-300" },
  "analysis-completed": { Icon: Sparkles, tone: "text-violet-300" },
  "analysis-failed": { Icon: AlertTriangle, tone: "text-rose-300" },
  "upload-completed": { Icon: UploadIcon, tone: "text-cyan-300" },
  "system-warning": { Icon: Info, tone: "text-amber-300" },
};

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
