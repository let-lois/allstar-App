import { requireOptionalNativeModule } from 'expo'

/*
  Loaded only when this build has it.

  Builds 8 and 9 share a runtime version, so an over-the-air update made from
  this code reaches build 8 too — and build 8 has no speech module. Importing
  the package there would throw at launch (`requireNativeModule`) and take the
  whole app down with it. So the package is required only after the optional
  lookup finds its native half; on an older build `HAS_NATIVE_DICTATION` is
  false, no dictation props are passed, and the note composer offers the
  keyboard's mic instead.
*/
type SpeechModule = typeof import('expo-speech-recognition').ExpoSpeechRecognitionModule
const speech: SpeechModule | null = requireOptionalNativeModule('ExpoSpeechRecognition')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('expo-speech-recognition') as typeof import('expo-speech-recognition')).ExpoSpeechRecognitionModule
  : null

export const HAS_NATIVE_DICTATION = speech !== null

/**
 * Note dictation, through the phone's own speech recognition.
 *
 * The web app's dictation used the page's `webkitSpeechRecognition`. Inside
 * this app, on iOS, that starts — the microphone prompt appears and the note
 * says "Listening" — and then never returns a word: iOS does not deliver
 * speech results to a web page running inside an app. Reported from a phone
 * with the permissions granted. So the web app asks the shell instead
 * (`dictationStart` / `dictationStop` on `AllStarWeb`), and the shell runs
 * Apple's (or Android's) recogniser and posts each result back through the
 * DOM component's `dictationEvent` handle.
 *
 * Module-level functions, not closures: they are passed to the DOM component
 * as props, and a new identity on every render would re-send the props and
 * re-render the whole web app.
 */

export async function dictationStart(opts: { lang: string }): Promise<{ ok: boolean; error?: string }> {
  if (!speech) return { ok: false, error: 'service-not-allowed' }
  try {
    const perm = await speech.requestPermissionsAsync()
    if (!perm.granted) return { ok: false, error: 'not-allowed' }
    if (!speech.isRecognitionAvailable()) return { ok: false, error: 'service-not-allowed' }
    speech.start({
      lang: opts.lang || 'en-US',
      interimResults: true,
      // One long session where the platform allows it; the web side restarts
      // when the recogniser ends one on its own (iOS 18+ ends at each final).
      continuous: true,
      addsPunctuation: true,
    })
    return { ok: true }
  } catch {
    return { ok: false, error: 'unknown' }
  }
}

export async function dictationStop(): Promise<void> {
  try {
    speech?.stop()
  } catch {
    /* already stopped */
  }
}

export type DictationEvent =
  | { type: 'result'; transcript: string; isFinal: boolean }
  | { type: 'error'; error: string }
  | { type: 'end' }

/** Forward the recogniser's events to `send` until the returned function is called. */
export function forwardDictationEvents(send: (event: DictationEvent) => void): () => void {
  if (!speech) return () => {}
  const subs = [
    speech.addListener('result', (e) => {
      send({ type: 'result', transcript: e.results[0]?.transcript ?? '', isFinal: e.isFinal })
    }),
    speech.addListener('error', (e) => send({ type: 'error', error: e.error })),
    speech.addListener('end', () => send({ type: 'end' })),
  ]
  return () => subs.forEach((s) => s.remove())
}
