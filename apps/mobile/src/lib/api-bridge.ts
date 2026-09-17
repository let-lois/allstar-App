/**
 * The webview's API calls, routed through the native side.
 *
 * This exists because of where the webview is loaded from. Expo hands a DOM
 * component to WKWebView with `loadFileURL`, so the page's origin is `file://`
 * and every cross-origin request it makes carries `Origin: null`. The Worker's
 * `corsHeaders()` echoes headers only for an origin in its `ALLOWED_ORIGINS`
 * list, and `null` is not one — so it answers with no CORS headers, the browser
 * discards the response, and every screen reports a network problem. Signing in
 * is the first thing a rep notices. The Worker's own comment predicts it: this
 * turns "nobody can sign in" into a one-line fix in `wrangler tail`.
 *
 * The alternative was adding `null` to the server's allowlist — a production
 * change letting every sandboxed page in the world talk to the API, to fix a
 * client that should not have needed it. So the request crosses the bridge
 * instead, where React Native's `fetch` is not a browser and CORS does not
 * apply. No server change, and nothing in the web app's `http.ts` knows.
 *
 * Split out of the shell component so it can be tested without a phone:
 * `scripts/verify-bridge.mjs` drives it. That gate found the null-body status
 * bug below.
 */

/** One request, in the only shape a native action can carry. */
export interface ApiRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Text as-is, base64 when `isBase64` is set. */
  body?: string
  /** Whether `body` needs decoding before it is sent. Photo bytes do. */
  isBase64?: boolean
}

export interface ApiResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  /** Text for JSON and CSV, base64 when `isBase64` is set (photo bytes). */
  body: string
  isBase64: boolean
}

/**
 * Statuses the Response constructor refuses to give a body to.
 *
 * `new Response('', { status: 204 })` throws `Invalid response status code`,
 * because 204, 205 and 304 are defined as having no body at all. The bridge
 * always has a string in hand — `''` for an empty one — so without this the
 * shim would throw inside `fetch` and the screen would fail in a way that
 * looks nothing like its cause. Nothing returns 204 today except the CORS
 * preflight, which a native fetch never sends; this is the trap for the first
 * endpoint that does.
 */
const NULL_BODY_STATUS = new Set([204, 205, 304])

/**
 * Bytes to base64, in chunks.
 *
 * `String.fromCharCode(...bytes)` on a photo blows the argument limit and
 * throws a range error, which reads like a broken image rather than a broken
 * loop. The native side's response path does the same thing for the same
 * reason; the two are deliberately symmetrical.
 */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let raw = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    raw += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(raw)
}

/**
 * A request body, in the only shape a native action can carry.
 *
 * A native action crosses a JSON bridge between two JavaScript engines, so a
 * `Blob` cannot go over it — and a photo upload is exactly a `Blob`.
 * `apiUploadPhoto` in the web app's `http.ts` passes one as `raw`, which the
 * first version of this file rejected with a `TypeError` whose comment claimed
 * "nothing sends one today". That was simply wrong, and it made every photo
 * upload throw inside `fetch`.
 *
 * So the bytes are base64'd on the way out and decoded on the way in, which is
 * what the response path already did for photo bytes coming back.
 *
 * `FormData` and a stream are still refused, loudly. Neither can be serialised
 * without deciding a boundary or draining a stream on the wrong side of the
 * bridge, and nothing in the app sends either — but a silent loss of a body
 * comes back as a puzzling 400, so it says so instead.
 */
