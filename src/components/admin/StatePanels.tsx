"use client";

import { AlertTriangle, Loader2, Inbox, Clock } from "lucide-react";
import { cn } from "@/lib/cn";

/** Shared loading / empty / error / index-building panels for admin pages. */

function Panel({
  icon,
  title,
  detail,
  tone = "default",
  className,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  tone?: "default" | "error" | "warn";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "glass flex flex-col items-center justify-center gap-3 rounded-2xl px-6 py-14 text-center",
        className
      )}
    >
      <span
        className={cn(
          "inline-flex size-10 items-center justify-center rounded-full border",
          tone === "error"
            ? "border-rose-400/30 bg-rose-500/10 text-rose-300"
            : tone === "warn"
              ? "border-amber-400/30 bg-amber-500/10 text-amber-200"
              : "border-white/10 bg-white/[0.03] text-fog"
        )}
      >
        {icon}
      </span>
      <div className="text-sm font-medium text-white">{title}</div>
      {detail && <p className="max-w-md text-xs text-fog">{detail}</p>}
    </div>
  );
}

export function LoadingPanel({ label = "Loading…" }: { label?: string }) {
  return <Panel icon={<Loader2 size={18} className="animate-spin" />} title={label} />;
}

export function ErrorPanel({ message }: { message: string }) {
  return (
    <Panel
      tone="error"
      icon={<AlertTriangle size={18} />}
      title="Couldn't load this data"
      detail={message}
    />
  );
}

export function EmptyPanel({ label = "Nothing here yet" }: { label?: string }) {
  return <Panel icon={<Inbox size={18} />} title={label} />;
}

export function IndexBuildingPanel() {
  return (
    <Panel
      tone="warn"
      icon={<Clock size={18} />}
      title="Indexes are still building"
      detail="Firestore is building the indexes this view needs. This usually takes a few minutes after deploy — refresh shortly."
    />
  );
}
