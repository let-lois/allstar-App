/**
 * Nav glyphs as inline SVG — no icon-font request, no layout shift, and they
 * scale with the OS text-size setting.
 */
const base = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export const IconToday = () => (
  <svg {...base}>
    <path d="M4 5.5A1.5 1.5 0 015.5 4h13A1.5 1.5 0 0120 5.5v13a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18.5z" />
    <path d="M4 9h16M8.5 4v3M15.5 4v3" />
    <path d="M8 13.5l2.4 2.4L16 12" />
  </svg>
)

export const IconMap = () => (
  <svg {...base}>
    <path d="M9 4L4 6v14l5-2 6 2 5-2V4l-5 2-6-2z" />
    <path d="M9 4v14M15 6v14" />
  </svg>
)

export const IconLeads = () => (
  <svg {...base}>
    <path d="M4 10.5L12 4l8 6.5V20a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1z" />
  </svg>
)

export const IconPipeline = () => (
  <svg {...base}>
    <path d="M4 6h16M6 12h12M9 18h6" />
  </svg>
)

export const IconMore = () => (
  <svg {...base}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </svg>
)

export const IconPhone = () => (
  <svg {...base}>
    <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 006 6l1.5-2 4 1.5v3a2 2 0 01-2.2 2A16.5 16.5 0 014.5 5.7 2 2 0 016.5 3.5z" />
  </svg>
)

export const IconMessage = () => (
  <svg {...base}>
    <path d="M20 12a7 7 0 01-7 7H9l-4 2 1-4a7 7 0 1114-5z" />
  </svg>
)

export const IconNavigate = () => (
  <svg {...base}>
    <path d="M12 2l8 19-8-5-8 5z" />
  </svg>
)

export const IconCamera = () => (
  <svg {...base}>
    <path d="M3 8.5A1.5 1.5 0 014.5 7h2.2l1.3-2h7l1.3 2h2.2A1.5 1.5 0 0120 8.5v9A1.5 1.5 0 0118.5 19h-13A1.5 1.5 0 014 17.5z" />
    <circle cx="12" cy="13" r="3.4" />
  </svg>
)

export const IconNote = () => (
  <svg {...base}>
    <path d="M6 3.5h8l4 4v13H6z" />
    <path d="M14 3.5v4h4M9 12h6M9 16h4" />
  </svg>
)

export const IconCalendar = () => (
  <svg {...base}>
    <rect x="4" y="5" width="16" height="15" rx="1.5" />
    <path d="M4 9.5h16M8.5 3.5v3M15.5 3.5v3" />
  </svg>
)

export const IconPlus = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

/** Upload: a sheet with an arrow going into it. Used for the CSV import. */
export const IconUpload = () => (
  <svg {...base}>
    <path d="M12 15V4M8.5 7.5 12 4l3.5 3.5" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
)

export const IconChevron = () => (
  <svg {...base} width={20} height={20}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)

export const IconBack = () => (
  <svg {...base}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
)

export const IconClose = () => (
  <svg {...base}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export const IconLocate = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    <circle cx="12" cy="12" r="8" />
  </svg>
)

export const IconSearch = () => (
  <svg {...base}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </svg>
)

export const IconMic = () => (
  <svg {...base}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3" />
  </svg>
)

export const IconRoute = () => (
  <svg {...base}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="18" r="2.5" />
    <path d="M6 8.5v4a3 3 0 003 3h6a3 3 0 003-3v-1" />
  </svg>
)

/**
 * Log out: a solid arrow leaving a room through the wall it opens.
 *
 * Drawn to the shape people already know from lift signs and exit doors — a
 * filled arrowhead crossing a boundary — rather than the thin outlined door
 * that was here before. On a 24px glyph in sunlight a 1.9px outline of a door
 * reads as a rectangle with some marks in it; a filled head reads as an arrow
 * at a glance, which is the whole job.
 *
 * The arrow points left because that is the direction of travel in every
 * left-to-right interface: back out, away, done. Pointing it right would be the
 * international sign for *entering*.
 */
