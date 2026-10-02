import { chromium } from 'playwright'
import { chromiumPath } from './lib/browser.mjs'
import { dismissTour } from './lib/tour.mjs'

/**
 * Framing the badge photo by hand.
 *
 * A rep picks a photo, drags and zooms it inside the badge's 4:5 frame, checks
 * it on the real badge, and saves — or cancels, and nothing changes. The
 * fixture is a 12MP (4032 × 3024) camera-sized JPEG drawn here: four coloured
 * quarters and a black disc in the middle, so where the crop landed can be
 * read straight off the saved pixels.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4173'
const fails = []
const ok = (cond, msg, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${got !== undefined ? `  (${got})` : ''}`)
  if (!cond) fails.push(msg)
}

const browser = await chromium.launch({ executablePath: chromiumPath() })
const errors = []

async function demo(viewport, mobile) {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /Try the demo/ }).click()
  await page.getByRole('button', { name: /Dana Whitfield/ }).click()
  await dismissTour(page)
  await page.waitForTimeout(1200)
  await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  return { ctx, page }
}

/* The 12MP fixture, drawn in the page and handed back as bytes. */
async function bigJpeg(page, { w = 4032, h = 3024 } = {}) {
  const b64 = await page.evaluate(async ({ w, h }) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const x = c.getContext('2d')
    x.fillStyle = '#dc2828'; x.fillRect(0, 0, w / 2, h / 2)
    x.fillStyle = '#28a03c'; x.fillRect(w / 2, 0, w / 2, h / 2)
    x.fillStyle = '#2850dc'; x.fillRect(0, h / 2, w / 2, h / 2)
    x.fillStyle = '#f0c828'; x.fillRect(w / 2, h / 2, w / 2, h / 2)
    x.fillStyle = '#1e1e1e'; x.beginPath(); x.arc(w / 2, h / 2, h / 10, 0, Math.PI * 2); x.fill()
    // Grain, so it compresses like a photo rather than four flat colours.
    const d = x.getImageData(0, 0, w, h)
    let seed = 7
    for (let i = 0; i < d.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const n = (seed % 25) - 12
      d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n
    }
    x.putImageData(d, 0, 0)
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(s)
  }, { w, h })
  return Buffer.from(b64, 'base64')
}

/* Colour of the saved photo at (fx, fy), as fractions of its size. */
const pixel = (page, dataUrl, fx, fy) =>
  page.evaluate(
    ({ dataUrl, fx, fy }) =>
      new Promise((resolve) => {
        const im = new Image()
        im.onload = () => {
          const c = document.createElement('canvas')
          c.width = im.naturalWidth
          c.height = im.naturalHeight
          const x = c.getContext('2d')
          x.drawImage(im, 0, 0)
          const d = x.getImageData(Math.floor(fx * (c.width - 1)), Math.floor(fy * (c.height - 1)), 1, 1).data
          resolve({ r: d[0], g: d[1], b: d[2], w: im.naturalWidth, h: im.naturalHeight })
        }
        im.src = dataUrl
      }),
    { dataUrl, fx, fy },
  )
const isRed = (p) => p.r > 170 && p.g < 90 && p.b < 90
const isBlue = (p) => p.b > 170 && p.r < 90
const isBlack = (p) => p.r < 70 && p.g < 70 && p.b < 70

const avatarImg = (page) => page.locator('button[aria-label*="profile photo" i] img')
const imgWidth = (page) => page.getByTestId('crop-image').evaluate((el) => el.getBoundingClientRect().width)
const imgLeft = (page) => page.getByTestId('crop-image').evaluate((el) => el.getBoundingClientRect().left)

