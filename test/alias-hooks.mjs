import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

/**
 * The resolve hook `test/alias.mjs` registers. See the comment there.
 *
 * Runs on its own thread, which is why it is a separate file: a loader cannot
 * be the module that registers it.
 */

/** The repository root — this file lives in `test/`. */
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The extensions the alias will try, in the order TypeScript would.
 *
 * An aliased import is written without one — `@/lib/chains`, never
 * `@/lib/chains.ts` — because the bundler supplies it. Node does not, so it is
 * supplied here rather than by rewriting every import in the app to suit the
 * test runner.
 */
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = join(ROOT, specifier.slice(2));
    const path = existsSync(base) ? base : EXTENSIONS.map((ext) => base + ext).find(existsSync);

    // A miss falls through unchanged, so the failure names the specifier the
    // author actually wrote instead of a path this file invented.
    if (path) return nextResolve(pathToFileURL(path).href, context);
  }
  return nextResolve(specifier, context);
}
