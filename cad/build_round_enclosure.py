"""Round (cylindrical) case for the v2 detector, with the LED-ring base screwed on the lid. Millimetres.

Requires numpy, trimesh, manifold3d, pillow and (for the preview) Blender 5.2. Run from any directory:
    python cad/build_round_enclosure.py
Writes cad/round-case/*.stl, a validation JSON and a preview PNG.

Three printed parts: tube (wall only, open at both ends), bottom plate, lid. (No light pipe: the LED hole stays open.)
The board hangs on three spacers from the BOTTOM PLATE, so removing the 4 plate screws
lets the whole board assembly leave through the bottom. The lid and the ring base share a
bore wider than the LED ring: lift the ring and its seat (build_ring_base.build_seat) out,
and the ring, still soldered to its cable, drops through the lid into the tube and leaves
through the bottom with the board. The lid can stay screwed on.

Everything inside is unchanged from the rectangular compact case
(build_compact_enclosure.py): same board posts, floor height, lid posts and
port positions. The cylinder's inner radius is the half-diagonal of the old inner
rectangle (plus a little), so whatever fitted in the rectangle fits in the circle.
The detector model (lp/assets/model/detector-pack.js) is not in this repository, so
part-by-part interference is NOT re-run; the checks prove instead that the free space
of the old case is intact.
"""
from pathlib import Path
import json, sys
import numpy as np
import trimesh
from manifold3d import Manifold, CrossSection

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_compact_enclosure as B
import build_ring_base as RB

sys.stdout.reconfigure(encoding='utf-8')
OUT = Path(__file__).resolve().parent / 'round-case'
OUT.mkdir(exist_ok=True)
NAME = 'cosmic-ray-detector-v2-round'
SEG = 240

CX, CY = (B.X0 + B.X1) / 2, (B.Y0 + B.Y1) / 2           # case axis (KiCad x, y)
HALF_DIAG = float(np.hypot((B.X1 - B.X0) / 2 - B.WALL, (B.Y1 - B.Y0) / 2 - B.WALL))
R_IN = round(HALF_DIAG + 0.5, 1)                         # 0.5 mm of air at the old rectangle's corners
R_OUT = R_IN + B.WALL
OUT_X = CX + R_OUT + 1                                    # beyond the +X outer wall
BOTTOM, FLOOR, SEAM, TOP = B.BOTTOM, B.FLOOR, B.SEAM, B.TOP

# ---- bottom plate: carries the spacers and the board, comes off with 4 M2 screws ----
PLATE_SCREW_R = 53.                                       # boss centre distance from the axis
PLATE_BOSS_R, PLATE_BOSS_H = 3.4, 12.
PLATE_PILOT_D, PLATE_PILOT_DEPTH = 2.2, 8.                # M2x8 self-tapping into the boss
PLATE_HOLE_D, PLATE_CBORE_D, PLATE_CBORE_H = 2.4, 4.4, 1.4
def _plate_screws():
    pts = [(CX - 20., CY - np.sqrt(PLATE_SCREW_R ** 2 - 20. ** 2)), (CX + 20., CY - np.sqrt(PLATE_SCREW_R ** 2 - 20. ** 2))]
    dx = np.sqrt(PLATE_SCREW_R ** 2 - 27.5 ** 2)
    pts += [(CX - dx, CY + 27.5), (CX + dx, CY + 27.5)]
    return [(float(x), float(y)) for x, y in pts]
PLATE_SCREWS = _plate_screws()


def disc(r, z0, z1, cx=CX, cy=CY):
    return CrossSection.circle(r, SEG).translate([cx, -cy]).extrude(z1 - z0).translate([0, 0, z0])

def to_kicad(x, y):
    """Ring-base frame (as placed at [CX, -CY, TOP], +Y = design +Y) -> KiCad x, y that B.cyl/B.box expect."""
    return CX + x, CY - y

def ring_slot(z0, z1, shrink=0.):
    (x0, y0), (x1, y1) = RB.slot_centres()
    r = RB.SLOT_W / 2 - shrink
    return Manifold.batch_hull([B.cyl(*to_kicad(x0, y0), z0, z1, r, SEG), B.cyl(*to_kicad(x1, y1), z0, z1, r, SEG)])

def usb_cut():
    return B.xslot(CX - R_OUT - 1, 40.1, 38.6 - B.USB_GROW / 2, 54.6 + B.USB_GROW / 2,
                   -19.2 - B.DROP - B.USB_EXTEND, -9.2 - B.DROP + B.USB_GROW, 1.2)

