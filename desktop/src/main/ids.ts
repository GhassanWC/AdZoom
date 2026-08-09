/**
 * Opaque handle generation.
 *
 * Every id the renderer ever sees (project, media, export, job) comes from
 * here: 22 URL-safe characters of CSPRNG output, matching the
 * `[A-Za-z0-9_-]{6,64}` shape the IPC validators enforce. They are unguessable,
 * which matters because a media id is the ONLY thing standing between the
 * renderer and a file on disk.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

export function newId(length = 22): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! & 63];
  return out;
}
