import { cn } from "@/lib/cn";

type Status = "ready" | "processing" | "draft" | "failed";

const styles: Record<Status, string> = {
  ready: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  processing: "border-violet-400/30 bg-violet-400/10 text-violet-300",
  draft: "border-white/10 bg-white/[0.03] text-fog",
  failed: "border-rose-400/30 bg-rose-400/10 text-rose-300",
};

const labels: Record<Status, string> = {
  ready: "Ready",
  processing: "Processing",
  draft: "Draft",
  failed: "Failed",
};

export function StatusPill({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        styles[status],
        className
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "ready" && "bg-emerald-400",
          status === "processing" && "animate-pulse bg-violet-400",
          status === "draft" && "bg-fog",
          status === "failed" && "bg-rose-400"
        )}
      />
      {labels[status]}
    </span>
  );
}
