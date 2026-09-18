#!/usr/bin/env python3
"""
Generate the app's brand assets from the source logo files.

Run rarely — only when the logo itself changes:

    pip install Pillow
    python3 scripts/make-brand-assets.py

Sources live in brand/ and are NOT served: everything under public/ is deployed,
and the originals are 1.7 MB of artwork nobody's phone should download. The
generated files are what ship.

What this does that a rename could not:

  * Keys out the background. Both sources are RGB with no alpha — the white
    behind the wordmark is real pixels, so dropping it straight onto a warm
    off-white card would show a white rectangle around it.
  * Squares up the margins. The source wordmark sits 134px from the left edge
    and 63px from the right, which reads as off-centre wherever it is placed.
  * Builds the knockout variant. The wordmark is black type; the login screen is
    near-black. The light version recolours only the achromatic pixels, leaving
    the teal star alone, so it stays on brand rather than becoming a silhouette.
  * Produces a real maskable icon. Android crops maskable icons to a circle, and
    the star nearly fills its tile — used as-is, its points get sliced off.
"""

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "brand"
OUT = ROOT / "public"
MOBILE = ROOT / "apps" / "mobile" / "assets" / "images"
# The two images the web app *imports* rather than serves. They moved out of
# public/ when the native shell arrived: a DOM component's page is loaded from
# `file://`, so an absolute `/logo.png` resolves to the filesystem root and the
# image 404s. An import is a real dependency to both bundlers.
WEB_SRC = ROOT / "src" / "assets"

WORDMARK = SRC / "allstar-wordmark.png"
STAR = SRC / "allstar-star.png"

# Measured from the artwork rather than guessed. Sampling the star tile puts the
# brand teal at #07B3CA; it was eyeballed as #17B9CE, which is visibly wrong.
TEAL = (7, 179, 202)

# Luminance bounds for the background key. Anything at or above LIGHT is
# background, at or below INK is solid, and the gap is the anti-aliased edge —
# ramped rather than cut, or the type acquires jagged fringes at small sizes.
LIGHT = 235.0
INK = 60.0
# Max channel spread below which a pixel counts as grey rather than coloured.
# Separates the black type (recolourable) from the teal star (never recoloured).
ACHROMATIC = 40


def luminance(r: int, g: int, b: int) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def key_background(im: Image.Image, ink=(0, 0, 0), recolour_ink=False) -> Image.Image:
    """White background -> alpha. Optionally repaint the achromatic ink."""
    im = im.convert("RGB")
    out = Image.new("RGBA", im.size)
    src = im.load()
    dst = out.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b = src[x, y]
            lum = luminance(r, g, b)
            spread = max(r, g, b) - min(r, g, b)

            if spread > ACHROMATIC:
                # Coloured — the star, and the teal "HOME SOLUTIONS" line. Kept
                # exactly as drawn in both variants.
                dst[x, y] = (r, g, b, 255)
                continue

            if lum >= LIGHT:
                alpha = 0
            elif lum <= INK:
                alpha = 255
            else:
                alpha = int(round(255 * (LIGHT - lum) / (LIGHT - INK)))

            if alpha == 0:
                dst[x, y] = (0, 0, 0, 0)
            elif recolour_ink:
                dst[x, y] = (*ink, alpha)
            else:
                # Keep the original grey so anti-aliasing stays smooth.
                dst[x, y] = (r, g, b, alpha)
    return out


def star_glyph(im: Image.Image) -> Image.Image:
    """Just the black star, on transparency — the tile's teal field discarded.

    Needed because compositing the whole tile onto another teal field leaves a
    visible rounded-square seam: the tile's own edge pixels are anti-aliased
    against white, so they never quite match the field behind them.
    """
    im = im.convert("RGB")
    out = Image.new("RGBA", im.size)
    src = im.load()
    dst = out.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b = src[x, y]
            spread = max(r, g, b) - min(r, g, b)
            lum = luminance(r, g, b)
            # Coloured or bright -> field, not glyph.
            if spread > ACHROMATIC or lum >= LIGHT:
                dst[x, y] = (0, 0, 0, 0)
            elif lum <= INK:
                dst[x, y] = (0, 0, 0, 255)
            else:
                dst[x, y] = (0, 0, 0, int(round(255 * (LIGHT - lum) / (LIGHT - INK))))
    return out


