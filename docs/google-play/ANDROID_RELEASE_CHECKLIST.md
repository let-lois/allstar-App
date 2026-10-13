# Android release checklist — Allstar Field

One pass per release. ✅ = done and verified in this repository on 2026-10-13;
☐ = still to do, with who does it.

## A. Code and configuration (repository)

- ✅ Package name `com.allstarhomesolutions.allstar` (matches iOS; permanent once uploaded)
- ✅ Version name `1.0.0`; version code managed by EAS, auto-incremented per production build
- ✅ Target SDK 36 / compile SDK 36 (Android 16), min SDK 24 (Android 7.0) — from React Native 0.86's version catalog, no override
- ✅ Production profile builds an **AAB** (`eas.json` → `build.production.android.buildType: app-bundle`)
- ✅ Production builds listen on the `production` EAS Update channel, runtime `exposdk:57.0.0`
- ✅ Store build hides testing aids (demo, "Simulate no signal"), webview inspector off — `verify:storebuild`, `verify:inspectable`
- ✅ Permissions reduced to location (while in use) and microphone; storage and overlay permissions stripped — `verify:android-release`
- ✅ `allowBackup=false`
- ✅ Adaptive icon (foreground, background, monochrome) and splash (light/dark) — `verify:store-assets`
- ✅ Edge-to-edge enabled (required at targetSdk 36); predictive back disabled pending device testing (`predictiveBackGestureEnabled: false`)
- ✅ No keystore, upload key or Play service-account key in git; patterns in `apps/mobile/.gitignore` — `verify:android-release`
- ✅ EAS Submit → internal track as draft (`eas.json`)
- ✅ Public account-deletion page `GET /delete-account` (live after merge) — `smoke:account-delete`
- ☐ Merge the Android release branch (Curtis/Sean approve) — deploys `/delete-account`

Checks to run before every Android build:

```bash
npm run verify:android-release   # Play-facing config
npm run verify:play-listing      # listing text and graphics limits
npm run verify:store-assets      # icon/splash alpha rules
npm run verify:webview-patch     # the Android webview bridge patch
npm run verify:shellandroid      # boots the exported bundle the way Android does
```

## B. Build

- ✅ First production AAB triggered on EAS: build `e3129f4a-ea0b-4a93-9f2e-490a72759823` (1.0.0, version code 2) — result recorded in `GOOGLE_PLAY_HANDOFF.md`
- ☐ Download a copy of the upload keystore from EAS into the company password manager (someone with Expo account access)
- For later releases:

  ```bash
  cd apps/mobile
  npx eas-cli build --platform android --profile production
  ```

## C. Play Console (Bea, after the account exists)

- ☐ Organization developer account verified (Company: D-U-N-S, legal name, address, website, contact, $25)
- ☐ Users and permissions: Bea, Sean, (later) the EAS service account
- ☐ Create app: Allstar Field, English (US), App, Free
- ☐ Play App Signing: Google-generated app-signing key; EAS keystore as upload key (set by the first upload)
- ☐ Internal testing release: upload the AAB by hand, release notes, testers, roll out
- ☐ App content: privacy policy, app access (reviewer login), ads (No), content rating, target audience (18+), data safety, government/financial/health (No), account deletion URL
- ☐ Main store listing: text from `PLAY_STORE_LISTING.md`, graphics from `assets/`
- ☐ Store settings: category Business, contact email
- ☐ Countries: United States (or as decided)
- ☐ EAS Submit service account created, invited, key uploaded to EAS (optional)

## D. Testing (see `ANDROID_TESTING_PLAN.md`)

- ☐ P0 tests A1–A14 pass on the Play-installed build across the device matrix
- ☐ Closed test with 12+ testers for 14 days — **only if** the Console shows the requirement (personal accounts)
- ☐ Android vitals clean for a week

## E. Production

- ☐ Company sign-off: store name, countries, date
- ☐ Promote the tested release to Production, staged rollout 20% → 50% → 100%
- ☐ Watch vitals and support mail at each step; halt if a P0 appears

## F. Every later release

1. Bump `version` in `apps/mobile/app.json` for a user-visible release (version code rises on its own).
2. Run the checks in A.
3. Build; submit with `npx eas-cli submit -p android --profile production --latest` (after the first manual upload).
4. Internal test → promote.
5. JavaScript-only fixes may go out as an EAS Update to `production` instead — only with explicit approval, since it reaches iOS and Android users at once.
