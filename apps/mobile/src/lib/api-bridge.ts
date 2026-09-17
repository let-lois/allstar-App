/**
 * The shape the native side and the webview agree on for one API call.
 *
 * Deliberately only strings and plain objects: props and native actions cross
 * between two JavaScript engines over a JSON bridge, so a `Blob`, a
 * `FormData` or a `Headers` cannot travel. Every request the web app makes
 * carries a JSON string body or none, so nothing is lost today — but a future
 * binary upload will have to base64 itself, the way the response side does.
 */
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
