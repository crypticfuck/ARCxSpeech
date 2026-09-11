import threading
import time
import sys
import ctypes
import uvicorn
import webview
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import os

from api.routes import router

if sys.platform == "win32":
    # Without this, the process is treated as DPI-unaware and Windows
    # silently rescales any coordinates it's given -- which is exactly
    # why the work-area rect from _windows_work_area() below can still
    # end up covering the taskbar once applied to the window. Must run
    # before any window is created.
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PROCESS_PER_MONITOR_DPI_AWARE
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()  # fallback for older Windows
        except Exception:
            pass

app = FastAPI(title="ARC Labs API")

# The UI is served from this same origin, so no CORS middleware is
# needed ("*" + allow_credentials=True is an invalid combination anyway).

app.include_router(router)

# Only elements landing an exact click on `pywebview-drag-region` start a
# window drag (see main() below) -- not just any descendant of one. With
# the default (False), clicking a button *inside* a drag region would
# still register as a drag-start because pywebview walks up the DOM from
# the click target looking for an ancestor match, which is how a click on
# e.g. a titlebar menu button would end up nested under #titlebar (see
# theme.css's -webkit-app-region: drag on #titlebar) and start dragging
# instead of opening the menu.
webview.settings['DRAG_REGION_DIRECT_TARGET_ONLY'] = True

# Mount the static UI files
UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "UI")
app.mount("/", StaticFiles(directory=UI_DIR, html=True), name="ui")

import socket

