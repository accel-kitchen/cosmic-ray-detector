"""Round base (80 mm cylinder) with a raised boss that carries a 16-LED WS2812 ring, in millimetres.

Requires numpy, trimesh and manifold3d. Run from any directory:
    python cad/build_ring_base.py
Writes cad/ring-base/*.stl, a validation JSON and a preview PNG.

The ring dimensions below are the usual values for 16x WS2812 5050 rings
(Adafruit style). The AliExpress listing gives no dimensions; measure the real
ring with calipers and edit RING_* before printing.
"""
from pathlib import Path
import json, sys
import numpy as np
import trimesh
from manifold3d import Manifold

sys.stdout.reconfigure(encoding='utf-8')
OUT = Path(__file__).resolve().parent / 'ring-base'
OUT.mkdir(exist_ok=True)
SEG = 180

# ---- ring LED (assumed; check against the real part) ----
RING_OD = 44.5     # outer diameter
RING_ID = 31.7     # inner diameter
RING_PCB = 1.6     # PCB thickness (LEDs stand another ~1.6 mm above this)
FIT = 0.3          # radial clearance for the pocket

# ---- base ----
BASE_D = 80.       # requested: 8 cm
BASE_H = 10.
EDGE = 1.5         # chamfer on the base's top and bottom edges
# ---- boss ----
BOSS_D = 70.       # 70 mm so a ball diffuser sits on it (was 52)
BOSS_H = 8.        # height above the base top
# ---- ring seat ----
POCKET_D = RING_OD + 2*FIT
POCKET_DEPTH = RING_PCB     # ring PCB sits flush with the boss rim; LEDs stand proud
POST_D = RING_ID - 2*FIT    # locating post inside the ring's centre hole
# ---- wiring ----
# The ring's cable is soldered to the ring and leaves straight down, so the hole sits UNDER the
# ring's annulus (not at the centre): a stadium slot, long side along the circle. It also gives
# room for the solder joints on the ring's back. The ring can be turned to put its pads over it.
SLOT_R, SLOT_L, SLOT_W = 19.5, 16., 7.   # centre radius, tangential length, radial width (r 16.0..23.0)
SLOT_ANGLE = 180.                        # direction of the slot in this part's frame (+X = 0 deg, +Y = 90 deg)
SLIT_W = 6.                              # open side slit from the slot out to the rim (-X): both ends of the cable are soldered
                                         # (ring and board), so the cable has to slide in sideways, never through a closed hole
GROOVE_W, GROOVE_H = 7., 3.5   # old standalone channel in the underside (now off; the slit replaces it)
# ---- feet ----
FOOT_D, FOOT_DEPTH, FOOT_R = 10.2, 1.2, 31.   # recesses for 10 mm stick-on rubber feet
# ---- screw mount on the round case lid (3x M3 from inside the lid) ----
PILOT_R, PILOT_D, PILOT_DEPTH = 34., 2.6, 6.5   # self-tapping pilot holes in the underside
PILOT_ANGLES = (90., 210., 330.)

def slot_centres():
    """The two end-circle centres (x, y) of the stadium slot, in this part's frame."""
    a = np.radians(SLOT_ANGLE)
    c = np.array([SLOT_R * np.cos(a), SLOT_R * np.sin(a)])
    t = np.array([-np.sin(a), np.cos(a)])
    h = SLOT_L / 2 - SLOT_W / 2
    return c - t * h, c + t * h

def slot_solid(z0, z1):
    (x0, y0), (x1, y1) = slot_centres()
    return Manifold.batch_hull([cyl(SLOT_W / 2, z0, z1).translate([x0, y0, 0]), cyl(SLOT_W / 2, z0, z1).translate([x1, y1, 0])])

def cyl(r, z0, z1):
    return Manifold.cylinder(z1 - z0, r, r, SEG).translate([0, 0, z0])

def cone(r0, r1, z0, z1):
    return Manifold.cylinder(z1 - z0, r0, r1, SEG).translate([0, 0, z0])

