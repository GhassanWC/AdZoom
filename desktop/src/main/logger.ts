/**
 * Application logging + crash reporting.
 *
 * Two rules govern everything written here (requirement: no private media,
 * tokens or sensitive paths in logs):
 *
 *   1. `redact()` runs over every message and metadata value. It strips
 *      Windows/POSIX absolute paths down to their file name, and masks anything
 *      that looks like a bearer token, API key or Firebase id token.
 *   2. Only main-process events are logged. The renderer's console stays in the
 *      renderer; it is never piped to disk.
 *
 * Crash reporting is Sentry-COMPATIBLE by shape (an envelope with
 * exception/level/tags/extra) and is only sent when `FRAMEVO_SENTRY_DSN` is
 * configured, so a default build phones home to nobody.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

export type LogLevel = "debug" | "info" | "warn" | "error";

let logFile: string | null = null;
let minLevel: LogLevel = "info";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Absolute paths (C:\…, \\server\…, /home/…) → just the file name. */
const WINDOWS_PATH = /(?:[A-Za-z]:\\|\\\\)[^\s"'()]+/g;
const POSIX_PATH = /(?:\/[\w.\-@ ]+){2,}/g;
const TOKENISH = /\b(?:ey[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g;
const BEARER = /\b(?:bearer|authorization|token|api[_-]?key)\b\s*[:=]\s*\S+/gi;

export function redact(value: string): string {
  return value
    .replace(TOKENISH, "«token»")
    .replace(BEARER, (m) => `${m.split(/[:=]/)[0]}=«redacted»`)
    .replace(WINDOWS_PATH, (m) => `«path»\\${m.split("\\").pop() ?? ""}`)
    .replace(POSIX_PATH, (m) => `«path»/${m.split("/").pop() ?? ""}`);
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return "«deep»";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function initLogging(logDir: string, level: LogLevel = "info"): string {
  mkdirSync(logDir, { recursive: true });
  logFile = join(logDir, "framevo-desktop.log");
  minLevel = level;
  rotateIfNeeded();
  return logFile;
}

function rotateIfNeeded(): void {
  if (!logFile) return;
  try {
    if (statSync(logFile).size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`);
  } catch {
    /* first run — no file yet */
  }
}

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const safeMessage = redact(message);
  const safeMeta = meta ? (redactDeep(meta) as Record<string, unknown>) : undefined;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${safeMessage}${
    safeMeta ? ` ${JSON.stringify(safeMeta)}` : ""
  }`;
  // eslint-disable-next-line no-console
  console[level === "debug" ? "log" : level](line);
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${line}\n`, "utf8");
  } catch {
    /* logging must never take the app down */
  }
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => log("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => log("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log("error", m, meta),
};

// ── Crash reporting ─────────────────────────────────────────────────────────

interface CrashContext {
  appVersion: string;
  platform: string;
  environment: string;
}

let crashContext: CrashContext | null = null;
let sentryDsn: string | null = null;

/** Parse `https://<key>@<host>/<projectId>` into an ingest endpoint + key. */
function parseDsn(dsn: string): { url: string; key: string } | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, "");
    if (!u.username || !projectId) return null;
    return {
      url: `${u.protocol}//${u.host}/api/${projectId}/store/`,
      key: u.username,
    };
  } catch {
    return null;
  }
}

export function initCrashReporting(context: CrashContext, dsn?: string): boolean {
  crashContext = context;
  sentryDsn = dsn && parseDsn(dsn) ? dsn : null;
  if (dsn && !sentryDsn) logger.warn("crash reporting: FRAMEVO_SENTRY_DSN is not a valid DSN");
  return sentryDsn !== null;
}

/**
 * Report an error. Always logs; additionally posts a Sentry-format event when a
 * DSN is configured. The message, stack and extras are redacted first — an
 * export failure must never ship the user's file paths off the machine.
 */
export function reportError(error: unknown, extra?: Record<string, unknown>): void {
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error(`${err.name}: ${err.message}`, { ...extra, stack: err.stack?.split("\n")[1] });
  if (!sentryDsn || !crashContext) return;
  const parsed = parseDsn(sentryDsn);
  if (!parsed) return;

  const event = {
    event_id: `${Date.now().toString(16)}${Math.floor(Math.random() * 1e8).toString(16)}`.padEnd(32, "0").slice(0, 32),
    timestamp: new Date().toISOString(),
    platform: "node",
    level: "error",
    release: crashContext.appVersion,
    environment: crashContext.environment,
    tags: { platform: crashContext.platform, surface: "desktop-main" },
    exception: {
      values: [
        {
          type: err.name,
          value: redact(err.message),
          stacktrace: { frames: redact(err.stack ?? "").split("\n").slice(1, 30).map((f) => ({ filename: f.trim() })) },
        },
      ],
    },
    extra: extra ? (redactDeep(extra) as Record<string, unknown>) : undefined,
  };

  void fetch(parsed.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${parsed.key}, sentry_client=framevo-desktop/1.0`,
    },
    body: JSON.stringify(event),
  }).catch(() => {
    /* reporting failures are never fatal */
  });
}
