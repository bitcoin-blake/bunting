#!/usr/bin/env python3
# Draws og.png, the 1200x630 Open Graph / Twitter card, in the page's look.
# Run after changing the page's pitch:  python3 -I scripts/og.py  (needs
# Pillow; font: scripts/og-fonts/DMSans.ttf, SIL OFL). Bump ?v= on the
# og:image and twitter:image URLs in index.html so caches fetch the new one.
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = str(ROOT / 'scripts/og-fonts/DMSans.ttf')
S = 2  # drawn at twice the size, then scaled down, for smooth edges
W, H, PAD = 1200 * S, 630 * S, 72 * S
# The page's light theme: --bg, --card, --fg, --muted, --line, --accent, --hero-string.
BG, CARD, FG, MUTED, LINE = (245, 246, 248), (255, 255, 255), (23, 32, 51), (101, 112, 133), (225, 229, 235)
ACCENT, STRING = (73, 101, 219), (154, 165, 183)
FLAGS = [(239, 106, 98), (239, 185, 79), (76, 175, 145), (99, 125, 227), (154, 115, 209)]  # --f1..--f5
GRADIENT = [(0.05, (73, 101, 219)), (0.52, (117, 98, 206)), (1.0, (181, 97, 135))]  # --hero-gradient


def font(size, weight=400):
    f = ImageFont.truetype(FONT, size * S)
    f.set_variation_by_axes([min(max(size, 9), 40), weight])  # optical size, weight
    return f


def glow(img, centre, radius, colour, alpha):
    """A soft tint, like the page's background gradients."""
    layer = Image.new('L', img.size, 0)
    (cx, cy), (rx, ry) = centre, radius
    ImageDraw.Draw(layer).ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=alpha)
    img.paste(Image.new('RGB', img.size, colour), mask=layer.filter(ImageFilter.GaussianBlur(120 * S)))


def gradient_text(img, xy, text, f):
    """Text filled with the hero's left-to-right gradient."""
    x0, _, x1, _ = ImageDraw.Draw(img).textbbox(xy, text, font=f)
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).text(xy, text, font=f, fill=255)
    fill = Image.new('RGB', img.size)
    px = ImageDraw.Draw(fill)
    for x in range(x0, x1 + 1):
        t = (x - x0) / (x1 - x0)
        for (a, ca), (b, cb) in zip(GRADIENT, GRADIENT[1:]):
            if t <= b:
                k = max(0, (t - a) / (b - a))
                px.line([(x, 0), (x, img.height)], fill=tuple(round(p + (q - p) * k) for p, q in zip(ca, cb)))
                break
    img.paste(fill, mask=mask)


img = Image.new('RGB', (W, H), BG)
glow(img, (W * .95, -40 * S), (420 * S, 300 * S), (85, 108, 218), 60)
glow(img, (-40 * S, H * .9), (300 * S, 240 * S), (239, 185, 79), 36)
d = ImageDraw.Draw(img)

# The brand: the page's mark (three pennants on a dark tile) and its name.
m = 52 * S
d.rounded_rectangle([PAD, 56 * S, PAD + m, 56 * S + m], radius=15 * S, fill=FG)
for pts, colour in [([(9, 12.2), (15.2, 14.4), (10.8, 22.4)], FLAGS[0]), ([(16.8, 15.4), (23.2, 15.4), (20, 24)], FLAGS[1]),
                    ([(24.8, 14.4), (31, 12.2), (29.2, 22.4)], FLAGS[3])]:
    d.polygon([(PAD + x * m / 40, 56 * S + y * m / 40) for x, y in pts], fill=colour)
d.text((PAD + m + 14 * S, 56 * S + m / 2), 'Bunting', font=font(32, 700), fill=FG, anchor='lm')

# The pitch.
d.line([(PAD, 176 * S), (PAD + 30 * S, 176 * S)], fill=ACCENT, width=2 * S)
d.text((PAD + 42 * S, 176 * S), 'B I T C O I N - N A T I V E   A S S E T   W A L L E T', font=font(15, 600), fill=ACCENT, anchor='lm')
d.text((PAD - 4 * S, 200 * S), 'RGB assets,', font=font(96, 600), fill=FG)
gradient_text(img, (PAD - 4 * S, 300 * S), 'in full colour.', font(96, 600))
d = ImageDraw.Draw(img)
y = 432 * S
for line in ['Issue, invoice, pay and receive RGB assets on the', 'Bitcoin BLAKE2b chain, entirely in a browser tab.']:
    d.text((PAD, y), line, font=font(27), fill=MUTED)
    y += 40 * S

x = PAD
for chip in ['RGB v0.12', 'txbt4', 'tapret: no OP_RETURN', 'test coins only']:
    f = font(19, 500)
    tw = d.textlength(chip, font=f)
    d.rounded_rectangle([x, H - 88 * S, x + tw + 30 * S, H - 50 * S], radius=19 * S, outline=LINE, width=2 * S, fill=CARD)
    d.text((x + 15 * S, H - 69 * S), chip, font=f, fill=FG, anchor='lm')
    x += tw + 42 * S

# The hero illustration: five pennants hanging from a sagging string.
k, ox, oy = .92 * S, 730 * S, 120 * S
at = lambda x, y: (ox + x * k, oy + y * k)
curve = [((1 - t) ** 2 * 32 + 2 * t * (1 - t) * 240 + t * t * 448, (1 - t) ** 2 * 50 + 2 * t * (1 - t) * 360 + t * t * 50)
         for t in (i / 80 for i in range(81))]
d.line([at(x, y) for x, y in curve], fill=STRING, width=3 * S, joint='curve')
for (tx, ty, deg), colour in zip([(78, 106, 49), (153, 177, 32), (240, 205, 0), (327, 177, -32), (402, 106, -49)], FLAGS):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    turn = lambda x, y: at(tx + x * c - y * s, ty + x * s + y * c)
    d.polygon([turn(-30, 0), turn(30, 0), turn(0, 84)], fill=colour)
    d.polygon([turn(-30, 0), turn(0, 0), turn(0, 84)], fill=tuple(round(v + (255 - v) * .12) for v in colour))
for x, y in [(32, 50), (448, 50)]:
    cx, cy = at(x, y)
    d.ellipse([cx - 5 * S, cy - 5 * S, cx + 5 * S, cy + 5 * S], fill=STRING)

img = img.resize((W // S, H // S), Image.LANCZOS)
img.save(ROOT / 'og.png', optimize=True)
print('og.png', img.size)
