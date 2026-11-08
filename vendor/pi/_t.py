import cv2, sys
p = r"D:\code\pi-web\.data\attachment-inbox\01a1852f-ec27-72a4-8f74-47bc030d32df\028fe41e-2e03-413b-a21b-915952b79f8e-932cffae-71ba-47f6-a346-12156dd30338\64543a23-192e-4fe9-b617-6a8130be5d7d\64543a23-192e-4fe9-b617-6a8130be5d7d-111.jpg"
img = cv2.imread(p)
print("shape", img.shape)
g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
small = cv2.resize(g, None, fx=0.5, fy=0.5)
thr = cv2.adaptiveThreshold(small, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 21, 10)
cv2.imwrite(r"D:\code\pi\ocr_thr.png", thr)
import numpy as np
print("mean", g.mean(), "std", g.std())