# ---- 6-pin J4 + microSD window on the -X side, and the gain-trimmer R10 hole: defined once in build_compact_enclosure.py ----
J4_Y0, J4_Y1 = B.J4_Y0, B.J4_Y1
J4_WIN_Y0, J4_WIN_Y1, J4_WIN_Z0, J4_WIN_Z1 = B.J4_WIN_Y0, B.J4_WIN_Y1, B.J4_WIN_Z0, B.J4_WIN_Z1
SD_WIN_Y0, SD_WIN_Y1, SD_WIN_Z0, SD_WIN_Z1 = B.SD_WIN_Y0, B.SD_WIN_Y1, B.SD_WIN_Z0, B.SD_WIN_Z1
TRIM_X, TRIM_Y, TRIM_Z_FACE, TRIM_HOLE_D = B.TRIM_X, B.TRIM_Y, B.TRIM_Z_FACE, B.TRIM_HOLE_D
def side_cuts():
    """Windows through the -X wall: the 6-pin plug and the microSD card, merged into one opening."""
    return B.j4_sd_cut(CX - R_OUT - 1)

def design():
    # --- tube: wall only, from the plate seam (z = FLOOR) up to the lid seam ---
    tube = disc(R_OUT, FLOOR, SEAM) - disc(R_IN, FLOOR - 1, SEAM + 1)
    for x, y in B.LID_POSTS:                              # lid posts, now standing on the plate seam
        tube += B.cyl(x, y, FLOOR, SEAM, 3.4)
        tube -= B.cyl(x, y, SEAM - 10.6, SEAM + 1, B.LID_PILOT_D / 2)
    for x, y in PLATE_SCREWS:                             # plate bosses, in the free air beyond the old rectangle
        tube += B.cyl(x, y, FLOOR, FLOOR + PLATE_BOSS_H, PLATE_BOSS_R)
        tube -= B.cyl(x, y, FLOOR - 1, FLOOR + PLATE_PILOT_DEPTH, PLATE_PILOT_D / 2)
    # same openings as the compact case, run out through the curved wall
    tube -= usb_cut()
    tube -= B.xslot(116.3, OUT_X, 56.8, 83.6, 5.2 - B.SIDE_DROP, 21.3 - B.SIDE_DROP, 1.)  # OLED window
    tube -= B.xhole(115.3, OUT_X, B.RESET_Y, B.RESET_HOLE_Z, B.RESET_R)                  # RESET
    tube -= B.xhole(115.3, OUT_X, B.LED_HOLE_Y, B.LED_HOLE_Z, B.LED_HOLE_R)              # status-LED hole (no light pipe is used; the hole stays open)
    tube -= B.box(B.AUDIO_X0, B.AUDIO_X1, 99.3, CY + R_OUT + 1, B.AUDIO_Z0, B.AUDIO_Z1)  # audio jacks (the SD socket is NOT here: it faces -X)
    tube -= side_cuts()                                   # 6-pin J4 + microSD J8, -X side

    # --- bottom plate ---
    plate = disc(R_OUT, BOTTOM, FLOOR)
    for x, y in B.BOARD_POSTS:
        plate -= B.cyl(x, y, BOTTOM - 1, FLOOR + 1, B.FLOOR_HOLE_D / 2)
    for x, y in PLATE_SCREWS:
        plate -= B.cyl(x, y, BOTTOM - 1, FLOOR + 1, PLATE_HOLE_D / 2)
        plate -= B.cyl(x, y, BOTTOM - 1, BOTTOM + PLATE_CBORE_H, PLATE_CBORE_D / 2)
    plate -= usb_cut()                                    # the old floor was notched for the USB boot too
    plate -= B.trim_hole(BOTTOM - 1, FLOOR + 1)          # screwdriver hole straight up to the gain trimmer R10

    # --- lid ---
    lid = disc(R_OUT, SEAM, TOP)
    lip = disc(R_IN - B.FIT, SEAM - 3., SEAM + .1) - disc(R_IN - B.FIT - 1.2, SEAM - 3.1, SEAM + .2)
    for x, y in B.LID_POSTS:
        lip -= B.cyl(x, y, SEAM - 4, SEAM + 1, 3.75)
    lid += lip
    for x, y in B.LID_POSTS:
        lid -= B.cyl(x, y, SEAM - 4, TOP + 1, B.LID_HOLE_D / 2)
        lid -= B.cyl(x, y, TOP - 1.4, TOP + 1, 3.2)
    lid -= disc(RB.BORE_D / 2, SEAM - 6, TOP + 1)         # the LED ring passes through here (same bore as the ring base)
    for deg in RB.PILOT_ANGLES:                           # M3 holes for the ring base (same frame as the ring base's pilots)
        a = np.radians(deg)
        lid -= B.cyl(*to_kicad(RB.PILOT_R * np.cos(a), RB.PILOT_R * np.sin(a)), SEAM - 6, TOP + 1, 3.4 / 2)

    return {'base': tube, 'plate': plate, 'lid': lid}, {}

