"""Build a new, two-piece FDM case for the v2 detector, in millimetres.

Requires numpy, trimesh, manifold3d and matplotlib. Run from any directory:
    python cad/build_compact_enclosure.py
The existing Inventor case is not used to construct this design.
"""
from pathlib import Path
import base64, gzip, hashlib, json, re, struct, sys
import numpy as np
import trimesh
from manifold3d import Manifold, Mesh, CrossSection, JoinType, OpType

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'cad'
NAME = 'cosmic-ray-detector-v2-compact'
# Design frame: X = KiCad X, Y = minus KiCad Y, Z = height above PCB bottom.
X0, X1, Y0, Y1 = 33., 119., 30., 105.
# The board stands on three M2 hex spacers screwed through the floor. The floor
# top sits at the spacer foot; BOTTOM stays put so the USB notch keeps material.
SPACER = 17.
BOTTOM, FLOOR, SEAM, TOP = -20.4, -SPACER, 38.6, 41.
WALL, RADIUS, FIT = 2.4, 4., .3
SIZE = f'{X1-X0:g} x {Y1-Y0:g} x {round(TOP-BOTTOM,2):g} mm'
BOARD_POSTS = [(62.5, 63.), (91., 39.), (91., 96.)]
LID_POSTS = [(36.8,33.8),(115.2,33.8),(36.8,101.2),(115.2,101.2)]
# One rectangular opening: 8.5 mm beyond the outer jack centres horizontally
# and 10 mm above/below their axes. Also exposes the SD slot beneath OUT.
# DROP lowers the USB opening from the PCB-derived position to match the fitted
# unit. The OLED, audio, RESET and LED openings were lowered by DROP too, then
# raised by RAISE, so they now sit RAISE-DROP above the PCB-derived position.
# The USB opening is open down to the case bottom, widened by USB_EXTEND.
DROP = 3.
RAISE = 6.
USB_EXTEND = 6.
# The USB opening is also 10 mm larger: 5 mm more on each side, 10 mm taller at the top.
USB_GROW = 10.
SIDE_DROP = DROP-RAISE
AUDIO_X0, AUDIO_X1 = 40.5, 90.5
AUDIO_Z0, AUDIO_Z1 = -6.405-SIDE_DROP, 13.595-SIDE_DROP
# Separate front openings, in the assembled PCB frame. RESET's stem axis is
# above its housing centre; LED's optical axis is offset from its pad origin.
# RESET_Z is the stem axis; the hole itself sits DROP lower. The LED hole is a
# copy of the RESET hole at the same height, beside it. The size is the largest
# that keeps a WALL-thick web to both RESET and the OLED window.
MIN_WEB = 1.6  # thinnest wall left between the enlarged RESET, LED and OLED openings
RESET_Y, RESET_Z, RESET_R = 42., 5.595, 3.75
RESET_HOLE_Z = RESET_Z-SIDE_DROP
LED_X, LED_Y, LED_TOP = 101., 50.43, 9.895
LED_HOLE_Y, LED_HOLE_Z, LED_HOLE_R = 51.25, RESET_HOLE_Z, RESET_R
PIPE_Z, PIPE_R = 11.9, 1.5
PIPE_INLET_R, PIPE_ELBOW_X = .75, 102.1
# Light pipe: drops from the LED level to the front hole beyond the PCB edge.
PIPE_OUT_R, PIPE_DROP_X0, PIPE_DROP_X1, PIPE_COLLAR_R = LED_HOLE_R-.3, 108., 110., LED_HOLE_R+.8
# Lid screws thread into the printed boss: M2 self-tapping pilot (diameter).
LID_PILOT_D = 2.2
FLOOR_HOLE_D = 3.0  # clearance holes for the spacer screws
LID_HOLE_D = 3.4  # clearance holes in the lid for the lid screws

def box(x0,x1,y0,y1,z0,z1):
    return Manifold.cube([x1-x0,y1-y0,z1-z0]).translate([x0,-y1,z0])

