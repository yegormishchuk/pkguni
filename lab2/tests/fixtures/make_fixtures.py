"""Генерирует тестовые изображения всех форматов (нужен Pillow).

Pillow используется ТОЛЬКО для создания эталонных файлов для автотестов,
само приложение читает заголовки вручную.
Запуск: python tests/fixtures/make_fixtures.py
"""
import os
import random
import struct

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
random.seed(42)


def path(name):
    return os.path.join(HERE, name)


def noise(mode, size):
    im = Image.new('RGB', size)
    im.putdata([(random.randrange(256), random.randrange(256), random.randrange(256)) for _ in range(size[0] * size[1])])
    return im.convert(mode) if mode != 'RGB' else im


def gradient(size):
    w, h = size
    im = Image.new('RGB', size)
    im.putdata([(x * 255 // max(1, w - 1), y * 255 // max(1, h - 1), 128) for y in range(h) for x in range(w)])
    return im


# JPEG
gradient((64, 48)).save(path('jpeg_baseline.jpg'), quality=75, dpi=(72, 72), subsampling=2)
gradient((80, 60)).save(path('jpeg_progressive.jpg'), quality=90, dpi=(300, 300), progressive=True, subsampling=0)
gradient((40, 30)).convert('L').save(path('jpeg_gray.jpg'), quality=50)
gradient((32, 32)).convert('CMYK').save(path('jpeg_cmyk.jpg'), quality=85, dpi=(150, 150))
exif = Image.Exif()
exif[271] = 'TestCam'
exif[272] = 'Model X'
exif[282] = 180
exif[283] = 180
exif[296] = 2
gradient((48, 36)).save(path('jpeg_exif.jpg'), quality=95, exif=exif.tobytes())

# PNG
gradient((50, 40)).save(path('png_rgb.png'), dpi=(96, 96))
gradient((20, 10)).convert('RGBA').save(path('png_rgba.png'))
gradient((16, 16)).convert('P', palette=Image.ADAPTIVE, colors=16).save(path('png_palette4.png'), bits=4)
gradient((33, 17)).convert('1').save(path('png_mono.png'))
Image.new('I;16', (12, 8), 40000).save(path('png_gray16.png'))

# GIF
gradient((30, 20)).convert('P', palette=Image.ADAPTIVE, colors=32).save(path('gif_static.gif'))
frames = [gradient((24, 24)).rotate(a).convert('P', palette=Image.ADAPTIVE, colors=64) for a in (0, 90, 180)]
frames[0].save(path('gif_anim.gif'), save_all=True, append_images=frames[1:], duration=100, loop=0)

# TIFF
gradient((60, 40)).save(path('tiff_lzw.tif'), compression='tiff_lzw', dpi=(300, 300))
gradient((60, 40)).convert('L').save(path('tiff_deflate_cm.tif'), compression='tiff_adobe_deflate', resolution=118.11, resolution_unit='cm')
pages = [gradient((20, 10)).convert('P', palette=Image.ADAPTIVE, colors=256) for _ in range(3)]
pages[0].save(path('tiff_multipage.tif'), save_all=True, append_images=pages[1:], compression='packbits')
gradient((17, 9)).convert('CMYK').save(path('tiff_cmyk.tif'))

# BMP
gradient((31, 21)).save(path('bmp_24.bmp'), dpi=(96, 96))
gradient((40, 10)).convert('1').save(path('bmp_mono.bmp'))
gradient((10, 10)).convert('RGBA').save(path('bmp_32.bmp'))
gradient((25, 25)).convert('L').save(path('bmp_gray8.bmp'))


def rle8_bmp():
    w, h = 8, 2
    data = bytes([8, 1, 0, 0, 4, 2, 4, 3, 0, 0, 0, 1])  # строка 1: 8×цвет1; строка 2: 4×2 + 4×3; конец
    palette = b''.join(struct.pack('<BBBB', i * 60, i * 60, 255 - i * 60, 0) for i in range(4))
    off = 14 + 40 + len(palette)
    info = struct.pack('<IiiHHIIiiII', 40, w, h, 1, 8, 1, len(data), 3780, 3780, 4, 0)
    head = b'BM' + struct.pack('<IHHI', off + len(data), 0, 0, off)
    with open(path('bmp_rle8.bmp'), 'wb') as f:
        f.write(head + info + palette + data)


rle8_bmp()

# PCX
gradient((30, 20)).convert('P', palette=Image.ADAPTIVE, colors=256).save(path('pcx_8bit.pcx'))
gradient((30, 20)).save(path('pcx_24.pcx'))
gradient((33, 7)).convert('1').save(path('pcx_mono.pcx'))
gradient((19, 11)).convert('L').save(path('pcx_gray.pcx'))


# Повреждённые файлы и подмена расширений
def write(name, data):
    with open(path(name), 'wb') as f:
        f.write(data)


def read(name):
    with open(path(name), 'rb') as f:
        return f.read()


big = noise('RGB', (120, 90))
big.save(path('_big.png'))
big.save(path('_big.jpg'), quality=95)
big.save(path('_big.bmp'))
big.convert('P', palette=Image.ADAPTIVE).save(path('_big.gif'))
big.save(path('_big.tif'))
png = read('_big.png')
write('broken_png_no_iend.png', png[:-12])
write('broken_png_truncated.png', png[: len(png) // 2])
crc = bytearray(read('png_rgb.png'))
crc[29] ^= 0xFF  # порча CRC чанка IHDR
write('broken_png_crc.png', bytes(crc))
jpg = read('_big.jpg')
write('broken_jpeg_no_eoi.jpg', jpg[:-2])
write('broken_jpeg_truncated.jpg', jpg[: len(jpg) // 2])
write('broken_jpeg_header.jpg', jpg[:40])
write('broken_bmp_truncated.bmp', read('_big.bmp')[:5000])
write('broken_gif_truncated.gif', read('_big.gif')[:-200])
write('broken_tiff_truncated.tif', read('_big.tif')[:3000])
write('broken_pcx_no_palette.pcx', read('pcx_8bit.pcx')[:-769])
write('fake_text.jpg', 'Это обычный текстовый файл, переименованный в .jpg\n'.encode('utf-8'))
write('fake_random.bmp', bytes(random.randrange(256) for _ in range(500)))
write('empty.png', b'')
write('png_renamed.jpg', read('png_rgb.png'))
write('jpeg_renamed.gif', read('jpeg_baseline.jpg'))
write('jpeg_trailing.jpg', read('jpeg_baseline.jpg') + b'\0' * 100)
for name in ('_big.png', '_big.jpg', '_big.bmp', '_big.gif', '_big.tif'):
    os.remove(path(name))
print('ok')