async function encodeBody(body: BodyInit): Promise<{ body: string; isBase64: boolean }> {
  if (typeof body === 'string') return { body, isBase64: false }
  // Text in disguise: carried as text so the hot path stays cheap.
  if (body instanceof URLSearchParams) return { body: body.toString(), isBase64: false }
  if (body instanceof Blob) return { body: toBase64(await body.arrayBuffer()), isBase64: true }
  if (body instanceof ArrayBuffer) return { body: toBase64(body), isBase64: true }
  if (ArrayBuffer.isView(body)) {
    /*
      Sliced to this view's own window. A `Uint8Array` can be a view onto part
      of a larger buffer, and base64'ing the whole buffer would upload
      somebody else's bytes along with the photo.
    */
    return {
      body: toBase64(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
      isBase64: true,
    }
  }
  throw new TypeError(
    `The native API bridge cannot carry a ${
      (body as object).constructor?.name ?? typeof body
    } body. Text, URLSearchParams and binary (Blob, ArrayBuffer, typed array) cross; ` +
      `FormData and streams do not, and nothing in the app sends one.`,
  )
}

/**
 * Replace `fetch` with one that sends API requests over the bridge.
 *
 * Only requests to `apiUrl` are diverted. Map tiles, the Google Maps script
 * and everything else keep the webview's own `fetch`, because they are either
 * not CORS-restricted or not ours to reroute.
 *
 * Returns the previous `fetch`, which the tests use and the app ignores.
 */
/**
 * Where a proxy keeps the real `fetch` it replaced.
 *
 * Installing twice used to wrap the *previous proxy* rather than the webview's
 * own `fetch`, because `target.fetch` was whatever was there at the time. Two
 * consequences, and both are real:
 *
 *   - every install retained the closure of the one before it, so the chain
 *     grew without bound;
 *   - every request that is *not* the API — which means every map tile — walked
 *     the whole chain before reaching the real `fetch`. A rep panning the map
 *     issues hundreds of tile requests, so this is the hot path.
 *
 * Measured at two shim frames per install. It matters because the shell calls
 * this in the component body, not an effect (deliberately — see
 * `allstar-web.tsx`), and the DOM root re-renders whenever the native side
 * emits props.
 *
 * So a proxy carries the genuine `fetch` with it, and a re-install *replaces*
 * rather than stacks.
 */
const ORIGINAL = Symbol.for('allstar.apiProxy.original')

type Proxied = typeof fetch & { [ORIGINAL]?: typeof fetch }

export function installApiProxy(
  send: (req: ApiRequest) => Promise<ApiResponse>,
  apiUrl: string,
  target: { fetch: typeof fetch } = globalThis,
): typeof fetch {
  const browserFetch =
    (target.fetch as Proxied)[ORIGINAL] ?? target.fetch.bind(target)

  /*
    A missing native action would be indistinguishable from the bug this
    replaces.

    `send` arrives as a prop across the bridge. If it were ever absent — a
    renamed prop, a route that forgot to pass it — the shim would call
    `undefined(...)`, the request would fail, and the web app's own diagnosis
    would report the server's allowed-origins list, sending whoever read it to
    the wrong console for the second time. Failing here instead names the real
    fault once, at install, before a single request has been shaped by it.
  */
  if (typeof send !== 'function') {
    throw new TypeError(
      'installApiProxy needs the native apiFetch action; got ' +
        typeof send +
        '. Without it every API call fails and the app blames the API\'s CORS configuration.',
    )
  }

  const proxy = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!apiUrl || !url.startsWith(apiUrl)) return browserFetch(input as RequestInfo, init)

    const headers: Record<string, string> = {}
    new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ).forEach((value, key) => {
      headers[key] = value
    })

    /*
      The body, from wherever the caller put it.

      `init.body` is how the whole web app sends one. A `Request` can carry one
      too, and the only honest way to read it is to drain it — so that case
      goes through `blob()`, which `encodeBody` already knows how to carry. The
      alternative is what was here before: reading `init.body` only, and
      silently sending a `Request`'s body nowhere.
    */
    const raw: BodyInit | null =
      init?.body ?? (input instanceof Request && input.body ? await input.blob() : null)
    const encoded = raw != null ? await encodeBody(raw) : undefined

    const call = send({
      url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      body: encoded?.body,
      isBase64: encoded?.isBase64,
    })

    /*
      The caller's `AbortSignal`, which used to be dropped on the floor.

      `request()` in the web app's `http.ts` gives every call a deadline — 20s
      normally, 45s for a photo down, 60s for one up — and arms it with
      `signal`. A signal is a live object with listeners, so it cannot cross a
      JSON bridge, and dropping it meant none of those deadlines existed on a
      phone: a stalled cellular request hung the screen forever instead of
      failing at twenty seconds. That is the difference between a rep seeing
      "could not reach the server" and a rep force-quitting the app.

      Raced rather than forwarded, and rejected with the same `AbortError` a
      browser would raise, so `answeredButBlocked` still recognises a timeout
      as a timeout rather than calling it a CORS problem.

      What this does *not* do is cancel the native request — it keeps running
      and its answer is discarded. Every abort in the app today is a deadline
      rather than a person changing their mind, so the cost is a few wasted
      seconds of radio on a request that already failed. Cancelling for real
      needs a request registry on both sides of the bridge, and should wait
      until something actually needs it.
    */
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null)
    const res = await (signal
      ? Promise.race([
          call,
          new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
              return
            }
            signal.addEventListener(
              'abort',
              () =>
                reject(
                  signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
                ),
              { once: true },
            )
          }),
        ])
      : call)

    const payload = NULL_BODY_STATUS.has(res.status)
      ? null
      : res.isBase64
        ? Uint8Array.from(atob(res.body), (c) => c.charCodeAt(0))
        : res.body

    return new Response(payload as BodyInit | null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }

  ;(proxy as Proxied)[ORIGINAL] = browserFetch
  target.fetch = proxy as typeof fetch

  return browserFetch
}
