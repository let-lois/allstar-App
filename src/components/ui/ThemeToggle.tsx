import { useEffect, useState } from 'react'
import { apply, readChoice, resolve, saveChoice, watchSystem, type ThemeChoice } from '../../lib/theme'

/**
 * Light, dark, or whatever the phone says.
 *
 * A three-way segmented control rather than a switch. A switch can only say
 * light-or-dark, and the state people most want back after trying both is
 * "follow the phone" — which a switch cannot express once it has been touched.
 * Three small targets beat two plus a buried reset.
 *
 * It sits in the profile row rather than under a Settings heading because it is
 * a property of *this phone*, not of the account or the company: the same rep
 * signing in on a spare handset should get that handset's preference, and
 * nothing here is worth a round trip to a server.
 */

const OPTIONS: { value: ThemeChoice; label: string; glyph: string }[] = [
  { value: 'light', label: 'Light', glyph: '☀' },
  { value: 'dark', label: 'Dark', glyph: '☾' },
  { value: 'system', label: 'Follow the phone', glyph: 'A' },
]

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readChoice())

  /*
    Re-apply on mount rather than trusting the pre-paint snippet alone.

    The snippet sets the attribute before the bundle loads, which is the point of
    it — but a hot reload, or a route that remounts the shell, can leave the DOM
    out of step with what is stored. Applying once here costs nothing and makes
    the stored preference the single source of truth.
  */
  useEffect(() => {
    apply(choice)
  }, [choice])

  // Keep following the phone if that is what was asked for — see `watchSystem`.
  useEffect(() => watchSystem(() => setChoice((c) => c)), [])

  const applied = resolve(choice)

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      data-tour="theme-toggle"
      className="flex shrink-0 items-center rounded-pill border border-line bg-surface-field"
    >
      {OPTIONS.map((o) => {
        const selected = choice === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            /*
              The accessible name says what it does, not what it shows. "A" is a
              glyph for "automatic" and reads as the letter A to a screen reader,
              which is no use to anybody.
            */
            aria-label={
              o.value === 'system'
                ? `Follow the phone (currently ${applied})`
                : o.label
            }
            title={o.label}
            onClick={() => {
              saveChoice(o.value)
              setChoice(o.value)
            }}
            className={[
              /*
                44px, not the 32 this shipped with.

                Three small glyphs looked right and measured wrong: the viewport
                audit flagged them at every width against this project's own
                tap-target rule, and a rep changing theme outdoors in gloves is
                exactly who the rule is for. The pill's own padding shrank to
                keep the group from growing into the profile row beside it.
              */
              'focusable grid h-11 w-11 place-items-center rounded-full text-[15px] leading-none transition-colors',
              /*
                An opaque tile with an accent ring, not a hairline. On the light
                ground the old pairing was white on off-white with a grey ring —
                the weakest selected state in the app, on the control that
                switches the theme. Opaque rather than a tint: the group sits on
                the recessed field colour, and an accent glyph on a translucent
                tint over *that* measured 3.99:1 in the light theme. On the
                surface itself it is 4.75 light and 7.9 dark, and the ring is
                the shape half of the signal.
              */
              selected
                ? 'bg-surface text-accent ring-1 ring-accent'
                : 'text-ink-mute active:bg-surface',
            ].join(' ')}
          >
            <span aria-hidden>{o.glyph}</span>
          </button>
        )
      })}
    </div>
  )
}