def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])

def build(groove=False, feet=True, pilots=False, slit=True):
    R = BASE_D / 2
    # body: cylinder with chamfered top and bottom edges (profile as stacked cones)
    body = cone(R - EDGE, R, 0, EDGE) + cyl(R, EDGE, BASE_H - EDGE) + cone(R, R - EDGE, BASE_H - EDGE, BASE_H)
    top = BASE_H
    boss = cyl(BOSS_D / 2, top - 0.01, top + BOSS_H)
    part = body + boss
    # ring pocket in the boss top, leaving a centre post
    zt = top + BOSS_H
    part = part - cyl(POCKET_D / 2, zt - POCKET_DEPTH, zt + 1)
    part = part + cyl(POST_D / 2, zt - POCKET_DEPTH - 0.01, zt)  # post top flush with the PCB top
    # cable slot under the ring annulus, all the way through (no hole at the centre)
    part = part - slot_solid(-1, zt + 1)
    if slit:
        assert SLOT_ANGLE == 180.
        part = part - box(-(R + 1), -SLOT_R, -SLIT_W / 2, SLIT_W / 2, -1, zt + 1)
    # standalone variant only: underside channel from the slot out to the rim
    if groove:
        assert SLOT_ANGLE == 180.
        part = part - box(-(R + 1), -SLOT_R, -GROOVE_W / 2, GROOVE_W / 2, -1, GROOVE_H)
    # rubber-foot recesses, kept clear of the channel
    if feet:
        for k in range(4):
            a = np.radians(45 + 90 * k)
            part = part - cyl(FOOT_D / 2, -1, FOOT_DEPTH).translate([FOOT_R * np.cos(a), FOOT_R * np.sin(a), 0])
    if pilots:
        for deg in PILOT_ANGLES:
            a = np.radians(deg)
            part = part - cyl(PILOT_D / 2, -1, PILOT_DEPTH).translate([PILOT_R * np.cos(a), PILOT_R * np.sin(a), 0])
    return part

def to_trimesh(m):
    mesh = m.to_mesh()
    return trimesh.Trimesh(np.asarray(mesh.vert_properties)[:, :3], np.asarray(mesh.tri_verts), process=True)

