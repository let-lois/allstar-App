import { API_URL } from './api-url'

/**
 * Where Help opens: the All Star Help site.
 *
 * One address for every Help control in the app, so the header's question
 * mark, the More screen and the sign-in screen can never point at three
 * different places. `VITE_HELP_URL` (read as `EXPO_PUBLIC_HELP_URL`, like every
 * build setting — see src/vite-env.d.ts) points it at a dedicated help site when
 * there is one; until then it is the support page the API serves, which
 * carries the FAQs and the support contact.
 */
export const HELP_URL: string = process.env.EXPO_PUBLIC_HELP_URL?.trim() || `${API_URL}/support`
