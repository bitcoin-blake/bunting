#!/usr/bin/env python3
# Draws og.png, the 1200x630 Open Graph / Twitter card. Run after changing the
# page's pitch:  python3 -I scripts/og.py  (needs Pillow; font:
# scripts/og-fonts/Inter.ttf, SIL OFL)
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = str(ROOT / 'scripts/og-fonts/Inter.ttf')
W, H, PAD = 1200, 630, 80
BG, FG, MUTED, LINE = (247, 245, 239), (29, 36, 51), (93, 100, 116), (226, 221, 208)
FLAGS = [(200, 55, 45), (233, 162, 59), (47, 125, 91), (31, 78, 140)]  # the page's --f1..--f4


def font(size, weight=400):
    f = ImageFont.truetype(FONT, size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def wrap(draw, text, f, width):
    lines, line = [], ''
    for word in text.split():
        trial = f'{line} {word}'.strip()
        if draw.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


img = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(img)

# The bunting: a string of pennants across the top.
n, gap, top = 14, 10, 0
w = (W - gap * (n + 1)) / n
d.line([(0, top + 4), (W, top + 4)], fill=LINE, width=3)
for i in range(n):
    x = gap + i * (w + gap)
    d.polygon([(x, top), (x + w, top), (x + w / 2, top + 64)], fill=FLAGS[i % 4])

d.text((PAD, 150), 'Bunting', font=font(104, 650), fill=FG)
y = 290
for line in wrap(d, 'RGB assets on the BLAKE2b chain, in a browser tab.', font(44, 500), W - 2 * PAD):
    d.text((PAD, y), line, font=font(44, 500), fill=FG)
    y += 58
y += 14
for line in wrap(d, 'Issue a token, make an invoice, pay one and take a payment in. '
                    'rgbjs validates and builds every transfer; the tab signs.', font(30), W - 2 * PAD):
    d.text((PAD, y), line, font=font(30), fill=MUTED)
    y += 42

x = PAD
for chip in ['RGB v0.12', 'txbt4', 'tapret: no OP_RETURN', 'test coins only']:
    f = font(26, 500)
    tw = d.textlength(chip, font=f)
    d.rounded_rectangle([x, H - 108, x + tw + 36, H - 60], radius=24, outline=LINE, width=2, fill=(255, 253, 248))
    d.text((x + 18, H - 101), chip, font=f, fill=FG)
    x += tw + 52

img.save(ROOT / 'og.png', optimize=True)
print('og.png', img.size)
