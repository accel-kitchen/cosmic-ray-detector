"""Headless Blender renderer for the OMOCHI previews, called by render_omochi.py.

Reads a JSON file: {"meshes": {name: {"v": [[x,y,z]...], "f": [[a,b,c]...]}} (mm),
                    "scenes": [{"name", "size": [w,h], "camera": {...}, "items": [{"mesh","color","offset"}]}],
                    "out": folder}
"""
import bpy, json, math, sys
from pathlib import Path
from mathutils import Vector

data = json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_text())
out = Path(data['out'])
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.display.render_aa = '16'
shade = scene.display.shading
shade.light = 'STUDIO'
shade.color_type = 'OBJECT'
shade.show_shadows = True
shade.shadow_intensity = .45
shade.show_cavity = True
shade.cavity_type = 'BOTH'
shade.cavity_ridge_factor = 1.2
shade.cavity_valley_factor = 1.6
shade.show_specular_highlight = False
shade.show_object_outline = True
shade.object_outline_color = (.18, .17, .16)
shade.background_type = 'VIEWPORT'
shade.background_color = (.60, .59, .56)
scene.view_settings.view_transform = 'Standard'
scene.view_settings.exposure = .75

objects = {}
for name, m in data['meshes'].items():
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([[c / 1000 for c in v] for v in m['v']], [], m['f'])
    mesh.update()
    ob = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(ob)
    objects[name] = ob

cam_data = bpy.data.cameras.new('Camera')
cam_data.type = 'ORTHO'
cam_data.clip_start = .001
cam_data.clip_end = 10
cam = bpy.data.objects.new('Camera', cam_data)
bpy.context.collection.objects.link(cam)
scene.camera = cam

for sc in data['scenes']:
    scene.render.resolution_x, scene.render.resolution_y = sc['size']
    scene.render.resolution_percentage = 100
    shown = {it['mesh']: it for it in sc['items']}
    for name, ob in objects.items():
        ob.hide_render = name not in shown
        if name in shown:
            it = shown[name]
            ob.color = tuple(it['color']) + (1.,)
            ob.location = tuple(c / 1000 for c in it.get('offset', (0, 0, 0)))
    c = sc['camera']
    cam.location = Vector([v / 1000 for v in c['pos']])
    if c.get('top'):
        cam.rotation_euler = (0., 0., math.pi / 2)   # image up = -X, image right = +Y
    else:
        target = Vector([v / 1000 for v in c['target']])
        cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.ortho_scale = c['scale'] / 1000
    scene.render.filepath = str(out / (sc['name'] + '.png'))
    bpy.ops.render.render(write_still=True)
print('rendered', len(data['scenes']))
