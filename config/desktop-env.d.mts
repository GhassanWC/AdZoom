/**
 * Types for ./desktop-env.mjs.
 *
 * Hand-written so the plain-JS implementation can be shared by the desktop
 * build scripts (which cannot import TypeScript) AND the TypeScript server
 * route, without two copies of the rules that would drift apart.
 */

export type DesktopEnvironment = "development" | "production";

export interface DesktopConfigFields {
  environment: DesktopEnvironment;
  /** e.g. "adzoomdev". Non-secret. */
  firebaseProjectId: string;
  /** The Google Cloud PROJECT NUMBER. Non-secret. */
  messagingSenderId: string;
  authDomain: string;
  apiBaseUrl: string;
  /** `<project-number>-<hash>.apps.googleusercontent.com`. Non-secret. */
  googleClientId: string;
  /** Every NEXT_PUBLIC_* value for this environment. Never a secret. */
  publicEnv: Record<string, string>;
}

export interface DesktopConfigVerdict {
  ok: boolean;
  /** Blocking: the build fails and sign-in is refused. */
  errors: string[];
  /** Non-blocking: a capability is unavailable. */
  warnings: string[];
}

export type ResolvedDesktopConfig = DesktopConfigFields & DesktopConfigVerdict;

export interface ResolveOptions {
  environment?: DesktopEnvironment;
  /** Pre-read variables, for tests. Bypasses the filesystem entirely. */
  env?: Record<string, string>;
  processEnv?: Record<string, string | undefined>;
  root?: string;
}

export declare const REPO_ROOT: string;
export declare const ENVIRONMENTS: readonly ["development", "production"];

export declare function resolveEnvironment(
  env?: Record<string, string | undefined>
): DesktopEnvironment;

export declare function envFilesFor(
  environment: DesktopEnvironment,
  root?: string
): string[];

export declare function readEnvironmentFiles(
  environment: DesktopEnvironment,
  options?: { root?: string; processEnv?: Record<string, string | undefined> }
): Record<string, string>;

export declare function projectNumberFromClientId(clientId: unknown): string | null;

export declare function describeConfig(config: DesktopConfigFields): string;

export declare function resolveDesktopConfig(
  options?: ResolveOptions
): ResolvedDesktopConfig;

export declare function validateDesktopConfig(
  config: DesktopConfigFields
): DesktopConfigVerdict;

export declare function assertDesktopConfig<T extends ResolvedDesktopConfig>(
  config: T,
  label?: string
): T;
