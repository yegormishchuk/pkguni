"""Запуск: python lab3/samples/analyze.py. Нужны Pillow и Node.js в PATH."""
from pathlib import Path
import base64
import json
import subprocess
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).parent
names = ['shadows', 'lowcontrast', 'saltpepper']
def data(name):
    return base64.b64encode(Image.open(root / (name + '.png')).convert('L').tobytes()).decode()
payload = dict(width=720, height=360, mask=data('text-mask'), samples=[dict(name=n, data=data(n)) for n in names])
result = subprocess.run(['node', str(root / 'measure.mjs')], input=json.dumps(payload), text=True, capture_output=True, check=True)
rows = json.loads(result.stdout)
metrics = [{k:v for k,v in r.items() if k != 'pixels'} for r in rows]
(root / 'measurements.json').write_text(json.dumps(metrics, indent=2), encoding='utf8')
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 17)
figure = Image.new('RGB', (1440, 3*230), '#f6f6f4')
draw = ImageDraw.Draw(figure)
for y, name in enumerate(names):
    selected = ['Niblack k=-0.8', 'Bernsen C=40', 'Median 3x3 + Sauvola']
    images = [(Image.open(root / (name+'.png')), name)]
    for method in selected:
        r = next(r for r in rows if r['sample']==name and r['method']==method)
        im = Image.frombytes('L', (720,360), base64.b64decode(r['pixels']))
        images.append((im, f"{method}; F1={r['f1']:.4f}"))
    for x, (im, label) in enumerate(images):
        figure.paste(im.resize((348,174)), (x*360+6,y*230+42))
        draw.text((x*360+6, y*230+12), label, font=font, fill='#1c1c1e')
figure.save(root / 'comparison.png')
# Сравнение исходных и бинарных гистограмм; нормировка отдельно на максимум.
chart = Image.new('RGB',(1000,660),'white')
draw = ImageDraw.Draw(chart)
for y,name in enumerate(names):
    original=Image.open(root/(name+'.png')).convert('L').histogram()
    after=next(r['histogram'] for r in rows if r['sample']==name and r['method']=='Median 3x3 + Sauvola')
    for x,(hist,title) in enumerate([(original,name+' / before'),(after,name+' / after')]):
        x0=x*500+20;y0=y*220+190
        draw.text((x0,y*220+12),title,font=font,fill='#1c1c1e')
        for i,count in enumerate(hist):
            h=150*count/max(hist)
            draw.rectangle((x0+i*1.8,y0-h,x0+i*1.8+1,y0),fill='#3a5bd9')
        draw.text((x0,y0+3),'0',font=font,fill='#6b6b70')
        draw.text((x0+430,y0+3),'255',font=font,fill='#6b6b70')
chart.save(root/'histograms.png')
for r in rows:
    print(r['sample'],r['method'],r['f1'],r['ms'])
