import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Let a gate import the app's own modules.
 *
 * Loaded with `node --import ./scripts/lib/ts-imports.mjs`, never with a plain
 * `import` from inside a gate: ESM links a module's whole graph before a single
 * statement in it runs, so a hook registered in the gate's own body is
 * registered too late to affect the imports written above it. That version
 * appears to work right up until a gate imports something that needs it.
 *
 * Node can strip TypeScript types on its own, which is why gates can `import` a
 * `.ts` file directly and compare it against the Worker's copy with no build
 * step in between. What it will not do is guess an extension, and every file in
 * `src/` is written as `from '../lib/day'` because that is what Vite resolves.
 *
 * The alternative was to write `.ts` on the imports inside `src/` to suit the
 * test harness. Bending an application's source into the shape its tests want
 * is how a codebase acquires a build step nobody can explain, so the harness
 * bends instead.
 *
 * Deliberately narrow: only a relative specifier that resolves to nothing gets
 * `.ts`, `.tsx` and `/index.ts` tried after it. Anything that already resolves —
 * every package in `node_modules`, every path written out in full — is
 * untouched, so this cannot quietly shadow a real module with a same-named
 * source file.
 */
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw err
      for (const suffix of ['.ts', '.tsx', '/index.ts']) {
        const url = new URL(specifier + suffix, context.parentURL)
        if (existsSync(fileURLToPath(url))) return next(specifier + suffix, context)
      }
      throw err
    }
  },
})