def trim(im: Image.Image, pad_ratio: float = 0.0) -> Image.Image:
    """Crop to the visible artwork, then add even padding on all four sides."""
    box = im.getbbox()
    if box:
        im = im.crop(box)
    if pad_ratio <= 0:
        return im
    pad = int(round(max(im.size) * pad_ratio))
    canvas = Image.new("RGBA", (im.width + pad * 2, im.height + pad * 2), (0, 0, 0, 0))
    canvas.paste(im, (pad, pad))
    return canvas


def save(
    im: Image.Image, name: str, quantize: bool = False, out: Path = None, opaque: bool = False
) -> None:
    """Write a PNG, optionally palette-quantised.

    The sources are AI-generated and carry compression noise — thousands of
    near-identical near-whites — which makes a truecolour PNG far larger than the
    two-colour artwork warrants. Quantising the flat-colour icons is visually
    lossless here and cuts them by an order of magnitude.
    """
    path = (out or OUT) / name
    path.parent.mkdir(parents=True, exist_ok=True)
    img = im
    if opaque:
        """
        No alpha channel at all, for the one asset Apple rejects for having one.

        App Store validation refuses an app icon with an alpha channel, and it
        refuses a fully-opaque RGBA file too — the channel's presence is the
        fault, not its contents. Quantising is what introduced it here: a
        palette image carries a `transparency` entry even when nothing in it is
        transparent, so the icon looked fine and would have failed on the first
        upload.

        Flattened onto the artwork's own field colour rather than onto white, so
        an edge pixel that was anti-aliased against transparency lands on the
        colour it was meant to sit on.
        """
        flat = Image.new("RGB", img.size, TEAL)
        flat.paste(img, (0, 0), img if img.mode in ("RGBA", "LA") else None)
        img = flat
    elif quantize:
        img = im.quantize(colors=64, method=Image.Quantize.FASTOCTREE)
    img.save(path, "PNG", optimize=True)
    kb = path.stat().st_size / 1024
    print(f"  {name:28} {im.width:>4}x{im.height:<4}  {kb:6.1f} KB")


