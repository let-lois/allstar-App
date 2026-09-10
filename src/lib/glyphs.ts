/**
 * Named glyphs, for data that has to say *which* icon without importing one.
 *
 * `data/outcomes.ts` and `data/leaderboard.ts` are plain data modules — no
 * JSX, and imported directly by the no-browser gates through Node's type
 * stripping, which cannot load a `.tsx`. So they name an icon and the
 * rendering component looks it up. The union is here rather than beside the
 * map for the same reason: a type-only import would be erased, but the union
 * is also worth having somewhere a data file can reach without ceremony.
 *
 * Only for glyphs a data row picks. Chrome that always shows the same icon
 * imports it directly.
 */
export type GlyphName =
  | 'trophy'
  | 'flame'
  | 'money'
  | 'calendar'
  | 'house'
  | 'roof'
  | 'warn'
  | 'sofa'
  | 'doc'
