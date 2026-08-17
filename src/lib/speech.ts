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

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySpeechRecognition = any

function ctor(): AnySpeechRecognition | null {
  const w = window as unknown as Record<string, unknown>
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as AnySpeechRecognition | null
}

export function speechSupported(): boolean {
  return ctor() !== null
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

export function dictate(opts: {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onError: (error: DictationError) => void
  /** Fired once, when dictation is genuinely over. */
  onStop: () => void
}): Dictation | null {
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
