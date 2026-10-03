/**
 * Voice-to-text for notes. Typing a paragraph on a phone while standing on
 * someone's porch is the single slowest thing a rep does, so dictation is a
 * first-class input, not a nicety.
 *
 * Two things make the browser API hard to use in the field, and both are
 * handled here rather than in the UI:
 *
 *  1. Mobile engines end a session aggressively — after a pause, after a few
 *     seconds of silence, sometimes immediately. Left alone, the rep taps the
 *     mic, says nothing for a beat, and dictation is silently over. So we
 *     restart until the rep actually stops.
 *  2. Failures are varied and mostly actionable (mic blocked, no connection,
 *     no mic). They must reach the rep as words, not as a dead button.
 */

import type { ShellBridge, ShellDictationEvent } from './external'
import { isNativeShell } from './webview'

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySpeechRecognition = any

function ctor(): AnySpeechRecognition | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as AnySpeechRecognition | null
}

function nativeDictation(): ShellBridge['dictation'] | undefined {
  return typeof window !== 'undefined' ? window.__allstarShell?.dictation : undefined
}

/**
 * Which dictation this page can actually do.
 *
 * - `native`: inside the phone app, through the phone's own recogniser.
 * - `web`: a browser with the Web Speech API.
 * - `keyboard`: inside an app build without the native recogniser. Reported
 *   from an iPhone: the webview's `webkitSpeechRecognition` exists, asks for
 *   the microphone, says "Listening" — and never delivers a word, because iOS
 *   does not return speech results to a web page inside an app. So it is not
 *   offered there; the keyboard's own mic key is, and it does work.
 * - `none`: nothing at all.
 */
export type DictationMode = 'native' | 'web' | 'keyboard' | 'none'

export function dictationMode(): DictationMode {
  if (nativeDictation()) return 'native'
  if (isNativeShell()) return 'keyboard'
  return ctor() ? 'web' : 'none'
}

/** Whether to show the mic at all. In `keyboard` mode it shows, and explains. */
export function speechSupported(): boolean {
  return dictationMode() !== 'none'
}

export type DictationError =
  | 'blocked'
  | 'no-mic'
  | 'offline'
  | 'unavailable'
  | 'unknown'

export interface Dictation {
  stop: () => void
}

/** Engine error codes → what actually went wrong, from the rep's point of view. */
function classify(code: string): DictationError {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'blocked'
    case 'audio-capture':
      return 'no-mic'
    case 'network':
      return 'offline'
    case 'language-not-supported':
    case 'bad-grammar':
      return 'unavailable'
    default:
      return 'unknown'
  }
}

/** How many auto-restarts before we assume the engine isn't going to cooperate. */
const MAX_RESTARTS = 30

/*
  Dictation through the phone app's own recogniser.

  The same contract as the browser path below: `onInterim` with the words not
  yet settled, `onFinal` with everything settled so far, and a restart when
  the recogniser ends a session on its own (a pause, the end of an utterance)
  until the rep taps stop. Results arrive as `allstar-dictation` events posted
  by the shell; each one carries the transcript of the current utterance.
*/
function dictateNative(
  native: NonNullable<ShellBridge['dictation']>,
  opts: {
    onInterim: (text: string) => void
    onFinal: (text: string) => void
    onError: (error: DictationError) => void
    onStop: () => void
  },
): Dictation {
  const lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US'
  let finished = false
  let restarts = 0
  let committed = ''
  let current = ''

  const cleanup = () => window.removeEventListener('allstar-dictation', onEvent as EventListener)
  const finish = () => {
    if (finished) return
    finished = true
    cleanup()
    opts.onStop()
  }
  const fail = (code: string) => {
    if (finished) return
    opts.onError(classify(code))
    void native.stop().catch(() => {})
    finish()
  }
  const start = () =>
    native
      .start({ lang })
      .then((r) => {
        if (!r?.ok) fail(r?.error ?? 'unknown')
      })
      .catch(() => fail('unknown'))

  function onEvent(e: CustomEvent<ShellDictationEvent>) {
    const ev = e.detail
    if (finished || !ev) return
    if (ev.type === 'result') {
      const text = ev.transcript.trim()
      if (text) restarts = 0
      if (ev.isFinal) {
        if (text) committed = `${committed}${text} `
        current = ''
        opts.onInterim('')
      } else {
        current = text
        opts.onInterim(current)
      }
      const full = committed.trim()
      if (full) opts.onFinal(full)
    } else if (ev.type === 'error') {
      if (ev.error === 'no-speech' || ev.error === 'aborted') return
      fail(ev.error)
    } else if (ev.type === 'end') {
      // An utterance left unfinished when the session ended is still the rep's words.
      if (current) {
        committed = `${committed}${current} `
        current = ''
        opts.onInterim('')
        opts.onFinal(committed.trim())
      }
      if (restarts >= MAX_RESTARTS) {
        finish()
        return
      }
      restarts += 1
      window.setTimeout(() => {
        if (!finished) void start()
      }, 250)
    }
  }

  window.addEventListener('allstar-dictation', onEvent as EventListener)
  void start()
  return {
    stop: () => {
      if (finished) return
      if (current) {
        committed = `${committed}${current} `
        opts.onFinal(committed.trim())
      }
      void native.stop().catch(() => {})
      finish()
    },
  }
}

