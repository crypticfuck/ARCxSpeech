import json
from pathlib import Path

from app.subject_store import add_subject

with open(Path(__file__).parent / "patients.json") as f:
    patients = json.load(f)

migrated = 0
skipped = 0

for p in patients:
    try:
        add_subject(
            name=p["name"],
            subject_id=p["id"],
            sex=p.get("sex", ""),
            age=p.get("age", ""),
            group="",
        )
        migrated += 1
    except Exception as e:
        print(f"Skipped {p.get('id')}: {e}")
        skipped += 1

print(f"Done. Migrated: {migrated}, Skipped: {skipped}")