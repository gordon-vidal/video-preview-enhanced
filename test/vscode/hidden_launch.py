"""Start a program on a separate, invisible Windows desktop (same session, no admin).

  python -I hidden_launch.py [--wait | --wait-pid] <desktop-name> <env-json-file> <exe> [args...]

Windows only, Python 3 standard library only (ctypes), no admin rights.

The env file is a JSON object of variables to set on top of this process's
environment (null removes one). Without --wait it prints the child's PID and
returns; with --wait it waits for the child and exits with its exit code.
With --wait-pid it prints the PID before waiting.

Windows on that desktop never show on the user's screen, and the child and every
process it starts stay on it (a child inherits its parent's desktop). Desktops are
per session (WinSta0\\<name>) and vanish when the last process using them exits;
creating one with an existing name just opens it, so several launches can share
one desktop.
"""
import ctypes
import json
import os
import subprocess
import sys
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

GENERIC_ALL = 0x10000000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
CREATE_NEW_PROCESS_GROUP = 0x00000200
INFINITE = 0xFFFFFFFF


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD), ('lpReserved', wintypes.LPWSTR), ('lpDesktop', wintypes.LPWSTR),
        ('lpTitle', wintypes.LPWSTR), ('dwX', wintypes.DWORD), ('dwY', wintypes.DWORD),
        ('dwXSize', wintypes.DWORD), ('dwYSize', wintypes.DWORD), ('dwXCountChars', wintypes.DWORD),
        ('dwYCountChars', wintypes.DWORD), ('dwFillAttribute', wintypes.DWORD), ('dwFlags', wintypes.DWORD),
        ('wShowWindow', wintypes.WORD), ('cbReserved2', wintypes.WORD), ('lpReserved2', ctypes.c_void_p),
        ('hStdInput', wintypes.HANDLE), ('hStdOutput', wintypes.HANDLE), ('hStdError', wintypes.HANDLE),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [('hProcess', wintypes.HANDLE), ('hThread', wintypes.HANDLE),
                ('dwProcessId', wintypes.DWORD), ('dwThreadId', wintypes.DWORD)]


user32.CreateDesktopW.restype = wintypes.HANDLE
user32.CreateDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p]
user32.CloseDesktop.argtypes = [wintypes.HANDLE]
kernel32.CreateProcessW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, wintypes.BOOL,
                                    wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR, ctypes.POINTER(STARTUPINFOW),
                                    ctypes.POINTER(PROCESS_INFORMATION)]
kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def main():
    argv = sys.argv[1:]
    report_pid = bool(argv) and argv[0] == '--wait-pid'
    wait = report_pid or (bool(argv) and argv[0] == '--wait')
    if wait:
        argv = argv[1:]
    if len(argv) < 3:
        raise SystemExit(__doc__)
    name, env_file, exe, *args = argv
    desk = user32.CreateDesktopW(name, None, None, 0, GENERIC_ALL, None)
    if not desk:
        raise SystemExit(f'CreateDesktop failed: {ctypes.get_last_error()}')
    env = dict(os.environ)
    with open(env_file, encoding='utf-8') as f:
        for k, v in json.load(f).items():
            # Windows variable names are case-insensitive: drop every spelling.
            for have in [h for h in env if h.upper() == k.upper()]:
                env.pop(have)
            if v is not None:
                env[k] = str(v)
    block = ''.join(f'{k}={v}\0' for k, v in env.items()) + '\0'
    si = STARTUPINFOW()
    si.cb = ctypes.sizeof(si)
    si.lpDesktop = f'WinSta0\\{name}'
    pi = PROCESS_INFORMATION()
    cmdline = subprocess.list2cmdline([exe, *args])
    ok = kernel32.CreateProcessW(None, ctypes.create_unicode_buffer(cmdline), None, None, False,
                                 CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP,
                                 ctypes.create_unicode_buffer(block), None, ctypes.byref(si), ctypes.byref(pi))
    if not ok:
        raise SystemExit(f'CreateProcess failed: {ctypes.get_last_error()}')
    if report_pid or not wait:
        print(pi.dwProcessId, flush=True)
    code = 0
    if wait:
        kernel32.WaitForSingleObject(pi.hProcess, INFINITE)
        rc = wintypes.DWORD()
        kernel32.GetExitCodeProcess(pi.hProcess, ctypes.byref(rc))
        code = rc.value
    else:
        # Keep our desktop handle until the child has opened its own (it has once it runs).
        kernel32.Sleep(3000)
    kernel32.CloseHandle(pi.hThread)
    kernel32.CloseHandle(pi.hProcess)
    user32.CloseDesktop(desk)
    sys.exit(code)


if __name__ == '__main__':
    main()
