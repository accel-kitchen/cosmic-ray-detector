"""LED-ring base: a 72 mm cylinder that carries the WS2812 LED ring (68 mm OD, 52 mm ID), in millimetres.

Requires numpy, trimesh and manifold3d (matplotlib for the preview). Run from any directory:
    python cad/build_ring_base.py
Writes cad/ring-base/*.stl, a validation JSON and a preview PNG.

Two versions with the same body:
- ring-base.stl (stand-alone, on a table): rubber-foot recesses underneath.
- ring-base-lidmount.stl (on the round case lid): a spigot underneath goes into the lid's 70 mm
  hole and the body rests on the hole's rim. Bayonet lock, no screws: three lugs at the foot of
  the spigot pass down through notches in the lid hole; turning the base clockwise (seen from
  above) by TWIST degrees puts them under the lid until they hit stops under the lid. Turn back,
  lift off, slide the cable out through the slit, and the ring (with its cable) passes straight
  down through the lid hole.
Both: the ring lies in an annular pocket in the top face around a locating post. Its cable is
soldered to the ring and leaves straight down from under the annulus, so it runs through a slot
under the annulus and out sideways through an open slit (the other end is soldered to the board).

Ring OD/ID measured by the user on 2026-11-21 (68 / 52). The PCB thickness is still assumed.
"""
from pathlib import Path
import json, sys
import numpy as np
import trimesh
from manifold3d import Manifold, CrossSection

sys.stdout.reconfigure(encoding='utf-8')
OUT = Path(__file__).resolve().parent / 'ring-base'
OUT.mkdir(exist_ok=True)
SEG = 180

# ---- ring LED ----
RING_OD = 68.      # measured 2026-11-21
RING_ID = 52.      # measured 2026-11-21
RING_PCB = 1.6     # assumed; LEDs stand another ~1.6 mm above this
FIT = 0.3          # radial clearance of the pocket and the locating post

# ---- body ----
BASE_D = 72.       # 80 -> 72 at the user's request (2026-11-20): 2 mm around the 68 mm ring
HEIGHT = 18.       # above the table or the lid top
EDGE = 1.5         # bottom-edge chamfer, stand-alone version
LID_EDGE = 0.3     # bottom-edge chamfer, lid-mount version (it rests on a 1 mm rim around the lid hole)
TOP_EDGE = 0.5     # top-edge chamfer
MIN_WALL = 2.0     # least material between a hole/recess and an outer face
MIN_RIM = 1.5      # least rim between the ring pocket and the outer face

# ---- ring pocket ----
POCKET_D = RING_OD + 2 * FIT        # annular pocket ...
POCKET_DEPTH = RING_PCB             # ... as deep as the PCB, so the PCB top is flush with the rim
POST_D = RING_ID - 2 * FIT          # locating post in the ring's hole, top flush with the PCB top

# ---- cable: slot under the middle of the ring's annulus, open slit to the rim (-X) ----
SLOT_R, SLOT_L, SLOT_W = (RING_OD + RING_ID) / 4, 16., 7.   # centre radius, tangential length, radial width
SLOT_ANGLE = 180.                                           # +X = 0 deg, +Y = 90 deg
SLIT_W = 6.

# ---- rubber feet (stand-alone) ----
FOOT_D, FOOT_DEPTH, FOOT_R = 10.2, 1.2, 27.

# ---- lid mount: bayonet (twist-lock), no screws ----
LID_HOLE_D = RING_OD + 2.           # hole in the round case lid; the ring passes with 1 mm a side
LID_T = 2.4                         # lid thickness (build_compact_enclosure TOP - SEAM; asserted by the case script)
SPIGOT_FIT = 0.2                    # radial clearance of the spigot in the lid hole
SPIGOT_D = LID_HOLE_D - 2 * SPIGOT_FIT
LUG_GAP = 0.15                      # axial play between the lug tops and the lid underside when locked
LUG_H = 1.6                         # lug thickness
SPIGOT_H = LID_T + LUG_GAP + LUG_H  # the spigot reaches through the lid; the lugs sit just under it
LUG_R = 37.5                        # lug outer radius: 2.5 mm under the lid beyond the 35 mm hole edge
LUG_SPAN = 20.6                     # angular width of each lug (deg)
# The odd-looking 20.6 / 2.15 / 0.65 keep every lug, notch and stop edge off the vertex angles of the
# polygonal circles (2 deg steps here, 1.5 deg in the case script); an edge through a vertex leaves
# zero-area triangles and the mesh is no longer watertight after cleaning.
LUG_ANGLES = (90., 210., 330.)      # lug centres in the ring-base frame, LOCKED position (slit at 180 deg, toward J4)
TWIST = 30.                         # insert TWIST deg counter-clockwise of locked, then turn clockwise to lock
NOTCH_R_FIT, NOTCH_A_FIT = 0.4, 2.15  # lid notch clearance around a lug: radial mm, angular deg each side
STOP_SPAN, STOP_A_GAP = 5., 0.65      # stops under the lid just past each locked lug: width, angular gap (deg)