export function dictate(opts: {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onError: (error: DictationError) => void
  /** Fired once, when dictation is genuinely over. */
  onStop: () => void
}): Dictation | null {
  const native = nativeDictation()
  if (native) return dictateNative(native, opts)
  // Inside an app without the native recogniser the web API starts and never
  // answers — see `dictationMode`. The composer offers the keyboard instead.
  if (isNativeShell()) return null
  const Rec = ctor()
  if (!Rec) return null

  const rec = new Rec()
  rec.lang = navigator.language || 'en-US'
  rec.interimResults = true

  /**
   * Single-utterance mode, deliberately.
   *
   * `continuous = true` works on desktop and silently produces nothing on
   * mobile — the engine accepts the flag and never emits a result, which is the
   * worst possible failure for a rep who just held the phone up and talked. So
   * we run one utterance at a time and stitch sessions together in `onend`,
   * which behaves the same on desktop and actually works on a phone.
   */
  rec.continuous = false

  /** Set when the rep taps stop, or when we hit an unrecoverable error. */
  let finished = false
  let restarts = 0
  let restartTimer: number | undefined
  /** Text from utterances that have already ended. */
  let committed = ''
  /** Finalized text within the current utterance. */
  let sessionFinal = ''

  const finish = () => {
    if (finished) return
    finished = true
    window.clearTimeout(restartTimer)
    opts.onStop()
  }

  rec.onresult = (event: any) => {
    // Rebuild the whole utterance each time rather than appending. `onresult`
    // fires repeatedly with the same indexes as confidence firms up, so
    // appending duplicates words — which reads as a stutter in the note.
    let interim = ''
    let final = ''
    for (let i = 0; i < event.results.length; i++) {
      const res = event.results[i]
      if (res.isFinal) final += `${res[0].transcript.trim()} `
      else interim += res[0].transcript
    }
    sessionFinal = final
    // A result means the engine is alive — reset the cap, or a long dictation
    // with natural pauses would eventually be cut off mid-sentence.
    if (final || interim) restarts = 0
    opts.onInterim(interim)
    const full = `${committed}${sessionFinal}`.trim()
    if (full) opts.onFinal(full)
  }

  rec.onerror = (event: any) => {
    const code = String(event?.error ?? 'unknown')
    // Normal on mobile: the engine heard nothing yet, or is cycling a session.
    // `onend` will restart us; surfacing these would be crying wolf.
    if (code === 'no-speech' || code === 'aborted') return
    finished = true
    window.clearTimeout(restartTimer)
    opts.onError(classify(code))
    opts.onStop()
  }

  rec.onend = () => {
    if (finished) return
    // Bank the finished utterance before the next session resets the indexes.
    committed = `${committed}${sessionFinal}`
    sessionFinal = ''
    if (restarts >= MAX_RESTARTS) {
      finish()
      return
    }
    restarts += 1
    // Restarting synchronously inside onend throws InvalidStateError on most
    // engines — let the current session tear down first.
    restartTimer = window.setTimeout(() => {
      if (finished) return
      try {
        rec.start()
      } catch {
        finish()
      }
    }, 250)
  }

  try {
    rec.start()
  } catch {
    opts.onError('unknown')
    return null
  }

  return {
    stop: () => {
      finished = true
      window.clearTimeout(restartTimer)
      try {
        rec.stop()
      } catch {
        /* already stopped */
      }
      opts.onStop()
    },
  }
}
