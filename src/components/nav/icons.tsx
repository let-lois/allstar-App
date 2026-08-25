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
