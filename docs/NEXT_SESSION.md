# Handoff: get the DOM shell onto a phone

Written at the end of the session that built `packages/core`, `apps/mobile` and
the DOM shell. Everything here is pushed to
`claude/adoring-ramanujan-nkugv6` and open as PR #146.

## Done — the shell is on Expo Go

No new session was needed in the end. `EXPO_TOKEN` arrived when the container
restarted, secrets being injected at boot.

The tappable link:

```
exp://u.expo.dev/497739ce-76e6-420a-b80e-308126e25f35?runtime-version=exposdk%3A57.0.0&channel-name=preview
```

Dashboard: https://expo.dev/accounts/let-lois/projects/all-star-app/updates/55f39791-f0a5-4483-93e1-833b3834ea05

Two things about that which are easy to get wrong:

- **`eas update:configure` chose `runtimeVersion: {"policy":"appVersion"}`, and
  Expo Go cannot load that.** It needs `sdkVersion`. Changed, and the published
  update confirms it: `Runtime version exposdk:57.0.0`. Expo's own guidance
  warns against changing this policy casually, because it decides which
  installed builds can receive future updates — so it was checked rather than
  assumed: `build_list` returns `[]`, no builds exist, nothing to orphan. The
  change is free now and would not have been later.
- **`eas update --branch preview` publishes to a *branch*, and no channel
  existed.** `channel:list` was empty, so a `channel=preview` link would have
  resolved to nothing. `eas channel:create preview` connected the two. Channels
  and branches are separate objects.

Verified rather than constructed: the manifest at `u.expo.dev` returns 200 for
`expo-channel-name: preview` with `exposdk:57.0.0` on iOS.

## Why EAS Update rather than a tunnel
## Why EAS Update rather than a tunnel

`npx expo start --tunnel` cannot work from a Claude Code cloud container, and
this is settled rather than suspected:

- All egress is TLS-intercepted. A **direct** connection to
  `connect.ngrok-agent.com:443` with the proxy bypassed still returns a
  certificate issued by `O = Anthropic, CN = Egress Gateway SDS Issuing CA`.
- ngrok v2 pins its own root CA, so it fails with `x509: certificate signed by
  unknown authority`. That part is fixable — `root_cas: host` in
  `~/.ngrok2/ngrok.yml` plus `SSL_CERT_FILE=/root/.ccr/ca-bundle.crt` — and
  once fixed the next error is `failed to auth: session closed`, because the
  connection then terminates at an HTTPS proxy that cannot carry ngrok's
  protocol.
- `/root/.ccr/README.md` lists this case outright: "Not supported through the
  proxy … certificate-pinned clients (e.g. ngrok)".

EAS Update sidesteps it completely: the bundle is uploaded over ordinary HTTPS,
which works fine, and Expo Go fetches it from Expo's servers.

## What is already done

- `expo-updates@~57.0.22` installed in `apps/mobile` (SDK-compatible, via
  `npx expo install`). Typecheck clean and `expo export --platform ios` still
  produces 1,507 native modules and a 298-module DOM bundle.
- The Expo project exists and `app.json` carries its identity: owner
  `let-lois`, slug `all-star-app`, `extra.eas.projectId`
  `497739ce-76e6-420a-b80e-308126e25f35`.
- `eas.json` has development, preview and production profiles, each with
  `EXPO_PUBLIC_ORIGIN=https://allstar.letlois.com` in its `env` block.

## What is deliberately NOT done

**`updates.url` and `runtimeVersion` are not hand-written.** Expo's own
`eas-update` skill says to let the CLI do it:

> Use `eas update:configure` rather than manually inventing `updates.url`,
> `runtimeVersion`, native metadata, or build-profile channels. … Do not
> partially reproduce `update:configure` by adding a runtime-version policy,
> config plugin, update URL, or channels by hand.

The command understands EAS project linking, Continuous Native Generation and
committed native directories; guessing at its output is how a project ends up
with configuration nobody can explain. It is one command in the new session.

## The steps

```sh
cd apps/mobile

# 1. Confirm the token arrived
npx eas-cli@latest whoami            # expect an account, not "Not logged in"

# 2. Let the CLI write the update config, then read its diff
npx eas-cli@latest update:configure
git diff app.json eas.json

# 3. runtimeVersion policy — only if step 2 did not already set it
#    "sdkVersion" is what lets Expo Go load the bundle.

# 4. Check the current flags before publishing, they move
npx eas-cli@latest update --help

# 5. Publish. SDK 55+ requires an environment.
npx eas-cli@latest update --channel preview --message "first preview" --environment preview

# 6. A tappable link
#    https://qr.expo.dev/eas-update?projectId=497739ce-76e6-420a-b80e-308126e25f35&channel=preview&format=url
#    Print the resulting URL in chat — tapping beats scanning a QR off a monitor.
```

Note on step 5: the skill documents `--channel`, not `--branch`. A channel
points at a branch server-side and they are separate objects; check
`update --help` rather than trusting either spelling from memory.

## What is still unproven after this

That the shell **renders correctly**. Everything verified so far is about what
it bundles: module counts, compiled Tailwind, the presence of the rep app's
strings and the absence of the admin console's. Opening the link on a real
phone is the first time anyone sees the thing.

Watch for, in particular:

- **The in-app-browser alert.** `src/lib/webview.ts` was fixed this session so
  an Expo DOM component is not mistaken for someone else's browser — a DOM
  component matches both generic signatures by construction. If a red
  "camera, microphone and location won't work here" banner appears, that fix
  regressed and `verify:webview` should have caught it.
- **The badge QR.** It is built from `window.location.origin` unless
  `EXPO_PUBLIC_ORIGIN` is set. It is set in `eas.json`, but that applies to
  EAS Build; a local `expo start` needs `.env.local` (see
  `apps/mobile/.env.example`).
- **Keyboard behaviour in Visit Mode**, which is the single worst thing about a
  webview on a phone and the reason that screen is first on the nativize list.

## Suite state

`npm run verify:all` is 77 gates. The last clean full run was 76/77 before
`verify:lists-e2e` was fixed in ef5b45f; runs after that showed the two
timing-sensitive browser gates (`addresspick`, `lists-e2e`) failing, and the
cause was found: **eleven stray `vite preview` servers** left running by
earlier turns, starving four cores. They were killed. Re-run the suite on a
quiet machine before reading anything into those two.

`verify:lists-e2e` and `verify:phase1-e2e` also need `cd api && npm ci` first,
or they fail for want of wrangler.