def verify(solids):
    rep = {'parts': {}}
    for name, m in solids.items():
        t = B.to_mesh(m)
        assert t.is_watertight and t.is_winding_consistent and t.volume > 0, name
        assert len(t.split()) == 1, name
        rep['parts'][name] = {'watertight': True, 'single_solid': True, 'volume_mm3': round(float(t.volume), 1),
                              'bounds_mm': np.round(t.bounds, 2).tolist()}
    rep['overlaps_mm3'] = {}
    for a, b in (('base', 'lid'), ('base', 'plate'), ('plate', 'lid')):
        ov = (solids[a] ^ solids[b]).volume()
        assert ov < .001, (a, b, ov)
        rep['overlaps_mm3'][f'{a}-{b}'] = round(ov, 6)
    # 1) the old case's free interior is still free (nothing new intrudes) - checked for tube, plate and lid
    old_base = B.design()['base']
    cavity = B.slab(B.X0 + B.WALL, B.X1 - B.WALL, B.Y0 + B.WALL, B.Y1 - B.WALL, B.FLOOR, B.SEAM, B.RADIUS - B.WALL)
    free_old = cavity - old_base
    rep['old_free_interior_intrusion_mm3'] = {}
    for name in ('base', 'plate', 'lid'):
        iv = (solids[name] ^ free_old).volume()
        rep['old_free_interior_intrusion_mm3'][name] = round(iv, 6)
    # the lid (lip) lies above the old parts (z > 35 mm), so it is reported, not asserted
    for name in ('base', 'plate'):
        assert rep['old_free_interior_intrusion_mm3'][name] < .01, f'{name} intrudes on the old free interior'
    rep['old_free_interior_mm3'] = round(free_old.volume(), 1)
    corners = [(B.X0 + B.WALL, B.Y0 + B.WALL), (B.X1 - B.WALL, B.Y0 + B.WALL), (B.X0 + B.WALL, B.Y1 - B.WALL), (B.X1 - B.WALL, B.Y1 - B.WALL)]
    gap = R_IN - max(np.hypot(x - CX, y - CY) for x, y in corners)
    assert gap > 0.3
    rep['corner_to_wall_gap_mm'] = round(float(gap), 2)
    # 2) every opening is clear from inside to outside
    probes = {
        'oled_window': B.xslot(116.5, OUT_X + .5, 57.2, 83.2, 5.2 - B.SIDE_DROP + .4, 21.3 - B.SIDE_DROP - .4, .6),
        'reset': B.xhole(116.5, OUT_X + .5, B.RESET_Y, B.RESET_HOLE_Z, B.RESET_R - .05),
        'led_hole': B.xhole(116.5, OUT_X + .5, B.LED_HOLE_Y, B.LED_HOLE_Z, B.LED_HOLE_R - .05),
        'usb': B.xslot(CX - R_OUT - .5, 40.0, 40., 53., -19. - B.DROP - B.USB_EXTEND + .4, -10. - B.DROP, .6),
        'audio_jacks': B.box(B.AUDIO_X0 + .3, B.AUDIO_X1 - .3, 100., CY + R_OUT + .5, B.AUDIO_Z0 + .3, B.AUDIO_Z1 - .3),
        # lanes start at the connector mouths (board edge, x = 41), not at the wall, and run out through the wall;
        # checked at the PCB-derived height and 3 mm higher
        **B.opening_lanes(CX - R_OUT - .5),
    }
    rep['openings_clear'] = {}
    union_bp = solids['base'] + solids['plate']
    for k, p in probes.items():
        v = (union_bp ^ p).volume()
        assert v < .001, f'{k} obstructed: {v}'
        rep['openings_clear'][k] = True
    # 2b) the new windows must not eat the plate bosses / lid posts, and keep a web to the USB opening and to the new hole's neighbours
    rep['new_openings'] = {}
    for x, y in PLATE_SCREWS:
        boss = B.cyl(x, y, FLOOR, FLOOR + PLATE_BOSS_H, PLATE_BOSS_R) - B.cyl(x, y, FLOOR - 1, FLOOR + PLATE_PILOT_DEPTH, PLATE_PILOT_D / 2)
        assert (boss - solids['base']).volume() < .001, f'a new opening cut into the plate boss at {x:.1f},{y:.1f}'
    for x, y in B.LID_POSTS:
        if y > 60:                                        # (the two y = 33.8 posts are touched by the existing USB cut, unchanged)
            post = B.cyl(x, y, FLOOR, SEAM, 3.4) - B.cyl(x, y, SEAM - 10.6, SEAM + 1, B.LID_PILOT_D / 2)
            assert (post - solids['base']).volume() < .001, f'a new opening cut into the lid post at {x:.1f},{y:.1f}'
    usb_y1 = 54.6 + B.USB_GROW / 2
    assert J4_WIN_Y0 - usb_y1 >= B.MIN_WEB, 'web between the USB opening and the J4 window is too thin'
    web_spacer = float(np.hypot(B.BOARD_POSTS[0][0] - TRIM_X, B.BOARD_POSTS[0][1] - TRIM_Y) - TRIM_HOLE_D / 2 - B.FLOOR_HOLE_D / 2)
    assert web_spacer >= B.MIN_WEB, 'trimmer hole too close to the spacer screw hole'
    wall_x = lambda y: CX - float(np.sqrt(R_IN ** 2 - (y - CY) ** 2))
    rep['new_openings'] = {
        'j4_plug_window_y_z_mm': [[J4_WIN_Y0, J4_WIN_Y1], [J4_WIN_Z0, J4_WIN_Z1]],
        'sd_window_y_z_mm': [[SD_WIN_Y0, SD_WIN_Y1], [SD_WIN_Z0, SD_WIN_Z1]],
        'web_to_usb_opening_mm': round(J4_WIN_Y0 - usb_y1, 2),
        'trimmer_hole_diameter_mm': TRIM_HOLE_D, 'trimmer_hole_axis_kicad_xy': [TRIM_X, TRIM_Y],
        'web_trimmer_hole_to_spacer_screw_hole_mm': round(web_spacer, 2),
        'reach_depth_mm': {'j4_mouth_to_inner_wall': round(41.1 - wall_x((J4_Y0 + J4_Y1) / 2), 1),
                           'sd_mouth_to_inner_wall': round(41.1 - wall_x(90.4), 1),
                           'trimmer_face_to_plate_top_mm': round(TRIM_Z_FACE - FLOOR, 1)}}
    # 3) plate screws: through the plate, into the pilot, clear all the way; spacer screw holes clear
    rep['plate_screw_paths_clear'] = True
    for x, y in PLATE_SCREWS:
        v = (union_bp ^ B.cyl(x, y, BOTTOM - 1, FLOOR + PLATE_PILOT_DEPTH - .5, 1.0)).volume()
        assert v < .001, f'plate screw path blocked at {x:.1f},{y:.1f}: {v}'
    for x, y in B.BOARD_POSTS:
        v = (solids['plate'] ^ B.cyl(x, y, BOTTOM - 1, FLOOR + 1, B.FLOOR_HOLE_D / 2 - .05)).volume()
        assert v < .001
    # 4) the board assembly can leave through the bottom: nothing in the tube projects into the old rectangle
    footprint = CrossSection.square([B.X1 - B.X0 - 2 * B.WALL, B.Y1 - B.Y0 - 2 * B.WALL]).translate([B.X0 + B.WALL, -(B.Y1 - B.WALL)])
    tube_inside = (solids['base'] ^ disc(R_IN, FLOOR, SEAM))
    proj = tube_inside.project()
    # the old case's own posts also stand in the rectangle corners; only NEW obstruction counts
    old_inside = (old_base ^ cavity).project()
    extra = (proj - old_inside) ^ cavity.project()   # old cavity only: its rounded corners were wall, never free
    rep['extra_obstruction_area_in_old_rectangle_mm2'] = round(extra.area(), 4)
    assert extra.area() < .01, 'something new in the tube blocks the old rectangle footprint'
    # 5) assembled state: ring base and seat placed on the lid exactly as in the preview
    ring = RB.build(feet=False, pilots=True, slit=False, bore=True).translate([CX, -CY, TOP])
    stack = solids['lid'] + ring
    assert (solids['lid'] ^ ring).volume() < .001
    zt_ring = TOP + RB.BASE_H + RB.BOSS_H
    seat = RB.build_seat().translate([CX, -CY, zt_ring - RB.SEAT_H])
    assert (stack ^ seat).volume() < .001, 'seat collides with the ring base or lid'
    # with the seat lifted out, a ring-sized disc goes straight down through ring base + lid and on down the tube
    ring_probe = disc(RB.RING_OD / 2 + .5, FLOOR, zt_ring + 1)
    assert ((stack + solids['base']) ^ ring_probe).volume() < .001, 'the LED ring cannot pass down through the lid'
    assert (seat ^ ring_probe).volume() > 1., 'ring probe cannot fail (the seat should block it)'
    # with the seat in, the cable slot runs from under the ring through the seat, the bore and the lid
    assert ((stack + seat) ^ ring_slot(SEAM - 5, zt_ring + 1, shrink=.5)).volume() < .001, 'cable slot not clear through seat + ring base + lid'
    lid_hole_web = RB.PILOT_R - 3.4 / 2 - RB.BORE_D / 2
    assert lid_hole_web >= B.MIN_WEB, 'lid M3 hole too close to the bore'
    for deg in RB.PILOT_ANGLES:
        a = np.radians(deg)
        probe = B.cyl(*to_kicad(RB.PILOT_R * np.cos(a), RB.PILOT_R * np.sin(a)), SEAM - 5, TOP + RB.PILOT_DEPTH - .5, 1.2, 48)
        assert (stack ^ probe).volume() < .001, f'M3 path blocked at {deg} deg'
    # the test must be able to fail: the mirrored pattern (the old y-sign bug) is blocked
    mirrored = 0.
    for deg in RB.PILOT_ANGLES:
        a = np.radians(deg)
        probe = B.cyl(*to_kicad(RB.PILOT_R * np.cos(a), -RB.PILOT_R * np.sin(a)), SEAM - 5, TOP + RB.PILOT_DEPTH - .5, 1.2, 48)
        mirrored += (stack ^ probe).volume()
    assert mirrored > 1., 'assembly check cannot detect a mirrored hole pattern'
    rep['assembled_ring_base'] = {'seat_fits_without_overlap': True,
                                  'ring_passes_down_through_ring_base_lid_and_tube_with_seat_out': True,
                                  'ring_probe_diameter_mm': round(RB.RING_OD + 1., 2),
                                  'cable_slot_clear_through_seat_ring_base_and_lid': True, 'm3_paths_clear': True,
                                  'web_lid_m3_hole_to_bore_mm': round(lid_hole_web, 2),
                                  'mirrored_pattern_blocked_mm3': round(mirrored, 1)}
    return rep

