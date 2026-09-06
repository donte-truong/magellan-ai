import csv
import io
import json
from pathlib import PurePath

from app.db import digest, new_id, now
from app.errors import invalid

MAX_UPLOAD_BYTES = 1024 * 1024
MAX_ROWS = 100
LABEL_COLUMNS = ("component", "part", "part_name", "name", "material", "description")


def parse_upload(filename, content):
    if not filename or PurePath(filename).suffix.lower() != ".csv":
        raise invalid("Upload must be a CSV file")
    if not content or len(content) > MAX_UPLOAD_BYTES:
        raise invalid("CSV must be nonempty and at most 1 MiB")
    try:
        decoded = content.decode("utf-8-sig")
        if "\x00" in decoded:
            raise invalid("CSV cannot contain NUL characters")
        reader = csv.DictReader(io.StringIO(decoded, newline=""), strict=True)
        original = reader.fieldnames or []
        columns = [c.strip().lower().replace(" ", "_") for c in original]
        if not columns or any(not c for c in columns) or len(set(columns)) != len(columns):
            raise invalid("CSV requires unique nonempty column headers")
        if len(columns) > 30:
            raise invalid("CSV supports at most 30 columns")
        label_column = next((c for c in LABEL_COLUMNS if c in columns), None)
        if not label_column:
            raise invalid(
                "CSV requires a component, part, part_name, name, material or description column"
            )
        reader.fieldnames = columns
        rows, warnings = [], []
        for number, row in enumerate(reader, 2):
            if len(rows) >= MAX_ROWS:
                raise invalid("CSV supports at most 100 data rows")
            if None in row or any(value is None for value in row.values()):
                raise invalid(
                    "CSV row has a different number of fields than its header", row=number
                )
            row = {k: v.strip() for k, v in row.items()}
            label = row[label_column]
            if not label or len(label) > 200:
                raise invalid(
                    "Every BOM row requires a component name of 1–200 characters", row=number
                )
            if any(len(v) > 2000 for v in row.values()):
                raise invalid("CSV cells must be at most 2000 characters", row=number)
            quantity = None
            raw_quantity = row.get("quantity", row.get("qty", ""))
            if raw_quantity:
                try:
                    quantity = float(raw_quantity)
                    if not 0 <= quantity < float("inf"):
                        raise ValueError
                except ValueError:
                    warnings.append(
                        f"Row {number}: invalid quantity; preserved as text and treated as unknown"
                    )
                    quantity = None
            if not raw_quantity:
                warnings.append(f"Row {number}: quantity is unknown")
            kind = row.get("kind", "material" if label_column == "material" else "component")
            if kind not in {"component", "material"}:
                raise invalid("BOM kind must be component or material", row=number)
            # Exact, compact canonical row is retained as the user-asserted evidence span.
            span = json.dumps(
                {
                    "component": label,
                    "kind": kind,
                    "quantity": quantity,
                    "unit": row.get("unit") or None,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            if len(span) > 600:
                raise invalid("BOM row name and unit exceed the evidence-span limit", row=number)
            rows.append(
                {
                    "raw": row,
                    "label": label,
                    "kind": kind,
                    "quantity": quantity,
                    "unit": row.get("unit") or None,
                    "span": span,
                    "line": number,
                }
            )
        if not rows:
            raise invalid("CSV requires at least one data row")
    except (UnicodeDecodeError, csv.Error) as exc:
        raise invalid("CSV must be valid UTF-8 with well-formed quoting") from exc
    return {
        "id": new_id("up"),
        "filename": filename.replace("\\", "/").rsplit("/", 1)[-1],
        "row_count": len(rows),
        "columns": columns,
        "preview": [r["raw"] for r in rows[:10]],
        "warnings": warnings,
        "content_hash": digest(content),
        "created_at": now(),
        "_rows": rows,
        "_content": decoded,
    }
