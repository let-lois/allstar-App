import { contactUrlFor, destinationFor } from '../apps/mobile/src/lib/handoff.ts'

/**
 * Where the shell sends a URL the webview tried to navigate to.
 *
 * The bug this pins: Call, Text and Email on every lead did nothing on a
 * phone. The web app emits `<a href="tel:…">`, the webview asks the shell, the
 * shell allowed only its own page and handed everything else to the in-app
 * browser — which opens web content and nothing else. `tel:+15125550100` opened
 * nothing, no error, on both platforms. The rep saw a button that did not work
 * and could not know why.
 *
 * Pure and fast, and run on every case rather than a sample, because the cost
 * of a wrong row here is a rep who cannot phone a homeowner back.
 */

const fails = []
const ok = (cond, msg, measured) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${measured ? `  (${measured})` : ''}`)
  if (!cond) fails.push(msg)
}

const DEV = 'http://192.168.1.20:8081'
const is = (url, want, dev = null) => {
  const got = destinationFor(url, dev)
  ok(got === want, `${url} → ${want}`, got === want ? undefined : `got ${got}`)
}

console.log('--- the shell\'s own page, and only that ---')
is('file:///android_asset/www.bundle/10b27f92.html', 'shell')
is('file:///var/containers/Bundle/Application/x/www.bundle/10b27f92.html', 'shell')
is('about:blank', 'shell')
is(`${DEV}/_expo/@dom/allstar-web.tsx`, 'shell', DEV)
// A build has no dev server; the same URL is then just a web page.
is(`${DEV}/_expo/@dom/allstar-web.tsx`, 'browser', null)
// A prefix is not the dev server. Compared with the slash, so a registrable
// host that merely starts with the address is refused.
is('http://192.168.1.20:8081.evil.example/x', 'browser', DEV)
is('http://192.168.1.20:80810/x', 'browser', DEV)

console.log('\n--- what the phone can open, and the browser cannot ---')
// Exactly the shapes the web app emits: @allstar/core/contact builds these.
is('tel:+15125550100', 'system')
is('sms:+15125550100', 'system')
is('sms:+15125550100?body=Hi%20there', 'system')
is('mailto:owner@example.com', 'system')
is('mailto:owner@example.com?subject=Your%20roof', 'system')
// Android's own scheme for "open this in Chrome", should anything emit it.
is('intent://allstar.letlois.com/#Intent;scheme=https;end', 'system')
is('geo:30.5115,-97.6755', 'system')

console.log('\n--- directions go to the real Maps app ---')
is('https://maps.apple.com/?daddr=100%20Cedar%20Bend%20Dr', 'directions')
is('https://www.google.com/maps/dir/?api=1&destination=100+Cedar+Bend+Dr', 'directions')
is('https://google.com/maps/dir/?api=1&destination=x', 'directions')
is('https://www.google.co.uk/maps/dir/?api=1&destination=x', 'directions')
// Not directions: a Google page that is not the maps product, and a maps host
// that is somebody else's.
is('https://www.google.com/search?q=maps', 'browser')
is('https://maps.apple.com.evil.example/', 'browser')

console.log('\n--- everything else on the web opens in the in-app browser ---')
is('https://allstar.letlois.com/verify/b_123', 'browser')
is('https://www.google.com/maps/@30.5,-97.6,3a,75y', 'directions') // street view is under /maps too, and belongs with it
is('http://example.com/', 'browser')
is('https://help.allstarhomesolutions.com/visits/', 'browser')

console.log('\n--- Call, Text and Email, asked for directly (openExternal) ---')
const url = (input, os, want, why) => {
  const got = contactUrlFor(input, os)
  ok(got === want, why, got === want ? undefined : `got ${got}`)
}
url('tel:5125550100', 'ios', 'tel:5125550100', 'a call goes to the dialer as written')
url('tel:+15125550100', 'android', 'tel:+15125550100', 'with its + intact')
url('sms:5125550100?body=Hi%20Sam%2C%20', 'ios', 'sms:5125550100&body=Hi%20Sam%2C%20', 'a text on iOS takes its greeting after &, the way Messages reads it')
url('sms:5125550100?body=Hi%20Sam%2C%20', 'android', 'sms:5125550100?body=Hi%20Sam%2C%20', 'and after ? on Android, unchanged')
url('sms:5125550100', 'ios', 'sms:5125550100', 'a text with no greeting is left alone')
url('mailto:sam@example.com?subject=Following%20up', 'ios', 'mailto:sam@example.com?subject=Following%20up', 'an email keeps its subject')
url('https://evil.example/', 'ios', null, 'the direct hand-off refuses a web page')
url('javascript:alert(1)', 'ios', null, 'and any other scheme')
url('file:///etc/passwd', 'android', null, 'and a file')

console.log('')
if (fails.length) {
  console.log(`${fails.length} check(s) failed:`)
  fails.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('=== every URL the webview can be asked for goes somewhere that can open it ===')
