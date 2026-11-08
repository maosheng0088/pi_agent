from PIL import Image
import numpy as np
p = r"D:\code\pi\客服素材\01a182b5-3abe-77f3-b89e-bdcd7149714a\exec-0ce05799-5f74-4302-b331-29de5ac2ec83.png"
img = Image.open(p).convert("RGB")
a = np.array(img)
print("shape", a.shape)
# unique color count
flat = a.reshape(-1,3)
uniq, counts = np.unique(flat, axis=0, return_counts=True)
print("unique colors:", len(uniq))
top = np.argsort(-counts)[:12]
for i in top:
    print("  #%02x%02x%02x"%tuple(uniq[i]), counts[i], f"{100*counts[i]/len(flat):.1f}%")
# Save downscaled ascii-art luminance map 60x60
g = np.array(img.convert("L").resize((60,60)))
chars = " .:-=+*#%@"
print("\n--- luminance map (60x60) ---")
for row in g:
    print("".join(chars[min(9, int(v/26))] for v in row))
