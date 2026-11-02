"""Preview renders for the OMOCHI variants: Blender (Workbench) + a PIL overview sheet."""
from pathlib import Path
import json, subprocess, tempfile
import numpy as np
import trimesh

BLENDER = Path('C:/Program Files/Blender Foundation/Blender 5.2/blender.exe')
FONT = 'C:/Windows/Fonts/BIZ-UDGothicB.ttc'

PLAIN = dict(body=(.90, .88, .82), lid=(.80, .77, .70), cover=(.98, .96, .92), inlay=(.80, .60, .20), pipe=(.95, .55, .68))
CSI = dict(body=(.93, .73, .78), lid=(.84, .62, .68), cover=(.98, .84, .87), inlay=(.36, .58, .34), pipe=(.95, .55, .68))


def mesh_json(trimesh_obj):
    return {'v': np.round(trimesh_obj.vertices, 4).tolist(), 'f': trimesh_obj.faces.tolist()}


def run(solids, base_face, covers, fills, out):
    import build_compact_enclosure as cc
    import build_omochi_variants as bv
    from manifold3d import Manifold

    tm = cc.to_mesh
    meshes = {'base': tm(solids['base']), 'lid': tm(solids['lid']), 'pipe': tm(solids['lightpipe']),
              'base_face': tm(base_face)}
    for key in ('cover', 'cover-plain', 'cover-csi'):
        meshes[key] = tm(covers[key])
        meshes['fill-' + key] = tm(fills[key])
    # as printed: top on the bed (the same flip the STL export uses)
    printed = bv.print_orient(meshes['cover-plain'], True)
    meshes['cover_print'] = printed
    # section through the pillars (KiCad Y = CY - 17), looking from the -Y side
    keep = cc.box(0, 300, 0, bv.CY - 17, -60, 120)
    for key, solid in (('sec_base', base_face), ('sec_lid', solids['lid']), ('sec_cover', covers['cover-plain'])):
        meshes[key] = tm(solid ^ keep)
    meshes = {k: mesh_json(v) for k, v in meshes.items()}

    cx, cy = bv.CX, -bv.CY
    stack_target = (cx, cy, 16.)
    three_q = dict(pos=(cx + 134, cy - 123, 94.), target=stack_target, scale=186.)
    exploded = dict(pos=(cx + 120, cy - 130, 100.), target=(cx, cy, 30.), scale=250.)
    top = dict(pos=(cx, cy, 300.), target=(cx, cy, 0.), scale=106., top=True)
    front_wide = dict(pos=(400., -67.5, 16.), target=(119., -67.5, 16.), scale=112.)
    front_close = dict(pos=(400., -47., 3.), target=(119., -47., 3.), scale=46.)
    face_34 = dict(pos=(270., 20., 95.), target=(119., -55., 16.), scale=175.)
    section = dict(pos=(cx, -400., 12.), target=(cx, -50., 12.), scale=150.)
    printed_view = dict(pos=(45.5 + 120, 40. - 110, 120.), target=(45.5, 40., 6.), scale=128.)

    def items(pal, cover, body='base', fill=True, lid_off=(0, 0, 0), cover_off=(0, 0, 0)):
        its = [dict(mesh=body, color=pal['body']), dict(mesh='lid', color=pal['lid'], offset=lid_off),
               dict(mesh='pipe', color=pal['pipe']), dict(mesh=cover, color=pal['cover'], offset=cover_off)]
        if fill:
            its.append(dict(mesh='fill-' + cover, color=pal['inlay'], offset=(cover_off[0], cover_off[1], cover_off[2] - .03)))
        return its

    S = lambda name, cam, its, size=(1500, 1100): dict(name=name, size=list(size), camera=cam, items=its)
    scenes = [
        S('p1_assembled', three_q, items(PLAIN, 'cover')),
        S('p1_exploded', exploded, items(PLAIN, 'cover', lid_off=(0, 0, 20), cover_off=(0, 0, 62))),
        S('p1_top', top, items(PLAIN, 'cover'), (1500, 1300)),
        S('p1_printed', printed_view, [dict(mesh='cover_print', color=PLAIN['cover'])]),
        S('p1_section', section, [dict(mesh='sec_base', color=PLAIN['body']), dict(mesh='sec_lid', color=PLAIN['lid']),
                                  dict(mesh='sec_cover', color=PLAIN['cover'])], (1500, 900)),
        S('p2_plain', three_q, items(PLAIN, 'cover-plain')),
        S('p2_csi', three_q, items(CSI, 'cover-csi')),
        S('p2_plain_top', top, items(PLAIN, 'cover-plain'), (1500, 1300)),
        S('p2_csi_top', top, items(CSI, 'cover-csi'), (1500, 1300)),
        S('p3_front', front_wide, items(PLAIN, 'cover', body='base_face', fill=False), (1500, 1000)),
        S('p3_closeup', front_close, items(PLAIN, 'cover', body='base_face', fill=False), (1400, 1100)),
        S('p3_34', face_34, items(PLAIN, 'cover', body='base_face', fill=False)),
    ]
    prev = out / '_render'
    prev.mkdir(exist_ok=True)
    jpath = prev / 'scene.json'
    jpath.write_text(json.dumps({'meshes': meshes, 'scenes': scenes, 'out': str(out)}), encoding='utf-8')
    here = Path(__file__).resolve().parent
    res = subprocess.run([str(BLENDER), '--background', '--python', str(here / 'blender_omochi.py'), '--', str(jpath)],
                         capture_output=True, text=True)
    if res.returncode:
        raise RuntimeError(res.stdout[-3000:] + '\n' + res.stderr[-3000:])
    jpath.unlink()
    prev.rmdir()
    sheet(out)


def sheet(out):
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.truetype(FONT, 34)
    small = ImageFont.truetype(FONT, 26)
    cells = [('p1_assembled', '1  餅カバー(月のうさぎ)'), ('p1_exploded', '1  分解'),
             ('p2_plain', '2  白餅(プラ版)'), ('p2_csi', '2  塩大福(CsI版)'),
             ('p3_34', '3  顔(目=RESET/LED、口とほっぺ=彫り)'), ('p3_closeup', '3  前面クローズアップ')]
    w, h = 750, 560
    canvas = Image.new('RGB', (w * 2, 90 + (h + 50) * 3), (237, 234, 228))
    d = ImageDraw.Draw(canvas)
    d.text((24, 22), 'OMOCHI  —  Online MOnitor of Cosmic- and gamma-ray Hits, Individually', fill=(60, 52, 44), font=font)
    for i, (name, label) in enumerate(cells):
        im = Image.open(out / f'{name}.png').convert('RGB')
        im.thumbnail((w, h))
        x, y = (i % 2) * w, 90 + (i // 2) * (h + 50)
        canvas.paste(im, (x + (w - im.width) // 2, y + 44 + (h - im.height) // 2))
        d.text((x + 24, y + 6), label, fill=(60, 52, 44), font=small)
    canvas.save(out / 'omochi-overview.png', optimize=True)