def cyl(x,y,z0,z1,r,n=64):
    return Manifold.cylinder(z1-z0,r,r,n).translate([x,-y,z0])

def rr(x0,x1,y0,y1,r):
    return CrossSection.square([x1-x0-2*r,y1-y0-2*r]).translate([x0+r,-y1+r]).offset(r,JoinType.Round,2,64)

def slab(x0,x1,y0,y1,z0,z1,r):
    return rr(x0,x1,y0,y1,r).extrude(z1-z0).translate([0,0,z0])

def xslot(x0,x1,y0,y1,z0,z1,r):
    m = rr(y0,y1,z0,z1,r).extrude(x1-x0)
    return m.transform(np.array([[0,0,1,x0],[-1,0,0,0],[0,-1,0,0]],float))

def yslot(x0,x1,y0,y1,z0,z1,r):
    m = rr(x0,x1,z0,z1,r).extrude(y1-y0)
    return m.transform(np.array([[1,0,0,0],[0,0,1,-y1],[0,-1,0,0]],float))

def xhole(x0,x1,y,z,r):
    return Manifold.cylinder(x1-x0,r,r,64).rotate([0,90,0]).translate([x0,-y,z])

def yhole(x,y0,y1,z,r):
    return Manifold.cylinder(y1-y0,r,r,64).rotate([90,0,0]).translate([x,-y0,z])

def union(parts):
    return Manifold.batch_boolean(parts,OpType.Add)

def to_mesh(m):
    assert str(m.status()).endswith('NoError'), m.status()
    a=m.to_mesh()
    return trimesh.Trimesh(np.asarray(a.vert_properties)[:,:3],np.asarray(a.tri_verts),process=True)

def load_detector():
    path=ROOT/'lp/assets/model/detector-pack.js'
    raw=gzip.decompress(base64.b64decode(re.search(r'CRD_PACK="([^"]+)',path.read_text()).group(1)))
    jl=struct.unpack_from('<I',raw,4)[0]
    meta=json.loads(raw[8:8+jl]); off=(8+jl+3)//4*4
    parts={}
    for p in meta['parts']:
        if p['group'] in ['case','plate','hw'] or p['id']=='SCREW_M2':
            continue
        meshes=[]
        for c in p['chunks']:
            v=np.frombuffer(raw,'<u2',c['n']*3,off+c['o']).reshape(-1,3)/65535
            v=v*(np.array(c['bmax'])-c['bmin'])+c['bmin']+meta['origin']
            v=v[:,[0,2,1]]; v[:,1]*=-1
            f=np.frombuffer(raw,'<u2' if c['it']==16 else '<u4',c['c'],off+c['io']).reshape(-1,3)
            # Permutation and reflection together preserve winding.
            meshes.append(trimesh.Trimesh(v.copy(),f.copy(),process=True))
        if meshes:
            parts[p['id']]=meshes
    # Check the assembly used by the pack against the current PCB locations.
    pcb=(ROOT/'cosmic-ray-detector.kicad_pcb').read_text(encoding='utf-8')
    expected={'J3':(49.,90.0626),'J5':(60.,90.0626),'J6':(71.,90.0626),
              'J7':(82.,90.0626),'J8':(49.625,90.275),'OLED1':(93.4,74.2),
              'RESET1':(100.25,42.),'LED1':(101.,51.7),'U3':(80.44,54.24)}
    actual={}
    for fp in re.split(r'\n\t\(footprint ',pcb)[1:]:
        ref=re.search(r'\(property "Reference" "([^"]+)"',fp).group(1)
        xy=tuple(map(float,re.search(r'\n\t\t\(at ([^)]+)',fp).group(1).split()[:2]))
        if ref in expected:
            actual[ref]=xy
        if 'MountingHole' in fp.splitlines()[0] and xy in BOARD_POSTS:
            actual[str(xy)]=xy
    assert all(ref in actual and np.allclose(actual[ref],xy,atol=.0001) for ref,xy in expected.items())
    assert all(str(xy) in actual for xy in BOARD_POSTS)
    return parts,hashlib.sha256(path.read_bytes()).hexdigest()

