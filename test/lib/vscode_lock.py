"""Serialize changes to the shared test lock directory on Windows."""
import ctypes
import json
import msvcrt
import os
import re
import sys
import tempfile
import time
from ctypes import wintypes
from pathlib import Path


OWNER = re.compile(r'(vscode|perf)-([1-9][0-9]*)-([0-9]+)')
LEGACY_MAX_AGE = 40 * 60
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel.WaitForSingleObject.restype = wintypes.DWORD
kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(ctypes.c_ulonglong)] * 4


def process_start(pid):
    """Return exact Windows creation time, or None once the process is gone."""
    handle = kernel.OpenProcess(0x101000, False, pid)  # SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        error = ctypes.get_last_error()
        if error == 87:  # ERROR_INVALID_PARAMETER: the process no longer exists
            return None
        raise ctypes.WinError(error)
    try:
        status = kernel.WaitForSingleObject(handle, 0)
        if status == 0:  # WAIT_OBJECT_0: process has exited
            return None
        if status != 258:  # WAIT_TIMEOUT: process is still running
            raise ctypes.WinError(ctypes.get_last_error())
        times = [ctypes.c_ulonglong() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            raise ctypes.WinError(ctypes.get_last_error())
        return str(times[0].value)
    finally:
        kernel.CloseHandle(handle)


def marker(lock, layer, pid):
    start = process_start(pid)
    if start is None:
        raise RuntimeError(f'{layer} process {pid} exited before it could be recorded')
    # Keep the filename readable by older runners, with exact identity in the contents.
    epoch_ms = (int(start) - 116444736000000000) // 10000
    owner = f'{layer}-{pid}-{epoch_ms}'
    with (lock / owner).open('x', encoding='ascii') as f:
        f.write(start)
    return owner


def holder(lock):
    try:
        stat = lock.stat()
        entries = list(lock.iterdir())
        owners = [(p, m) for p in entries if (m := OWNER.fullmatch(p.name))]
        for p, match in owners:
            layer, pid, started = match.groups()
            expected = p.read_text(encoding='ascii')
            try:
                actual = process_start(int(pid))
            except PermissionError:
                # Older markers do not contain an exact creation time. If the PID
                # cannot be inspected, leave the lock in place.
                actual = expected
            if actual is not None and (not expected or actual == expected):
                return {'layer': layer, 'pid': pid, 'started': int(started)}
        if owners and len(owners) == len(entries):
            return None
        if all(p.name == 'owner.txt' for p in entries):
            if time.time() - stat.st_mtime > LEGACY_MAX_AGE:
                return None
            if entries:
                return {'note': entries[0].read_text(encoding='utf-8', errors='replace').strip()}
        return {'note': 'the VS Code lock directory (manual holder or runner starting)'}
    except FileNotFoundError:
        # A runner from an older checkout may release the directory without taking the guard.
        return {'note': 'the VS Code lock directory is changing'}


def acquire(lock, layer, pid):
    if lock.exists():
        owner = holder(lock)
        if owner is not None:
            return owner
    with tempfile.TemporaryDirectory(prefix='vpe-vscode-txn-', dir=lock.parent) as tmp:
        stage = Path(tmp) / 'new'
        stage.mkdir()
        own = marker(stage, layer, pid)
        # The guard protects both the stale observation and the takeover. Publish
        # a nonempty directory atomically so older runners also see the owner.
        if lock.exists():
            owner = holder(lock)
            if owner is not None:
                return owner
            try:
                lock.rename(Path(tmp) / 'stale')
            except FileNotFoundError:
                pass  # An older runner released it after the check.
        try:
            stage.rename(lock)
        except FileExistsError:
            return {'note': 'the VS Code lock directory is changing'}
        return {'acquired': own}


def main():
    target, action, *args = sys.argv[1:]
    lock = Path(target)
    # Never unlink the guard file: all contenders must lock the same file object.
    # Windows releases the byte-range lock even if a helper is terminated.
    with open(f'{lock}.guard', 'a+b') as guard:
        guard.seek(0)
        msvcrt.locking(guard.fileno(), msvcrt.LK_LOCK, 1)
        if action == 'acquire':
            layer, pid = args
            result = acquire(lock, layer, int(pid))
        elif action == 'track':
            own, layer, pid = args
            if not (lock / own).is_file():
                raise RuntimeError('lost the VS Code lock before recording the layer')
            result = {'tracked': marker(lock, layer, int(pid))}
        elif action == 'release':
            own, *children = args
            known = {own, *children}
            if (lock / own).is_file() and {p.name for p in lock.iterdir()} <= known:
                with tempfile.TemporaryDirectory(prefix='vpe-vscode-txn-', dir=lock.parent) as tmp:
                    lock.rename(Path(tmp) / 'released')
            result = {}
        else:
            raise ValueError(action)
        print(json.dumps(result))


if __name__ == '__main__':
    main()
