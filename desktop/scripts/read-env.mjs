/**
 * The desktop build's view of configuration.
 *
 * A thin, intentional wrapper over `config/desktop-env.mjs` — which is shared
 * with the server authentication endpoint, so the rules about which Firebase
 * project pairs with which OAuth client cannot drift between them.
 *
 * The important property is what this does NOT read: `.env.local`. That file
 * carries no environment in its name, so a development build that fell back to
 * it would silently inherit whatever a production edit last left there. That is
 * precisely how a production OAuth client ended up in a development desktop
 * build, producing `auth/invalid-credential` at sign-in with nothing in the
 * build output to explain it. Only `.env`, `.env.<environment>` and
 * `.env.<environment>.local` are consulted.
 */
export {
  ENVIRONMENTS,
  REPO_ROOT,
  assertDesktopConfig,
  describeConfig,
  envFilesFor,
  projectNumberFromClientId,
  readEnvironmentFiles,
  resolveDesktopConfig,
  resolveEnvironment,
  validateDesktopConfig,
} from "../../config/desktop-env.mjs";
