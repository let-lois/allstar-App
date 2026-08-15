/**
 * Voice-to-text for notes. Typing a paragraph on a phone while standing on
 * someone's porch is the single slowest thing a rep does, so dictation is a
 * first-class input, not a nicety.
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

export interface Dictation {
  stop: () => void
}

/**
 * Streams interim results so the rep sees words appear as they speak — silence
 * for two seconds reads as a broken feature and they give up and type.
 */
export function dictate(opts: {
  onInterim: (text: string) => void
  onFinal: (text: string) => void
  onEnd: (reason?: string) => void
}): Dictation | null {
  const Rec = ctor()
  if (!Rec) return null

  const rec = new Rec()
  rec.lang = navigator.language || 'en-US'
  rec.continuous = true
  rec.interimResults = true

  let finalText = ''

  rec.onresult = (event: any) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i]
      if (res.isFinal) finalText += res[0].transcript
      else interim += res[0].transcript
    }
    if (interim) opts.onInterim(interim)
    if (finalText) opts.onFinal(finalText.trim())
  }
  rec.onerror = (e: any) => opts.onEnd(e?.error ?? 'error')
  rec.onend = () => opts.onEnd()

  try {
    rec.start()
  } catch {
    return null
  }

  return {
    stop: () => {
      try {
        rec.stop()
      } catch {
        /* already stopped */
      }
    },
  }
}
