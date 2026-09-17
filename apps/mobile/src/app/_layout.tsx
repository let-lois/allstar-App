/**
 * A stack with no chrome.
 *
 * The template shipped native tabs, and they are the right default for an app
 * whose navigation is native. This one's navigation is not, yet: the web app
 * inside the DOM shell has its own tab bar, its own headers and its own back
 * behaviour, and a second native tab bar underneath it would be two sets of
 * controls disagreeing about where the user is.
 *
 * So the native layer is deliberately empty for now — one full-bleed screen.
 * Tabs come back in the same commit as the first nativized screen, at which
 * point they are navigating between native routes and mean something.
 */
import { Stack, DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useColorScheme } from 'react-native'

import { AnimatedSplashOverlay } from '@/components/animated-icon'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const colorScheme = useColorScheme()
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  )
}