def place(t, kind):
    """Print orientation: lid upside-down (outer face on the bed), others as built."""
    t = t.copy()
    if kind == 'lid':
        t.apply_transform(trimesh.transformations.rotation_matrix(np.pi, [1, 0, 0]))
    t.apply_translation(-t.bounds[0])
    return t

def render(solids, ring_base):
    import subprocess, tempfile
    blender = Path('C:/Program Files/Blender Foundation/Blender 5.2/blender.exe')
    if not blender.exists():
        print('Blender not found; preview skipped'); return
    from PIL import Image, ImageDraw, ImageFont
    ring = ring_base.copy(); ring.apply_translation([CX, -CY, TOP])
    seat = trimesh.load(Path(__file__).resolve().parent / 'ring-base' / 'ring-base-seat.stl')
    seat.apply_translation([CX, -CY, TOP + RB.BASE_H + RB.BOSS_H - RB.SEAT_H])
    items = []
    for name, mesh, col in (('base', B.to_mesh(solids['base']), [.18, .34, .43]), ('plate', B.to_mesh(solids['plate']), [.30, .46, .55]),
                            ('lid', B.to_mesh(solids['lid']), [.07, .14, .20]), ('ringbase', ring, [.80, .72, .58]),
                            ('seat', seat, [.93, .88, .76])):
        items.append(dict(name=name, vertices=mesh.vertices.tolist(), faces=mesh.faces.tolist(), color=col))
    with tempfile.TemporaryDirectory(prefix='round-preview-', dir=OUT) as temp:
        folder = Path(temp)
        (folder / 'mesh.json').write_text(json.dumps(dict(items=items, axis=[CX, CY])), encoding='utf-8')
        run = subprocess.run([str(blender), '--background', '--python', str(Path(__file__).resolve().parent / 'render_round_enclosure.py'),
                              '--', str(folder / 'mesh.json')], capture_output=True, text=True)
        if run.returncode:
            raise RuntimeError(run.stdout[-3000:] + chr(10) + run.stderr[-3000:])
        canvas = Image.new('RGB', (1800, 2420), (242, 244, 247))
        d = ImageDraw.Draw(canvas)
        font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 25)
        title = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 32)
        d.text((52, 22), f'COSMIC RAY DETECTOR v2  /  round case  \u00d8{2*R_OUT:.1f} mm  +  LED ring base \u00d8{RB.BASE_D:g} (boss \u00d8{RB.BOSS_D:g})', fill=(35, 56, 70), font=title)
        for i, (name, label) in enumerate([('front', 'OLED / RESET / LED side (+X)'), ('ports', 'USB / audio side'),
                                           ('exploded', 'exploded: ring seat / ring base / lid / tube / bottom plate'), ('under', 'underside: plate with 4 screws'),
                                           ('side', '-X wall: USB / 6-pin J4 plug window / microSD window'), ('trimmer', 'underside: gain-trimmer (R10) screwdriver hole')]):
            x = (i % 2) * 900; y = 85 + (i // 2) * 780
            d.text((x + 35, y), label, fill=(35, 56, 70), font=font)
            canvas.paste(Image.open(folder / (name + '.png')).convert('RGB'), (x, y + 35))
        canvas.save(OUT / (NAME + '-preview.png'))

def main():
    solids, info = design()
    rep = verify(solids)
    rep.update(info)
    rep['geometry_mm'] = {'inner_radius': R_IN, 'outer_diameter': round(2 * R_OUT, 1), 'wall': B.WALL,
                          'case_height_without_lid': round(SEAM - BOTTOM, 1),
                          'total_height_with_ring_base': round(TOP - BOTTOM + RB.BASE_H + RB.BOSS_H, 1),
                          'axis_kicad_xy': [CX, CY]}
    rep['ring_base'] = {'base_diameter': RB.BASE_D, 'boss_diameter': RB.BOSS_D, 'boss_height': RB.BOSS_H,
                        'screws': '3x M3x8 from inside the lid', 'on_circle_radius_mm': RB.PILOT_R,
                        'angles_deg': list(RB.PILOT_ANGLES), 'lid_hole_mm': 3.4, 'base_pilot_mm': RB.PILOT_D,
                        'bore_through_lid_and_ring_base_mm': round(RB.BORE_D, 2),
                        'seat': {'diameter': round(RB.SEAT_D, 2), 'thickness': RB.SEAT_H, 'file': 'ring-base/ring-base-seat.stl'},
                        'cable_slot_in_seat_mm': [RB.SLOT_L, RB.SLOT_W], 'cable_slot_centre_radius_mm': RB.SLOT_R,
                        'seat_open_slit_width_mm': RB.SLIT_W}
    rep['serviceability'] = {'plate_screws': 'M2x8 x4, from underneath, into tube bosses',
                             'plate_screw_positions_kicad_xy': [[round(x, 2), round(y, 2)] for x, y in PLATE_SCREWS],
                             'ring_exit': 'lift ring + seat out, ring drops through the lid bore into the tube; lid stays screwed on',
                             'board_exit': 'downward through the open bottom with the plate, the ring following on its cable',
                             'ring_cable_end': 'soldered to the board (no connector)',
                             'min_ring_cable_length_mm': 150, 'comfortable_ring_cable_length_mm': 200}
    for name, m in solids.items():
        place(B.to_mesh(m), name).export(OUT / f'{NAME}-{name}.stl')
    rb = trimesh.load(Path(__file__).resolve().parent / 'ring-base' / 'ring-base-lidmount.stl')
    render(solids, rb)
    rep['notes'] = ['Detector model not available in this repo: interference with individual parts was not re-run.',
                    'Inside the case nothing changed from the compact case; only the outer wall is round and the floor is a separate plate.',
                    'Ring size is assumed (see build_ring_base.py). No physical test print yet.']
    (OUT / f'{NAME}-validation.json').write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(rep, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
