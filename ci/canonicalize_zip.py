#!/usr/bin/env python3
"""Rewrite a GNOME extension ZIP with stable ordering and timestamps."""

from __future__ import annotations

import argparse
import os
import tempfile
import zipfile
from pathlib import Path


EPOCH = (1980, 1, 1, 0, 0, 0)


def canonicalize(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(path)
    with zipfile.ZipFile(path, "r") as source:
        entries = source.infolist()
        names = [entry.filename for entry in entries]
        if len(names) != len(set(names)):
            raise ValueError("source ZIP contains duplicate paths")
        entries.sort(key=lambda entry: entry.filename)
        parent = path.parent
        with tempfile.NamedTemporaryFile(prefix=f".{path.name}.", suffix=".tmp", dir=parent, delete=False) as handle:
            temporary = Path(handle.name)
        try:
            with zipfile.ZipFile(
                temporary,
                "w",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=9,
                strict_timestamps=True,
            ) as destination:
                for entry in entries:
                    info = zipfile.ZipInfo(entry.filename, EPOCH)
                    info.create_system = 3
                    info.external_attr = entry.external_attr
                    info.compress_type = zipfile.ZIP_DEFLATED
                    destination.writestr(info, source.read(entry.filename))
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("zip", type=Path)
    args = parser.parse_args()
    canonicalize(args.zip)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
