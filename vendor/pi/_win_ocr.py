import os, glob, sys
d = r"D:\code\pi\客服素材\01a182b5-3abe-77f3-b89e-bdcd7149714a"
files = sorted(glob.glob(os.path.join(d, "*.png")))[:2]
try:
    from winsdk.windows.media.ocr import OcrEngine
    from winsdk.windows.graphics.imaging import BitmapDecoder
    from winsdk.windows.storage import StorageFile, FileAccessMode
    print("winsdk OK")
except Exception as e:
    print("winsdk import fail:", e); sys.exit(1)

engine = OcrEngine.try_create_from_user_profile_languages()
print("engine:", engine)
if engine is None:
    sys.exit(2)
for f in files:
    sf = StorageFile.get_file_from_path_async(f)
    import asyncio
    # use asyncio helper
    async def run():
        s = await StorageFile.get_file_from_path_async(f)
        stream = await s.open_async(FileAccessMode.READ)
        dec = await BitmapDecoder.create_async(stream)
        bmp = await dec.get_software_bitmap_async()
        res = await engine.recognize_async(bmp)
        return res
    r = asyncio.get_event_loop().run_until_complete(run())
    print("="*20, os.path.basename(f))
    print(r.text[:1500])
