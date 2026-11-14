"""Step 2b: trace the snapped 2x image (stacked, flat colours). usage: python mv_trace.py NAME"""
import sys, pathlib, vtracer
D = pathlib.Path(__file__).resolve().parent.parent
n = sys.argv[1]
vtracer.convert_image_to_svg_py(str(D / f'work-{n}/snap2x.png'), str(D / f'work-{n}/trace.svg'), colormode='color', hierarchical='stacked', mode='spline',
    filter_speckle=6, color_precision=8, layer_difference=4, corner_threshold=60, length_threshold=5.0, max_iterations=10, splice_threshold=45, path_precision=2)
