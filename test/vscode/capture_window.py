import ctypes as _c; _c.windll.user32.SetProcessDPIAware()
import ctypes, sys, struct, time
from ctypes import wintypes
u=ctypes.WinDLL('user32',use_last_error=True); g=ctypes.WinDLL('gdi32')
out=sys.argv[1]
V=ctypes.c_void_p
u.GetDC.restype=V;u.GetDC.argtypes=[V]
g.CreateCompatibleDC.restype=V;g.CreateCompatibleDC.argtypes=[V]
g.SelectObject.argtypes=[V,V];g.SelectObject.restype=V
u.PrintWindow.argtypes=[V,V,wintypes.UINT]
u.GetWindowTextLengthW.restype=ctypes.c_int
cands=[]
CB=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
def cb(h,_):
    n=u.GetWindowTextLengthW(h)
    if n>0 and u.GetParent(h)==0:
        b=ctypes.create_unicode_buffer(n+1);u.GetWindowTextW(h,b,n+1)
        r=wintypes.RECT();u.GetWindowRect(h,ctypes.byref(r))
        cands.append((h,b.value,r.right-r.left,r.bottom-r.top))
    return True
u.EnumWindows(CB(cb),0)
for c in cands: pass
best=[c for c in cands if 'Visual Studio Code' in c[1] or 'Extension Development' in c[1]]
if not best: sys.exit('no window')
h,t,w,hh=max(best,key=lambda c:c[2]*c[3])
dc=u.GetDC(h); mdc=g.CreateCompatibleDC(dc)
class BMI(ctypes.Structure):
    _fields_=[('s',wintypes.DWORD),('w',wintypes.LONG),('h',wintypes.LONG),('p',wintypes.WORD),('b',wintypes.WORD),('c',wintypes.DWORD),('si',wintypes.DWORD),('x',wintypes.LONG),('y',wintypes.LONG),('u',wintypes.DWORD),('i',wintypes.DWORD)]
bmi=BMI(ctypes.sizeof(BMI),w,-hh,1,32,0,0,0,0,0,0)
bits=ctypes.c_void_p()
g.CreateDIBSection.restype=V;g.CreateDIBSection.argtypes=[V,V,wintypes.UINT,V,V,wintypes.DWORD]
hb=g.CreateDIBSection(mdc,ctypes.byref(bmi),0,ctypes.byref(bits),None,0)
g.SelectObject(mdc,hb)
ok=u.PrintWindow(h,mdc,2)
data=ctypes.string_at(bits,w*hh*4)
open(out,'wb').write(struct.pack('<ii',w,hh)+data)
print('printwindow',ok,w,hh,'nonzero',any(data[i] for i in range(0,len(data),4097)))
