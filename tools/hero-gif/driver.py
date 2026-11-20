"""Input and capture for a VS Code window on a hidden desktop (tools/hero-gif/record.js starts it there).

  python -I driver.py <command-file> <out-dir>

Runs on the same hidden desktop as VS Code (test/vscode/hidden_launch.py), so it can find the window,
post mouse and key messages to it (nothing touches the real mouse, keyboard or screen) and capture it
with PrintWindow (as test/vscode/capture_window.py does).

Reads JSON lines appended to <command-file> (polled every 5 ms) and appends one JSON reply line per
command to <command-file>.out. Commands:
  {"op":"size","w":1280,"h":800}          window to (0, 0), w x h physical pixels
  {"op":"move","x":..,"y":..}              WM_MOUSEMOVE (client pixels)
  {"op":"down"|"up","x":..,"y":..,"button":"left"|"right","mods":["ctrl","shift"]}
  {"op":"dbl","x":..,"y":..}               WM_LBUTTONDBLCLK (Windows sends down, up, dblclk, up)
  {"op":"key","vk":..,"mods":[..]}         WM_KEYDOWN + WM_KEYUP
  {"op":"char","text":".."}                WM_CHAR per character
  {"op":"shot","file":".."}                one capture as .bgra (8-byte header: width, height)
  {"op":"rec","on":true|false}             continuous capture into <out-dir>/f<seq>_<ms>.bgra
  {"op":"title"|"mark"}                    the window title; a mark is only its reply time
  {"op":"quit"}
Every reply carries "t": milliseconds on the same clock as the recorded frame names, so record.js
can line the input (the drawn cursor) up with the frames.
Modifiers: Chromium reads Ctrl / Shift with GetKeyState, not from the message, so the driver attaches
its input queue to the window's thread and sets the keyboard state there while the message is handled.
"""
import ctypes
import json
import os
import struct
import sys
import threading
import time
from ctypes import wintypes

