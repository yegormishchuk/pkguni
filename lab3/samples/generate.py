"""Воспроизводимая синтетическая база. Pillow нужен только для генерации PNG."""
from pathlib import Path
import random
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
W, H = 720, 360
font = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 34)
small = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 22)
mask = Image.new('L', (W, H), 255)
d = ImageDraw.Draw(mask)
for y, text in [(42, 'LOCAL THRESHOLD'), (110, 'Variant 15 / Lab 3'), (178, '0123456789  ABC xyz')]:
    d.text((38, y), text, fill=0, font=font)
d.text((38, 266), 'Fine lines and uneven illumination', fill=0, font=small)
d.line((38, 312, 680, 312), fill=0, width=2)
mask = mask.point(lambda p: 255 if p >= 128 else 0)
mask.save(ROOT / 'text-mask.png')
rng = random.Random(15)
for name in ['shadows', 'lowcontrast', 'saltpepper']:
    image = Image.new('L', (W, H))
    for y in range(H):
        for x in range(W):
            ink = mask.getpixel((x, y)) == 0
            if name == 'shadows':
                bg = 100 + 145 * x / (W-1) + 6 * y / H
                value = bg - (65 if ink else 0) + rng.uniform(-2, 2)
            elif name == 'lowcontrast':
                bg = 190 + 10*x/W + rng.uniform(-6, 6)
                value = bg - (22 if ink else 0)
            else:
                value = 35 if ink else 225
                if rng.random() < .08:
                    value = 255 if rng.random() < .5 else 0
            image.putpixel((x, y), round(max(0, min(255, value))))
    image.save(ROOT / (name + '.png'))
image = Image.new('L', (W, H), 128)
d = ImageDraw.Draw(image)
for i, r in enumerate([1, 2, 4, 8, 16, 24]):
    x = 55 + i*115
    d.ellipse((x-r, 95-r, x+r, 95+r), fill=240)
    d.ellipse((x-r, 240-r, x+r, 240+r), fill=15)
d.line((25, 165, 695, 165), fill=240, width=1)
d.line((25, 180, 695, 180), fill=15, width=1)
image.save(ROOT / 'details.png')
print('Generated four 720x360 samples and binary text mask.')