def main():
    part = build()
    tm = to_trimesh(part)
    tm.export(OUT / 'ring-base.stl')
    zt = BASE_H + BOSS_H
    checks = {
        'watertight': bool(tm.is_watertight),
        'winding_consistent': bool(tm.is_winding_consistent),
        'volume_mm3': round(float(tm.volume), 1),
        'bounds_mm': [[round(float(v), 2) for v in row] for row in tm.bounds],
        'components': len(tm.split(only_watertight=False)),
        'base_diameter_mm': BASE_D,
        'overall_height_mm': zt,
        'boss_diameter_mm': BOSS_D,
        'ring_pocket_diameter_mm': round(POCKET_D, 2),
        'ring_pocket_depth_mm': POCKET_DEPTH,
        'centre_post_diameter_mm': round(POST_D, 2),
        'boss_wall_around_pocket_mm': round((BOSS_D - POCKET_D) / 2, 2),
        'slot': {'centre_radius': SLOT_R, 'length': SLOT_L, 'width': SLOT_W, 'angle_deg': SLOT_ANGLE,
                 'wall_to_centre_post_mm': round(SLOT_R - SLOT_W / 2 - POST_D / 2, 2),
                 'wall_to_pocket_rim_mm': round(BOSS_D / 2 - (SLOT_R + SLOT_W / 2), 2)},
        'assumed_ring': {'od': RING_OD, 'id': RING_ID, 'pcb': RING_PCB},
    }
    # the printed bottom face must be flat except for the channel and foot recesses
    sec = tm.section(plane_origin=[0, 0, 0.5], plane_normal=[0, 0, 1])
    checks['section_z0.5_loops'] = len(sec.discrete) if sec is not None else 0
    (OUT / 'ring-base-validation.json').write_text(json.dumps(checks, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(checks, indent=2, ensure_ascii=False))
    render(tm)
    # variant that screws onto the round case lid: no channel or feet, three pilot holes
    lid_tm = to_trimesh(build(feet=False, pilots=True))
    assert lid_tm.is_watertight and lid_tm.is_winding_consistent and len(lid_tm.split(only_watertight=False)) == 1
    lid_tm.export(OUT / 'ring-base-lidmount.stl')

def render(tm):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    fig = plt.figure(figsize=(14, 5.2), dpi=130)
    # 3D view
    ax = fig.add_subplot(1, 3, 1, projection='3d')
    tris = tm.vertices[tm.faces]
    n = tm.face_normals
    shade = np.clip(0.45 + 0.55 * (n @ np.array([-0.4, -0.6, 0.7])), 0.2, 1)
    col = np.outer(shade, [0.80, 0.72, 0.58]); col = np.c_[col, np.ones(len(col))]
    ax.add_collection3d(Poly3DCollection(tris, facecolors=col, edgecolor='none'))
    r = BASE_D / 2
    ax.set_xlim(-r, r); ax.set_ylim(-r, r); ax.set_zlim(0, 2 * r)
    ax.set_box_aspect((1, 1, 1)); ax.view_init(28, -55); ax.set_axis_off()
    ax.set_title('3D', fontsize=10)
    # ring ghost on the boss
    zt = BASE_H + BOSS_H
    t = np.linspace(0, 2 * np.pi, 200)
    for rr in (RING_OD / 2, RING_ID / 2):
        ax.plot(rr * np.cos(t), rr * np.sin(t), np.full_like(t, zt), color='crimson', lw=1)
    # top view
    ax2 = fig.add_subplot(1, 3, 2)
    for rr, c, lab in ((BASE_D / 2, 'k', f'base Ø{BASE_D:g}'), (BOSS_D / 2, 'tab:blue', f'boss Ø{BOSS_D:g}'),
                       (POCKET_D / 2, 'crimson', f'pocket Ø{POCKET_D:.1f}'), (POST_D / 2, 'tab:green', f'post Ø{POST_D:.1f}')):
        ax2.plot(rr * np.cos(t), rr * np.sin(t), color=c, lw=1.4, label=lab)
    (sx0, sy0), (sx1, sy1) = slot_centres()
    ang = np.linspace(-np.pi / 2, np.pi / 2, 40)
    d = np.array([sx1 - sx0, sy1 - sy0]); d /= np.linalg.norm(d); nrm = np.array([-d[1], d[0]])
    cap1 = np.array([[sx1, sy1]]) + SLOT_W / 2 * (np.outer(np.cos(ang), d) + np.outer(np.sin(ang), -nrm))
    cap0 = np.array([[sx0, sy0]]) + SLOT_W / 2 * (np.outer(np.cos(ang), -d) + np.outer(np.sin(ang), nrm))
    outline = np.vstack([cap1, cap0, cap1[:1]])
    ax2.plot(outline[:, 0], outline[:, 1], color='tab:orange', lw=1.6, label=f'cable slot {SLOT_L:g} x {SLOT_W:g}')
    ax2.set_aspect('equal'); ax2.legend(fontsize=7, loc='lower right'); ax2.set_title('top (mm)', fontsize=10)
    ax2.axis('off')
    # section through XZ
    ax3 = fig.add_subplot(1, 3, 3)
    sec = tm.section(plane_origin=[0, 0.0, 0], plane_normal=[0, 1, 0])
    for p in sec.discrete:
        ax3.fill(p[:, 0], p[:, 2], color='#d6b88f', ec='k', lw=0.6)
    ax3.set_aspect('equal'); ax3.set_title('section Y=0 (slot + open slit to -X)', fontsize=10)
    ax3.set_xlabel('X mm'); ax3.set_ylabel('Z mm')
    fig.tight_layout()
    fig.savefig(OUT / 'ring-base-preview.png')

if __name__ == '__main__':
    main()