def design():
    base=slab(X0,X1,Y0,Y1,BOTTOM,SEAM,RADIUS)-slab(X0+WALL,X1-WALL,Y0+WALL,Y1-WALL,FLOOR,SEAM+1,RADIUS-WALL)
    # 3.0 mm clearance holes for the M2 screws that hold the board spacers.
    for x,y in BOARD_POSTS:
        base -= cyl(x,y,BOTTOM-1,FLOOR+1,FLOOR_HOLE_D/2)
    for x,y in LID_POSTS:
        base += cyl(x,y,FLOOR-.2,SEAM,3.4)
        base -= cyl(x,y,SEAM-10.6,SEAM+1,LID_PILOT_D/2)
    # Ports follow the fitted detector, not the previous case.
    base -= xslot(32,40.1,38.6-USB_GROW/2,54.6+USB_GROW/2,-19.2-DROP-USB_EXTEND,-9.2-DROP+USB_GROW,1.2)  # USB boot clearance
    base -= xslot(116.3,120,56.8,83.6,5.2-SIDE_DROP,21.3-SIDE_DROP,1.)   # OLED window
    base -= xhole(115.3,120,RESET_Y,RESET_HOLE_Z,RESET_R)  # RESET finger hole
    base -= xhole(115.3,120,LED_HOLE_Y,LED_HOLE_Z,LED_HOLE_R)  # separate clear light pipe
    # Clear bulky audio plug housings with one generous, square-cornered port.
    # Start beyond the board spacers so their floor support remains intact.
    base -= box(AUDIO_X0,AUDIO_X1,99.3,106,AUDIO_Z0,AUDIO_Z1)
    lid=slab(X0,X1,Y0,Y1,SEAM,TOP,RADIUS)
    lip=slab(X0+WALL+FIT,X1-WALL-FIT,Y0+WALL+FIT,Y1-WALL-FIT,SEAM-3.,SEAM+.1,1.3)
    lip-=slab(X0+WALL+FIT+1.2,X1-WALL-FIT-1.2,Y0+WALL+FIT+1.2,Y1-WALL-FIT-1.2,SEAM-3.1,SEAM+.2,.2)
    for x,y in LID_POSTS:
        lip-=cyl(x,y,SEAM-4,SEAM+1,3.75)
    lid+=lip
    for x,y in LID_POSTS:
        lid-=cyl(x,y,SEAM-4,TOP+1,LID_HOLE_D/2)
        lid-=cyl(x,y,TOP-1.4,TOP+1,3.2)
    # Optional L-shaped light pipe, kept below the scintillator.
    # Narrow inlet clears the SiPM board edge at X=100; the full-size rod starts
    # beyond that edge while the inlet stays directly above the LED lens.
    pipe=xhole(PIPE_ELBOW_X,PIPE_DROP_X0,LED_Y,PIPE_Z,PIPE_R)
    pipe+=xhole(LED_X,PIPE_ELBOW_X+.1,LED_Y,PIPE_Z,PIPE_INLET_R)
    pipe+=cyl(LED_X,LED_Y,LED_TOP+.5,PIPE_Z,PIPE_INLET_R)
    a=Manifold.sphere(PIPE_R,48).translate([PIPE_DROP_X0,-LED_Y,PIPE_Z])
    b=Manifold.sphere(PIPE_OUT_R,48).translate([PIPE_DROP_X1,-LED_HOLE_Y,LED_HOLE_Z])
    pipe+=Manifold.batch_hull([a,b])
    pipe+=xhole(PIPE_DROP_X1,119.8,LED_HOLE_Y,LED_HOLE_Z,PIPE_OUT_R)
    pipe+=xhole(115.5,116.4,LED_HOLE_Y,LED_HOLE_Z,PIPE_COLLAR_R)
    return {'base':base,'lid':lid,'lightpipe':pipe}

