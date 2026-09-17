/**
 * Hand a blob to the browser as a download.
 *
 * Three copies of this existed, and they were not equivalent. The one on the
 * reports screen neither put the anchor in the document nor waited before
 * revoking the object URL — and Safari starts the download *after* `click()`
 * returns, so it was handed a URL that no longer existed. The other two were
 * right, one of them carrying the comment explaining exactly that, which is
 * the shape of a lesson learned in one place and not the others.
 *
 * So: in the document, clicked, removed, and the URL revoked on a later tick.
 *
 * Worth knowing before this is packaged as a native app: `<a download>` with a
 * `blob:` URL is unreliable to non-functional inside a WebView — Android needs
 * the host to implement a download listener and does not hand it blob URLs at
 * all, and iOS ignores the attribute in most configurations. The failure is
 * silent: no file, no error, nothing to catch. This is the right shape for the
 * web, and the place to change when there is a shell to change it for.
 */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
