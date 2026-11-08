import os, glob
from PIL import Image
d = r"D:\code\pi\客服素材\01a182b5-3abe-77f3-b89e-bdcd7149714a"
files = sorted(glob.glob(os.path.join(d, "*.png")))
print("count:", len(files))
try:
    import ddddocr
    ocr = ddddocr.DdddOcr(show_ad=False)
    for f in files:
        img = Image.open(f)
        try:
            res = ocr.classification(img)
        except Exception as e:
            res = "ERR:"+str(e)
        print("="*20, os.path.basename(f))
        print(res[:600])
except Exception as e:
    print("ddddocr init fail:", e)
