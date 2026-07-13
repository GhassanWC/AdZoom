/**
 * Test stub for Next.js's `server-only` package.
 *
 * `server-only` exists solely to make a CLIENT bundle fail loudly if it imports a
 * server module. It has no runtime behaviour, and it isn't installed outside the
 * Next toolchain — so under `node --test` importing it throws ERR_MODULE_NOT_FOUND
 * and takes the whole suite down with it.
 *
 * A no-op is the honest stand-in: in the test runner there IS no client bundle to
 * protect, and stubbing it lets us test the real server modules (the Director's
 * analysis stage) instead of only the pure ones underneath them. The guarantee it
 * provides in production is a BUNDLER guarantee and is unaffected by this file.
 */
export {};
