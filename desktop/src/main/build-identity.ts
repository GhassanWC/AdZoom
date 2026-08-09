/**
 * Does the renderer this app is SERVING belong to the same project as the
 * sign-in client this bundle was BUILT with?
 *
 * The desktop app is two artifacts produced by two commands: `build:bundle`
 * bakes the OAuth client id into main, and `build:renderer` bakes the Firebase
 * web config into the static export. Each command validates itself — and a
 * mismatched PAIR passes both, because neither has ever seen the other.
 *
 * When they disagree, sign-in fails at the very last step with Firebase's
 * `auth/invalid-credential`: "the Google id_token is not allowed to be used
 * with this application… project_number: 461465030931". Two opaque numbers, no
 * mention of which artifact is stale or what to rebuild. The renderer therefore
 * ships a stamp of the environment it was built for, and this module compares
 * the two and says the thing the user actually needs to hear.
 *
 * Everything here is a public identifier — project ids, project numbers, an
 * OAuth client id, an API origin. No secret is written to the stamp or read
 * from it.
 */

/** What `scripts/build-renderer.mjs` writes next to the static export. */
export interface RendererBuildStamp {
  environment: string;
  firebaseProjectId: string;
  messagingSenderId: string;
  apiBaseUrl: string;
}

/** The identity of the main bundle, substituted by esbuild at build time. */
export interface MainBuildIdentity {
  environment: string;
  /** `574329747163-abc.apps.googleusercontent.com` */
  googleClientId: string;
  apiBaseUrl: string;
}

/** `<project number>-<hash>.apps.googleusercontent.com` → the project number. */
export function oauthProjectNumber(clientId: string): string | null {
  const match = /^(\d{6,})-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.exec(clientId.trim());
  return match ? match[1] : null;
}

/** Parse a stamp defensively: an old or hand-edited file must not throw. */
export function parseRendererStamp(value: unknown): RendererBuildStamp | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const stamp: RendererBuildStamp = {
    environment: text("environment"),
    firebaseProjectId: text("firebaseProjectId"),
    messagingSenderId: text("messagingSenderId"),
    apiBaseUrl: text("apiBaseUrl"),
  };
  // Without the project number there is nothing to compare, and claiming
  // agreement on that basis would be worse than saying nothing.
  return stamp.messagingSenderId ? stamp : null;
}

/**
 * The message to show, or null when the two halves agree.
 *
 * A MISSING stamp is not a mismatch: it means the renderer predates this check
 * (or the app is serving a dev server, which has no stamp at all), and refusing
 * to sign in over that would break working installs to guard a hypothesis.
 */
export function describeBuildMismatch(
  main: MainBuildIdentity,
  renderer: RendererBuildStamp | null
): string | null {
  if (!renderer) return null;
  const clientProject = oauthProjectNumber(main.googleClientId);
  if (!clientProject || clientProject === renderer.messagingSenderId) return null;

  const stale =
    renderer.environment && renderer.environment !== main.environment
      ? `The app is showing a ${renderer.environment} screen inside a ${main.environment} build. `
      : "";
  return (
    `${stale}This app's sign-in client belongs to Google Cloud project #${clientProject}, ` +
    `but the screen it is showing signs in to Firebase project ` +
    `"${renderer.firebaseProjectId || "unknown"}" (#${renderer.messagingSenderId}), ` +
    `so Google's token will be rejected. Rebuild both halves for one environment: ` +
    `npm run desktop:build (development), or FRAMEVO_ENV=production npm run desktop:build.`
  );
}