def slot_centres():
    """The two end-circle centres (x, y) of the stadium slot, in this part's frame."""
    a = np.radians(SLOT_ANGLE)
    c = np.array([SLOT_R * np.cos(a), SLOT_R * np.sin(a)])
    t = np.array([-np.sin(a), np.cos(a)])
    h = SLOT_L / 2 - SLOT_W / 2
    return c - t * h, c + t * h

def _foot_centres():
    return [(FOOT_R * np.cos(np.radians(45 + 90 * k)), FOOT_R * np.sin(np.radians(45 + 90 * k))) for k in range(4)]

# geometry rules (fail early instead of writing a broken STL)
assert (BASE_D - POCKET_D) / 2 >= MIN_RIM, 'rim around the ring pocket too thin'
assert POST_D / 2 <= SLOT_R - SLOT_W / 2 and SLOT_R + SLOT_W / 2 <= POCKET_D / 2, 'cable slot must lie under the ring annulus'
assert BASE_D / 2 - (SLOT_R + SLOT_W / 2) >= MIN_WALL, 'cable slot too close to the outer wall'
assert LID_HOLE_D / 2 - RING_OD / 2 >= 1.0, 'lid hole too tight for the ring'
assert (BASE_D - LID_HOLE_D) / 2 - LID_EDGE >= 0.5, 'nothing left for the lid-mount body to rest on'
assert BASE_D / 2 - EDGE - (FOOT_R + FOOT_D / 2) >= MIN_WALL, 'foot recess too close to the rim'
assert LUG_R - LID_HOLE_D / 2 >= 2.0, 'lugs reach too little under the lid'
_slit_half = np.degrees(np.arcsin((SLIT_W / 2) / (SPIGOT_D / 2)))
assert all(abs((a - SLOT_ANGLE + 180) % 360 - 180) - LUG_SPAN / 2 >= _slit_half + 2 for a in LUG_ANGLES), 'a lug sits on the cable slit'
assert TWIST > LUG_SPAN / 2 + NOTCH_A_FIT + STOP_A_GAP, 'twist too small: a locked lug would still sit under its notch'
assert min(np.hypot(fx - sx, fy - sy) for fx, fy in _foot_centres() for sx, sy in slot_centres()) - FOOT_D / 2 - SLOT_W / 2 >= MIN_WALL, \
    'foot recess too close to the cable slot'

def cyl(r, z0, z1):
    return Manifold.cylinder(z1 - z0, r, r, SEG).translate([0, 0, z0])

def cone(r0, r1, z0, z1):
    return Manifold.cylinder(z1 - z0, r0, r1, SEG).translate([0, 0, z0])

def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])

def slot_solid(z0, z1, shrink=0.):
    (x0, y0), (x1, y1) = slot_centres()
    r = SLOT_W / 2 - shrink
    return Manifold.batch_hull([cyl(r, z0, z1).translate([x0, y0, 0]), cyl(r, z0, z1).translate([x1, y1, 0])])

def sector2d(r0, r1, a0, a1):
    """Annular sector between radii r0..r1 and angles a0..a1 (deg, counter-clockwise), as a 2D CrossSection."""
    t = np.radians(np.linspace(a0, a1, max(8, int(abs(a1 - a0)) + 2)))
    pts = [(r1 * np.cos(x), r1 * np.sin(x)) for x in t] + [(r0 * np.cos(x), r0 * np.sin(x)) for x in t[::-1]]
    return CrossSection([pts])

def sector(r0, r1, a0, a1, z0, z1):
    return sector2d(r0, r1, a0, a1).extrude(z1 - z0).translate([0, 0, z0])

