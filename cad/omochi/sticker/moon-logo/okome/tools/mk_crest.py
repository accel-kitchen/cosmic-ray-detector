"""Round crest (moon + the utensil) cut out of the traced sticker art. usage: python mk_crest.py   (needs work-*/web.svg; writes site/crest-*.svg, svgo'd to *.min.svg)"""
import re, pathlib, subprocess
D = pathlib.Path(__file__).resolve().parent.parent
# OKOME 版: 月 + 丸カンつきの米粒 + 粒子の飛跡。雲・桜・星は外す（79 は縁に残る小さな星の点）。
# notch は雲の縁取りで月が欠けたところ。左右 2 か所あるので、矩形のリストにした。
CFG = {
    'okome': dict(cx=26.0, cy=18.6, r=18.5, box=(12.0, 3.0, 40.5, 34.0), drop={79}, moon=(25.2, 16.2, 12.4), notch=[(10, 10.5, 19.0, 19.6)]),
}
(D / 'site').mkdir(exist_ok=True)
for n, c in CFG.items():
    s = open(D / f'work-{n}/web.svg', encoding='utf-8').read()
    gt = re.search(r'<g transform="(translate\([^"]*\) scale\([^"]*\))">', s).group(1)
    tx, ty, k = map(float, re.search(r'translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)', gt).groups())
    ground = re.search(r'<path d="M0,0H56.32V74H0Z" fill="(#[0-9A-F]{6})"', s).group(1)
    paths = re.findall(r'<path d="([^"]*)" fill="(#[0-9A-Fa-f]{6})"(?: transform="([^"]*)")?/>', s)
    x0b, y0b, x1b, y1b = c['box']
    keep = []
    for i, (d, f, tf) in enumerate(paths):
        if i == 0 or i in c['drop']: continue
        nums = list(map(float, re.findall(r'-?\d+\.?\d*', d))); xs, ys = nums[0::2], nums[1::2]
        mt = re.search(r'translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)', tf or ''); dx, dy = (float(mt.group(1)), float(mt.group(2))) if mt else (0, 0)
        X0, X1 = (min(xs) + dx) * k + tx - 3, (max(xs) + dx) * k + tx - 3
        Y0, Y1 = (min(ys) + dy) * k + ty - 3, (max(ys) + dy) * k + ty - 3
        if X0 >= x0b and X1 <= x1b and Y0 >= y0b and Y1 <= y1b: keep.append((i, d, f, tf))
    gold = next(f for i, d, f, tf in keep if i == 1)
    out = []
    for j, (i, d, f, tf) in enumerate(keep):
        out.append(f'<path d="{d}" fill="{f}"' + (f' transform="{tf}"' if tf else '') + '/>')
        if i == 1 and c['notch']:   # the moon path has notches where the clouds' outlines were: fill them with a gold disc clipped to those corners
            mx, my, mr = c['moon']
            rects = ''.join(f'<rect x="{a + 3}" y="{b + 3}" width="{e - a}" height="{g - b}"/>' for a, b, e, g in c['notch'])
            out.append(f'</g><clipPath id="n">{rects}</clipPath><circle cx="{mx + 3}" cy="{my + 3}" r="{mr}" fill="{gold}" clip-path="url(#n)"/><g transform="{gt}">')
    cx, cy, r = c['cx'] + 3, c['cy'] + 3, c['r']
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{cx - r:g} {cy - r:g} {2 * r:g} {2 * r:g}" width="200" height="200">\n'
           f'<defs><clipPath id="k"><circle cx="{cx:g}" cy="{cy:g}" r="{r:g}"/></clipPath></defs>\n'
           f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}" fill="{ground}"/>\n<g clip-path="url(#k)"><g transform="{gt}">\n' + '\n'.join(out) + '\n</g></g></svg>\n')
    (D / f'site/crest-{n}.svg').write_text(svg, encoding='utf-8')
    subprocess.run(['npx', '--yes', 'svgo', '-p', '2', '--multipass', str(D / f'site/crest-{n}.svg'), '-o', str(D / f'site/crest-{n}.min.svg')], shell=True, check=True, capture_output=True)
    print(n, len(keep), 'paths,', (D / f'site/crest-{n}.min.svg').stat().st_size, 'bytes')
