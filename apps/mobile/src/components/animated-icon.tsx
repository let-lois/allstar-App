import { Image } from 'expo-image'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { Easing, Keyframe } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'

/**
 * The gap between the system splash and the app being on screen.
 *
 * It is a real gap, and it is this app's own fault: the shell is a DOM
 * component, so the first frame is not a React Native view — it is a webview
 * parsing a megabyte of JavaScript from source. Hiding the system splash the
 * moment the native tree mounts would show a rep a blank white rectangle for
 * as long as that takes. So this overlay takes over from the splash, holds the
 * mark, and fades out, covering the webview's boot.
 *
 * `SplashScreen.hideAsync()` is called from this overlay's own `onLayout`
 * rather than from the layout route, so the handover happens on the frame the
 * overlay is actually drawn. Hiding it a frame early is the flash this exists
 * to prevent.
 *
 * ## What this used to show
 *
 * Expo's logo. Every file here came from the template and nobody had changed
 * the artwork: `splash-icon.png` was byte-identical to `expo-logo.png`, the
 * glow was Expo's, and the plate behind it was Expo's blue gradient. So the
 * All-Star app launched on somebody else's brand. The mark is generated from
 * `brand/` now by `scripts/make-brand-assets.py`, the same source the web
 * app's wordmark and PWA icons come from.
 *
 * The plate and the rotating glow went with it rather than being recoloured.
 * They were decoration around a logo that is already a solid tile, and a
 * 7200-degree rotation on the first thing a rep sees every morning is a
 * flourish that stops being charming on day two.
 */
const DURATION = 600

/**
 * How long after the fade begins the overlay is removed regardless.
 *
 * The fade normally reports back through `withCallback` and unmounts itself.
 * If it does not — a layout animation that never ran, a worklet callback that
 * never crossed back — the alternatives are a plate that never leaves, or an
 * invisible full-screen view at `zIndex: 1000` that swallows every tap over a
 * perfectly working app. A tester would report either as "the app is dead", and
 * neither can be told from the outside. So the overlay also leaves on a clock.
 * Generous enough that the animation finishing first is the normal case.
 */
const REMOVE_BY = DURATION + 400

/** Matches the `splash.backgroundColor` in app.json, and the app's own. */
const BACKDROP = '#f0f2f7'

export function AnimatedSplashOverlay() {
  const [animate, setAnimate] = useState(false)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (!animate) return
    const t = setTimeout(() => setVisible(false), REMOVE_BY)
    return () => clearTimeout(t)
  }, [animate])

  if (!visible) return null

  const splashKeyframe = new Keyframe({
    0: { transform: [{ scale: 1 }], opacity: 1 },
    20: { opacity: 1 },
    70: { opacity: 0, easing: Easing.elastic(0.7) },
    100: { opacity: 0, transform: [{ scale: 1 }], easing: Easing.elastic(0.7) },
  })

  const mark = <Image style={styles.mark} source={require('@/assets/images/splash-icon.png')} />

  return animate ? (
    /*
      Nothing behind this overlay should have to wait for it: from the moment
      the fade begins, touches go straight through to the app.
    */
    <Animated.View
      pointerEvents="none"
      entering={splashKeyframe.duration(DURATION).withCallback((finished) => {
        'worklet'
        if (finished) {
          scheduleOnRN(setVisible, false)
        }
      })}
      style={styles.splashOverlay}>
      {mark}
    </Animated.View>
  ) : (
    <View
      onLayout={() => {
        SplashScreen.hideAsync().finally(() => {
          setAnimate(true)
        })
      }}
      style={styles.splashOverlay}>
      {mark}
    </View>
  )
}

const styles = StyleSheet.create({
  /* Square, because the mark is. The old 76x71 was the Expo logo's aspect. */
  mark: {
    width: 96,
    height: 96,
  },
  splashOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: BACKDROP,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
})
