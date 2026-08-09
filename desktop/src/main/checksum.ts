/**
 * Content hashes for media files.
 *
 * STREAMED, never buffered. A screen recording is routinely several gigabytes,
 * so `readFileSync` + hash would spike memory by the size of the file and can
 * simply fail past the Buffer limit. Everything here reads in fixed chunks and
 * holds only the hash state.
 *
 * TWO hashes in ONE pass, on purpose:
 *
 *   sha256 — our own content identity. Recorded against the media row so a
 *            re-import of the same file is recognisable and a local file that
 *            changed under us is detectable.
 *   md5    — the only digest Firebase Storage reports back (`md5Hash`, base64).
 *            It is what makes "verify the upload arrived intact" an actual
 *            comparison rather than a hopeful look at the byte count.
 *
 * MD5 is used here purely as a transport integrity check against a value the
 * storage service computes independently. It is not used for security, and
 * nothing trusts it to prove authorship.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

/** 8 MiB — large enough to keep the syscall count low, small enough to be invisible. */
const CHUNK_BYTES = 8 * 1024 * 1024;

export interface FileDigest {
  /** Lowercase hex. */
  sha256: string;
  /** BASE64, matching the encoding Firebase Storage reports in `md5Hash`. */
  md5Base64: string;
  sizeBytes: number;
}

/**
 * Hash a file without loading it.
 *
 * `onProgress` reports bytes read so a multi-gigabyte hash can show movement
 * rather than looking frozen; it is optional because most callers do not care.
 */
export function digestFile(
  path: string,
  onProgress?: (bytesRead: number, totalBytes: number) => void
): Promise<FileDigest> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    try {
      totalBytes = statSync(path).size;
    } catch (err) {
      reject(new Error(`cannot read ${describe(path)} (${codeOf(err)})`));
      return;
    }

    const sha256 = createHash("sha256");
    const md5 = createHash("md5");
    let bytesRead = 0;

    const stream = createReadStream(path, { highWaterMark: CHUNK_BYTES });
    stream.on("data", (chunk) => {
      sha256.update(chunk);
      md5.update(chunk);
      bytesRead += chunk.length;
      onProgress?.(bytesRead, totalBytes);
    });
    stream.on("error", (err) =>
      reject(new Error(`cannot read ${describe(path)} (${codeOf(err)})`))
    );
    stream.on("end", () => {
      resolve({
        sha256: sha256.digest("hex"),
        md5Base64: md5.digest("base64"),
        sizeBytes: bytesRead,
      });
    });
  });
}

/**
 * Does the object the storage service now holds match what we hashed?
 *
 * Both halves matter. `md5Hash` catches corruption; `size` catches the case
 * where the service reports no digest at all (it is absent on some upload
 * paths), where a byte comparison is the only check available and is still
 * enough to catch the failure that actually happens — a truncated upload.
 */
export function uploadMatches(args: {
  expected: FileDigest;
  remoteMd5Base64?: string | null;
  remoteSizeBytes?: number | null;
}): { ok: true } | { ok: false; reason: string } {
  const { expected, remoteMd5Base64, remoteSizeBytes } = args;

  if (typeof remoteSizeBytes === "number" && remoteSizeBytes !== expected.sizeBytes) {
    return {
      ok: false,
      reason: `uploaded ${remoteSizeBytes} bytes, expected ${expected.sizeBytes}`,
    };
  }
  if (remoteMd5Base64 && remoteMd5Base64 !== expected.md5Base64) {
    return { ok: false, reason: "the uploaded file's checksum does not match the original" };
  }
  if (!remoteMd5Base64 && typeof remoteSizeBytes !== "number") {
    // Neither signal available: refuse to claim verification we did not do.
    return { ok: false, reason: "the upload could not be verified" };
  }
  return { ok: true };
}

/** File name only — a path must never reach a log line or the renderer. */
function describe(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "file";
}

/**
 * The errno CODE, never the message.
 *
 * Node stamps the offending PATH into `err.message` ("ENOENT: no such file or
 * directory, stat 'C:\\Users\\…'"), so forwarding the message would defeat
 * `describe` entirely — which is exactly what the test that found this was
 * checking. The code alone ("ENOENT", "EACCES") is what a reader actually needs.
 */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code : "unknown error";
}
