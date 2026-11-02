import sys, pathlib
from playwright.sync_api import sync_playwright
from PIL import Image
D = pathlib.Path(__file__).parent.resolve()
def render(files, out, w=700, bg='#8a8a8a'):
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={'width': w, 'height': 1000})
        ims = []
        for i, f in enumerate(files):
            h = D / ('_r%d.html' % i)
            h.write_text('<body style="margin:0;background:%s"><img src="%s" style="width:%dpx;display:block"></body>' % (bg, pathlib.Path(f).resolve().name if pathlib.Path(f).resolve().parent == D else pathlib.Path(f).resolve().as_uri(), w), encoding='utf-8')
            pg.goto(h.as_uri()); pg.wait_for_timeout(500)
            pg.screenshot(path=str(D / ('_r%d.png' % i)), full_page=True); ims.append(Image.open(D / ('_r%d.png' % i)).convert('RGB'))
            h.unlink()
        b.close()
    H = max(i.height for i in ims)
    s = Image.new('RGB', (w * len(ims), H), bg)
    for i, im in enumerate(ims): s.paste(im, (i * w, 0))
    s.save(D / out)
    for i in range(len(ims)): (D / ('_r%d.png' % i)).unlink()
if __name__ == '__main__':
    render(sys.argv[2:], sys.argv[1])
