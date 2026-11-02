"""OMOCHI case variants for the v2 detector (millimetres).

  1. cover   : a hollow, flat-topped "mochi" cap that slips over the lid, moon-rabbit
               logo engraved in the top face. Printed upside down (top on the bed).
  2. flavour : the same cap with a 白餅 (plain scintillator) or 塩大福 (CsI) mark.
  3. face    : the stock base with a smile and two cheeks engraved on the OLED face;
               the RESET and LED holes become the eyes.

The validated stock case in build_compact_enclosure.py is imported, never modified,
and its main() is never called, so the stock STLs and preview stay untouched.

    python cad/build_omochi_variants.py            # STLs + validation + previews
    python cad/build_omochi_variants.py --no-render
"""
from pathlib import Path
import json, subprocess, sys, tempfile
import numpy as np
import trimesh
from manifold3d import Manifold, CrossSection, FillRule, JoinType, OpType

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_compact_enclosure as cc
import omochi_art as art

OUT = HERE / 'omochi'
OUT.mkdir(exist_ok=True)
NAME = 'cosmic-ray-detector-v2-omochi'

# ---- cover geometry ---------------------------------------------------------
CAP_FIT = .3          # clearance around the lid / base outline, per side
CAP_T = 2.2           # skirt wall (horizontal) and top-plate thickness
SKIRT_DROP = 10.      # skirt reaches this far below the lid/base seam
Z_BASE = cc.TOP + 1.  # the shoulder starts here, clear of the lid screw heads
V0 = 2.5              # vertical rise before the bevel starts
BEVEL = 7.             # 45 degree shoulder: no overhang steeper than 45 deg when printed top-down
H = V0 + BEVEL        # height of the top face above Z_BASE
R_OUT = 8.            # plan corner radius of the cap at the skirt
PILLAR_R, PILLAR_GAP = 3.5, .2
ENGRAVE = .6          # depth of the logo and lettering
CX, CY = (cc.X0 + cc.X1) / 2, (cc.Y0 + cc.Y1) / 2
A_I, B_I = (cc.X1 - cc.X0) / 2 + CAP_FIT, (cc.Y1 - cc.Y0) / 2 + CAP_FIT
A_O, B_O = A_I + CAP_T, B_I + CAP_T
R_IN = cc.RADIUS + CAP_FIT
R_CAV = R_IN + .5 * CAP_T   # pillow() shrinks the corner radius by half the inset, so this gives R_IN at the skirt
Z_TOP = Z_BASE + H
Z_SKIRT = cc.SEAM - SKIRT_DROP

# ---- face geometry (design frame: u = KiCad Y, v = -Z when extruded along X) --
FACE_DEPTH = .8
SMILE_C, SMILE_R, SMILE_W = (46.6, 5.8), 7.2, 1.5
CHEEKS = [(37.0, 1.8), (56.2, 1.8)]
CHEEK_R, CHEEK_DEPTH = 2.1, .6


def densify(points, step=1.):
    out = [np.array(points[0], float)]
    for a, b in zip(points[:-1], points[1:]):
        a, b = np.array(a, float), np.array(b, float)
        k = max(1, int(np.ceil(np.hypot(*(b - a)) / step)))
        out += [a + (b - a) * i / k for i in range(1, k + 1)]
    return out


def chaikin(points, n):
    # densified first, so the corner rounding stays local instead of eating the long straight runs
    p = densify(points)
    for _ in range(n):
        q = [p[0]]
        for a, b in zip(p[:-1], p[1:]):
            q += [.75 * a + .25 * b, .25 * a + .75 * b]
        q.append(p[-1])
        p = q
    return p


def pillow(A, B, R, rmin, poly):
    """Convex solid from thin rounded-rectangle slabs along a smoothed (inset, z) profile."""
    slabs = []
    for d, z in chaikin(poly, 3):
        r = min(max(R - .5 * d, rmin), A - d - .1, B - d - .1)
        slabs.append(cc.slab(CX - A + d, CX + A - d, CY - B + d, CY + B - d, Z_BASE + z - .02, Z_BASE + z, r))
    return Manifold.batch_hull(slabs)


def cover_solid():
    zs = Z_SKIRT - Z_BASE
    t = CAP_T
    outer = pillow(A_O, B_O, R_OUT, 3., [(0, zs), (0, V0), (BEVEL, H), (BEVEL + 6, H)])
    # inner surface: the outer one moved in by t along its normal (0.414 t = the 45 degree corner offsets)
    cavity = pillow(A_O, B_O, R_CAV, 1.5,
                    [(t, zs - 1), (t, V0 - .414 * t), (BEVEL + .414 * t, H - t), (BEVEL + .414 * t + 6, H - t)])
    shell = outer - cavity
    for sx in (-1, 1):
        for sy in (-1, 1):
            shell += cc.cyl(CX + sx * 22, CY + sy * 17, cc.TOP + PILLAR_GAP, Z_TOP - t + .6, PILLAR_R)
    return shell