ctypes.windll.user32.SetProcessDPIAware()
u = ctypes.WinDLL('user32', use_last_error=True)
g = ctypes.WinDLL('gdi32')
k32 = ctypes.WinDLL('kernel32')
V = ctypes.c_void_p
u.GetDC.restype = V; u.GetDC.argtypes = [V]
u.ReleaseDC.argtypes = [V, V]
g.CreateCompatibleDC.restype = V; g.CreateCompatibleDC.argtypes = [V]
g.SelectObject.argtypes = [V, V]; g.SelectObject.restype = V
g.DeleteObject.argtypes = [V]; g.DeleteDC.argtypes = [V]
g.CreateDIBSection.restype = V; g.CreateDIBSection.argtypes = [V, V, wintypes.UINT, V, V, wintypes.DWORD]
u.PrintWindow.argtypes = [V, V, wintypes.UINT]
u.PostMessageW.argtypes = [V, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
u.SendMessageW.argtypes = [V, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
u.SendMessageW.restype = wintypes.LPARAM
u.SetWindowPos.argtypes = [V, V, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
u.GetWindowThreadProcessId.argtypes = [V, ctypes.POINTER(wintypes.DWORD)]
u.GetWindowThreadProcessId.restype = wintypes.DWORD
u.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
u.SetKeyboardState.argtypes = [ctypes.c_char_p]
u.GetKeyboardState.argtypes = [ctypes.c_char_p]
u.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
u.ChildWindowFromPointEx.restype = V

CMD, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
T0 = time.perf_counter()
now = lambda: round((time.perf_counter() - T0) * 1000, 1)


def find_window():
    found = []
    CB = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, _):
        n = u.GetWindowTextLengthW(h)
        if n > 0 and u.GetParent(h) == 0 and u.IsWindowVisible(h):
            b = ctypes.create_unicode_buffer(n + 1); u.GetWindowTextW(h, b, n + 1)
            r = wintypes.RECT(); u.GetWindowRect(h, ctypes.byref(r))
            if 'Visual Studio Code' in b.value:
                found.append((h, b.value, (r.right - r.left) * (r.bottom - r.top)))
        return True
    u.EnumWindows(CB(cb), 0)
    if not found:
        return None, ''
    h, t, _ = max(found, key=lambda c: c[2])
    return h, t


class Capture:
    def __init__(self):
        self.h = None; self.w = self.hh = 0; self.mdc = None; self.bits = None; self.bmp = None

    def prepare(self, h):
        r = wintypes.RECT(); u.GetWindowRect(h, ctypes.byref(r))
        w, hh = r.right - r.left, r.bottom - r.top
        if (h, w, hh) == (self.h, self.w, self.hh):
            return
        if self.mdc:
            g.DeleteObject(self.bmp); g.DeleteDC(self.mdc)
        dc = u.GetDC(h); self.mdc = g.CreateCompatibleDC(dc); u.ReleaseDC(h, dc)

        class BMI(ctypes.Structure):
            _fields_ = [('s', wintypes.DWORD), ('w', wintypes.LONG), ('h', wintypes.LONG), ('p', wintypes.WORD), ('b', wintypes.WORD),
                        ('c', wintypes.DWORD), ('si', wintypes.DWORD), ('x', wintypes.LONG), ('y', wintypes.LONG), ('u', wintypes.DWORD), ('i', wintypes.DWORD)]
        bmi = BMI(ctypes.sizeof(BMI), w, -hh, 1, 32, 0, 0, 0, 0, 0, 0)
        self.bits = ctypes.c_void_p()
        self.bmp = g.CreateDIBSection(self.mdc, ctypes.byref(bmi), 0, ctypes.byref(self.bits), None, 0)
        g.SelectObject(self.mdc, self.bmp)
        self.h, self.w, self.hh = h, w, hh

    def grab(self, h):
        self.prepare(h)
        u.PrintWindow(h, self.mdc, 2)  # PW_RENDERFULLCONTENT: the GPU-composited picture too
        return self.w, self.hh, ctypes.string_at(self.bits, self.w * self.hh * 4)


cap = Capture()
lock = threading.Lock()
rec = {'on': False, 'seq': 0, 'n': 0}
state = {'hwnd': None}


def recorder():
    while True:
        if not rec['on'] or not state['hwnd']:
            time.sleep(0.005); continue
        t = now()
        with lock:
            w, hh, data = cap.grab(state['hwnd'])
        rec['seq'] += 1; rec['n'] += 1
        with open(os.path.join(OUT, f"f{rec['seq']:06d}_{int(t)}.bgra"), 'wb') as f:
            f.write(struct.pack('<ii', w, hh)); f.write(data)
        # ~25 fps at most: enough for a 12-15 fps result picked by timestamps
        rest = 0.040 - (time.perf_counter() - T0 - t / 1000)
        if rest > 0:
            time.sleep(rest)


MK = {'left': 0x0001, 'right': 0x0002}
MSG = {('left', 'down'): 0x0201, ('left', 'up'): 0x0202, ('right', 'down'): 0x0204, ('right', 'up'): 0x0205}
VK = {'ctrl': 0x11, 'shift': 0x10, 'alt': 0x12}


def lparam(x, y):
    return ((int(y) & 0xFFFF) << 16) | (int(x) & 0xFFFF)


class Mods:
    """Ctrl / Shift as GetKeyState sees them in the window's thread while a message is handled."""
    def __init__(self, hwnd, mods):
        self.hwnd, self.mods = hwnd, mods or []

    def __enter__(self):
        if not self.mods:
            return self
        self.tid = u.GetWindowThreadProcessId(self.hwnd, None)
        self.me = k32.GetCurrentThreadId()
        u.AttachThreadInput(self.me, self.tid, True)
        st = ctypes.create_string_buffer(256); u.GetKeyboardState(st)
        self.old = st.raw
        b = bytearray(st.raw)
        for m in self.mods:
            b[VK[m]] = 0x80
            b[{'ctrl': 0xA2, 'shift': 0xA0, 'alt': 0xA4}[m]] = 0x80
        u.SetKeyboardState(bytes(b))
        return self

    def __exit__(self, *a):
        if not self.mods:
            return
        time.sleep(0.03)
        u.SetKeyboardState(self.old)
        u.AttachThreadInput(self.me, self.tid, False)


def wparam(c, button=None):
    w = MK.get(button, 0) if button else 0
    for m in c.get('mods') or []:
        w |= {'ctrl': 0x0008, 'shift': 0x0004}.get(m, 0)
    return w


def handle(c):
    op = c['op']
    h, title = find_window()
    if h:
        state['hwnd'] = h
    h = state['hwnd']
    if op in ('title', 'mark'):
        return {'title': title}
    if not h:
        return {'error': 'no window'}
    if op == 'size':
        u.SetWindowPos(h, None, 0, 0, int(c['w']), int(c['h']), 0x0004 | 0x0010)  # NOZORDER | NOACTIVATE
        return {'title': title}
    if op == 'move':
        with Mods(h, c.get('mods')):
            u.SendMessageW(h, 0x0200, wparam(c, c.get('held')), lparam(c['x'], c['y']))
        return {}
    if op in ('down', 'up'):
        b = c.get('button', 'left')
        with Mods(h, c.get('mods')):
            u.SendMessageW(h, 0x0200, wparam(c, b if op == 'up' else None), lparam(c['x'], c['y']))
            u.SendMessageW(h, MSG[(b, op)], wparam(c, b if op == 'down' else None), lparam(c['x'], c['y']))
        return {}
    if op == 'dbl':
        lp = lparam(c['x'], c['y'])
        u.SendMessageW(h, 0x0201, 1, lp); u.SendMessageW(h, 0x0202, 0, lp)
        time.sleep(0.06)
        u.SendMessageW(h, 0x0203, 1, lp); u.SendMessageW(h, 0x0202, 0, lp)
        return {}
    if op == 'key':
        vk = int(c['vk']); sc = u.MapVirtualKeyW(vk, 0)
        ext = 1 << 24 if vk in (0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E) else 0
        with Mods(h, c.get('mods')):
            u.SendMessageW(h, 0x0100, vk, 1 | (sc << 16) | ext)
            time.sleep(0.02)
            u.SendMessageW(h, 0x0101, vk, 1 | (sc << 16) | ext | (3 << 30))
        return {}
    if op == 'char':
        for ch in c['text']:
            u.SendMessageW(h, 0x0102, ord(ch), 1)
            time.sleep(0.01)
        return {}
    if op == 'shot':
        with lock:
            w, hh, data = cap.grab(h)
        with open(c['file'], 'wb') as f:
            f.write(struct.pack('<ii', w, hh)); f.write(data)
        return {'w': w, 'h': hh, 'title': title}
    if op == 'rec':
        rec['on'] = bool(c['on'])
        return {'frames': rec['n']}
    return {'error': f'unknown op {op}'}


def main():
    threading.Thread(target=recorder, daemon=True).start()
    seen = 0
    open(CMD, 'a').close()
    while True:
        with open(CMD, encoding='utf-8') as f:
            lines = [l for l in f.read().split('\n') if l.strip()]
        for line in lines[seen:]:
            c = json.loads(line)
            t = now()
            if c.get('op') == 'quit':
                rec['on'] = False
                with open(CMD + '.out', 'a', encoding='utf-8') as f:
                    f.write(json.dumps({'id': c.get('id'), 't': t}) + '\n')
                return
            try:
                r = handle(c)
            except Exception as e:  # report, keep running
                r = {'error': repr(e)}
            r.update({'id': c.get('id'), 't': t})
            with open(CMD + '.out', 'a', encoding='utf-8') as f:
                f.write(json.dumps(r) + '\n')
        seen = len(lines)
        time.sleep(0.005)


main()