try {
  /* ====== iPhone: the whole flow ======================================== */
  {
    const { ctx, page } = await demo({ width: 390, height: 844 }, true)
    const big = await bigJpeg(page)
    ok(big.length > 1_000_000, 'the fixture is a camera-sized photo', `${(big.length / 1024 / 1024).toFixed(1)}MB, 4032×3024`)

    /* --- cancel leaves everything as it was ----------------------------- */
    await page.setInputFiles('input[type=file]', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: big })
    await page.getByTestId('photo-cropper').waitFor({ timeout: 10_000 })
    ok((await page.getByTestId('photo-cropper').getAttribute('data-step')) === 'adjust', 'picking a photo opens the framing step')
    const frame = await page.getByTestId('crop-frame').boundingBox()
    ok(frame && Math.abs(frame.width / frame.height - 0.8) < 0.01, 'the frame is the badge photo’s 4:5', frame && `${Math.round(frame.width)}×${Math.round(frame.height)}`)
    const stage = await page.getByTestId('crop-stage').boundingBox()
    ok(frame && stage && frame.width >= stage.width - 40, 'and as wide as the phone allows', frame && `${Math.round(frame.width)} of ${Math.round(stage.width)}`)
    await page.getByTestId('crop-cancel').click()
    await page.waitForTimeout(300)
    ok((await page.getByTestId('photo-cropper').count()) === 0, 'Cancel closes it')
    ok((await avatarImg(page).count()) === 0, 'and the photo is unchanged (still none)')

    /* --- the default is the centre ------------------------------------- */
    await page.setInputFiles('input[type=file]', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: big })
    await page.getByTestId('photo-cropper').waitFor()
    await page.getByTestId('crop-preview').click()
    ok((await page.getByTestId('photo-cropper').getAttribute('data-step')) === 'preview', 'Preview shows the badge before anything is saved')
    const previewPhoto = page.getByTestId('photo-cropper').getByTestId('badge-photo')
    ok((await previewPhoto.getAttribute('data-state')) === 'present', 'the preview is the real badge, carrying the framed photo')
    const centred = await previewPhoto.getAttribute('src')
    const mid = await pixel(page, centred, 0.5, 0.5)
    ok(mid.w === 256 && mid.h === 320, 'it is 256×320', `${mid.w}×${mid.h}`)
    ok(centred.length <= 64_000, 'and a grainy 12MP photo still fits the server’s 64,000-character limit', `${centred.length}`)
    ok(isBlack(mid), 'untouched, the frame is centred on the photo', JSON.stringify(mid))
    ok((await avatarImg(page).count()) === 0, 'previewing has not saved it')

    /* --- Adjust goes back; drag moves the photo, clamped to the frame ---- */
    await page.getByTestId('crop-back').click()
    const before = await imgLeft(page)
    const sb = await page.getByTestId('crop-stage').boundingBox()
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
    await page.mouse.down()
    await page.mouse.move(sb.x + sb.width / 2 + 2000, sb.y + sb.height / 2, { steps: 8 })
    await page.mouse.up()
    const after = await imgLeft(page)
    const fb = await page.getByTestId('crop-frame').boundingBox()
    ok(after > before, 'dragging moves the photo', `${Math.round(before)} → ${Math.round(after)}`)
    ok(Math.abs(after - fb.x) < 1.5, 'but never past the frame’s edge — no gap inside the frame', `photo left ${after.toFixed(1)}, frame left ${fb.x.toFixed(1)}`)

    /* --- zoom: slider and buttons --------------------------------------- */
    const w0 = await imgWidth(page)
    await page.getByTestId('crop-zoom').fill('2')
    const w2 = await imgWidth(page)
    ok(Math.abs(w2 / w0 - 2) < 0.02, 'the slider zooms', `${Math.round(w0)} → ${Math.round(w2)}`)
    await page.getByRole('button', { name: 'Zoom out' }).click()
    ok((await imgWidth(page)) < w2, 'and − zooms back out')
    await page.getByTestId('crop-zoom').fill('1')

    /* --- pinch, with two touch pointers --------------------------------- */
    const pinch = async (from, to) => {
      const s = await page.getByTestId('crop-stage').boundingBox()
      const cx = s.x + s.width / 2
      const cy = s.y + s.height / 2
      await page.getByTestId('crop-stage').evaluate((el, { cx, cy, from, to }) => {
        const ev = (type, id, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: cy, bubbles: true, isPrimary: id === 1 }))
        ev('pointerdown', 1, cx - from); ev('pointerdown', 2, cx + from)
        for (let i = 1; i <= 6; i++) { const d = from + ((to - from) * i) / 6; ev('pointermove', 1, cx - d); ev('pointermove', 2, cx + d) }
        ev('pointerup', 1, cx - to); ev('pointerup', 2, cx + to)
      }, { cx, cy, from, to })
      await page.waitForTimeout(100)
    }
    const p0 = await imgWidth(page)
    await pinch(40, 100)
    const p1 = await imgWidth(page)
    ok(p1 / p0 > 2.2 && p1 / p0 < 2.8, 'pinching apart zooms in, by the fingers’ spread', `×${(p1 / p0).toFixed(2)}`)
    await pinch(100, 10)
    ok(Math.abs((await imgWidth(page)) - p0) < 1.5, 'pinching together stops at the smallest size that still fills the frame')

    /* --- the saved photo is what was framed ----------------------------- */
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2)
    await page.mouse.down()
    await page.mouse.move(sb.x + sb.width / 2 + 2000, sb.y + sb.height / 2, { steps: 8 })
    await page.mouse.up()
    await page.getByTestId('crop-preview').click()
    await page.getByTestId('crop-save').click()
    await page.waitForTimeout(800)
    ok((await page.getByTestId('photo-cropper').count()) === 0, 'Save to badge closes the cropper')
    const saved = (await avatarImg(page).getAttribute('src')) ?? ''
    ok(saved.startsWith('data:image/jpeg'), 'and sets the photo')
    ok(saved.length <= 64_000, 'within the server’s 64,000-character limit', `${saved.length}`)
    const tl = await pixel(page, saved, 0.05, 0.05)
    const bl = await pixel(page, saved, 0.05, 0.95)
    ok(isRed(tl) && isBlue(bl), 'it is the left of the photo, where it was dragged to', `${JSON.stringify(tl)} ${JSON.stringify(bl)}`)
    ok(!isBlack(await pixel(page, saved, 0.5, 0.5)), 'not the centre the old picker always took')

    /* --- the badge shows it --------------------------------------------- */
    await page.goto(`${BASE}/badge`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)
    // Demo users have no badge; the photo is checked on a live badge in verify:onboarding.

    /* --- replace mid-way, and cancel keeps the photo already saved ------- */
    await page.goto(`${BASE}/more`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)
    await page.setInputFiles('input[type=file]', { name: 'IMG_0002.jpg', mimeType: 'image/jpeg', buffer: big })
    await page.getByTestId('photo-cropper').waitFor()
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null)
    await page.getByTestId('crop-replace').click()
    const fc = await chooser
    ok(fc !== null, 'Choose another opens the photo picker again')
    if (fc) {
      const tall = await bigJpeg(page, { w: 3024, h: 4032 })
      await fc.setFiles({ name: 'IMG_0003.jpg', mimeType: 'image/jpeg', buffer: tall })
      await page.waitForTimeout(1200)
      ok((await page.getByTestId('photo-cropper').getAttribute('data-step')) === 'adjust', 'and the new photo opens in the frame, centred')
      const nat = await page.getByTestId('crop-image').evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }))
      ok(nat.h > nat.w && Math.max(nat.w, nat.h) <= 2048, 'a portrait photo stays portrait, worked on at most 2048px', `${nat.w}×${nat.h}`)
    }
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    ok((await page.getByTestId('photo-cropper').count()) === 0, 'Escape cancels')
    ok((await avatarImg(page).getAttribute('src')) === saved, 'and the saved photo is untouched by the cancelled one')

    /* --- a short phone: everything still reachable ---------------------- */
    await page.setViewportSize({ width: 375, height: 667 })
    await page.setInputFiles('input[type=file]', { name: 'IMG_0004.jpg', mimeType: 'image/jpeg', buffer: big })
    await page.getByTestId('photo-cropper').waitFor()
    await page.waitForTimeout(300)
    const vis = async (id) => {
      const b = await page.getByTestId(id).boundingBox()
      return b && b.y >= 0 && b.y + b.height <= 667
    }
    ok((await vis('crop-preview')) && (await vis('crop-replace')) && (await vis('crop-cancel')) && (await vis('crop-zoom')), 'on a 375×667 phone every control is on screen without scrolling')
    await page.getByTestId('crop-preview').click()
    await page.waitForTimeout(200)
    await page.getByTestId('crop-save').scrollIntoViewIfNeeded()
    ok(await vis('crop-save'), 'and Save to badge is too')
    await page.getByTestId('crop-cancel').click()
    await ctx.close()
  }

  /* ====== larger phone, tablet and desktop ================================ */
  for (const [label, viewport, mobile] of [
    ['iPhone Pro Max 430×932', { width: 430, height: 932 }, true],
    ['iPad 820×1180', { width: 820, height: 1180 }, true],
    ['desktop 1366×860', { width: 1366, height: 860 }, false],
  ]) {
    const { ctx, page } = await demo(viewport, mobile)
    const big = await bigJpeg(page)
    await page.setInputFiles('input[type=file]', { name: 'IMG.jpg', mimeType: 'image/jpeg', buffer: big })
    await page.getByTestId('photo-cropper').waitFor()
    await page.waitForTimeout(300)
    const f = await page.getByTestId('crop-frame').boundingBox()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    const btn = await page.getByTestId('crop-preview').boundingBox()
    ok(f && Math.abs(f.width / f.height - 0.8) < 0.01 && overflow <= 0 && btn && btn.y + btn.height <= viewport.height, `${label}: 4:5 frame, no sideways scroll, controls on screen`, f && `${Math.round(f.width)}×${Math.round(f.height)}`)
    if (!mobile) {
      const w0 = await imgWidth(page)
      const s = await page.getByTestId('crop-stage').boundingBox()
      await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
      await page.mouse.wheel(0, -400)
      await page.waitForTimeout(200)
      ok((await imgWidth(page)) > w0 * 1.3, `${label}: the mouse wheel zooms`)
      await page.keyboard.press('ArrowLeft')
    }
    await page.getByTestId('crop-preview').click()
    await page.waitForTimeout(200)
    const badge = await page.getByTestId('photo-cropper').getByTestId('team-badge').boundingBox()
    ok(badge && badge.width > 200, `${label}: the preview badge is shown at a readable size`, badge && `${Math.round(badge.width)}px wide`)
    await page.getByTestId('crop-cancel').click()
    await ctx.close()
  }

  /* ====== a file that is not a photo ===================================== */
  {
    const { ctx, page } = await demo({ width: 390, height: 844 }, true)
    await page.setInputFiles('input[type=file]', { name: 'notes.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not an image at all') })
    await page.waitForTimeout(800)
    ok((await page.getByTestId('photo-cropper').count()) === 0 && (await page.getByRole('alert').filter({ hasText: /could not be read/ }).count()) === 1, 'a file that is not an image says so, and opens nothing')
    await ctx.close()
  }
} finally {
  await browser.close()
}

ok(errors.length === 0, 'no page errors', errors[0])
if (fails.length) {
  console.log(`\n${fails.length} failed`)
  process.exit(1)
}
console.log('\nall passed')
