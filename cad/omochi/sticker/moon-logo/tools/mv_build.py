"""Step 3: layered mm-unit SVG (ground / art / logo-lockup / cutline) from the traced art + the real logo.
usage: python mv_build.py NAME"""
import sys, re, json, pathlib
from playwright.sync_api import sync_playwright

D = pathlib.Path('F:/Document/Research/software/pcb/cosmic-ray-detector/cosmic-ray-detector-v2/cad/omochi/sticker/moon-logo')
name = sys.argv[1]
W = D / ('work-' + name)
snap = json.load(open(W / 'snap.json'))
pal = snap['palette']
CREAM, NAVY, GOLD = '#' + pal[0], '#' + pal[1], '#' + pal[2]
PINK = '#' + pal[-1]
LOGO_W = 32.0                      # mm, same for both stickers

# ---- sticker geometry (mm). Trim 52 x 70, bleed 3 mm.
TW, TH, B = 52.0, 70.0, 3.0
PW, PH = TW + 2 * B, TH + 2 * B
RY, R = 27.0, 10.0                 # dome height, bottom corner radius
def arch(x0, y0, x1, y1, ry, r):
    rx = (x1 - x0) / 2
    return (f'M{x0:g},{y0 + ry:g}A{rx:g},{ry:g} 0 0 1 {x1:g},{y0 + ry:g}L{x1:g},{y1 - r:g}'
            f'A{r:g},{r:g} 0 0 1 {x1 - r:g},{y1:g}L{x0 + r:g},{y1:g}A{r:g},{r:g} 0 0 1 {x0:g},{y1 - r:g}Z')
trim_d = arch(B, B, B + TW, B + TH, RY, R)
bleed_d = arch(0, 0, PW, PH, RY + B, R + B)

# ---- art: placement of the 3200x4000 trace into the page
sx0, sy0, sx1, sy1 = snap['sil_bbox']
sw, sh = sx1 - sx0, sy1 - sy0
FIT = {'owan': 1.0, 'ohashi': 0.965}   # ohashi art runs closer to the cutline, so pull it in
s = min(TW / sw, TH / sh) * FIT[name]
cx_mm, cy_mm = B + TW / 2, B + TH / 2
cxs, cys = (sx0 + sx1) / 2, (sy0 + sy1) / 2
k = s / 2                                      # trace units are 2x source px
tx, ty = cx_mm - cxs * s, cy_mm - cys * s
print(name, 'scale %.5f mm/px' % s, 'art size %.2f x %.2f mm' % (sw * s, sh * s))

tr = open(W / 'trace.svg', encoding='utf-8').read()
paths = re.findall(r'<path d="([^"]*)" fill="(#[0-9A-Fa-f]{6})"(?: transform="([^"]*)")?/>', tr)
print(len(paths), 'traced paths')
def bbox_of(d, tf):
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', d)))
    xs, ys = nums[0::2], nums[1::2]
    dx = dy = 0.0
    m = re.search(r'translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)', tf or '')
    if m: dx, dy = float(m.group(1)), float(m.group(2))
    return min(xs) + dx, min(ys) + dy, max(xs) + dx, max(ys) + dy
out_paths = []
dropped = []
for i, (d, fill, tf) in enumerate(paths):
    f = fill.upper()
    bb = bbox_of(d, tf)
    big = (bb[2] - bb[0]) > 0.85 * 3200 * (sw / 3200 * 1.0) * 2 / 2 and (bb[3] - bb[1]) > 0.85 * sh * 2
    if f == '#FFFFFF': dropped.append((i, 'page')); continue
    if f == CREAM.upper() and (bb[2] - bb[0]) > 0.85 * sw * 2 and (bb[3] - bb[1]) > 0.85 * sh * 2:
        dropped.append((i, 'cream body ring')); continue
    out_paths.append((d, f, tf))
print('dropped', dropped, 'kept', len(out_paths))

def fmt_tf(tf):
    return f' transform="{tf}"' if tf else ''
art_svg = '\n'.join(f'<path d="{d}" fill="{f}"{fmt_tf(tf)}/>' for d, f, tf in out_paths)

# ---- real logo, recoloured into the sticker palette
lg = open('F:/Document/Website/accel-kitchen/4x/accel-kitchen-material-logo-outline-03.svg', encoding='utf-8').read()
body = lg[lg.index('</defs>') + 7: lg.rindex('</svg>')]
cls = {
    'st0': f'fill="none" stroke="{CREAM}" stroke-miterlimit="10" stroke-width=".9"',
    'st1': f'fill="none" stroke="{NAVY}" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round"',
    'st2': f'fill="{NAVY}"',
    'st3': f'fill="{NAVY}"',
    'st4': f'fill="{PINK}"',
}
body = re.sub(r'class="(st\d)"', lambda m: cls[m.group(1)], body)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    pg.set_content('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 80" width="720">' + '<g id="g">' + body + '</g></svg>')
    bb = pg.evaluate("(() => { const r = document.getElementById('g').getBBox(); return [r.x, r.y, r.width, r.height]; })()")
    b.close()
lx, ly, lw, lh = bb
ls = LOGO_W / lw
gl = snap['logo_bbox']
gcx, gcy = (gl[0] + gl[2]) / 2 * s + tx, (gl[1] + gl[3]) / 2 * s + ty
ltx, lty = gcx - (lx + lw / 2) * ls, gcy - (ly + lh / 2) * ls
print('logo %.1f x %.1f mm at center (%.1f, %.1f)' % (LOGO_W, lh * ls, gcx, gcy))

CUT = '#FF00FF'
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{PW:g}mm" height="{PH:g}mm" viewBox="0 0 {PW:g} {PH:g}">
<title>{name.upper()} sticker (moon style, with Accel Kitchen logo)</title>
<defs><clipPath id="bleed"><path d="{bleed_d}"/></clipPath></defs>
<g id="ground"><path d="{bleed_d}" fill="{CREAM}"/></g>
<g id="art" clip-path="url(#bleed)"><g transform="translate({tx:.3f} {ty:.3f}) scale({k:.6f})">
{art_svg}
</g></g>
<g id="logo-lockup" transform="translate({ltx:.3f} {lty:.3f}) scale({ls:.5f})">{body}</g>
<g id="cutline"><path d="{trim_d}" fill="none" stroke="{CUT}" stroke-width=".25"/></g>
</svg>
'''
(D / f'sticker-{name}-moon-vector.svg').write_text(svg, encoding='utf-8')
# no-cutline, no-bleed web version: trim size only, clipped to the arch
web = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{B:g} {B:g} {TW:g} {TH:g}">
<defs><clipPath id="c"><path d="{trim_d}"/></clipPath></defs>
<g clip-path="url(#c)">
<path d="{bleed_d}" fill="{CREAM}"/>
<g transform="translate({tx:.3f} {ty:.3f}) scale({k:.6f})">
{art_svg}
</g>
<g transform="translate({ltx:.3f} {lty:.3f}) scale({ls:.5f})">{body}</g>
</g></svg>
'''
(W / 'web.svg').write_text(web, encoding='utf-8')
json.dump({'scale_mm_per_px': s, 'art_mm': [sw * s, sh * s], 'logo_center': [gcx, gcy], 'logo_mm': [LOGO_W, lh * ls]}, open(W / 'build.json', 'w'))
print('written', len(svg) // 1024, 'KB')
