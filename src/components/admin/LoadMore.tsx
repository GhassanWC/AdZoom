"use client";

import { Button } from "@/components/ui/Button";

/** Footer "Load more" control for paginated admin tables. */
export function LoadMore({
  hasMore,
  loading,
  onClick,
  count,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
  count: number;
}) {
  return (
    <div className="flex items-center justify-between pt-1">
      <span className="text-xs text-fog">{count.toLocaleString("en-US")} shown</span>
      {hasMore && (
        <Button variant="ghost" size="sm" onClick={onClick} disabled={loading}>
          {loading ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
