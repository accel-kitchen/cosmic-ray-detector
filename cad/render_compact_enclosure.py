"""Headless Blender preview helper, called by build_compact_enclosure.py."""
import bpy, json, sys
from pathlib import Path
from mathutils import Vector

data_path=Path(sys.argv[sys.argv.index('--')+1])
data=json.loads(data_path.read_text())
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
scene.render.engine='BLENDER_WORKBENCH'
scene.render.resolution_x=900
scene.render.resolution_y=700
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.film_transparent=False
shade=scene.display.shading
shade.light='STUDIO'
shade.color_type='OBJECT'
shade.show_shadows=True
shade.show_cavity=True
shade.cavity_type='BOTH'
shade.show_specular_highlight=True
shade.background_type='VIEWPORT'
shade.background_color=(.89,.91,.94)
scene.view_settings.view_transform='Standard'
objects={}
for item in data:
    mesh=bpy.data.meshes.new(item['name'])
    mesh.from_pydata([[a/1000 for a in v] for v in item['vertices']],[],item['faces'])
    mesh.update()
    ob=bpy.data.objects.new(item['name'],mesh)
    bpy.context.collection.objects.link(ob)
    ob.color=tuple(item['color'])+(1.,)
    objects[item['name']]=ob
cam_data=bpy.data.cameras.new('Camera')
cam=bpy.data.objects.new('Camera',cam_data)
bpy.context.collection.objects.link(cam)
scene.camera=cam
cam_data.type='ORTHO'
cam_data.clip_start=.001
cam_data.clip_end=10
views=[('exploded',(.20,-.21,.16),(.076,-.067,.018),.180,.022,False),
       ('front',(.21,-.19,.14),(.076,-.067,.004),.170,0.,False),
       ('ports',(-.07,-.22,.13),(.076,-.067,.004),.170,0.,False),
       ('fit',(.18,-.20,.25),(.076,-.067,.004),.175,0.,True)]
for name,pos,target,scale,lift,hide in views:
    objects['lid'].location.z=lift
    objects['lid'].hide_render=hide
    cam.location=pos
    cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler()
    cam_data.ortho_scale=scale
    scene.render.filepath=str(data_path.parent/(name+'.png'))
    bpy.ops.render.render(write_still=True)
