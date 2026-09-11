"""
Batch Ambient Extract
=====================
Runs every recording in an ambient_audio folder through
extract_ambient_metrics (app/ambient_analyzer.py) -- the same function
the app itself calls, with no extra preprocessing (ambient audio is
analyzed raw, unlike patient audio).

Usage (from the ARCxSpeech-main project root, i.e. the folder that
contains the "app" package):

    python batch_extract_ambient.py --ambient_dir "recordings\\ambient_audio"
"""

import argparse
import os
import sys
import traceback

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.ambient_analyzer import extract_ambient_metrics

AUDIO_EXTS = (".wav", ".WAV")


def list_wavs(folder):
    if not folder or not os.path.isdir(folder):
        return []
    return sorted(
        os.path.join(folder, f)
        for f in os.listdir(folder)
        if f.endswith(AUDIO_EXTS)
    )


def main():
    parser = argparse.ArgumentParser(description="Batch-extract ambient noise metrics.")
    parser.add_argument("--ambient_dir", required=True, help="Folder of ambient recordings")
    parser.add_argument("--out_dir", default=".", help="Where to write the output CSV")
    args = parser.parse_args()

    files = list_wavs(args.ambient_dir)
    if not files:
        print(f"No .wav files found in {args.ambient_dir!r} -- nothing to do.")
        return

    os.makedirs(args.out_dir, exist_ok=True)

    rows = []
    for path in files:
        fname = os.path.basename(path)
        print(f"[ambient] {fname} ...", end=" ")
        try:
            metrics = extract_ambient_metrics(path)
            row = {"filename": fname, "status": "ok"}
            row.update(metrics)
            print("ok")
        except Exception as e:
            row = {"filename": fname, "status": f"ERROR: {e}"}
            print(f"FAILED -> {e}")
            traceback.print_exc()
        rows.append(row)

    df = pd.DataFrame(rows)
    out_path = os.path.join(args.out_dir, "ambient_features.csv")
    df.to_csv(out_path, index=False)
    print(f"\n-> wrote {out_path}  ({len(df)} recordings)")


if __name__ == "__main__":
    main()