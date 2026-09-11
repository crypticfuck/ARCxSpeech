"""
One-time migration: moves data written before the Project layer existed
(a single global subjects.json / sessions.json / recordings.json /
research_sessions.json / baseline.json + one shared recordings/ folder
at the app root) into a new "Default Project" under projects/, so
nothing that was already captured becomes orphaned when project-scoped
storage goes live.

Safe to run more than once -- it no-ops if there's no old-style data
left at the app root to migrate (i.e. a previous run already moved it,
or this is a brand-new install that never had pre-project data).

Usage (from ARCxSpeech-main/):
    python migrate_to_projects.py
"""

import json
import os
import shutil

from app import project_store
from app.project_paths import APP_ROOT, project_dir

OLD_FILES = [
    "subjects.json",
    "sessions.json",
    "recordings.json",
    "research_sessions.json",
    "baseline.json",
]

OLD_RECORDINGS_DIR = os.path.join(APP_ROOT, "recordings")

DEFAULT_PROJECT_NAME = "Default Project"


def _old_data_exists() -> bool:
    """True if there's anything at the app root worth migrating: any of
    the old flat JSON files with actual rows in them, or a recordings/
    folder with files in it. An empty/missing file or an empty
    recordings/ folder isn't "data" -- nothing to move."""
    for filename in OLD_FILES:
        path = os.path.join(APP_ROOT, filename)
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    if json.load(f):
                        return True
            except (json.JSONDecodeError, OSError):
                # Corrupted or unreadable -- still worth migrating so a
                # human can look at it inside the project folder rather
                # than silently leaving it behind at the app root.
                return True

    if os.path.isdir(OLD_RECORDINGS_DIR):
        for _root, _dirs, files in os.walk(OLD_RECORDINGS_DIR):
            if files:
                return True

    return False


def migrate():
    if not _old_data_exists():
        print("Nothing to migrate -- no pre-project data found at the app root.")
        return

    # Reuse an existing "Default Project" if this is a re-run that
    # partially completed, rather than creating a second one.
    existing = next(
        (p for p in project_store.load_projects() if p.get("name") == DEFAULT_PROJECT_NAME),
        None,
    )
    project = existing or project_store.create_project(DEFAULT_PROJECT_NAME)
    dest_dir = project_dir(project["id"])
    print(f"Migrating pre-project data into '{DEFAULT_PROJECT_NAME}' ({project['id']})")

    for filename in OLD_FILES:
        src = os.path.join(APP_ROOT, filename)
        if os.path.exists(src):
            dest = os.path.join(dest_dir, filename)
            shutil.move(src, dest)
            print(f"  moved {filename}")

    if os.path.isdir(OLD_RECORDINGS_DIR):
        dest_recordings = os.path.join(dest_dir, "recordings")
        if os.path.isdir(dest_recordings):
            # Destination already has a recordings/ folder (e.g. a
            # partially-completed prior run) -- merge file-by-file
            # instead of shutil.move, which refuses to overwrite an
            # existing directory.
            for sub in ("patient_audio", "ambient_audio"):
                src_sub = os.path.join(OLD_RECORDINGS_DIR, sub)
                if not os.path.isdir(src_sub):
                    continue
                dest_sub = os.path.join(dest_recordings, sub)
                os.makedirs(dest_sub, exist_ok=True)
                for fname in os.listdir(src_sub):
                    shutil.move(os.path.join(src_sub, fname), os.path.join(dest_sub, fname))
            # Anything left directly in recordings/ (e.g. uploaded files,
            # which were saved straight into UPLOAD_DIR rather than the
            # patient_audio/ambient_audio subfolders).
            for fname in os.listdir(OLD_RECORDINGS_DIR):
                src_path = os.path.join(OLD_RECORDINGS_DIR, fname)
                if os.path.isfile(src_path):
                    shutil.move(src_path, os.path.join(dest_recordings, fname))
            shutil.rmtree(OLD_RECORDINGS_DIR, ignore_errors=True)
        else:
            shutil.move(OLD_RECORDINGS_DIR, dest_recordings)
        print("  moved recordings/ (patient_audio + ambient_audio)")

    print("Migration complete.")
    print(
        f"Every subject/session/recording that existed before is now "
        f"under project '{DEFAULT_PROJECT_NAME}' in the home page."
    )


if __name__ == "__main__":
    migrate()
