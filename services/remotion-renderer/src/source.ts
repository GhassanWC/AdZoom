/**
 * Make the job's source recording available to the Remotion composition's
 * `<OffthreadVideo src>` as a NORMAL local HTTP URL.
 *
 * Why local HTTP (not file:// and not a GCS signed URL):
 *  - `file://` → renderMedia throws "Can only download URLs starting with
 *    http:// or https://" (Remotion downloads OffthreadVideo assets Node-side).
 *  - a GCS signed HTTPS URL works in principle but Remotion's Node-side asset
 *    download can be slow / stall on egress, hanging with no render progress.
 *  - a tiny localhost static server gives Remotion a normal http:// URL while the
 *    bytes are already on local disk → fast, private, no egress mid-render.
 *
 * Flow: validate object metadata (exists / readable / non-empty) → stream the
 * object to `/tmp/.../source.mp4` (bounded by an abort signal + timeout) → start
 * a 127.0.0.1 static server (Range + HEAD) → return `http://127.0.0.1:<port>/source.mp4`.
 */
import { createServer, type Server } from "node:http";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import { bucket } from "./firebase.js";
import { SourceUnavailableError } from "./errors.js";
import type { ExportJobDoc } from "@/lib/firebase/schema";

export interface PreparedSource {
  /** http://127.0.0.1:<port>/source.mp4 — the ONLY value handed to <OffthreadVideo>. */
  renderUrl: string;
  /** Source object size in bytes. */
  bytes: number;
  /** Local file path on /tmp (cleaned up with the work dir). */
  localPath: string;
  /** Stop the local HTTP server. Idempotent; never rejects. */
  close: () => Promise<void>;
}

export interface PrepareSourceOpts {
  /** Hard cap on the metadata-read control-plane call. */
  resolveTimeoutMs: number;
  /** Hard cap on streaming the object to /tmp. */
  downloadTimeoutMs: number;
  /** Aborts metadata-read + download on cancel / the worker's hard timeout. */
  signal?: AbortSignal;
}

/** Bound a promise by a timeout + an optional abort signal. */
function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${label} timed out after ${ms}ms`))),
      ms
    );
    const onAbort = () => finish(() => reject(new Error(`${label} aborted`)));
    if (signal) {
      if (signal.aborted) {
        finish(() => reject(new Error(`${label} aborted`)));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e))
    );
  });
}

/** Static one-file HTTP server on 127.0.0.1:<ephemeral>, with Range + HEAD so
 *  Remotion/FFmpeg's asset fetch behaves like any normal video URL. */
function startLocalFileServer(
  filePath: string,
  routeName: string
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const size = statSync(filePath).size;
  const server: Server = createServer((req, res) => {
    const startedAt = Date.now();
    const method = (req.method || "GET").toUpperCase();
    const rangeHeader = req.headers.range ?? "";
    const userAgent = req.headers["user-agent"] ?? "";
    const url = req.url ?? "";
    // Log on ARRIVAL so we know Remotion/Chromium reached the server even if the
    // response later stalls (received without a matching "done" ⇒ a serving hang;
    // no "received" at all ⇒ the render never fetched the source).
    console.info("[local-source] request received", { method, url, range: rangeHeader, userAgent });

    let status = 200;
    let bytesPlanned = 0;
    res.on("finish", () =>
      console.info("[local-source] request done", {
        method,
        url,
        range: rangeHeader,
        status,
        bytes: bytesPlanned,
        durationMs: Date.now() - startedAt,
      })
    );
    res.on("close", () => {
      if (!res.writableFinished) {
        console.warn("[local-source] request closed before finish", {
          method,
          url,
          range: rangeHeader,
          status,
          durationMs: Date.now() - startedAt,
        });
      }
    });

    if (method !== "GET" && method !== "HEAD") {
      status = 405;
      res.writeHead(405).end();
      return;
    }
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const match = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null;
    let start = 0;
    let end = size - 1;
    if (match) {
      const s = match[1] ? Number.parseInt(match[1], 10) : NaN;
      const e = match[2] ? Number.parseInt(match[2], 10) : NaN;
      start = Number.isFinite(s) ? s : 0;
      end = Number.isFinite(e) ? Math.min(e, size - 1) : size - 1;
      if (start > end || start >= size) {
        status = 416;
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      status = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    bytesPlanned = end - start + 1;
    res.setHeader("Content-Length", String(bytesPlanned));
    res.writeHead(status);
    if (method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(filePath, { start, end });
    // Swallow stream/socket errors (e.g. client aborts a range) so a half-read
    // response can never crash the worker process.
    stream.on("error", () => res.destroy());
    res.on("error", () => stream.destroy());
    stream.pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // Keep-alive sockets must not block server.close() — track + destroy on close.
    const sockets = new Set<import("node:net").Socket>();
    server.on("connection", (sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/${routeName}`,
        port,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

export async function prepareSource(
  job: ExportJobDoc,
  workDir: string,
  opts: PrepareSourceOpts
): Promise<PreparedSource> {
  const file = bucket().file(job.sourceStoragePath);

  // ── Validation: object exists, readable by this SA, non-empty ─────────────
  let bytes = 0;
  try {
    const [meta] = await withDeadline(
      file.getMetadata(),
      opts.resolveTimeoutMs,
      opts.signal,
      "source metadata read"
    );
    bytes = Number((meta as { size?: number | string }).size ?? 0) || 0;
  } catch (err) {
    throw new SourceUnavailableError(
      `source metadata read failed for ${job.sourceStoragePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!(bytes > 0)) {
    throw new SourceUnavailableError(
      `source object ${job.sourceStoragePath} is empty or has no readable size`
    );
  }

  // ── Download to /tmp (streamed, bounded by timeout + abort) ───────────────
  const ext = extname(job.sourceStoragePath) || ".mp4";
  const routeName = `source${ext}`;
  const localPath = join(workDir, routeName);
  const timeout = AbortSignal.timeout(Math.max(1, opts.downloadTimeoutMs));
  const combined = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    await pipeline(file.createReadStream(), createWriteStream(localPath), { signal: combined });
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string };
    const aborted = e?.name === "AbortError" || e?.code === "ABORT_ERR";
    throw new SourceUnavailableError(
      `source download ${aborted ? "timed out / aborted" : "failed"} for ${job.sourceStoragePath}: ${e?.message ?? String(err)}`
    );
  }

  // ── Serve it over a local HTTP server → normal http:// URL for Remotion ───
  let server: { url: string; port: number; close: () => Promise<void> };
  try {
    server = await startLocalFileServer(localPath, routeName);
  } catch (err) {
    throw new SourceUnavailableError(
      `failed to start local source server: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Hard guard: never hand a non-http URL to the compositor.
  if (!/^http:\/\//i.test(server.url)) {
    await server.close().catch(() => {});
    throw new SourceUnavailableError(`local source URL is not http: ${server.url.slice(0, 16)}…`);
  }

  return { renderUrl: server.url, bytes, localPath, close: server.close };
}