export const IconSignOut = () => (
  <svg {...base} strokeWidth={2}>
    {/* The room, open on the side the arrow leaves through. */}
    <path d="M13.5 4.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4.5" />
    {/* The shaft, stopping short so the filled head sits on the end of it. */}
    <path d="M13 12H6.5" />
    <path d="M9 8.5 4.5 12 9 15.5z" fill="currentColor" stroke="currentColor" strokeLinejoin="round" />
  </svg>
)

/* ==========================================================================
 * Theme
 *
 * Three states, three shapes — sun, moon, phone — so the chosen one is found
 * by silhouette rather than by reading. They replace `☀`, `☾` and a literal
 * capital `A`, which were text characters standing in for icons: they took
 * whatever the system font gave them, sat on the text baseline rather than
 * centred in their target, and the `A` needed its own accessible name to mean
 * anything at all.
 * ======================================================================= */

export const IconSun = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" />
  </svg>
)

export const IconMoon = () => (
  <svg {...base}>
    {/* A crescent as one closed path, not a disc with a disc cut out of it: a
        cut-out needs a mask or an even-odd fill, and both render as a filled
        circle wherever that is not honoured. */}
    <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />
  </svg>
)

/** Follow the phone — the device itself, which is what the setting defers to. */
export const IconDevice = () => (
  <svg {...base}>
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M10.5 5.5h3" />
  </svg>
)

/* ==========================================================================
 * Controls
 * ======================================================================= */

/** Filters — sliders, the shape that means "narrow this" rather than a funnel. */
export const IconFilter = () => (
  <svg {...base}>
    <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h10M18 17h2" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="16" cy="17" r="2" />
  </svg>
)

/** A list of things, distinct from `IconPipeline`'s narrowing stack. */
export const IconList = () => (
  <svg {...base}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.6" cy="6" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="4.6" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="4.6" cy="18" r="1.3" fill="currentColor" stroke="none" />
  </svg>
)

export const IconSettings = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M3.6 7.2l2.6 1.5M17.8 15.3l2.6 1.5M3.6 16.8l2.6-1.5M17.8 8.7l2.6-1.5" />
  </svg>
)

export const IconPencil = () => (
  <svg {...base}>
    <path d="M4 20h4l10.5-10.5a2.1 2.1 0 00-3-3L5 17z" />
    <path d="M14.5 5.5l4 4" />
  </svg>
)

export const IconPlay = () => (
  <svg {...base}>
    <path d="M7 4.8l12 7.2-12 7.2z" fill="currentColor" stroke="currentColor" />
  </svg>
)

export const IconCheck = () => (
  <svg {...base} strokeWidth={2.2}>
    <path d="M4.5 12.5l5 5 10-11" />
  </svg>
)

export const IconRefresh = () => (
  <svg {...base}>
    <path d="M20 12a8 8 0 10-3 6.2" />
    <path d="M20 5.5V12h-6" />
  </svg>
)

export const IconStar = () => (
  <svg {...base}>
    <path d="M12 3.5l2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 17.4l-5.4 2.9 1.1-6.1L3.2 9.9l6.1-.8z" />
  </svg>
)

export const IconArrowUp = () => (
  <svg {...base}>
    <path d="M12 19.5V5M6 11l6-6 6 6" />
  </svg>
)

export const IconArrowDown = () => (
  <svg {...base}>
    <path d="M12 4.5V19M6 13l6 6 6-6" />
  </svg>
)

/** A hazard, for a warning that is worth interrupting somebody for. */
export const IconWarn = () => (
  <svg {...base}>
    <path d="M12 3.5l9 15.5H3z" />
    <path d="M12 9.5v4.2" />
    <circle cx="12" cy="16.4" r="1.05" fill="currentColor" stroke="none" />
  </svg>
)

