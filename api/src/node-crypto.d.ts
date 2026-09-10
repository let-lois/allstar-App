/**
 * Just enough of `node:crypto` to derive a backup key.
 *
 * The Worker runs with `nodejs_compat`, so `node:crypto` is genuinely there at
 * runtime — but this project's tsconfig loads `@cloudflare/workers-types` and
 * nothing else, deliberately. Adding `@types/node` to that list would put Node's
 * globals beside the Workers ones, and where the two disagree (`crypto`,
 * `fetch`, `Request`, timers) TypeScript resolves it by declaration order rather
 * than by which one actually runs. Every existing file in `src/` is typed
 * against the Workers globals and should stay that way.
 *
 * So this declares the one function `backup.ts` uses and nothing else. It is one
 * function on purpose: the AES-GCM half of the same file went through
 * `createCipheriv` at first and local dev answered `[unenv]
 * crypto.createCipheriv is not implemented yet`, so the encryption moved to Web
 * Crypto, which is native here. What is left is `scryptSync`, which the backup
 * format's header names by parameter and which Web Crypto has no equivalent of.
 *
 * A hand-written declaration can drift from the real signature. `smoke:backup`
 * runs this in the real runtime and opens the result with Node's own crypto,
 * which is what catches drift — and would have caught a `scryptSync` that
 * returned something plausible and wrong.
 */
declare module 'node:crypto' {
  export function scryptSync(
    password: string | Uint8Array,
    salt: string | Uint8Array,
    keylen: number,
    options?: { N?: number; r?: number; p?: number; maxmem?: number },
  ): Uint8Array
}