def on_top(cs, s, t, depth=ENGRAVE):
    """Place a drawing (s right, t up as seen from the front) on the top face and extrude downwards."""
    placed = cs.rotate(90.).translate([CX - t, -CY + s])
    return placed.extrude(depth + .3).translate([0, 0, Z_TOP - depth])


def cover_marks(variant):
    marks = [on_top(art.logo(), 0., 6.),
             on_top(art.text('OMOCHI', 8.2), 0., -27.)]
    if variant == 'plain':
        marks.append(on_top(art.text('白餅', 6.2), 0., 27.))
    elif variant == 'csi':
        marks.append(on_top(art.text('塩大福', 6.2), 0., 27.))
        marks.append(on_top(art.salt_grains(0., 6., 22.5), 0., 0.))
    return Manifold.batch_boolean(marks, OpType.Add)


def xcut(cs, x0, x1):
    """Extrude a drawing in (u = KiCad Y, v = -Z) along +X, like cc.xslot."""
    m = cs.extrude(x1 - x0)
    return m.transform(np.array([[0, 0, 1, x0], [-1, 0, 0, 0], [0, -1, 0, 0]], float))


def smile_cs():
    c, r, w = SMILE_C, SMILE_R, SMILE_W
    ang = np.radians(np.linspace(238., 302., 28))
    outer = [(c[0] + (r + w / 2) * np.cos(a), -(c[1] + (r + w / 2) * np.sin(a))) for a in ang]
    inner = [(c[0] + (r - w / 2) * np.cos(a), -(c[1] + (r - w / 2) * np.sin(a))) for a in ang[::-1]]
    cs = CrossSection([np.array(outer + inner)], FillRule.EvenOdd)
    cap = lambda a: CrossSection.circle(w / 2, 24).translate([c[0] + r * np.cos(a), -(c[1] + r * np.sin(a))])
    return cs + cap(ang[0]) + cap(ang[-1])


def face_base(base):
    cuts = xcut(smile_cs(), cc.X1 - FACE_DEPTH, cc.X1 + .5)
    for y, z in CHEEKS:
        cuts += xcut(CrossSection.circle(CHEEK_R, 48).translate([y, -z]), cc.X1 - CHEEK_DEPTH, cc.X1 + .5)
    return base - cuts, cuts


def print_orient(mesh, flip):
    t = mesh.copy()
    if flip:
        t.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
    t.apply_translation(-t.bounds[0])
    return t


def part_report(t):
    """Printability numbers for a part in its print orientation (z up).

    Overhang is the angle between the face normal and straight down: a flat ceiling is 0 deg,
    a 45 degree chamfer is 45 deg. Faces under 44 deg are steeper than a 45 degree overhang;
    flat pit floors 0.6 mm above the bed are the engraved logo (a 0.6 mm bridge over the bed)."""
    n = t.face_normals
    a = t.area_faces
    zc = t.triangles_center[:, 2]
    ang = np.degrees(np.arccos(np.clip(-n[:, 2], -1, 1)))
    above = zc > .05
    pits = above & (ang < 5.) & (zc < .7)
    steep = above & (ang < 44.) & ~pits
    return {'watertight': bool(t.is_watertight), 'winding_consistent': bool(t.is_winding_consistent),
            'single_connected_solid': len(t.split()) == 1, 'volume_mm3': round(float(t.volume), 1),
            'triangles': int(len(t.faces)), 'print_extents_mm': np.round(t.extents, 3).tolist(),
            'approx_mass_g_pla': round(float(t.volume) * 1.24e-3, 1),
            'engraved_pit_floors_mm2': round(float(a[pits].sum()), 1),
            'overhang_steeper_than_45deg_mm2': {'z_below_1mm': round(float(a[steep & (zc < 1.)].sum()), 1),
                                                'z_above_1mm': round(float(a[steep & (zc >= 1.)].sum()), 1)}}


def min_wall(outer_m, cavity_m):
    """Smallest distance from the cavity surface to the outside surface.

    Cavity vertices near the open skirt rim are skipped: the cavity is cut through the
    rim, so the outer hull's closed bottom face is not part of the real shell."""
    o = cc.to_mesh(outer_m)
    c = cc.to_mesh(cavity_m)
    v = c.vertices[c.vertices[:, 2] > Z_SKIRT + 3.]
    return float(trimesh.proximity.closest_point(o, v)[1].min())


