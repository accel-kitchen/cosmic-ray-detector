"""Step 1: silhouette + fixed palette + smooth label map for a generated sticker.
usage: python mv_labels.py NAME   (reads gen-NAME.png in moon-logo/, writes work-NAME/*)"""
import sys, json, pathlib
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.cluster.vq import kmeans2

D = pathlib.Path(__file__).resolve().parent.parent
name = sys.argv[1]
K = int(sys.argv[2]) if len(sys.argv) > 2 else 9
W = D / ('work-' + name); W.mkdir(exist_ok=True)
im = Image.open(D / ('gen-' + name + '.png')).convert('RGB')
a = np.asarray(im).astype(np.float32)
H, Wd = a.shape[:2]

# --- silhouette: everything that is not the white page. The cream body is only ~12 levels darker in blue.
nonwhite = (a[..., 2] < 249) | (a[..., 1] < 251)
nonwhite = ndi.binary_opening(nonwhite, iterations=2)
lab, n = ndi.label(nonwhite)
big = np.argmax(np.bincount(lab.ravel())[1:]) + 1
sil = ndi.binary_fill_holes(lab == big)
ys, xs = np.nonzero(sil)
bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
print(name, 'silhouette bbox', bbox, 'area', int(sil.sum()))
np.save(W / 'sil.npy', sil)

# --- palette: k-means on the inside pixels, in a perceptual-ish space (plain Lab via skimage)
from skimage.color import rgb2lab, lab2rgb
inside = sil & ~ndi.binary_erosion(sil, iterations=6)
inside = ndi.binary_erosion(sil, iterations=6)
px = a[inside]
rng = np.random.default_rng(1)
sub = px[rng.choice(len(px), 200000, replace=False)]
sublab = rgb2lab((sub / 255.0).reshape(-1, 1, 3)).reshape(-1, 3)
cent, _ = kmeans2(sublab, K, minit='++', seed=3, iter=30)
rgb = (lab2rgb(cent.reshape(-1, 1, 3)).reshape(-1, 3) * 255).round().astype(int)
cnt = np.bincount(np.argmin(((sublab[:, None, :] - cent[None]) ** 2).sum(-1), 1), minlength=K)
order = np.argsort(-cnt)
for i in order:
    print('  #%02X%02X%02X' % tuple(rgb[i]), cnt[i], 'L=%.0f' % cent[i][0])
json.dump({'bbox': bbox, 'palette': [[int(v) for v in rgb[i]] for i in order], 'count': [int(cnt[i]) for i in order]}, open(W / 'pal0.json', 'w'))
