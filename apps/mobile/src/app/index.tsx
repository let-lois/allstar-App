/**
 * The app, as it exists today, on a phone.
 *
 * A route file cannot itself be a DOM component — `'use dom'` marks a whole
 * module as web code, and Expo Router needs this one to be native — so the
 * shell is imported rather than declared here. That split is the rule, not a
 * preference.
 */
import { StyleSheet, View } from 'react-native'

import AllStarWeb from '@/components/allstar-web'

export default function Index() {
  return (
    <View style={styles.fill}>
      <AllStarWeb
        dom={{
          /*
            The web app draws its own scrolling regions and its own safe-area
            padding — it is a mobile-first PWA that reps already run
            full-screen from the home screen. Letting the webview add a second
            scroll container on top gives the rubber-banding-inside-
            rubber-banding feel that makes a wrapped website obvious.
          */
          scrollEnabled: false,
          contentInsetAdjustmentBehavior: 'never',
          style: styles.fill,
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({ fill: { flex: 1 } })
