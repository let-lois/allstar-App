/**
 * The first screen, and for now the only real one.
 *
 * It exists to answer the question the whole monorepo rests on: can the native
 * app reach the domain? Everything below is read from `@allstar/core` — the
 * same module the web app and the admin console read — so if this renders on a
 * phone, the extraction worked and every screen after it can be built on the
 * same footing.
 *
 * It is a checkpoint, not a design. The real home screen is Today, and it is
 * the first thing to be nativized; see docs/MIGRATION_PROGRESS.md.
 */
import { ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { OUTCOMES, OUTCOME_TO_STATUS, STATUS_LABEL } from '@allstar/core/outcomes'
import { distanceMiles } from '@allstar/core/geo'
import { ThemedText } from '@/components/themed-text'
import { ThemedView } from '@/components/themed-view'
import { MaxContentWidth, Spacing } from '@/constants/theme'

/*
  An outcome names a code; the stage it moves a lead to is a separate table.
  Two of the eight (Skip and No Answer) move nothing, which is the distinction
  the help centre spends a paragraph on — so the screen has to say so too.
*/
const statusOf = (code: (typeof OUTCOMES)[number]['code']) => {
  const status = OUTCOME_TO_STATUS[code]
  return status ? STATUS_LABEL[status] : 'leaves the stage alone'
}

/* Two real coordinates, so the number below is arithmetic and not a constant. */
const A = { lat: 33.4484, lng: -112.074 }
const B = { lat: 33.4942, lng: -111.9261 }

export default function Index() {
  return (
    <ThemedView style={styles.fill}>
      <SafeAreaView style={styles.fill}>
        <ScrollView contentContainerStyle={styles.page}>
          <ThemedText type="title">All-Star</ThemedText>
          <ThemedText type="small">
            Native shell. Nothing here is the product yet.
          </ThemedText>

          <View style={styles.section}>
            <ThemedText type="smallBold">
              Outcomes, read from @allstar/core
            </ThemedText>
            {OUTCOMES.map((o) => (
              <ThemedText key={o.code} type="small">
                {o.label} → {statusOf(o.code)}
              </ThemedText>
            ))}
          </View>

          <View style={styles.section}>
            <ThemedText type="smallBold">Geography, same package</ThemedText>
            <ThemedText type="small">
              Phoenix to Scottsdale: {distanceMiles(A, B).toFixed(1)} miles
            </ThemedText>
          </View>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: {
    gap: Spacing.three,
    maxWidth: MaxContentWidth,
    padding: Spacing.four,
    width: '100%',
  },
  section: { gap: Spacing.one },
})
