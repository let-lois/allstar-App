# Google Play handoff — Allstar Field

For Bea (Play Console), Sean and the company. Build and Console status updated
**2026-10-31**; the audit sections below are as of 2026-10-13.

## The short version

- The Android app **builds as a signed, Play-ready App Bundle**: EAS build
  `e3129f4a-ea0b-4a93-9f2e-490a72759823`, version **1.0.0 (version code 2)**,
  target SDK 36, min SDK 24, `BUILD SUCCESSFUL` with `:app:signReleaseBundle`,
  `app-release.aab` 73.0 MB.
  Download: <https://expo.dev/artifacts/eas/vZ4JFd2U1ttvv5xhtkPnMXP8fpQwkUD4bDFWv9xbrto.aab>
  (Expo dashboard → all-star-app → Builds; the link expires 2026-11-12).
- **Current build:** EAS build `a21ac854-d56c-44b7-a148-468f1f01bfd0`, 1.0.0
  (version code 3), built from `main` after the Android display fixes. It is
  uploaded to **Internal testing** (release 3, track Active). Download link
  expires 2026-11-15. Version 2 above is superseded.
- The Play app exists as a **draft** (temporary name "com.allstarhomesolutions.allstar
  (unreviewed)" until setup is complete). Testers can opt in, but the Play Store
  app answers "Item not found" for at least one account so far; until that clears,
  testers use the direct preview APK (`ANDROID_TESTING_PLAN.md`).
- The Console tasks, in order, with exact values: **`PLAY_CONSOLE_ENTRY_SHEET.md`**.
- Store listing text, icon, feature graphic and screenshots are ready in this folder.
- Data safety, content rating and app-access answers are written out in
  `GOOGLE_PLAY_COMPLIANCE_AUDIT.md`.
- **Not yet done, and not doable from here:** the Play Console account, the
  first upload, and testing on a real Android phone. Android has never been
  confirmed working on a physical device — that is the biggest risk left.

## Status board

| Area | Item | Status |
|---|---|---|
| Audit | Architecture, Android support, identifiers, permissions, SDK levels, integrations, assets | COMPLETE |
| Config | Package `com.allstarhomesolutions.allstar`, version 1.0.0, EAS-managed version code | COMPLETE |
| Config | Target/compile SDK 36, min SDK 24 (verified in the build log) | COMPLETE |
| Config | AAB output, production channel, internal-track draft submission | COMPLETE |
| Config | Unneeded permissions removed; backup disabled | COMPLETE (verified in generated manifest; the AAB itself could not be downloaded to inspect — the build environment's proxy blocks artifact downloads) |
| Config | Edge-to-edge / system bars | IN PROGRESS — enabled (required at SDK 36); appearance must be checked on a device (test A4) |
| Config | App name "Allstar Field" | BLOCKED — company decision (`GOOGLE_PLAY_SETUP.md` §6); on-device name is still "All-Star" |
| Config | Deep links / App Links | COMPLETE — not needed; the `allstar://` scheme exists, no verified web links |
| Config | Crash reporting | COMPLETE as decided — no SDK added; Play's Android vitals reports crashes/ANRs without one |
| Signing | Upload key (EAS keystore) + Play App Signing | IN PROGRESS — keystore exists and signed the AAB; Play App Signing is chosen at first upload; a backup copy must be downloaded by someone with Expo access |
| Build | Production AAB | COMPLETE — build `e3129f4a` |
| Build | Install and run on a device / emulator | BLOCKED — no device or emulator here; internal testing |
| Backend | Public `/delete-account` page | COMPLETE — live (HTTP 200, checked 2026-10-31) |
| Backend | `SUPPORT_EMAIL` on the Worker | BLOCKED — company provides the inbox |
| Backend | Backup retention for deleted accounts | BLOCKED — ops decision |
| Console | Developer account (organization) | BLOCKED — company: D-U-N-S, legal details, $25 |
| Console | App created, internal release | COMPLETE — draft app created; release 3 live on Internal testing |
| Console | App content, store listing, contact details | NOT STARTED — Bea; values in `PLAY_CONSOLE_ENTRY_SHEET.md` |
| Listing | Title, short + full description, release notes | COMPLETE (name pending) |
| Assets | 512 icon, feature graphic, 8 phone + 8 7-inch + 8 10-inch screenshots | COMPLETE |
| Compliance | Data safety, content rating, target audience, ads, app access answers | COMPLETE (to enter in the Console) |
| Compliance | Privacy policy covers Android | BLOCKED — could not be opened from here; counsel to review |
| Compliance | Reviewer login | BLOCKED — company creates the account |
| Testing | Plan, device matrix, test cases, triage, rollout/rollback | COMPLETE |
| Testing | Internal testing run | IN PROGRESS — opt-in works; Play Store shows "Item not found" for a tester account, cause not yet found; direct preview APK in use |
| Automation | EAS build/submit commands documented; service-account setup documented | COMPLETE |
| Automation | CI pipeline | NOT STARTED, deliberately — the repo has no CI (`scripts/verify-all.mjs`: "Not CI"); see below |

## What changed in the repository

| File | Change |
|---|---|
| `apps/mobile/app.json` | `android.blockedPermissions` (READ/WRITE_EXTERNAL_STORAGE, SYSTEM_ALERT_WINDOW); `android.allowBackup: false`. iOS untouched |
| `apps/mobile/eas.json` | Production Android `buildType: app-bundle`; submit `releaseStatus: draft` on the internal track |
| `apps/mobile/.gitignore` | Keystores, `credentials.json`, Play service-account keys |
| `api/src/pages.ts`, `api/src/index.ts` | `GET /delete-account`; `/support` links to it |
| `api/scripts/smoke-account-delete.mjs` | Covers the new page |
| `scripts/verify-android-release.mjs` | New check: Play-facing config (31 checks) |
| `scripts/verify-play-listing.mjs` | New check: listing text and graphics limits |
| `scripts/make-play-assets.mjs` | Regenerates the Play graphics from the app |
| `package.json` | `verify:android-release`, `verify:play-listing` |
| `docs/google-play/*` | These six documents and `assets/` |

## Commands run, and results

| Command | Result |
|---|---|
| `npx expo prebuild --platform android --no-install` (scratch, not committed) | Generated manifest: permissions as intended, `allowBackup="false"`, storage/overlay `tools:node="remove"` |
| `npm run verify:android-release` | 31/31 pass; fails 4 checks on the old `app.json` (checked) |
| `npm run verify:play-listing` | All pass — title 13/30, short 67/80, full 1563/4000, notes 192/500, all 26 images within limits |
| `npm run verify:store-assets` | 3/3 |
| `npm run verify:storebuild` | Pass — store build hides demo and testing aids |
| `npm run verify:inspectable` | 34/34 |
| `npm run verify:webview-patch` | 22/22 |
| `npm run verify:handoff` | 33/33 |
| `npm run verify:shellandroid` | 22/22 — the exported bundle boots in Android order |
| `node scripts/verify-api-access.mjs` | Every route declared |
| `cd api && npm run smoke:account-delete` | Pass, including the new `/delete-account` checks |
| `npm run typecheck` (web), `cd api && npm run typecheck` | Clean |
| `cd apps/mobile && npx tsc --noEmit` | 55 errors, all pre-existing: shared web files use Google Maps types the mobile tsconfig does not load (TS2503/TS2304). None in files changed here |
| `npm run build` | Pass |
| EAS build `e3129f4a` (production, Android) | **FINISHED** — `BUILD SUCCESSFUL in 19m 22s`, signed AAB 73.0 MB |
| `curl https://expo.dev/artifacts/…aab` | 403 from the environment's proxy — not downloaded |
| `curl https://help.allstarhomesolutions.com/privacy` | 403 from the environment's proxy — not verified |

Expo Doctor, inside the EAS build, flagged two pre-existing warnings (iOS build 10
shipped with the same): React 18 at the repository root (the web app) next to
React 19 in the mobile app, and nine Expo packages one patch release behind
(`npx expo install --check`). Neither stopped the build; both are worth a
separate, tested change.

## What Bea does in the Play Console

1. Once the company account is verified: create the app (`GOOGLE_PLAY_SETUP.md` §3).
2. Internal testing → create release → **Google-generated app-signing key** → upload the AAB above → notes from `PLAY_STORE_LISTING.md` → roll out.
3. Add internal testers and send the opt-in link (`ANDROID_TESTING_PLAN.md` §2).
4. Fill **App content** from `GOOGLE_PLAY_COMPLIANCE_AUDIT.md` §3 (after the branch is merged, so `/delete-account` is live).
5. Fill the **Main store listing** and upload everything in `assets/`.
6. Run the P0 tests on real phones; log results.
7. When the exit criteria pass and the company signs off: promote to Production with a staged rollout.

## What Sean / the company provides

| Item | Used for |
|---|---|
| Legal company name, address, D-U-N-S number, website | Organization developer account (same D-U-N-S as Apple's business account) |
| Account owner identity, contact phone, $25 | Google's verification and fee |
| Support email inbox | Store listing contact; Worker `SUPPORT_EMAIL` |
| Store name decision | "Allstar Field" vs "All-Star Field Sales"; same on both stores |
| Countries | United States or wider |
| Reviewer account (email + password, field-rep role, sample leads) | Play "App access" and Apple review |
| Privacy policy review for Android | Policy compliance |
| Backup retention decision | Data deletion accuracy |
| Someone with Expo account access to download the upload keystore backup | Key safety |

## Exact steps before release

1. Merge the Android release branch (deploys `/delete-account`; no other production effect).
2. Company: Play organization account, support inbox, reviewer account, name decision.
3. Set `SUPPORT_EMAIL` on the Worker (Cloudflare → Workers → allstar-api → Settings → Variables).
4. Bea: create app, upload AAB `e3129f4a` to Internal testing, fill App content and listing.
5. Test on real Android phones (P0 list). Fix anything found; rebuild (version code rises automatically).
6. Closed test 12 × 14 days **only if** the Console requires it.
7. Company sign-off → staged production rollout.

## Optional automation

The project builds on EAS from GitHub refs (Expo dashboard or `eas-cli`) and has
no CI by design. If the team later wants it:

- **EAS Workflows** (`apps/mobile/.eas/workflows/*.yml`): a workflow that runs the
  production Android build and then `submit` to the internal track, triggered on
  a tag. Needs only the EAS project; credentials stay in EAS.
- **GitHub Actions**: a job on pull requests touching `apps/mobile/**` that runs
  `npm ci` and `npm run verify:android-release && npm run verify:play-listing`.
  Needs no secrets. A build/submit job would need an `EXPO_TOKEN` repository
  secret (Expo → Account settings → Access tokens); the Play service-account key
  stays in EAS, never in GitHub.
