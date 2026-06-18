/**
 * Local dev entry. Defaults `DEV_DISABLE_OIDC=1` (skip Google OIDC; render in
 * the background) so the whole cloud-export pipeline runs on a Windows dev box
 * with `npm run dev` (app) + `npm run worker:dev` (this), no GCP required.
 *
 * Still needs Firebase Admin creds + a Storage bucket — set
 * `FIREBASE_SERVICE_ACCOUNT_B64` and `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` (or
 * point `GOOGLE_APPLICATION_CREDENTIALS` at a key file).
 */
import { loadDotEnvLocal } from "./load-env.js";

// Pull the repo-root .env.local into process.env (Firebase project + creds +
// bucket) before anything reads config.
loadDotEnvLocal();

process.env.DEV_DISABLE_OIDC = process.env.DEV_DISABLE_OIDC ?? "1";
process.env.PORT = process.env.PORT ?? "8787";

await import("./server.js");

export {};