def main() -> None:
    print("wordmark")
    word = key_background(Image.open(WORDMARK))
    word = trim(word)
    # 720px wide covers a 3x display at the ~240px the login renders it.
    ratio = 720 / word.width
    word_std = word.resize((720, max(1, round(word.height * ratio))), Image.LANCZOS)
    # Imported by `ui/Wordmark.tsx`, not served — see WEB_SRC.
    save(word_std, "logo.png", quantize=True, out=WEB_SRC)

    light = key_background(Image.open(WORDMARK), ink=(255, 255, 255), recolour_ink=True)
    light = trim(light)
    light = light.resize(word_std.size, Image.LANCZOS)
    save(light, "logo-light.png", quantize=True)

    print("icon")
    # Flood-filling from the corners would be tidier, but the tile's rounded
    # corners are the only background here and a global key reaches them all.
    star = key_background(Image.open(STAR))
    star = trim(star)
    for size in (512, 192):
        save(star.resize((size, size), Image.LANCZOS), f"icon-{size}.png", quantize=True)
    # The 192 exists twice on purpose, and both are generated so neither can
    # drift: index.html serves it from public/ as the PWA icon, and
    # `nav/BottomNav.tsx` imports it, which is the only form that resolves
    # inside the native shell.
    save(star.resize((192, 192), Image.LANCZOS), "icon-192.png", quantize=True, out=WEB_SRC)
    save(star.resize((32, 32), Image.LANCZOS), "favicon-32.png", quantize=True)

    # Maskable: full-bleed teal, star inside the 80% safe circle so a circular
    # crop cannot clip its points. Also serves as the iOS touch icon, which does
    # not want transparency either.
    inner = round(512 * 0.60)
    glyph = trim(star_glyph(Image.open(STAR))).resize((inner, inner), Image.LANCZOS)
    for name, size in (("icon-maskable-512.png", 512), ("apple-touch-icon.png", 180)):
        canvas = Image.new("RGBA", (512, 512), (*TEAL, 255))
        canvas.paste(glyph, ((512 - inner) // 2, (512 - inner) // 2), glyph)
        if size != 512:
            canvas = canvas.resize((size, size), Image.LANCZOS)
        save(canvas, name, quantize=True)


def mobile() -> None:
    """The native app's identity.

    This existed as Expo's template branding until now, which is worth saying
    plainly: the icon source was a file called `expo-symbol 2.svg` with Expo's
    blue gradient, `splash-icon.png` was byte-identical to `expo-logo.png`, and
    the three Android adaptive layers were Expo's chevron. So the App Store
    listing, the home screen and the launch screen all showed somebody else's
    logo. Only `public/` had ever been generated from `brand/`.

    Generated here rather than exported by hand so the phone cannot drift from
    the web: one source of artwork, one set of rules about keying and safe
    areas, and `verify:brand-assets` fails if a file stops matching what this
    would write.

    ## The sizes, and why each one

    `icon.png` at 1024 because that is what App Store Connect requires, and
    anything smaller is upscaled into a soft icon. Full-bleed rather than
    transparent: iOS composites an icon onto black and masks it itself, so a
    transparent icon becomes a star floating on a black square.

    The Android layers are separate because an adaptive icon is composited by
    the launcher, which crops the pair to whatever shape the device uses — a
    circle on many. The star is placed inside the same 60% safe box the web
    maskable icon uses, which is what stops its points being sliced off.

    The monochrome layer is the star as a flat silhouette. Android tints it
    itself for themed icons, so any colour here would be discarded — and a
    layer with colour in it reads as a mistake to whoever next opens the file.
    """
    print("mobile")
    star_tile = trim(key_background(Image.open(STAR)))
    glyph_src = trim(star_glyph(Image.open(STAR)))

    inner = round(1024 * 0.60)
    glyph = glyph_src.resize((inner, inner), Image.LANCZOS)
    offset = (1024 - inner) // 2

    """
    iOS wants a full-bleed square, not the rounded tile.

    The web's `icon-512.png` keeps the artwork's own rounded corners, which is
    right for a PWA icon that is drawn as-is. iOS is the opposite: it applies
    the squircle mask itself and composites whatever is behind the icon onto
    **black**, so handing it a rounded tile puts a black wedge in each corner.
    Same 60% safe box as the web maskable icon, which is what keeps the star's
    points clear of any mask a launcher or a watch face chooses.
    """
    ios = Image.new("RGBA", (1024, 1024), (*TEAL, 255))
    ios.paste(glyph, (offset, offset), glyph)
    save(ios, "icon.png", opaque=True, out=MOBILE)

    # The launch screen, which sits on its own background colour — so here the
    # artwork's rounded tile is right, and the same mark a rep tapped.
    save(star_tile.resize((512, 512), Image.LANCZOS), "splash-icon.png", quantize=True, out=MOBILE)

    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    fg.paste(glyph, (offset, offset), glyph)
    save(fg, "android-icon-foreground.png", quantize=True, out=MOBILE)

    save(
        Image.new("RGBA", (1024, 1024), (*TEAL, 255)),
        "android-icon-background.png",
        out=MOBILE,
    )

    mono = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    mono.paste(glyph, (offset, offset), glyph)
    save(mono, "android-icon-monochrome.png", quantize=True, out=MOBILE)

    # The web favicon doubles as Expo's, at the size a browser tab wants.
    save(star_tile.resize((48, 48), Image.LANCZOS), "favicon.png", quantize=True, out=MOBILE)


if __name__ == "__main__":
    main()
    mobile()
