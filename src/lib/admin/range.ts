/**
 * Date-range parsing shared by the admin API routes and UI.
 *
 * The dashboard's range selector (today / 7d / 30d / all) maps to an epoch-ms
 * lower bound. "all" → 0 (matches everything). Pure functions, no Firestore
 * dependency, so the client can import the same `RANGE_OPTIONS`.
 */

export type RangeKey = "today" | "7d" | "30d" | "all";

const DAY_MS = 86_400_000;

export const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
];

/** Coerce an arbitrary query-string value into a valid RangeKey (default 30d). */
export function parseRange(value: string | null | undefined): RangeKey {
  return value === "today" || value === "7d" || value === "30d" || value === "all"
    ? value
    : "30d";
}

/** Epoch-ms lower bound for a range. 0 = "all time". */
export function rangeSince(range: RangeKey, now: number = Date.now()): number {
  switch (range) {
    case "today": {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "all":
      return 0;
  }
}
