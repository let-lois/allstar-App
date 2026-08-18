import { useEffect, useRef, useState } from 'react'
import type { NoteTag } from '../../types'
import { NOTE_TAGS } from '../../data/outcomes'
import { useNoteTemplates } from '../../lib/useSettings'
import { Chip } from '../ui/Chip'
import {
  dictate,
  speechSupported,
  type Dictation,
  type DictationError,
} from '../../lib/speech'
import { haptic } from '../../lib/haptics'
import { IconMic } from '../nav/icons'

interface Props {
  body: string
  tags: NoteTag[]
  onBody: (v: string) => void
  onTags: (v: NoteTag[]) => void
  placeholder?: string
}

/**
 * Note input built to avoid the keyboard entirely when possible.
 *
 * Ranked by speed: one-tap templates → one-tap tags → dictation → typing.
 * The keyboard is the last resort, not the default, because typing a sentence
 * on a porch takes twenty seconds a rep does not have.
 */
/**
 * Dictation failures are almost all actionable, so each one gets told to the rep
 * in plain words with the next thing to try. Every phone keyboard has its own
 * mic key, which is the reliable escape hatch when the browser API won't play.
 */
const ERROR_COPY: Record<DictationError, string> = {
  blocked:
    'Microphone access is blocked. Allow it in your browser settings, or use the mic key on your keyboard.',
  'no-mic': 'No microphone found on this device.',
  offline: 'Dictation needs a connection. Use a quick note above, or type.',
  unavailable:
    'Dictation isn’t available in this browser. Use the mic key on your keyboard instead.',
  unknown:
    'Dictation stopped. Try again, or use the mic key on your keyboard.',
}

export function NoteComposer({ body, tags, onBody, onTags, placeholder }: Props) {
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<DictationError | null>(null)
  const dictation = useRef<Dictation | null>(null)
  const baseText = useRef('')
  const supported = speechSupported()
  const templates = useNoteTemplates()

  useEffect(() => () => dictation.current?.stop(), [])

  const toggleDictation = () => {
    if (listening) {
      dictation.current?.stop()
      dictation.current = null
      return
    }
    setError(null)
    baseText.current = body ? `${body.trim()} ` : ''
    const d = dictate({
      onInterim: setInterim,
      onFinal: (text) => onBody(`${baseText.current}${text}`),
      onError: setError,
      onStop: () => {
        setListening(false)
        setInterim('')
        dictation.current = null
      },
    })
    if (d) {
      dictation.current = d
      setListening(true)
      haptic('tap')
    } else {
      // Constructed but refused to start — don't leave a dead button.
      setError((e) => e ?? 'unknown')
    }
  }

  const appendTemplate = (t: string) => {
    haptic('tap')
    onBody(body.trim() ? `${body.trim()}. ${t}` : t)
  }

  const toggleTag = (tag: NoteTag) => {
    haptic('tap')
    onTags(tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag])
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-mute">
          Quick notes
        </p>
        <div className="snap-x-row -mx-1 px-1 pb-1">
          {templates.map((t) => (
            <Chip key={t} size="sm" onClick={() => appendTemplate(t)}>
              {t}
            </Chip>
          ))}
        </div>
      </div>

      <div className="relative">
        <textarea
          value={listening && interim ? `${body} ${interim}`.trim() : body}
          onChange={(e) => onBody(e.target.value)}
          rows={4}
          placeholder={placeholder ?? 'Tap a quick note above, dictate, or type…'}
          className="focusable w-full resize-none rounded-2xl border border-slate-200 p-3 pr-14 text-base leading-relaxed placeholder:text-slate-400"
        />
        {supported && (
          <button
            onClick={toggleDictation}
            aria-label={listening ? 'Stop dictation' : 'Dictate note'}
            aria-pressed={listening}
            className={`press focusable absolute right-2.5 top-2.5 grid h-11 w-11 place-items-center rounded-xl ${
              listening ? 'bg-red-600 text-white' : 'bg-slate-100 text-ink-mute'
            }`}
          >
            {listening && (
              <span
                className="absolute inset-0 rounded-xl bg-red-500"
                style={{ animation: 'pulse-ring 1.4s ease-out infinite' }}
                aria-hidden
              />
            )}
            <span className="relative">
              <IconMic />
            </span>
          </button>
        )}
      </div>
      {listening && (
        <p className="-mt-1 text-xs font-medium text-red-600">Listening — speak now</p>
      )}
      {!listening && error && (
        <p className="-mt-1 rounded-lg bg-amber-50 px-2.5 py-2 text-xs font-medium leading-relaxed text-amber-800">
          {ERROR_COPY[error]}
        </p>
      )}

      <div>
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-mute">
          Tags
        </p>
        <div className="flex flex-wrap gap-2">
          {NOTE_TAGS.map(({ tag, label }) => (
            <Chip
              key={tag}
              size="sm"
              selected={tags.includes(tag)}
              onClick={() => toggleTag(tag)}
            >
              {label}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  )
}