def spigot():
    """Spigot through the lid hole with the three bayonet lugs at its foot (locked position; z = 0 is the lid top).
    Built as ONE extrusion of the outline (circle + lugs) over the full spigot height, then the lug material above
    the lug tops is cut away with slightly wider sectors (inner radius 0.05 mm outside the spigot). Joining
    separate solids instead either leaves zero-area slivers or two shells that only touch."""
    z1 = -LID_T - LUG_GAP                                   # lug tops, just under the lid
    outline = CrossSection.circle(SPIGOT_D / 2, SEG)
    for a in LUG_ANGLES:
        outline = outline + sector2d(SPIGOT_D / 2 - 0.5, LUG_R, a - LUG_SPAN / 2, a + LUG_SPAN / 2)
    sp = outline.extrude(SPIGOT_H + 0.01).translate([0, 0, -SPIGOT_H])
    for a in LUG_ANGLES:
        sp = sp - sector(SPIGOT_D / 2 + 0.05, LUG_R + 1, a - LUG_SPAN / 2 - 1, a + LUG_SPAN / 2 + 1, z1, 1)
    return sp

def lid_notches():
    """Cut into the lid around its hole: where the lugs pass down (insert position = locked + TWIST). Lid top at z = 0."""
    out = None
    for a in LUG_ANGLES:
        c = a + TWIST
        s = sector(LID_HOLE_D / 2 - 0.5, LUG_R + NOTCH_R_FIT, c - LUG_SPAN / 2 - NOTCH_A_FIT, c + LUG_SPAN / 2 + NOTCH_A_FIT, -LID_T - 1, 1)
        out = s if out is None else out + s
    return out

def lid_stops():
    """Blocks under the lid just clockwise of each locked lug: the base stops turning at the locked position."""
    out = None
    for a in LUG_ANGLES:
        a1 = a - LUG_SPAN / 2 - STOP_A_GAP
        s = sector(LID_HOLE_D / 2 + 0.3, LUG_R + NOTCH_R_FIT, a1 - STOP_SPAN, a1, -LID_T - LUG_GAP - LUG_H, -LID_T + 0.01)
        out = s if out is None else out + s
    return out

def build(lid=False):
    """lid=False: stand-alone base with feet. lid=True: bayonet version for the round case lid (locked orientation)."""
    R = BASE_D / 2
    e = LID_EDGE if lid else EDGE
    part = cone(R - e, R, 0, e) + cyl(R, e, HEIGHT - TOP_EDGE) + cone(R, R - TOP_EDGE, HEIGHT - TOP_EDGE, HEIGHT)
    if lid:
        part = part + spigot()                                 # through the lid hole, bayonet lugs at its foot
    zb = (-SPIGOT_H if lid else 0.) - 1
    # annular ring pocket in the top face, leaving the locating post
    part = part - cyl(POCKET_D / 2, HEIGHT - POCKET_DEPTH, HEIGHT + 1)
    part = part + cyl(POST_D / 2, HEIGHT - POCKET_DEPTH - 0.01, HEIGHT)
    # cable slot under the annulus, all the way through, and the open slit out to the rim
    part = part - slot_solid(zb, HEIGHT + 1)
    assert SLOT_ANGLE == 180.
    part = part - box(-(R + 1), -SLOT_R, -SLIT_W / 2, SLIT_W / 2, zb, HEIGHT + 1)
    if not lid:
        for fx, fy in _foot_centres():
            part = part - cyl(FOOT_D / 2, -1, FOOT_DEPTH).translate([fx, fy, 0])
    return part