/* ==========================================================================
 * Award badges and photo categories
 *
 * These replace 🏆 🔥 💰 📅 and 🏠 🧱 ⚠ 🛋 📄 — real emoji, rendered by the
 * OS at whatever size and in whatever house style it likes, which is the one
 * kind of graphic this app cannot theme, size or measure. Same 24px grid and
 * `currentColor` as every other icon here, so they take the tone of whatever
 * they sit in.
 * ======================================================================= */

export const IconTrophy = () => (
  <svg {...base}>
    <path d="M8 4h8v4.5a4 4 0 01-8 0z" />
    <path d="M8 5.5H5.5V8a3 3 0 003 3M16 5.5h2.5V8a3 3 0 01-3 3" />
    <path d="M12 12.5V16M9 20h6M10 16h4l.5 4h-5z" />
  </svg>
)

export const IconFlame = () => (
  <svg {...base}>
    <path d="M12 3s4.5 3.7 4.5 8a4.5 4.5 0 01-9 0c0-1.6.7-3 1.5-4 .2 1.4.9 2.2 1.8 2.2 1 0 1.4-.9 1.2-2.2A9 9 0 0012 3z" />
    <path d="M7.5 13.5a4.5 4.5 0 009 0" />
  </svg>
)

/** Money as a banknote — a coin at 24px is a circle with marks in it. */
export const IconMoney = () => (
  <svg {...base}>
    <rect x="2.8" y="6.5" width="18.4" height="11" rx="1.8" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M6 12h.01M18 12h.01" />
  </svg>
)

export const IconRoof = () => (
  <svg {...base}>
    <path d="M2.8 11.5L12 4.5l9.2 7" />
    <path d="M5.5 13v7h13v-7" />
    <path d="M5.5 16.5h13M12 13v7" />
  </svg>
)

export const IconSofa = () => (
  <svg {...base}>
    <path d="M5 11V8.5A2.5 2.5 0 017.5 6h9A2.5 2.5 0 0119 8.5V11" />
    <path d="M3.5 12.5a1.8 1.8 0 013.6 0V15h9.8v-2.5a1.8 1.8 0 013.6 0V18H3.5z" />
  </svg>
)

export const IconDoc = () => (
  <svg {...base}>
    <path d="M6 3.5h7L18.5 9v11.5a1 1 0 01-1 1h-11a1 1 0 01-1-1v-16a1 1 0 011-1z" />
    <path d="M13 3.5V9h5.5M8.5 13h7M8.5 17h5" />
  </svg>
)

/* ==========================================================================
 * Outcomes
 *
 * The last characters in this app that were doing an icon's job: ★ ↻ ◷ $ ✕ ✓
 * ⊘ and an em dash, on the eight buttons a rep presses at a door. They were a
 * deliberate set rather than emoji, which is why they outlived the rest — but
 * they are still text, and the two that matter most are the two that suffer
 * most: at 15px in a pill, `✓` and `✕` are a tick and a cross in whatever
 * shape the system font has, and `◷` is a circle with a line in it.
 *
 * Reused where the meaning already has an icon — a star is interest, a loop is
 * a follow-up, a calendar is an appointment, a banknote is a quote, a cross is
 * a refusal, a tick is a sale. Only two are new.
 * ======================================================================= */

/**
 * Nobody answered.
 *
 * A door, not a dash. The em dash said "nothing happened", which is true of a
 * blank row and not of this: somebody walked to a house and knocked. It is the
 * most-pressed button on the outcome grid, and it deserves a shape rather than
 * a piece of punctuation.
 */
export const IconDoor = () => (
  <svg {...base}>
    <path d="M6 3.5h12v17H6z" />
    <path d="M4.5 20.5h15" />
    <circle cx="14.5" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </svg>
)

/** Do not contact — the international "no", which needs no gloss anywhere. */
export const IconBan = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M6 18L18 6" />
  </svg>
)
