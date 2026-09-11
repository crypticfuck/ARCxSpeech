import json
import os
import random
import tempfile
from datetime import datetime

from app.project_paths import project_file
from app.store_lock import locked


def _subjects_file(project_id):
    return project_file(project_id, "subjects.json")


def _atomic_write_json(filepath, data):
    """
    Writes JSON to `filepath` atomically: data is written to a temp file
    in the same directory, flushed to disk, then moved into place with
    os.replace (atomic on both POSIX and Windows). This means a crash or
    power loss mid-write can never leave `filepath` truncated or corrupt --
    either the old file is intact, or the new one is.
    """

    directory = os.path.dirname(filepath) or "."

    fd, tmp_path = tempfile.mkstemp(
        dir=directory,
        prefix=".tmp_",
        suffix=".json"
    )

    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())

        os.replace(tmp_path, filepath)

    except Exception:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        raise


def load_subjects(project_id):
    subjects_file = _subjects_file(project_id)

    if not os.path.exists(subjects_file):
        _atomic_write_json(subjects_file, [])

    try:
        with open(subjects_file, "r") as f:
            return json.load(f)

    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Subject data file at {subjects_file} is corrupted and could "
            f"not be read ({e}). No data was modified. Restore from a "
            "backup before continuing, since this file holds every "
            "subject in this project."
        ) from e


def _generate_subject_id(existing_subjects):
    """Same RD-##### scheme the old add_patient() used in api/routes.py.
    IDs only need to be unique within a project, so this checks against
    existing_subjects for the one project being added to -- not every
    subject across every project."""
    taken = {s.get("id") for s in existing_subjects}
    while True:
        candidate = f"RD-{random.randint(10000, 99999)}"
        if candidate not in taken:
            return candidate

@locked
def add_subject(project_id, name, subject_id=None, sex="", age="", group=""):
    """Creates and persists a new subject inside the given project.
    `subject_id` is generated (RD-#####) if not supplied. `group`
    defaults to "Unassigned" when left blank, matching the new UI's Add
    Subject modal."""

    subjects = load_subjects(project_id)

    if not subject_id:
        subject_id = _generate_subject_id(subjects)

    subject = {
        "id": subject_id,
        "name": name,
        "sex": sex,
        "age": age,
        "group": group or "Unassigned",
        "createdAt": datetime.now().isoformat(),
    }

    subjects.append(subject)
    _atomic_write_json(_subjects_file(project_id), subjects)

    return subject


def get_subject(project_id, subject_id):
    subjects = load_subjects(project_id)
    return next((s for s in subjects if s.get("id") == subject_id), None)

@locked
def delete_subject(project_id, subject_id):
    """Removes the subject row only. Cascading delete of that subject's
    sessions/recordings/files is deliberately NOT done here -- it
    belongs in api/routes.py, so this module stays subject-only.
    Returns True if a subject was actually removed, False if
    subject_id didn't exist."""

    subjects = load_subjects(project_id)
    remaining = [s for s in subjects if s.get("id") != subject_id]

    if len(remaining) == len(subjects):
        return False

    _atomic_write_json(_subjects_file(project_id), remaining)
    return True
