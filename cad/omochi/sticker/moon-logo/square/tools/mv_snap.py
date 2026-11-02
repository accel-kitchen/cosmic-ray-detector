"""Step 2: snap the generated image to a fixed flat palette, smooth, upscale 2x, blank the generated logo.
usage: python mv_snap.py NAME"""
import sys, json, pathlib
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from skimage.color import rgb2lab

D = pathlib.Path(__file__).resolve().parent.parent
name = sys.argv[1]
W = D / ('work-' + name)
PALS = {
    # name: (hex)  -- first entry is the ground (night sky), then the inks
    'owan': ['0A505C', 'F4F6EA', 'F6D451', 'FBA2C1', '88E5BA'],
    'ohashi': ['1F327C', 'F9F0E7', 'FBAB38', 'BC662A', 'F99DBE'],
}
pal = np.array([[int(h[i:i + 2], 16) for i in (0, 2, 4)] for h in PALS[name]], dtype=np.float32)
im = Image.open(D / ('gen-' + name + '.png')).convert('RGB')
a = np.asarray(im).astype(np.float32)
H, Wd = a.shape[:2]
sil = np.load(W / 'sil.npy')

lab = rgb2lab(a / 255.0)
plab = rgb2lab((pal / 255.0).reshape(-1, 1, 3)).reshape(-1, 3)
d = ((lab[:, :, None, :] - plab[None, None]) ** 2).sum(-1)
L0 = d.argmin(-1)
rim = sil & ~ndi.binary_erosion(sil, iterations=10)
L0[rim] = 0                       # the anti-aliased rim against the white page is ground, not ink
L0[~sil] = len(pal)               # bg label
nl = len(pal) + 1

# smooth: blur each one-hot map, 2x zoom, take argmax
S = 2
best = np.full((H * S, Wd * S), -1, np.float32)
lab2 = np.zeros((H * S, Wd * S), np.uint8)
for k in range(nl):
    g = ndi.gaussian_filter((L0 == k).astype(np.float32), 1.4)
    g2 = ndi.zoom(g, S, order=1)
    m = g2 > best
    best[m] = g2[m]
    lab2[m] = k
del best

# --- generated logo band: last band of non-cream rows near the bottom of the silhouette
ys, xs = np.nonzero(sil)
x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
ink = (L0 != 0) & (L0 != len(pal)) & ndi.binary_erosion(sil, iterations=40)
rows = ink[:, x0 + int(0.12 * (x1 - x0)): x1 - int(0.12 * (x1 - x0))].sum(1)
yy = np.arange(int(y1 - 0.30 * (y1 - y0)), int(y1 - 0.02 * (y1 - y0)))
on = rows[yy] > 0
bands = []
st = None
for y, o in zip(yy, on):
    if o and st is None: st = y
    if not o and st is not None:
        if bands and st - bands[-1][1] < 12: bands[-1][1] = y
        else: bands.append([st, y])
        st = None
if st is not None: bands.append([st, yy[-1]])
print(name, 'bands (y0,y1):', bands)
by0, by1 = bands[-1]
cols = np.nonzero(ink[by0:by1].sum(0))[0]
lbox = [int(cols.min()), int(by0), int(cols.max()), int(by1)]
print('generated logo bbox', lbox, 'w', lbox[2] - lbox[0], 'h', lbox[3] - lbox[1])
pad = 14
lab2[(lbox[1] - pad) * S:(lbox[3] + pad) * S, (lbox[0] - pad) * S:(lbox[2] + pad) * S] = 0   # cream
np.save(W / 'lab2.npy', lab2)
json.dump({'logo_bbox': lbox, 'bands': [[int(p), int(q)] for p, q in bands], 'sil_bbox': [int(x0), int(y0), int(x1), int(y1)], 'palette': PALS[name], 'scale': S, 'size': [Wd, H]}, open(W / 'snap.json', 'w'))

pal_img = np.vstack([pal, [255, 255, 255]]).astype(np.uint8)
Image.fromarray(pal_img[lab2]).save(W / 'snap2x.png')
Image.fromarray(pal_img[lab2]).resize((800, 1000), Image.NEAREST).save(W / 'snap-preview.png')
