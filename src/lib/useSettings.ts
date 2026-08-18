import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  effectiveNoteTemplates,
  effectiveOutcomes,
  effectivePhotoCategories,
} from './settings'

/**
 * The company's configuration, merged over the defaults.
 *
 * Hooks rather than direct imports of the constants, because a setting that
 * saves but changes nothing on the phone is worse than one that says it is
 * disabled — it looks like it worked.
 */

export function useOutcomes() {
  const settings = useAppStore((s) => s.settings)
  return useMemo(() => effectiveOutcomes(settings), [settings])
}

export function useNoteTemplates() {
  const settings = useAppStore((s) => s.settings)
  return useMemo(() => effectiveNoteTemplates(settings), [settings])
}

export function usePhotoCategories() {
  const settings = useAppStore((s) => s.settings)
  return useMemo(() => effectivePhotoCategories(settings), [settings])
}
