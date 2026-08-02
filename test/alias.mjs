import { register } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Teach `node --test` the `@/` import alias.
 *
 * The app resolves `@/lib/foo` through `paths` in tsconfig.json, which is a
 * bundler's map and not a runtime one — so a module imported straight into a
 * test process fails on the first aliased import it meets. This registers a
 * resolve hook that does the same substitution Next does: `@/` is the
 * repository root.
 *
 * Loaded with `--import ./test/alias.mjs`, alongside `--experimental-strip-types`
 * which is what lets a `.ts` module be imported at all. Both are in the
 * `test:web` script, so a test file only has to import what it is testing.
 */
register(new URL("./alias-hooks.mjs", import.meta.url), pathToFileURL("./"));
