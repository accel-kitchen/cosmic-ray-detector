"""2D artwork for the OMOCHI case variants (millimetres, built with manifold3d CrossSection).

Local drawing frame: s = to the viewer's right, t = up, as seen from above with the
OLED face of the case towards the viewer. Everything is hand-built from ellipses and
capsules, so there is no font or illustration licence to carry; the lettering uses the
SIL-OFL licensed BIZ UDGothic that ships with Windows.
"""
from pathlib import Path
import numpy as np
from manifold3d import CrossSection, JoinType, FillRule

FONT = Path('C:/Windows/Fonts/BIZ-UDGothicB.ttc')


def ell(cx, cy, rx, ry, rot=0.):
    return CrossSection.circle(1., 72).scale([rx, ry]).rotate(rot).translate([cx, cy])


def rrect(cx, cy, w, h, rot=0., r=.5):
    r = min(r, w / 2 - .01, h / 2 - .01)
    return CrossSection.square([w - 2 * r, h - 2 * r], True).offset(r, JoinType.Round, 2, 32).rotate(rot).translate([cx, cy])


def capsule(p, q, w):
    p, q = np.array(p, float), np.array(q, float)
    d = q - p
    return rrect(*((p + q) / 2), np.hypot(*d) + w, w, np.degrees(np.arctan2(d[1], d[0])), w / 2)


def union(parts):
    out = parts[0]
    for p in parts[1:]:
        out = out + p
    return out


def rabbit():
    """Moon rabbit pounding mochi, facing right, fitted inside a circle of radius ~12.5."""
    body = [ell(-3.4, -3.6, 6.4, 5.0, 12.), ell(-6.2, -5.4, 4.0, 3.4, 0.), ell(-10.0, -2.6, 1.9, 1.9)]
    head = [ell(2.4, 2.0, 4.0, 3.5, -12.), ell(6.0, 1.3, 1.2, 1.0)]
    ears = [ell(0.6, 8.9, 1.25, 4.3, 14.), ell(3.8, 8.5, 1.2, 4.0, -6.)]
    arm = [capsule((2.0, -1.6), (6.0, 0.9), 2.0)]
    kine = [capsule((6.0, 0.9), (10.0, 5.0), 1.5),
            rrect(10.4, 5.4, 6.4, 3.3, 135., 1.2)]
    usu = [rrect(6.8, -8.9, 9.6, 5.4, 0., 1.4), ell(6.8, -6.0, 4.1, 1.7)]
    shape = union(body + head + ears + arm + kine + usu)
    return shape


def fitted_rabbit(radius=12.6):
    shape = rabbit()
    x0, y0, x1, y1 = shape.bounds()
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    far = max(np.hypot(px - cx, py - cy) for poly in shape.to_polygons() for px, py in poly)
    k = radius / far
    return shape.translate([-cx, -cy]).scale([k, k])


def moon_ring(r_out=16.4, r_in=14.9):
    return CrossSection.circle(r_out, 128) - CrossSection.circle(r_in, 128)


def logo():
    """Moon ring with the rabbit inside it."""
    return moon_ring() + fitted_rabbit(13.0)


def diamond(cx, cy, size):
    return CrossSection.square([size, size], True).rotate(45.).translate([cx, cy])


def salt_grains(cx=0., cy=0., radius=21.5):
    """A sprinkle of tiny diamonds for the CsI (salt) edition."""
    ang = np.radians([152., 182., 212., 242., 272., 302., 332., 2., 32., 140.])
    size = [2.6, 1.8, 2.4, 1.6, 2.8, 1.8, 2.4, 1.6, 2.6, 1.9]
    rad = [radius, radius + 1.8, radius - .6, radius + 1.4, radius, radius + 2., radius - 1., radius + 1.6, radius + .4, radius + 1.2]
    return union([diamond(cx + r * np.cos(a), cy + r * np.sin(a), s) for a, s, r in zip(ang, size, rad)])


def text(txt, height, fit_width=None):
    """Outline of a line of text, centred on the origin, `height` mm tall (tallest glyph)."""
    from matplotlib.font_manager import FontProperties
    from matplotlib.textpath import TextPath
    path = TextPath((0, 0), txt, size=20, prop=FontProperties(fname=str(FONT)))
    polys = [p for p in path.to_polygons(closed_only=True) if len(p) > 2]
    cs = CrossSection(polys, FillRule.EvenOdd)
    x0, y0, x1, y1 = cs.bounds()
    k = height / (y1 - y0)
    if fit_width and (x1 - x0) * k > fit_width:
        k = fit_width / (x1 - x0)
    return cs.translate([-(x0 + x1) / 2, -(y0 + y1) / 2]).scale([k, k])
