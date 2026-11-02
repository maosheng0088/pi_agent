"""One kernel-backed browser lock shared by all Carrier Central business jobs."""
from __future__ import annotations

from contextlib import contextmanager
import math
import os
from pathlib import Path
import time


DEFAULT_LOCK_PATH = Path(__file__).resolve().parent.parent / ".data" / "amazon-carrier-browser.lock"


class BrowserBusyError(Exception):
    code = "browser_busy"

    def __init__(self):
        super().__init__("Amazon 专属浏览器仍由其他检查使用，本次等待已超时。")


def _lock(handle):
    handle.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(handle):
    handle.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def exclusive_browser_lock(lock_path, deadline, log=None, *, clock=time.monotonic, sleep=time.sleep):
    """Wait boundedly for the shared lock; process termination releases it.

    The full business job should hold this lock, not just one login: another
    account refresh/locale switch can invalidate the first job's session snapshot.
    No PID files, browser termination, profile removal or stale-lock deletion.
    """
    acquired = False
    handle = None
    try:
        if not math.isfinite(float(deadline)) or clock() >= float(deadline):
            raise BrowserBusyError()
        path = Path(lock_path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a+b")
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        announced = False
        while not acquired:
            if clock() >= float(deadline):
                raise BrowserBusyError()
            try:
                _lock(handle)
                acquired = True
            except OSError:
                if not announced and log:
                    announced = True
                    message = "[amazon-browser] 其他检查正在使用 Amazon 专属浏览器，等待释放后自动继续。"
                    try:
                        log(message, flush=True)
                    except TypeError:
                        try:
                            log(message)
                        except Exception:
                            pass
                    except Exception:
                        pass
                left = float(deadline) - clock()
                if left <= 0:
                    raise BrowserBusyError() from None
                sleep(min(0.25, left))
        yield
    except (ValueError, TypeError, OSError):
        if not acquired:
            raise BrowserBusyError() from None
        raise
    finally:
        if handle is not None:
            if acquired:
                try:
                    _unlock(handle)
                except OSError:
                    pass
            handle.close()