def mesh_manifold(mesh):
    mesh=mesh.copy(); mesh.merge_vertices(); trimesh.repair.fix_normals(mesh,multibody=True)
    return Manifold(Mesh(np.array(mesh.vertices,dtype=np.float32),np.array(mesh.faces,dtype=np.uint32)))

def verify(solids,parts):
    report={'printed_parts':{},'intersections':[],'source_checks':{},'unchecked_open_components':[], 'convex_envelope_checks':[]}
    for name,m in solids.items():
        t=to_mesh(m)
        assert t.is_watertight and t.is_winding_consistent and t.volume>0
        assert len(t.split())==1, name
        report['printed_parts'][name]={'watertight':bool(t.is_watertight),'single_connected_solid':True,
            'triangles':len(t.faces),'volume_mm3':round(t.volume,2),'bounds_design_mm':np.round(t.bounds,4).tolist()}
    assert (solids['base']^solids['lid']).volume()<.001
    assert (solids['base']^solids['lightpipe']).volume()<.001
    report['source_checks']['lid_and_base_overlap_mm3']=round((solids['base']^solids['lid']).volume(),6)
    # Validate the actual wall cross-section, so merged or blind openings fail.
    section=to_mesh(solids['base']).section(plane_origin=[X1-WALL/2,0,0],plane_normal=[1,0,0])
    loops=section.discrete
    front={}
    for name,y,z,r in [('reset',RESET_Y,RESET_HOLE_Z,RESET_R),('led',LED_HOLE_Y,LED_HOLE_Z,LED_HOLE_R)]:
        bounds=np.array([[-y-r,z-r],[-y+r,z+r]])
        matches=[line for line in loops if np.allclose(np.stack([line[:,1:].min(0),line[:,1:].max(0)]),bounds,atol=.01)]
        assert len(matches)==1, f'{name}: missing independent through-hole'
        probe=xhole(X1-WALL-.01,X1+.01,y,z,r-.05)
        assert (solids['base']^probe).volume()<.001, f'{name}: obstructed opening'
        front[name]={'centre_design_yz_mm':[y,z],'diameter_mm':2*r,'independent_through_hole':True}
    web=float(np.hypot(LED_HOLE_Y-RESET_Y,LED_HOLE_Z-RESET_HOLE_Z)-RESET_R-LED_HOLE_R)
    assert web>=MIN_WEB-1e-6, 'Insufficient material between RESET and LED openings'
    assert 56.8-(LED_HOLE_Y+LED_HOLE_R)>=MIN_WEB-1e-6, 'Insufficient material between LED hole and OLED window'
    stem=trimesh.util.concatenate(parts['RESET1']).vertices
    tip=stem[stem[:,0]>stem[:,0].max()-.02]
    tip_centre=(tip.min(0)+tip.max(0))/2
    assert np.allclose(tip_centre[1:],[-RESET_Y,RESET_Z],atol=.01), 'RESET hole is off axis'
    led=trimesh.util.concatenate(parts['LED1']).vertices
    lens=led[led[:,2]>8.3]
    lens_centre=(lens.min(0)+lens.max(0))/2
    assert np.allclose(lens_centre[:2],[LED_X,-LED_Y],atol=.01), 'Light pipe is off LED axis'
    assert abs(led[:,2].max()-LED_TOP)<.01
    front.update(minimum_web_mm=round(web,3),reset_stem_axis_design_yz_mm=np.round(tip_centre[1:]*[-1,1],3).tolist(),
                 lightpipe_inlet_design_xy_mm=[LED_X,-LED_Y],lightpipe_inlet_diameter_mm=2*PIPE_INLET_R,
                 lightpipe_to_led_gap_mm=.5)
    report['front_openings_mm']=front
    checked=0; total=0
    for pid,meshes in parts.items():
        merged=trimesh.util.concatenate(meshes)
        # Quantized material chunks have independently rounded boundaries.
        # Weld at 0.01 mm before testing the complete component surfaces.
        merged.merge_vertices(digits_vertex=2)
        for mesh in [merged]:
            for component in mesh.split(only_watertight=False):
                total+=1
                if not component.is_watertight:
                    if len(component.vertices)>=4 and np.linalg.matrix_rank(component.vertices-component.vertices.mean(0),tol=.005)==3:
                        component=component.convex_hull
                        report['convex_envelope_checks'].append(pid)
                    else:
                        report['unchecked_open_components'].append(pid)
                        continue
                if pid=='RESET1':
                    # The RESET hole sits SIDE_DROP lower than the modelled stem, so
                    # test the stem where the fitted unit has it.
                    component=component.copy(); component.apply_translation([0,0,-SIDE_DROP])
                m=mesh_manifold(component)
                if not str(m.status()).endswith('NoError'):
                    report['unchecked_open_components'].append(pid)
                    continue
                checked+=1
                for name,s in solids.items():
                    volume=(s^m).volume()
                    if volume>.003:
                        report['intersections'].append({'part':pid,'case':name,'overlap_mm3':round(volume,5)})
    report['source_checks'].update(checked_closed_components=checked,total_components=total)
    report['unchecked_open_components']=sorted(set(report['unchecked_open_components']))
    report['convex_envelope_checks']=sorted(set(report['convex_envelope_checks']))
    return report

