/**
 * Server-only GCP auth for the Speech-to-Text REST API. Mints a
 * cloud-platform-scoped access token from Application Default Credentials (App
 * Hosting / Cloud Run / GCE metadata) or the same base64 service account the
 * Firebase Admin app uses (`FIREBASE_SERVICE_ACCOUNT_B64`). Credentials NEVER
 * leave the server — the token is only used for server→Google REST calls.
 */
import { GoogleAuth } from "google-auth-library";

const SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

let cached: GoogleAuth | null = null;

function authClient(): GoogleAuth {
  if (cached) return cached;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      client_email: string;
      private_key: string;
      project_id?: string;
    };
    cached = new GoogleAuth({
      credentials: { client_email: json.client_email, private_key: json.private_key },
      projectId: json.project_id,
      scopes: SCOPES,
    });
  } else {
    // Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS or the
    // Cloud metadata server on GCP).
    cached = new GoogleAuth({ scopes: SCOPES });
  }
  return cached;
}

/** A cloud-platform-scoped OAuth access token. Throws if none can be obtained. */
export async function getCloudAccessToken(): Promise<string> {
  const client = await authClient().getClient();
  const res = await client.getAccessToken();
  const token = typeof res === "string" ? res : res.token;
  if (!token) throw new Error("could not obtain a GCP access token (check credentials)");
  return token;
}

/** Resolve the active GCP project id from env or ADC. */
export async function resolveProjectId(): Promise<string | undefined> {
  const env = process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (env) return env;
  try {
    return (await authClient().getProjectId()) || undefined;
  } catch {
    return undefined;
  }
}
