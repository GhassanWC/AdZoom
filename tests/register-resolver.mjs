// `--import` entry for `node --test`: registers the augment-only resolver
// (tests/loader.mjs) so tests + the src modules they load can use the `@/` alias
// and extensionless imports (matching Turbopack/tsc `bundler` resolution).
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
