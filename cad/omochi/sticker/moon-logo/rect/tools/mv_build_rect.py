"""Step 3 (rounded-rectangle version): layered mm-unit SVG (ground / art / logo-lockup / cutline), per-sticker colourway.
usage: python mv_build_rect.py NAME      (needs work-NAME/trace.svg from mv_snap.py + vtracer, see mv_trace.py)"""
import sys, re, json, pathlib
from playwright.sync_api import sync_playwright

D = pathlib.Path(__file__).resolve().parent.parent
name = sys.argv[1]
W = D / ('work-' + name)
snap = json.load(open(W / 'snap.json'))
src_pal = ['#' + h.upper() for h in snap['palette']]       # as snapped: cream, navy, gold, [dark gold,] pink, red

# ---- colourways: source colour -> final colour. Ground = the sticker body; the logo and the dark text follow the window colour.
WAYS = {
    'owan': {   # 若草寄り: pale green body, teal-leaning night
        'ground': '#DDE5B9', 'cream': '#DDE5B9', 'navy': '#0A4363', 'gold': '#E9B53C', 'pink': '#F58FA2', 'red': '#C8312B',
    },
    'ohashi': {  # 生成り寄り: kraft-cream body, indigo night
        'ground': '#F1E1C2', 'cream': '#F1E1C2', 'navy': '#1B2A78', 'gold': '#F2B22E', 'dgold': '#C47A1A', 'pink': '#F58BB0', 'red': '#B3272E',
    },
}
way = WAYS[name]
keys = ['cream', 'navy', 'gold'] + (['dgold'] if name == 'ohashi' else []) + ['pink', 'red']
remap = {src_pal[i]: way[k].upper() for i, k in enumerate(keys)}
print(name, 'colour map', remap)

# ---- sticker geometry (mm). Same size as the earlier style-15 stickers: trim 50.32 x 68, R 9.77, bleed 3.
TW, TH, B, R = 50.32, 68.0, 3.0, 9.77
PW, PH = TW + 2 * B, TH + 2 * B
def rrect(x0, y0, x1, y1, r):
    return (f'M{x0 + r:g},{y0:g}H{x1 - r:g}A{r:g},{r:g} 0 0 1 {x1:g},{y0 + r:g}V{y1 - r:g}A{r:g},{r:g} 0 0 1 {x1 - r:g},{y1:g}'
            f'H{x0 + r:g}A{r:g},{r:g} 0 0 1 {x0:g},{y1 - r:g}V{y0 + r:g}A{r:g},{r:g} 0 0 1 {x0 + r:g},{y0:g}Z')
trim_d = rrect(B, B, B + TW, B + TH, R)
bleed_d = rrect(0, 0, PW, PH, R + B)

# ---- art placement: fit the generated silhouette into the trim box, never touching the cutline
FIT = {'owan': 1.0, 'ohashi': 1.0}
sx0, sy0, sx1, sy1 = snap['sil_bbox']
sw, sh = sx1 - sx0, sy1 - sy0
s = min(TW / sw, TH / sh) * FIT[name]            # mm per source px
cxs, cys = (sx0 + sx1) / 2, (sy0 + sy1) / 2
tx, ty = B + TW / 2 - cxs * s, B + TH / 2 - cys * s
k = s / 2                                          # trace units are 2x source px
print(name, 'scale %.5f mm/px' % s, 'art %.2f x %.2f mm' % (sw * s, sh * s))

tr = open(W / 'trace.svg', encoding='utf-8').read()
paths = re.findall(r'<path d="([^"]*)" fill="(#[0-9A-Fa-f]{6})"(?: transform="([^"]*)")?/>', tr)
def bbox_of(d, tf):
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', d)))
    xs, ys = nums[0::2], nums[1::2]
    m = re.search(r'translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)', tf or '')
    dx, dy = (float(m.group(1)), float(m.group(2))) if m else (0.0, 0.0)
    return min(xs) + dx, min(ys) + dy, max(xs) + dx, max(ys) + dy
kept, dropped = [], []
PINK_SRC = src_pal[-2]
pink_boxes = [bbox_of(d, tf) for d, fl, tf in paths if fl.upper() == PINK_SRC]
def inside_pink(bb):
    return any(bb[0] >= q[0] - 2 and bb[1] >= q[1] - 2 and bb[2] <= q[2] + 2 and bb[3] <= q[3] + 2 for q in pink_boxes)
