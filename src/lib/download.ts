import { isNativeShell } from './webview'

/**
 * The device has no way to take a file from inside the app.
 *
 * Thrown only in the phone app, where `<a download>` does nothing and the
 * share sheet is the one road out — and only when that sheet cannot carry a
 * file either (an older WebView, or one that has no Web Share at all). The
 * callers turn it into a sentence; it is never swallowed, because the failure
 * it replaces was silence: a button that did nothing.
 */
export class FileSaveUnsupported extends Error {
  constructor() {
    super('This phone cannot save files from inside the app yet. Open the console on a computer to download it.')
    this.name = 'FileSaveUnsupported'
  }
}

/**
 * Hand a blob to the person — as a download in a browser, through the share
 * sheet in the phone app.
 *
 * Three copies of the download half existed, and they were not equivalent.
 * The one on the reports screen neither put the anchor in the document nor
 * waited before revoking the object URL — and Safari starts the download
 * *after* `click()` returns, so it was handed a URL that no longer existed.
 * So: in the document, clicked, removed, and the URL revoked on a later tick.
 *
 * `<a download>` with a `blob:` URL is unreliable to non-functional inside a
 * WebView — Android needs the host to implement a download listener and does
 * not hand it blob URLs at all, and iOS ignores the attribute in most
 * configurations. The failure is silent: no file, no error, nothing to catch.
 * That did not matter while every caller was a console screen the phone did
 * not bundle. It does now that the console is in the phone app, so inside the
 * shell the file goes to the share sheet instead — on iOS that is where Save
 * to Files and Save Image live — and where the sheet cannot take a file this
 * says so rather than doing nothing.
 *
 * A dismissed share sheet is the person changing their mind, not an error; it
 * resolves as shared and the caller says nothing.
 */
export async function saveFile(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  if (isNativeShell()) {
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
    if (typeof nav.share !== 'function' || !nav.canShare?.({ files: [file] })) throw new FileSaveUnsupported()
    try {
      await nav.share({ files: [file], title: filename })
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) throw err
    }
    return 'shared'
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'downloaded'
}
