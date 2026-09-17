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
  /** Always a string; the web app never sends a binary body today. */
  body?: string
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
 * Replace `fetch` with one that sends API requests over the bridge.
 *
 * Only requests to `apiUrl` are diverted. Map tiles, the Google Maps script
 * and everything else keep the webview's own `fetch`, because they are either
 * not CORS-restricted or not ours to reroute.
 *
 * Returns the previous `fetch`, which the tests use and the app ignores.
 */
export function installApiProxy(
  send: (req: ApiRequest) => Promise<ApiResponse>,
  apiUrl: string,
  target: { fetch: typeof fetch } = globalThis,
): typeof fetch {
  const browserFetch = target.fetch.bind(target)

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

  target.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!apiUrl || !url.startsWith(apiUrl)) return browserFetch(input as RequestInfo, init)

    const headers: Record<string, string> = {}
    new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ).forEach((value, key) => {
      headers[key] = value
    })

    const body = init?.body
    if (body != null && typeof body !== 'string') {
      /*
        Nothing sends one today — every request body in `http.ts` is a JSON
        string — but failing loudly beats a request that silently loses its
        body and comes back as a confusing 400.
      */
      throw new TypeError(
        `The native API bridge can only carry a string body; got ${
          (body as object).constructor.name
        }. Base64 it on both sides, as the response path does.`,
      )
    }

    const res = await send({
      url,
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      body: body ?? undefined,
    })

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

  return browserFetch
}
