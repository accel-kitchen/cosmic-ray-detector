"""Step 4: print PDF, optimised web SVG, and checks (cutline distance, colour IoU). usage: python mv_post_rect.py NAME"""
import sys, re, json, pathlib, subprocess
import numpy as np
import fitz
from PIL import Image
from scipy import ndimage as ndi
from playwright.sync_api import sync_playwright

D = pathlib.Path(__file__).resolve().parent.parent
name = sys.argv[1]
W = D / ('work-' + name)

# ---- print PDF
doc = fitz.open(str(W / 'print.svg')); pdf = fitz.open('pdf', doc.convert_to_pdf()); pg = pdf[0]
B = 3 / 25.4 * 72; r = pg.rect
pg.set_trimbox(fitz.Rect(B, B, r.width - B, r.height - B)); pg.set_bleedbox(r)
pdf.save(str(D / f'sticker-{name}-night-print.pdf'))
print(name, 'pdf: page %.2f x %.2f mm, images %d, fonts %d' % (r.width / 72 * 25.4, r.height / 72 * 25.4, len(pg.get_images()), len(pg.get_fonts())))

# ---- web SVG
(D / 'web').mkdir(exist_ok=True)
subprocess.run(['npx', '--yes', 'svgo', '-p', '2', '--multipass', str(W / 'web.svg'), '-o', str(D / 'web' / f'sticker-{name}-night.svg')], shell=True, check=True, capture_output=True)
print('web svg: %.1f KB' % ((D / 'web' / f'sticker-{name}-night.svg').stat().st_size / 1024))

# ---- distance from art to cutline, at 20 px/mm
PPM = 20
imgs = []
with sync_playwright() as p:
    b = p.chromium.launch()
    for f in (D / f'sticker-{name}-night-vector.svg', W / 'print.svg', D / 'web' / f'sticker-{name}-night.svg'):
        h = D / '_m.html'
        wmm = 58 if f.name.endswith('vector.svg') or f.name == 'print.svg' else None
        vb = re.search(r'viewBox="([^"]+)"', f.read_text(encoding='utf-8')).group(1).split()
        wpx, hpx = int(round(float(vb[2]) * PPM)), int(round(float(vb[3]) * PPM))
        h.write_text(f'<body style="margin:0;background:#fff"><img src="{f.as_uri()}" style="width:{wpx}px;height:{hpx}px;display:block"></body>', encoding='utf-8')
        pg2 = b.new_page(viewport={'width': wpx, 'height': hpx}); pg2.goto(h.as_uri()); pg2.wait_for_timeout(600)
        pg2.screenshot(path=str(D / '_m.png')); pg2.close()
        imgs.append(np.asarray(Image.open(D / '_m.png').convert('RGB')).astype(int))
    b.close()
for f in ('_m.html', '_m.png'): (D / f).unlink()
cut, prt, web = imgs
mag = ndi.binary_dilation((cut[..., 0] > 200) & (cut[..., 1] < 90) & (cut[..., 2] > 200), iterations=2)
inside = ndi.binary_fill_holes(mag)
ground = np.array([int(h_, 16) for h_ in re.findall(r'<g id="ground"><path d="[^"]*" fill="#([0-9A-F]{6})"', (D / f'sticker-{name}-night-vector.svg').read_text(encoding='utf-8'))[0:1] for h_ in (h_[0:2], h_[2:4], h_[4:6])])
art = (np.abs(prt - ground).max(-1) > 40) & inside
edt = ndi.distance_transform_edt(inside) / PPM
ys, xs = np.nonzero(art)
print('art to cutline: min %.2f mm | art bbox in trim: x %.1f-%.1f, y %.1f-%.1f of 50.32 x 68' % (edt[art].min(), xs.min() / PPM - 3, xs.max() / PPM - 3, ys.min() / PPM - 3, ys.max() / PPM - 3))

# ---- web vs full SVG: pixel difference inside the trim
a = prt[3 * PPM:3 * PPM + web.shape[0], 3 * PPM:3 * PPM + web.shape[1]]
hh, ww = min(a.shape[0], web.shape[0]), min(a.shape[1], web.shape[1])
d = np.abs(a[:hh, :ww] - web[:hh, :ww]).max(-1)
m = ndi.binary_erosion(inside[3 * PPM:3 * PPM + hh, 3 * PPM:3 * PPM + ww], iterations=4)
print('web vs print inside trim: %.2f%% of pixels differ by more than 40' % (100 * (d[m] > 40).mean()))
