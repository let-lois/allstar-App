import { useEffect, useState } from 'react'

/**
 * Media query as state.
 *
 * Used sparingly — layout differences belong in CSS. This exists for the cases
 * where phone and tablet need genuinely *different components* (a bottom sheet
 * versus a side panel), not just different styling on the same markup.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** Tailwind `md` — tablet; room for a map plus a list beside it. */
export const useIsWide = () => useMediaQuery('(min-width: 768px)')

/** Tailwind `lg` — enough width for a list *and* a readable detail pane. */
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)')
