import { OUTCOMES, NOTE_TEMPLATES, PHOTO_CATEGORIES } from '../data/outcomes'
import type { OutcomeDef, PhotoCategory } from '../types'

/**
 * Company customisation, merged over the defaults.
 *
 * The rule the whole thing rests on: **codes are structural, labels are not.**
 * `sold` and `no_answer` are keys that reporting, pipeline stages and a year of
 * history depend on. Renaming "Quote requested" to "Estimate requested" changes
 * a word on a button and must change nothing else.
 *
 * So an override can only supply a label and a position. Everything that carries
 * meaning — the code, the tone, the glyph, whether an outcome prompts for a
 * follow-up — stays in the source and cannot be edited away. An outcome the
 * server has never heard of is ignored rather than rendered, because a phone
 * that boots to a broken outcome grid is a rep who cannot record anything.
 */

export interface ClientSettings {
  outcomes?: { code: string; label?: string; order?: number }[]
  noteTemplates?: string[]
  photoCategories?: { key: string; label?: string }[]
}

export function effectiveOutcomes(settings: ClientSettings | null | undefined): OutcomeDef[] {
  const overrides = settings?.outcomes
  if (!overrides?.length) return OUTCOMES

  const byCode = new Map(overrides.map((o) => [o.code, o]))
  return [...OUTCOMES]
    .map((base) => {
      const o = byCode.get(base.code)
      return {
        // Spread the default first so nothing structural can be overwritten,
        // whatever the stored blob happens to contain.
        ...base,
        label: o?.label?.trim() || base.label,
        _order: o?.order ?? Number.MAX_SAFE_INTEGER,
      }
    })
    .sort((a, b) => a._order - b._order)
    .map(({ _order, ...rest }) => rest as OutcomeDef)
}

export function effectiveNoteTemplates(settings: ClientSettings | null | undefined): string[] {
  const t = settings?.noteTemplates
  return t?.length ? t : NOTE_TEMPLATES
}

export function effectivePhotoCategories(
  settings: ClientSettings | null | undefined,
): { key: PhotoCategory; label: string; glyph: string }[] {
  const overrides = settings?.photoCategories
  if (!overrides?.length) return PHOTO_CATEGORIES
  const byKey = new Map(overrides.map((c) => [c.key, c]))
  return PHOTO_CATEGORIES.map((base) => ({
    ...base,
    label: byKey.get(base.key)?.label?.trim() || base.label,
  }))
}
