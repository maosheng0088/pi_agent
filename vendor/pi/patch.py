import sys, shutil
from pathlib import Path
skill = Path(r"D:\code\pi-web\.data\skills\55dde3f1-e3eb-4fca-ad70-cc4736d29eff\v2")
src = skill / "scripts" / "make_bol.py"
dst = Path(r"D:\code\pi\output\make_bol_local.py")
code = src.read_text(encoding="utf-8")
old = """                for rownum in range(14,31):
                    for col in ('A','C','D','E','F','G'):
                        sheet.Range(f'{col}{rownum}').ClearContents()"""
new = """                for rownum in range(14,31):
                    for col in ('A','C','D','E','F','G'):
                        try:
                            sheet.Range(f'{col}{rownum}').ClearContents()
                        except Exception:
                            pass"""
assert old in code
code = code.replace(old, new)
dst.write_text(code, encoding="utf-8")
print("written", dst)
