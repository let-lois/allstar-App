import type { GlyphName } from '../../lib/glyphs'
import {
  IconCalendar,
  IconDoc,
  IconFlame,
  IconLeads,
  IconMoney,
  IconRoof,
  IconSofa,
  IconTrophy,
  IconWarn,
} from '../nav/icons'

/**
 * The icon a data row asked for, by name.
 *
 * This exists because the rows it serves used to carry emoji — 🏆 🔥 💰 📅 for
 * the award badges, 🏠 🧱 ⚠ 🛋 📄 for photo categories. An emoji is the one
 * graphic in this app that cannot be themed, sized or measured: the OS picks
 * the artwork, it ignores `currentColor`, it sits on the text baseline rather
 * than centred in its target, and it renders in a different house style on
 * every handset the team owns. These are the same 24px stroke icons as the
 * rest of the interface and inherit the colour of whatever they sit in.
 *
 * `IconLeads` doubles as the house: it is already a house, and a second one
 * drawn slightly differently is how an icon set stops looking like a set.
 */
const MAP: Record<GlyphName, () => React.JSX.Element> = {
  trophy: IconTrophy,
  flame: IconFlame,
  money: IconMoney,
  calendar: IconCalendar,
  house: IconLeads,
  roof: IconRoof,
  warn: IconWarn,
  sofa: IconSofa,
  doc: IconDoc,
}

export function Glyph({ name, className = '' }: { name: GlyphName; className?: string }) {
  const Icon = MAP[name]
  if (!Icon) return null
  // `aria-hidden` on the wrapper: every caller pairs one of these with its own
  // label, and an icon announced twice is worse than one announced once.
  return (
    <span aria-hidden className={`inline-grid place-items-center ${className}`}>
      <Icon />
    </span>
  )
}