n_centres = 0
for i, (d, fill, tf) in enumerate(paths):
    f = fill.upper(); bb = bbox_of(d, tf)
    if f == src_pal[0] and (bb[2] - bb[0]) < 200 and inside_pink(bb):   # white hole in a flower -> gold centre
        kept.append((d, way['gold'].upper(), tf)); n_centres += 1; continue
    if f == '#FFFFFF': dropped.append((i, 'page')); continue
    if f == src_pal[0] and (bb[2] - bb[0]) > 0.85 * sw * 2 and (bb[3] - bb[1]) > 0.85 * sh * 2:
        dropped.append((i, 'cream body')); continue
    kept.append((d, remap.get(f, f), tf))
print('dropped', dropped, 'kept', len(kept), 'of', len(paths), '| flower centres recoloured:', n_centres)
art_svg = '\n'.join(f'<path d="{d}" fill="{f}"' + (f' transform="{tf}"' if tf else '') + '/>' for d, f, tf in kept)

# ---- the real logo, in the sticker's colours
lg = open('F:/Document/Website/accel-kitchen/4x/accel-kitchen-material-logo-outline-03.svg', encoding='utf-8').read()
body = lg[lg.index('</defs>') + 7: lg.rindex('</svg>')]
NAVY, PINK, GROUND = way['navy'].upper(), way['pink'].upper(), way['ground'].upper()
cls = {
    'st0': f'fill="none" stroke="{GROUND}" stroke-miterlimit="10" stroke-width=".9"',
    'st1': f'fill="none" stroke="{NAVY}" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round"',
    'st2': f'fill="{NAVY}"', 'st3': f'fill="{NAVY}"', 'st4': f'fill="{PINK}"',
}
body = re.sub(r'class="(st\d)"', lambda m: cls[m.group(1)], body)
LOGO_W = 30.0
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    pg.set_content('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 80" width="720"><g id="g">' + body + '</g></svg>')
    lx, ly, lw, lh = pg.evaluate("(() => { const r = document.getElementById('g').getBBox(); return [r.x, r.y, r.width, r.height]; })()")
    b.close()
ls = LOGO_W / lw
gl = snap['logo_bbox']
gcx, gcy = (gl[0] + gl[2]) / 2 * s + tx, (gl[1] + gl[3]) / 2 * s + ty
ltx, lty = gcx - (lx + lw / 2) * ls, gcy - (ly + lh / 2) * ls
print('logo %.1f x %.1f mm centred at (%.1f, %.1f)' % (LOGO_W, lh * ls, gcx, gcy))

CUT = '#FF00FF'
art_g = f'<g transform="translate({tx:.3f} {ty:.3f}) scale({k:.6f})">\n{art_svg}\n</g>'
logo_g = f'transform="translate({ltx:.3f} {lty:.3f}) scale({ls:.5f})"'
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{PW:g}mm" height="{PH:g}mm" viewBox="0 0 {PW:g} {PH:g}">
<title>{name.upper()} sticker (moon style, rectangle, with Accel Kitchen logo)</title>
<defs><clipPath id="bleed"><path d="{bleed_d}"/></clipPath></defs>
<g id="ground"><path d="{bleed_d}" fill="{GROUND}"/></g>
<g id="art" clip-path="url(#bleed)">{art_g}</g>
<g id="logo-lockup" {logo_g}>{body}</g>
<g id="cutline"><path d="{trim_d}" fill="none" stroke="{CUT}" stroke-width=".25"/></g>
</svg>
'''
(D / f'sticker-{name}-rect-vector.svg').write_text(svg, encoding='utf-8')
(W / 'print.svg').write_text(re.sub(r'<g id="cutline">.*?</g>\n', '', svg, flags=re.S), encoding='utf-8')
web = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{B:g} {B:g} {TW:g} {TH:g}">
<defs><clipPath id="c"><path d="{trim_d}"/></clipPath></defs>
<g clip-path="url(#c)"><path d="{bleed_d}" fill="{GROUND}"/>
{art_g}
<g {logo_g}>{body}</g></g></svg>
'''
(W / 'web.svg').write_text(web, encoding='utf-8')
json.dump({'scale_mm_per_px': s, 'tx': tx, 'ty': ty, 'art_mm': [sw * s, sh * s], 'logo_mm': [LOGO_W, lh * ls], 'colours': way}, open(W / 'build.json', 'w'))
print('written', len(svg) // 1024, 'KB')
