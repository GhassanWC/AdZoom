/**
 * `--import` entry for the desktop package's `node --test` run.
 *
 * Registers a resolver that maps the `@/…` alias onto the APP's src/ (one level
 * up), so a main-process module under test can import the shared IPC contract
 * and render core exactly as it does at runtime.
 */
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