def render(solids,parts):
    import subprocess, tempfile
    blender=Path('C:/Program Files/Blender Foundation/Blender 5.2/blender.exe')
    if blender.exists():
        from PIL import Image,ImageDraw,ImageFont
        items=[]
        def add(name,t,color):
            items.append(dict(name=name,vertices=t.vertices.tolist(),faces=t.faces.tolist(),color=color))
        for name,m in solids.items():
            add(name,to_mesh(m),[.18,.34,.43] if name=='base' else [.07,.14,.20] if name=='lid' else [.72,.88,.90])
        for pid,meshes in parts.items():
            color=[.13,.37,.21] if pid.startswith('PCB') or pid=='U3' else [.32,.65,.78] if pid=='SCINT' else [.45,.47,.48] if pid.startswith('J') else [.08,.11,.14]
            add(pid,trimesh.util.concatenate(meshes),color)
        with tempfile.TemporaryDirectory(prefix='enclosure-preview-',dir=OUT) as temp:
            folder=Path(temp)
            (folder/'mesh.json').write_text(json.dumps(items),encoding='utf-8')
            run=subprocess.run([str(blender),'--background','--python',str(OUT/'render_compact_enclosure.py'),'--',str(folder/'mesh.json')],capture_output=True,text=True)
            if run.returncode:
                raise RuntimeError(run.stdout[-3000:]+'\n'+run.stderr[-3000:])
            canvas=Image.new('RGB',(1800,1570),(242,244,247))
            d=ImageDraw.Draw(canvas)
            font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',25)
            title=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',32)
            d.text((52,22),'COSMIC RAY DETECTOR v2  /  '+SIZE,fill=(35,56,70),font=title)
            for i,(name,label) in enumerate([('exploded','NEW ENCLOSURE / exploded'),('front','ENCLOSURE / OLED + RESET'),('ports','PORTS / USB + OUT, SD, IN1-3'),('fit','PCB FIT / lid removed')]):
                x=(i%2)*900; y=85+(i//2)*735
                d.text((x+35,y),label,fill=(35,56,70),font=font)
                canvas.paste(Image.open(folder/(name+'.png')).convert('RGB'),(x,y+35))
            canvas.save(OUT/(NAME+'-preview.png'))
        return
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    fig=plt.figure(figsize=(16,9),facecolor='#f2f4f7')
    views=[(221,'NEW ENCLOSURE / exploded',True),(222,'ENCLOSURE / front',False),
           (223,'PORTS / USB, OUT + SD, IN1-3',False),(224,'PCB FIT / lid removed',None)]
    def draw(ax,mesh,color,alpha=1,shift=(0,0,0)):
        v=mesh.vertices+np.array(shift)
        pc=Poly3DCollection(v[mesh.faces],facecolors=color,edgecolors=(0,0,0,0),linewidths=0,alpha=alpha,shade=True,
                            lightsource=matplotlib.colors.LightSource(azdeg=310,altdeg=45))
        ax.add_collection3d(pc)
    for number,title,exploded in views:
        ax=fig.add_subplot(number,projection='3d',facecolor='#f2f4f7')
        draw(ax,to_mesh(solids['base']),'#6a8898',.23 if exploded is None else 1)
        if exploded is not None:
            draw(ax,to_mesh(solids['lid']),'#334b5d',1,(0,0,23 if exploded else 0))
        if exploded is True or exploded is None:
            for pid in ['PCB_MAIN','PCB_SIPM','U3','SCINT','OLED1','J3','J5','J6','J7','RESET1']:
                for t in parts.get(pid,[]):
                    draw(ax,t,'#4e8b64' if pid.startswith('PCB') or pid=='U3' else '#8ebed1' if pid=='SCINT' else '#3c454c',.6 if pid=='SCINT' else 1)
        ax.set_title(title,fontsize=11,color='#273b4a',pad=4)
        ax.set_xlim(27,125);ax.set_ylim(-111,-24);ax.set_zlim(-23,58 if exploded else 36)
        ax.set_box_aspect([98,87,81 if exploded else 59]);ax.set_axis_off()
        ax.view_init(elev=28,azim=-42 if number!=223 else -135)
    fig.suptitle('COSMIC RAY DETECTOR v2  |  '+SIZE+'  |  FDM / 2.4 mm walls',
                 fontsize=17,color='#273b4a',y=.98)
    fig.subplots_adjust(left=.005,right=.99,bottom=.015,top=.93,wspace=.02,hspace=.02)
    fig.savefig(OUT/(NAME+'-preview.png'),dpi=170,facecolor=fig.get_facecolor())
    plt.close(fig)

def main():
    parts,source_hash=load_detector(); solids=design(); report=verify(solids,parts)
    report['detector_pack_sha256']=source_hash
    report['overall_mm']=[X1-X0,Y1-Y0,round(TOP-BOTTOM,2)]
    report['board_mount']={'spacer_length_mm':SPACER,'spacer_count':len(BOARD_POSTS),
        'floor_hole_diameter_mm':FLOOR_HOLE_D,'floor_thickness_mm':round(FLOOR-BOTTOM,2)}
    scint_top=max(t.bounds[1][2] for t in parts['SCINT'])
    report['audio_opening_mm']={'shape':'rectangle','width':AUDIO_X1-AUDIO_X0,
        'height':AUDIO_Z1-AUDIO_Z0,'horizontal_margin_from_outer_jack_centres':8.5,
        'vertical_margin_from_jack_axes':10.,'includes_microsd_access':True}
    report['notes']=['Nano ESP32 geometry in the source pack is a simplified model.',
                     f'The scintillator model excludes wrapping; {SEAM-scint_top:.3f} mm clearance to lid underside.',
                     'Physical prototype fit and optical lightpipe transmission remain untested.']
    for name,m in solids.items():
        t=to_mesh(m)
        if name=='lid':
            t.apply_transform(trimesh.transformations.rotation_matrix(np.pi,[1,0,0]))
        elif name=='lightpipe':
            t.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2,[0,1,0]))
        t.apply_translation(-t.bounds[0])
        t.export(OUT/(NAME+'-'+name+'.stl'))
        report['printed_parts'][name]['print_extents_mm']=np.round(t.extents,4).tolist()
    (OUT/(NAME+'-validation.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    render(solids,parts)
    print(json.dumps(report,ensure_ascii=False,indent=2))
    if report['intersections']:
        raise SystemExit('Resolve reported intersections before printing.')

if __name__=='__main__':
    main()
