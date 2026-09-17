/**
 * The two host globals this package uses, declared rather than inherited.
 *
 * `tsconfig.json` sets `"lib": ["ES2020"]` and `"types": []` — no DOM, no Node.
 * That is the point: it makes the compiler, not a convention, the thing that
 * stops `document` or `localStorage` from being reached for in here. The cost
 * is that genuinely cross-platform globals have to be named explicitly, and
 * these are the only two.
 *
 * Both are used defensively at the call site, because neither is guaranteed:
 *
 * - `crypto.randomUUID` — `uid()` feature-tests it and falls back to
 *   `Math.random()`. Hermes has no Web Crypto, so on React Native this takes
 *   the fallback unless the app installs `react-native-get-random-values`.
 * - `TextDecoder` — `sniffCsv()` constructs it inside a `try`, and a
 *   `ReferenceError` on a runtime that lacks it lands in the same `catch` as a
 *   malformed byte sequence. CSV import is an admin-console feature, so this
 *   path is desktop-only in practice.
 */

/*
  `crypto` itself is optional; `randomUUID` is declared present on it. The call
  site guards both (`typeof crypto !== 'undefined' && 'randomUUID' in crypto`),
  and typing the method as optional as well would force a non-null assertion
  into `uid()` that the runtime check already earns.
*/
declare const crypto: { randomUUID: () => string } | undefined

declare class TextDecoder {
  constructor(encoding?: string, options?: { fatal?: boolean })
  decode(input?: ArrayBufferView | ArrayBuffer): string
}
