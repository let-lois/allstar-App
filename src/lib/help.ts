/**
 * Where Help opens: the All Star Help Center.
 *
 * One address for every Help control in the app, so the header's question
 * mark, the More screen and the sign-in screen can never point at three
 * different places. The privacy policy and terms of use live there too, at
 * `/privacy` and `/terms` — the App Store listing's Privacy Policy URL. `VITE_HELP_URL` (read as `EXPO_PUBLIC_HELP_URL`, like every
 * build setting — see src/vite-env.d.ts) can point a test build elsewhere. The
 * API's own /support page stays what it is — the App Store's support URL — and
 * is not what Help opens.
 */
export const HELP_URL: string = process.env.EXPO_PUBLIC_HELP_URL?.trim() || 'https://help.allstarhomesolutions.com'