def bayonet_checks(lid, place=lambda m: m):
    """Check the twist-lock against a lid solid. place(m) moves a ring-base-frame solid onto that lid
    (lid top at the ring base's z = 0). Raises AssertionError on failure; returns a small report."""
    cap = build(lid=True)
    at = lambda a=0., dz=0.: place(cap.rotate([0, 0, a]).translate([0, 0, dz]))
    ov = lambda m: (lid ^ m).volume()
    assert ov(at()) < 1e-3, 'locked: ring base collides with the lid'
    assert ov(at(dz=-.1)) > .5, 'ring base does not rest on the lid'
    lift = ov(at(dz=LUG_GAP + .3))
    assert lift > .5, 'locked ring base can be lifted off: the lugs do not catch under the lid'
    for dz in np.arange(0., SPIGOT_H + 1.01, .25):
        assert ov(at(TWIST, dz)) < 1e-3, f'cannot insert at the notch position (blocked at dz = {dz:.2f})'
    for a in np.arange(0., TWIST + .01, 1.):
        assert ov(at(a)) < 1e-3, f'cannot turn to the locked position (blocked at {a:.0f} deg)'
    stop = ov(at(-2.))
    assert stop > .05, 'the stops do not stop the turn at the locked position'
    return {'locked_no_overlap': True, 'rests_on_lid': True, 'insert_path_clear': True, 'twist_path_clear': True,
            'lift_when_locked_blocked_mm3': round(lift, 1), 'overturn_2deg_blocked_mm3': round(stop, 2)}

def to_trimesh(m):
    mesh = m.to_mesh()
    return trimesh.Trimesh(np.asarray(mesh.vert_properties)[:, :3], np.asarray(mesh.tri_verts), process=True)

