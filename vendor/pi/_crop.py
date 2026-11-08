from PIL import Image
import numpy as np, os
d = r"D:\code\pi\客服素材\01a182b5-3abe-77f3-b89e-bdcd7149714a"
out = r"D:\code\pi\_ocr\crops"
os.makedirs(out, exist_ok=True)
f = "exec-0ce05799-5f74-4302-b331-29de5ac2ec83.png"
img = Image.open(os.path.join(d,f)).convert("RGB")
a = np.array(img.convert("L"))
# find dark text rows
ink = (a < 160).sum(axis=1)
runs=[]; start=None
for i,v in enumerate(ink):
    if v>2 and start is None: start=i
    elif v<=2 and start is not None:
        if i-start>6: runs.append((start,i))
        start=None
print("dark row bands (y0,y1,height):")
for r in runs[:40]: print("  ", r, r[1]-r[0])
# column profile of the largest band
if runs:
    y0,y1 = max(runs, key=lambda r: r[1]-r[0])
    band = a[y0:y1]
    colink = (band<160).sum(axis=0)
    cruns=[]; s=None
    for i,v in enumerate(colink):
        if v>0 and s is None: s=i
        elif v==0 and s is not None:
            if i-s>3: cruns.append((s,i))
            s=None
    print(f"\nlargest band y={y0}-{y1}, {len(cruns)} text columns, first 15:")
    for c in cruns[:15]: print("   x", c, "w=",c[1]-c[0])
