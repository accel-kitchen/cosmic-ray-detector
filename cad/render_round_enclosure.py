"""Headless Blender preview helper, called by build_round_enclosure.py."""
import bpy, json, sys
from pathlib import Path
from mathutils import Vector

data_path = Path(sys.argv[sys.argv.index('--') + 1])
data = json.loads(data_path.read_text())
cx, cy = data['axis']
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.resolution_x, scene.render.resolution_y = 900, 760
scene.render.image_settings.file_format = 'PNG'
sh = scene.display.shading
sh.light = 'STUDIO'; sh.color_type = 'OBJECT'; sh.show_shadows = True
sh.show_cavity = True; sh.cavity_type = 'BOTH'; sh.background_type = 'VIEWPORT'
sh.background_color = (.89, .91, .94)
scene.view_settings.view_transform = 'Standard'
objs = {}
for it in data['items']:
    me = bpy.data.meshes.new(it['name'])
    me.from_pydata([[a / 1000 for a in v] for v in it['vertices']], [], it['faces']); me.update()
    ob = bpy.data.objects.new(it['name'], me)
    bpy.context.collection.objects.link(ob)
    ob.color = tuple(it['color']) + (1.,)
    objs[it['name']] = ob
cd = bpy.data.cameras.new('Camera'); cam = bpy.data.objects.new('Camera', cd)
bpy.context.collection.objects.link(cam); scene.camera = cam
cd.type = 'ORTHO'; cd.clip_start = .001; cd.clip_end = 10
# name, camera offset (m, relative to axis), target z, ortho scale, lid lift, ring lift, plate drop
views = [('front', (.20, -.04, .16), .02, .20, 0., 0., 0.),      # +X side: OLED, RESET, LED
         ('ports', (-.19, -.12, .13), .02, .20, 0., 0., 0.),     # -X / +Y side: USB, audio
         ('exploded', (.20, -.17, .20), .03, .30, .020, .045, -.035),
         ('under', (.14, -.15, -.16), -.02, .20, 0., 0., -.012),  # from below, plate dropped a little
         ('side', (-.20, -.06, .06), -.00, .17, 0., 0., 0.),       # -X wall: USB, 6-pin plug window, microSD window
         ('trimmer', (.00, -.01, -.20), -.02, .15, 0., 0., 0.)]    # straight up at the plate: gain-trimmer hole
for name, off, tz, scale, lift, rlift, pdrop in views:
    objs['lid'].location.z = lift
    objs['ringbase'].location.z = rlift
    objs['plate'].location.z = pdrop
    cam.location = (cx / 1000 + off[0], -cy / 1000 + off[1], off[2])
    tgt = Vector((cx / 1000, -cy / 1000, tz))
    cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cd.ortho_scale = scale
    scene.render.filepath = str(data_path.parent / (name + '.png'))
    bpy.ops.render.render(write_still=True)