def main():
    parts = {'ring-base': build(), 'ring-base-lidmount': build(lid=True)}
    meshes = {}
    for name, m in parts.items():
        t = to_trimesh(m)
        assert t.is_watertight and t.is_winding_consistent and len(t.split(only_watertight=False)) == 1, name
        meshes[name] = t
    for name, m in parts.items():
        # the cable slot is clear top to bottom, and a 4.4 mm cable slides out sideways through the slit
        assert (m ^ slot_solid(-SPIGOT_H - 1, HEIGHT + 1, shrink=.5)).volume() < 1e-3, f'{name}: cable slot blocked'
        sweep = box(-(BASE_D / 2 + 2), -SLOT_R + 1, -2.2, 2.2, -SPIGOT_H - 1, HEIGHT + 1)
        assert (m ^ sweep).volume() < 1e-3, f'{name}: cable cannot slide out through the slit'
        # the ring fits its pocket: a ring-shaped probe (OD/ID with 0.1 mm to spare) at PCB height overlaps nothing
        ring = cyl(RING_OD / 2 - .1, HEIGHT - POCKET_DEPTH + .05, HEIGHT) - cyl(RING_ID / 2 + .1, HEIGHT - 2, HEIGHT + 1)
        assert (m ^ ring).volume() < 1e-3, f'{name}: ring does not fit the pocket'
    # lid-mount: bayonet against a stand-in lid ring with the same hole, notches and stops as the case lid
    lid_stub = cyl(BASE_D / 2 + 10, -LID_T, 0) - cyl(LID_HOLE_D / 2, -LID_T - 1, 1) - lid_notches() + lid_stops()
    bayonet = bayonet_checks(lid_stub)
    t = meshes['ring-base']
    checks = {
        'ring_measured': {'od': RING_OD, 'id': RING_ID, 'pcb_assumed': RING_PCB},
        'body': {'diameter_mm': BASE_D, 'height_mm': HEIGHT, 'top_chamfer_mm': TOP_EDGE},
        'ring_pocket': {'diameter_mm': round(POCKET_D, 2), 'depth_mm': POCKET_DEPTH, 'centre_post_diameter_mm': round(POST_D, 2),
                        'rim_around_pocket_mm': round((BASE_D - POCKET_D) / 2, 2)},
        'cable_slot': {'centre_radius': SLOT_R, 'length': SLOT_L, 'width': SLOT_W, 'angle_deg': SLOT_ANGLE,
                       'open_slit_width_mm': SLIT_W, 'wall_to_outer_face_mm': round(BASE_D / 2 - SLOT_R - SLOT_W / 2, 2)},
        'stand_alone': {'file': 'ring-base.stl', 'volume_mm3': round(float(t.volume), 1),
                        'bounds_mm': np.round(t.bounds, 2).tolist(), 'bottom_chamfer_mm': EDGE,
                        'feet': {'diameter': FOOT_D, 'depth': FOOT_DEPTH, 'circle_radius': FOOT_R,
                                 'wall_to_bottom_edge_mm': round(BASE_D / 2 - EDGE - (FOOT_R + FOOT_D / 2), 2)}},
        'lid_mount': {'file': 'ring-base-lidmount.stl', 'volume_mm3': round(float(meshes['ring-base-lidmount'].volume), 1),
                      'bounds_mm': np.round(meshes['ring-base-lidmount'].bounds, 2).tolist(),
                      'lid_hole_diameter_mm': LID_HOLE_D, 'ring_clearance_in_lid_hole_per_side_mm': (LID_HOLE_D - RING_OD) / 2,
                      'spigot_diameter_mm': round(SPIGOT_D, 2), 'spigot_height_mm': round(SPIGOT_H, 2),
                      'rest_rim_on_lid_mm': round((BASE_D - LID_HOLE_D) / 2 - LID_EDGE, 2), 'screws': 'none (bayonet)',
                      'bayonet': {'lugs': len(LUG_ANGLES), 'lug_angles_locked_deg': list(LUG_ANGLES), 'lug_span_deg': LUG_SPAN,
                                  'lug_outer_radius_mm': LUG_R, 'reach_under_lid_mm': LUG_R - LID_HOLE_D / 2,
                                  'lug_thickness_mm': LUG_H, 'axial_play_mm': LUG_GAP,
                                  'twist_deg': TWIST, 'lock_direction': 'clockwise seen from above',
                                  'lid_notch_centres_deg': [a + TWIST for a in LUG_ANGLES]}},
        'checks': {'watertight_single_solids': True, 'cable_slot_clear': True, 'cable_slides_out_through_slit': True,
                   'ring_fits_pocket': True, 'bayonet_against_stand_in_lid': bayonet},
    }
    (OUT / 'ring-base-validation.json').write_text(json.dumps(checks, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(checks, indent=2, ensure_ascii=False))
    for name, t in meshes.items():
        t.export(OUT / f'{name}.stl')
    render(meshes['ring-base'], meshes['ring-base-lidmount'])

def render(tm, cap_tm):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    fig = plt.figure(figsize=(18.5, 5.2), dpi=130)
    t = np.linspace(0, 2 * np.pi, 240)
    # 3D view of the lid-mount version
    ax = fig.add_subplot(1, 4, 1, projection='3d')
    tris = cap_tm.vertices[cap_tm.faces]
    n = cap_tm.face_normals
    shade = np.clip(0.45 + 0.55 * (n @ np.array([-0.4, -0.6, 0.7])), 0.2, 1)
    col = np.outer(shade, [0.80, 0.72, 0.58]); col = np.c_[col, np.ones(len(col))]
    ax.add_collection3d(Poly3DCollection(tris, facecolors=col, edgecolor='none'))
    r = BASE_D / 2
    ax.set_xlim(-r, r); ax.set_ylim(-r, r); ax.set_zlim(-r / 2, 3 * r / 2)
    ax.set_box_aspect((1, 1, 1)); ax.view_init(28, -55); ax.set_axis_off()
    for rr in (RING_OD / 2, RING_ID / 2):
        ax.plot(rr * np.cos(t), rr * np.sin(t), np.full_like(t, HEIGHT), color='crimson', lw=1)
    ax.set_title('3D (lid-mount, ring in red)', fontsize=10)
    # top view
    ax2 = fig.add_subplot(1, 4, 2)
    for rr, c, ls, lab in ((BASE_D / 2, 'k', '-', f'body Ø{BASE_D:g}'), (LID_HOLE_D / 2, 'tab:purple', '--', f'lid hole Ø{LID_HOLE_D:g}'),
                           (POCKET_D / 2, 'crimson', '-', f'pocket Ø{POCKET_D:.1f} (ring Ø{RING_OD:g})'),
                           (POST_D / 2, 'tab:green', '-', f'post Ø{POST_D:.1f} (ring hole Ø{RING_ID:g})')):
        ax2.plot(rr * np.cos(t), rr * np.sin(t), color=c, ls=ls, lw=1.3, label=lab)
    (sx0, sy0), (sx1, sy1) = slot_centres()
    ang = np.linspace(-np.pi / 2, np.pi / 2, 40)
    d = np.array([sx1 - sx0, sy1 - sy0]); d /= np.linalg.norm(d); nrm = np.array([-d[1], d[0]])
    cap1 = np.array([[sx1, sy1]]) + SLOT_W / 2 * (np.outer(np.cos(ang), d) + np.outer(np.sin(ang), -nrm))
    cap0 = np.array([[sx0, sy0]]) + SLOT_W / 2 * (np.outer(np.cos(ang), -d) + np.outer(np.sin(ang), nrm))
    outline = np.vstack([cap1, cap0, cap1[:1]])
    ax2.plot(outline[:, 0], outline[:, 1], color='tab:orange', lw=1.6, label=f'cable slot {SLOT_L:g} x {SLOT_W:g} + slit')
    ax2.plot([-BASE_D / 2, -SLOT_R], [SLIT_W / 2] * 2, color='tab:orange', lw=1)
    ax2.plot([-BASE_D / 2, -SLOT_R], [-SLIT_W / 2] * 2, color='tab:orange', lw=1)
    # bayonet: lugs (locked, solid blue) and the lid notches they drop through (dashed purple), lid stops (black)
    def sector_outline(r0, r1, a0, a1):
        tt = np.radians(np.linspace(a0, a1, 30))
        xs = np.r_[r1 * np.cos(tt), r0 * np.cos(tt[::-1]), r1 * np.cos(tt[:1])]
        ys = np.r_[r1 * np.sin(tt), r0 * np.sin(tt[::-1]), r1 * np.sin(tt[:1])]
        return xs, ys
    for i, a in enumerate(LUG_ANGLES):
        xs, ys = sector_outline(SPIGOT_D / 2, LUG_R, a - LUG_SPAN / 2, a + LUG_SPAN / 2)
        ax2.fill(xs, ys, color='tab:blue', alpha=.6, label='lug (locked)' if i == 0 else None)
        c = a + TWIST
        xs, ys = sector_outline(LID_HOLE_D / 2, LUG_R + NOTCH_R_FIT, c - LUG_SPAN / 2 - NOTCH_A_FIT, c + LUG_SPAN / 2 + NOTCH_A_FIT)
        ax2.plot(xs, ys, color='tab:purple', ls='--', lw=1, label=f'lid notch (insert, +{TWIST:g}°)' if i == 0 else None)
        a1 = a - LUG_SPAN / 2 - STOP_A_GAP
        xs, ys = sector_outline(LID_HOLE_D / 2 + .3, LUG_R + NOTCH_R_FIT, a1 - STOP_SPAN, a1)
        ax2.fill(xs, ys, color='k', label='stop under the lid' if i == 0 else None)
    ax2.set_aspect('equal'); ax2.legend(fontsize=7, loc='lower right', bbox_to_anchor=(1.25, -0.08)); ax2.set_title('top (mm)', fontsize=10)
    ax2.axis('off')
    # sections: stand-alone through Y = 0 (slot + slit on -X); lid-mount through X = 0 (lug at +Y, locked under the lid)
    for k, (mesh, title, lid) in enumerate(((tm, 'stand-alone ring-base.stl: section Y=0', False),
                                            (cap_tm, 'lid-mount, locked: section X=0 (lug at +Y)', True))):
        a = fig.add_subplot(1, 4, 3 + k)
        normal, col = ([1, 0, 0], 1) if lid else ([0, 1, 0], 0)
        sec = mesh.section(plane_origin=[0, 0.0, 0], plane_normal=normal)
        for p in sec.discrete:
            a.fill(p[:, col], p[:, 2], color='#d6b88f', ec='k', lw=0.6)
        if lid:
            for x0, x1 in ((-50, -LID_HOLE_D / 2), (LID_HOLE_D / 2, 50)):
                a.fill([x0, x1, x1, x0], [-LID_T, -LID_T, 0, 0], color='#33475b', ec='k', lw=0.6)
            a.text(44, -6.5, 'lid', fontsize=8, ha='center')
            a.annotate('lug', xy=(LUG_R - 1, -LID_T - LUG_GAP - LUG_H / 2), xytext=(46, -12), fontsize=8,
                       arrowprops=dict(arrowstyle='->', lw=.8))
        zr = HEIGHT - POCKET_DEPTH
        for s in (-1, 1):
            a.fill([s * RING_ID / 2, s * RING_OD / 2, s * RING_OD / 2, s * RING_ID / 2], [zr, zr, HEIGHT, HEIGHT], color='crimson')
        a.set_aspect('equal'); a.set_title(title, fontsize=10); a.set_xlabel('X mm')
        if k == 0:
            a.set_ylabel('Z mm')
    fig.tight_layout()
    fig.savefig(OUT / 'ring-base-preview.png')

if __name__ == '__main__':
    main()
