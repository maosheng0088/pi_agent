import os, glob
from PIL import Image
import collections
d = r"D:\code\pi\客服素材\01a182b5-3abe-77f3-b89e-bdcd7149714a"
files = sorted(glob.glob(os.path.join(d, "*.png")))
for f in files:
    img = Image.open(f).convert("RGB")
    w,h = img.size
    # color palette
    small = img.resize((160,160))
    colors = collections.Counter(small.getdata())
    top = colors.most_common(4)
    names = ["#%02x%02x%02x"%c for c,_ in top]
    # edge rows/cols variance -> find non-white content bbox
    gray = img.convert("L")
    import numpy as np
    a = np.array(gray)
    rows = (a<245).sum(axis=1)
    cols = (a<245).sum(axis=0)
    r = np.where(rows>3)[0]; c = np.where(cols>3)[0]
    bbox = (int(c.min()),int(r.min()),int(c.max()),int(r.max())) if len(r) and len(c) else None
    print(f"{os.path.basename(f)[5:13]}  {w}x{h}  mode={img.mode}  colors={names}")
    print(f"    ink_bbox={bbox}  nonwhite_px={int((a<245).sum())} ({100*(a<245).sum()/a.size:.1f}%)")
