import { useEffect, useRef, useState } from 'react'
import type { NoteTag } from '../../types'
import { NOTE_TAGS, NOTE_TEMPLATES } from '../../data/outcomes'
import { Chip } from '../ui/Chip'
import { dictate, speechSupported, type Dictation } from '../../lib/speech'
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
export function NoteComposer({ body, tags, onBody, onTags, placeholder }: Props) {
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const dictation = useRef<Dictation | null>(null)
  const baseText = useRef('')
  const supported = speechSupported()

  useEffect(() => () => dictation.current?.stop(), [])

  const toggleDictation = () => {
    if (listening) {
      dictation.current?.stop()
      dictation.current = null
      setListening(false)
      setInterim('')
      return
    }
    baseText.current = body ? `${body.trim()} ` : ''
    const d = dictate({
      onInterim: setInterim,
      onFinal: (text) => onBody(`${baseText.current}${text}`),
      onEnd: () => {
        setListening(false)
        setInterim('')
        dictation.current = null
      },
    })
    if (d) {
      dictation.current = d
      setListening(true)
      haptic('tap')
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
          {NOTE_TEMPLATES.map((t) => (
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