def _pick_free_port(preferred=8000):
    """Use 8000 if it's free, else let the OS hand us any free port --
    otherwise the app dies at startup if something else holds 8000."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

SERVER_PORT = _pick_free_port()

def start_server():
    uvicorn.run(app, host="127.0.0.1", port=SERVER_PORT, log_level="error")


def _windows_work_area(window):
    """Windows-only: the screen rect excluding the taskbar, as
    (x, y, width, height), for whichever monitor the window is currently
    on. Frameless windows are borderless as far as the OS is concerned,
    so pywebview's own Window.maximize() maximizes them to the *full*
    screen and covers the taskbar -- moving/resizing to this rect
    instead keeps the taskbar visible.

    Deliberately monitor-aware rather than using
    SystemParametersInfoW(SPI_GETWORKAREA), which only ever returns the
    *primary* monitor's work area -- on a multi-monitor setup, maximizing
    a window that lives on a secondary display would move/resize it to
    the primary display's geometry instead (wrong size, taskbar possibly
    in the wrong place or not accounted for at all). MonitorFromWindow +
    GetMonitorInfo instead resolve the work area of the actual monitor
    the window is on.

    Returns None on any non-Windows platform or if the win32 call fails.
    """
    if sys.platform != "win32":
        return None
    try:
        class RECT(ctypes.Structure):
            _fields_ = [
                ("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long),
            ]

        class MONITORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", ctypes.c_ulong),
                ("rcMonitor", RECT),
                ("rcWork", RECT),
                ("dwFlags", ctypes.c_ulong),
            ]

        MONITOR_DEFAULTTONEAREST = 2

        hwnd = window.native.Handle.ToInt64() if hasattr(window, "native") else None
        if not hwnd:
            # Fallback: pywebview versions/backends without a `.native`
            # handle can't be resolved to a specific monitor -- caller
            # falls back to the toolkit's own maximize().
            return None

        # Explicit argtypes/restype: handles are 64-bit pointers, and
        # ctypes' default int marshaling truncates to 32 bits, which
        # would silently corrupt the handle (and misidentify the
        # monitor) on 64-bit Windows.
        user32 = ctypes.windll.user32
        user32.MonitorFromWindow.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        user32.MonitorFromWindow.restype = ctypes.c_void_p
        user32.GetMonitorInfoW.argtypes = [ctypes.c_void_p, ctypes.POINTER(MONITORINFO)]
        user32.GetMonitorInfoW.restype = ctypes.c_bool

        hmonitor = user32.MonitorFromWindow(ctypes.c_void_p(hwnd), MONITOR_DEFAULTTONEAREST)
        if not hmonitor:
            return None

        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        ok = user32.GetMonitorInfoW(hmonitor, ctypes.byref(info))
        if not ok:
            return None

        rect = info.rcWork
        return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top
    except Exception:
        return None


def _windows_dpi_scale(window):
    """The same logical-to-physical scale factor pywebview's winforms
    backend uses internally (GetDpiForWindow(hwnd) / 96), so values we
    convert here land exactly where pywebview's own move()/resize() will
    put them. Returns 1.0 (no scaling) on any failure or non-Windows
    platform."""
    if sys.platform != "win32":
        return 1.0
    try:
        hwnd = window.native.Handle.ToInt64() if hasattr(window, "native") else None
        if not hwnd:
            return 1.0
        user32 = ctypes.windll.user32
        user32.GetDpiForWindow.argtypes = [ctypes.c_void_p]
        user32.GetDpiForWindow.restype = ctypes.c_uint
        dpi = user32.GetDpiForWindow(ctypes.c_void_p(hwnd))
        return dpi / 96 if dpi else 1.0
    except Exception:
        return 1.0


def _windows_strip_border(window):
    """Windows 11 draws a thin accent-colored border around top-level
    windows via DWM regardless of FormBorderStyle -- frameless=True only
    removes pywebview's own titlebar/frame, not this DWM border. pywebview
    only clears it in its own toggle_fullscreen() (DWMWA_BORDER_COLOR,
    value 0xFFFFFFFE = DWMWA_COLOR_NONE), which this app doesn't use, so
    it's still visible around the custom titlebar's edges. Applying the
    same call here removes it permanently. No-op on non-Windows."""
    if sys.platform != "win32":
        return
    try:
        hwnd = window.native.Handle.ToInt64() if hasattr(window, "native") else None
        if not hwnd:
            return
        DWMWA_BORDER_COLOR = 34
        DWMWA_COLOR_NONE = 0xFFFFFFFE
        dwmapi = ctypes.windll.dwmapi
        dwmapi.DwmSetWindowAttribute.argtypes = [
            ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint,
        ]
        value = ctypes.c_int(DWMWA_COLOR_NONE)
        dwmapi.DwmSetWindowAttribute(
            ctypes.c_void_p(hwnd), DWMWA_BORDER_COLOR, ctypes.byref(value), ctypes.sizeof(value)
        )
    except Exception:
        pass


def _windows_enable_taskbar_minimize_toggle(window):
    """Windows-only: frameless=True drops FormBorderStyle down to None,
    which also strips the WS_MINIMIZEBOX/WS_SYSMENU bits from the HWND's
    style -- window.minimize() still works fine (it doesn't depend on
    those bits), but Explorer's taskbar-button click behavior does: it
    only does its normal "click while active -> minimize, click while
    minimized -> restore" toggle for windows that carry those style
    bits. Without them, clicking the taskbar icon while the window is
    already open/focused does nothing. Re-adding the bits directly on
    the HWND restores that toggle without bringing back any visible
    titlebar/frame (WS_MINIMIZEBOX/WS_SYSMENU alone don't draw
    anything -- they're only ever rendered as part of a caption bar,
    which frameless windows don't have). No-op on non-Windows."""
    if sys.platform != "win32":
        return
    try:
        hwnd = window.native.Handle.ToInt64() if hasattr(window, "native") else None
        if not hwnd:
            return
        GWL_STYLE = -16
        WS_MINIMIZEBOX = 0x00020000
        WS_SYSMENU = 0x00080000

        user32 = ctypes.windll.user32
        # Prefer the 64-bit-safe *Ptr variants (present since XP/Vista on
        # 64-bit Windows); fall back to the plain ones for older/32-bit
        # setups where GetWindowLongPtrW isn't exported.
        get_style = getattr(user32, "GetWindowLongPtrW", None) or user32.GetWindowLongW
        set_style = getattr(user32, "SetWindowLongPtrW", None) or user32.SetWindowLongW
        get_style.argtypes = [ctypes.c_void_p, ctypes.c_int]
        get_style.restype = ctypes.c_void_p
        set_style.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
        set_style.restype = ctypes.c_void_p

        hwnd_p = ctypes.c_void_p(hwnd)
        style = get_style(hwnd_p, GWL_STYLE) or 0
        new_style = int(style) | WS_MINIMIZEBOX | WS_SYSMENU
        set_style(hwnd_p, GWL_STYLE, ctypes.c_void_p(new_style))
    except Exception:
        pass


class WindowApi:
    """Exposed to the UI as window.pywebview.api.* -- backs the custom
    minimize/maximize/close buttons in the UI's own titlebar (see
    #minimize-btn/#maximize-btn/#window-close-btn in shell.html and
    their handlers in js/shell.js). The window is created frameless,
    so these are the only way to control it."""

    def __init__(self, window):
        self._window = window
        self._is_maximized = False
        self._restore_geometry = None  # (x, y, width, height) saved just before maximizing

    def minimize(self):
        self._window.minimize()

    def maximize(self):
        if self._is_maximized:
            self._restore()
        else:
            self._maximize()
        self._is_maximized = not self._is_maximized

    def _maximize(self):
        self._restore_geometry = (self._window.x, self._window.y, self._window.width, self._window.height)
        work_area = _windows_work_area(self._window)
        if work_area:
            # GetMonitorInfo (in _windows_work_area) returns physical
            # pixels, but window.move()/window.resize() expect *logical*
            # pixels -- they multiply by the DPI scale internally to get
            # physical pixels for the actual Win32 call. Feeding them
            # physical pixels double-applies the scale on any display
            # above 100% scaling, so the window overshoots the screen's
            # right/bottom edge (covering the taskbar and running off
            # the right side). Convert back to logical pixels here using
            # the same per-window DPI pywebview itself uses.
            scale = _windows_dpi_scale(self._window)
            x, y, w, h = work_area
            self._window.move(round(x / scale), round(y / scale))
            self._window.resize(round(w / scale), round(h / scale))
        else:
            # Non-Windows: the toolkit's own maximize already respects
            # the dock/menu bar on macOS and most Linux window managers.
            self._window.maximize()

    def _restore(self):
        if self._restore_geometry:
            x, y, w, h = self._restore_geometry
            self._window.move(x, y)
            self._window.resize(w, h)
        else:
            self._window.restore()

    def close(self):
        self._window.destroy()


if __name__ == "__main__":
    # Start FastAPI server in a separate thread
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    
    # Wait a moment for server to start
    time.sleep(1)
    
    # Create webview window. frameless=True drops the native OS titlebar
    # since the UI draws its own (see #titlebar in shell.html) -- window
    # dragging/no-drag zones are already handled there via CSS
    # -webkit-app-region. js_api exposes WindowApi's methods to the page
    # as window.pywebview.api.minimize()/.maximize()/.close().
    window = webview.create_window(
        "Arc Labs",
        f"http://127.0.0.1:{SERVER_PORT}/shell.html",
        width=1200,
        height=800,
        text_select=True,
        frameless=True,
        easy_drag=False,
    )
    window_api = WindowApi(window)
    window.expose(window_api.minimize, window_api.maximize, window_api.close)
    window.events.shown += lambda: _windows_strip_border(window)
    window.events.shown += lambda: _windows_enable_taskbar_minimize_toggle(window)

    # Start the pywebview event loop
    webview.start()
