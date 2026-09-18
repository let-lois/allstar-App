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
 * `<a download>` with a `blob:` URL is unreliable to non-functional inside a
 * WebView — Android needs the host to implement a download listener and does
 * not hand it blob URLs at all, and iOS ignores the attribute in most
 * configurations. The failure is silent: no file, no error, nothing to catch.
 *
 * There is a native shell now, and it deliberately changes nothing here,
 * because every caller is a screen the shell does not bundle. All three —
 * `AdminLeads`, `AdminLists`, `AdminReports` — are behind `adminRoutes.tsx`,
 * which `apps/mobile/metro.config.js` swaps for a stub: the phone bundle
 * contains no reference to any of them. Exporting is an office job done on a
 * desktop, and a rep has no screen that reaches this.
 *
 * So the native path is a real piece of work — a save action over the bridge
 * into `expo-file-system` and a share sheet — for a button that is not there.
 * It belongs with the first mobile screen that actually needs to hand a file
 * to the OS, and not before. Checked rather than assumed: `grep saveFile src/`
 * and `grep -c Admin apps/mobile/dist/www.bundle/*.js`.
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
