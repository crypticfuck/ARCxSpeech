# ===========================
# Audio Configuration
# ===========================

import os
import sys


def _detect_serial_port():
    """
    Picks a serial port cross-platform instead of hardcoding a
    Windows-only name like "COM8" (which doesn't exist on macOS/Linux).

    Resolution order:
      1. ARCXSPEECH_SERIAL_PORT env var, if set -- always wins, so a
         specific machine/device can be pinned without editing code.
      2. Match by the board's known USB VID:PID (2886:0056) --
         identifies the actual acquisition device regardless of which
         COM number Windows assigns it or what else is plugged in
         (e.g. Bluetooth virtual COM ports have no VID/PID and would
         never match).
      3. Platform-specific fallback guess, used only if neither of the
         above found anything (e.g. device not plugged in yet at
         import time). recorder.py already raises a clear
         RecordingError if this guess is wrong, so it's a safe default
         rather than a silent failure.
    """

    override = os.environ.get("ARCXSPEECH_SERIAL_PORT")

    if override:
        return override

    BOARD_VID = 0x2886
    BOARD_PID = 0x0056

    try:

        from serial.tools import list_ports

        ports = list(list_ports.comports())

        for p in ports:

            if p.vid == BOARD_VID and p.pid == BOARD_PID:
                return p.device

    except Exception:

        pass

    if sys.platform.startswith("win"):

        return "COM8"

    elif sys.platform == "darwin":

        return "/dev/cu.usbserial"

    else:

        return "/dev/ttyUSB0"


SAMPLE_RATE = 48000

CHANNELS = 2

BIT_DEPTH = 16

PATIENT_CHANNEL = 0

AMBIENT_CHANNEL = 1

SERIAL_PORT = _detect_serial_port()

SERIAL_BAUD = 2000000

VOWEL_DURATION = 5

DDK_DURATION = 10

# NOTE: recording output directories used to be fixed, global constants
# here (OUTPUT_DIR / PATIENT_AUDIO_DIR / AMBIENT_AUDIO_DIR pointing at a
# single top-level "recordings/" folder). Now that recordings belong to
# a specific project, there is no single correct value for these --
# each project's takes live under their own per-take folder instead.
# Use app.project_paths.recording_dir(...) to resolve that folder per
# project/subject/session/task/take. See app/recorder.py's
# record_audio(), which now takes that directory as an explicit
# argument rather than importing fixed paths from here.

# ============================================================
# Preprocessing pipeline -- Layers 1 & 2 (used by app/preprocessing.py
# and the R&D staged-extraction feature, which compares "No Layer",
# "1 Layer" and "2 Layers" for the same recording).
# ============================================================

# Layer 1: DC Offset Removal has no tunable parameters.

# Layer 2: Frequency Filtering
HIGHPASS_CUTOFF_HZ = 40     # below pyin's fmin=50 so low male F0 isn't attenuated before pitch tracking
LOWPASS_CUTOFF_HZ = 7500
NOTCH_FREQ_HZ = 50          # Indian mains hum is 50 Hz
NOTCH_Q = 30