def main(render=True):
    solids = cc.design()
    base, lid, pipe = solids['base'], solids['lid'], solids['lightpipe']
    report = {'note': 'Prototype geometry. No physical print or fit test yet.', 'parts': {}, 'checks': {}}

    # cover ------------------------------------------------------------------
    solid = cover_solid()
    covers, fills = {}, {}
    for key, variant in (('cover', 'generic'), ('cover-plain', 'plain'), ('cover-csi', 'csi')):
        marks = cover_marks(variant)
        covers[key] = solid - marks
        fills[key] = marks ^ solid
    # cavity for the wall-thickness check (outer hull minus the shell)
    t = CAP_T
    zs = Z_SKIRT - Z_BASE
    outer_only = pillow(A_O, B_O, R_OUT, 3., [(0, zs), (0, V0), (BEVEL, H), (BEVEL + 6, H)])
    cavity_only = pillow(A_O, B_O, R_CAV, 1.5,
                         [(t, zs - 1), (t, V0 - .414 * t), (BEVEL + .414 * t, H - t), (BEVEL + .414 * t + 6, H - t)])
    report['checks']['cover_min_wall_mm'] = round(min_wall(outer_only, cavity_only), 2)

    for key, m in covers.items():
        tm = cc.to_mesh(m)
        assert tm.is_watertight and tm.is_winding_consistent and tm.volume > 0 and len(tm.split()) == 1, key
        for name, other in (('base', base), ('lid', lid), ('lightpipe', pipe)):
            v = (m ^ other).volume()
            assert v < .001, f'{key} overlaps {name}: {v} mm3'
            report['checks'][f'{key}_overlap_{name}_mm3'] = round(v, 6)
        p = print_orient(tm, True)
        p.export(OUT / f'{NAME}-{key}.stl')
        report['parts'][key] = part_report(p)

    # face -------------------------------------------------------------------
    base_face, face_cuts = face_base(base)
    tf = cc.to_mesh(base_face)
    assert tf.is_watertight and tf.is_winding_consistent and len(tf.split()) == 1
    assert (base_face ^ lid).volume() < .001 and (base_face ^ pipe).volume() < .001
    # the groove must stay clear of the RESET / LED holes and the OLED window
    eye_gap = []
    for ey in (cc.RESET_Y, cc.LED_HOLE_Y):
        for pts in [np.array(p) for p in smile_cs().to_polygons()]:
            for u, v in pts[::3]:
                eye_gap.append(np.hypot(u - ey, -v - cc.RESET_HOLE_Z) - cc.RESET_R)
        for y, z in CHEEKS:
            eye_gap.append(np.hypot(y - ey, z - cc.RESET_HOLE_Z) - cc.RESET_R - CHEEK_R)
    oled_gap = [56.8 - (y + CHEEK_R) if z + CHEEK_R > 8.2 else 99. for y, z in CHEEKS]
    report['checks']['face_min_gap_to_eye_holes_mm'] = round(float(min(eye_gap)), 2)
    report['checks']['face_groove_depth_mm'] = FACE_DEPTH
    report['checks']['face_remaining_wall_mm'] = round(cc.WALL - FACE_DEPTH, 2)
    assert min(eye_gap) >= 1.6, 'groove too close to an eye hole'
    pf = print_orient(tf, False)
    stock = part_report(print_orient(cc.to_mesh(base), False))
    report['checks']['stock_base_overhang_steeper_than_45deg_mm2'] = stock['overhang_steeper_than_45deg_mm2']
    pf.export(OUT / f'{NAME}-face-base.stl')
    report['parts']['face-base'] = part_report(pf)
    report['stock_parts_unchanged'] = ['cosmic-ray-detector-v2-compact-lid.stl', 'cosmic-ray-detector-v2-compact-lightpipe.stl']
    report['stock_verify'] = 'run with --verify (needs the KiCad PCB and detector pack)'
    (OUT / f'{NAME}-validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if '--verify' in sys.argv:
        parts, _ = cc.load_detector()
        stock = cc.verify({'base': base_face, 'lid': lid, 'lightpipe': pipe}, parts)
        report['stock_verify'] = {'intersections': stock['intersections'],
                                  'front_openings_mm': stock['front_openings_mm']}
        (OUT / f'{NAME}-validation.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print('stock verify intersections:', stock['intersections'])

    if render:
        import render_omochi
        render_omochi.run(solids, base_face, covers, fills, OUT)


if __name__ == '__main__':
    main('--no-render' not in sys.argv)
