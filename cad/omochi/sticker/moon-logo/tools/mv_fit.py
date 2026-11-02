"""Fit an arch (elliptical dome on a rectangle with rounded bottom corners) to each silhouette."""
import sys, json, pathlib
import numpy as np
D = pathlib.Path('F:/Document/Research/software/pcb/cosmic-ray-detector/cosmic-ray-detector-v2/cad/omochi/sticker/moon-logo')


def arch_mask(shape, x0, x1, y0, y1, ry, r, p=2.0):
    H, W = shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    cx = (x0 + x1) / 2; rx = (x1 - x0) / 2
    m = (xx >= x0) & (xx <= x1) & (yy >= y0) & (yy <= y1)
    # dome: |dx/rx|^p + |(y - (y0+ry))/ry|^p <= 1 for y < y0 + ry
    d = np.abs((xx - cx) / rx) ** p + np.abs((yy - (y0 + ry)) / ry) ** p
    m &= ~((yy < y0 + ry) & (d > 1))
    # bottom corners: circle of radius r
    for sx, ccx in ((-1, x0 + r), (1, x1 - r)):
        corner = (yy > y1 - r) & ((xx - ccx) * sx > 0)
        m &= ~(corner & ((xx - ccx) ** 2 + (yy - (y1 - r)) ** 2 > r * r))
    return m


def iou(a, b):
    return (a & b).sum() / (a | b).sum()


out = {}
for name in sys.argv[1:]:
    sil = np.load(D / ('work-' + name) / 'sil.npy')
    ys, xs = np.nonzero(sil)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    sub = 2  # fit on a half-size grid for speed
    s = sil[::sub, ::sub]
    X0, X1, Y0, Y1 = x0 / sub, x1 / sub, y0 / sub, y1 / sub
    best = (0, None)
    for p in (2.0, 2.5, 3.0):
        for ry in np.linspace(0.20, 0.55, 15) * (Y1 - Y0):
            for r in np.linspace(0.04, 0.22, 10) * (X1 - X0):
                m = arch_mask(s.shape, X0, X1, Y0, Y1, ry, r, p)
                v = iou(m, s)
                if v > best[0]:
                    best = (v, (p, ry, r))
    v, (p, ry, r) = best
    w, h = (x1 - x0), (y1 - y0)
    print(name, 'bbox', x0, y0, x1, y1, 'w,h', w, h, 'aspect %.3f' % (w / h), 'IoU %.4f' % v,
          'p', p, 'ry/h %.3f' % (ry / (Y1 - Y0)), 'r/w %.3f' % (r / (X1 - X0)))
    out[name] = dict(bbox=[int(x0), int(y0), int(x1), int(y1)], p=p, ry=float(ry * sub), r=float(r * sub), iou=float(v))
json.dump(out, open(D / 'fit.json', 'w'))
