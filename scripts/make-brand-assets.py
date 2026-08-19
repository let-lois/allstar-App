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


def save(im: Image.Image, name: str, quantize: bool = False) -> None:
    """Write a PNG, optionally palette-quantised.

    The sources are AI-generated and carry compression noise — thousands of
    near-identical near-whites — which makes a truecolour PNG far larger than the
    two-colour artwork warrants. Quantising the flat-colour icons is visually
    lossless here and cuts them by an order of magnitude.
    """
    path = OUT / name
    out = im
    if quantize:
        out = im.quantize(colors=64, method=Image.Quantize.FASTOCTREE)
    out.save(path, "PNG", optimize=True)
    kb = path.stat().st_size / 1024
    print(f"  {name:28} {im.width:>4}x{im.height:<4}  {kb:6.1f} KB")


def main() -> None:
    print("wordmark")
    word = key_background(Image.open(WORDMARK))
    word = trim(word)
    # 720px wide covers a 3x display at the ~240px the login renders it.
    ratio = 720 / word.width
    word_std = word.resize((720, max(1, round(word.height * ratio))), Image.LANCZOS)
    save(word_std, "logo.png", quantize=True)

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


if __name__ == "__main__":
    main()
