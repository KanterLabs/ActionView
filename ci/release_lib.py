#!/usr/bin/env python3
"""Small, dependency-free checks shared by ActionView's local release commands.

The infrastructure repository owns the release receipt and publication policy.
This module only knows the product package contract: semantic version, GNOME
metadata, the extension ZIP, and its SHA-256 manifest.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import zipfile
from pathlib import Path
from typing import Any


CONFIG_PATH = Path("ci/actionview.json")
METADATA_PATH = Path("actionview@kanterlabs.dev/metadata.json")
UUID = "actionview@kanterlabs.dev"
ARTIFACT_NAME = f"{UUID}.shell-extension.zip"
MANIFEST_NAME = "artifact-manifest.json"
CHECKSUM_NAME = "SHA256SUMS"
SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.([0-9]+)\.([0-9]+)"
    r"(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$"
)
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ReleaseError(RuntimeError):
    """An actionable release contract failure."""


def root_from_here() -> Path:
    return Path(__file__).resolve().parent.parent


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ReleaseError(f"missing required JSON file: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ReleaseError(f"invalid JSON in {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ReleaseError(f"{path} must contain a JSON object")
    return value


def load_config(root: Path) -> dict[str, Any]:
    config = load_json(root / CONFIG_PATH)
    required = ("schema_version", "product", "uuid", "version", "gnome_version",
                "artifact", "targets", "forge")
    missing = [key for key in required if key not in config]
    if missing:
        raise ReleaseError(f"{CONFIG_PATH} missing required keys: {', '.join(missing)}")
    if config["schema_version"] != 1:
        raise ReleaseError(f"unsupported {CONFIG_PATH} schema_version: {config['schema_version']!r}")
    if config["product"] != "ActionView":
        raise ReleaseError(f"release product must be ActionView, got {config['product']!r}")
    if config["uuid"] != UUID:
        raise ReleaseError(f"release UUID must be {UUID}, got {config['uuid']!r}")
    version = config["version"]
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        raise ReleaseError(f"release version is not semantic version syntax: {version!r}")
    gnome_version = config["gnome_version"]
    if not isinstance(gnome_version, int) or isinstance(gnome_version, bool) or gnome_version < 1:
        raise ReleaseError(f"gnome_version must be a positive integer, got {gnome_version!r}")
    artifact = config["artifact"]
    if not isinstance(artifact, dict):
        raise ReleaseError("release artifact must be an object")
    if artifact.get("name") != ARTIFACT_NAME:
        raise ReleaseError(f"artifact name must be {ARTIFACT_NAME!r}")
    if artifact.get("kind") != "gnome-shell-extension":
        raise ReleaseError("artifact kind must be gnome-shell-extension")
    targets = config["targets"]
    if not isinstance(targets, list) or not targets:
        raise ReleaseError("release targets must be a non-empty array")
    platform_ids = set()
    for target in targets:
        if not isinstance(target, dict) or not isinstance(target.get("id"), str):
            raise ReleaseError("each release platform target needs a string id")
        if target["id"] in platform_ids:
            raise ReleaseError(f"duplicate release platform target id: {target['id']}")
        platform_ids.add(target["id"])
        if target.get("runner") not in {"homelab", "homelab-heavy"}:
            raise ReleaseError(f"target {target['id']} has an invalid runner tier")
    forge = config["forge"]
    if not isinstance(forge, dict) or forge.get("operations_path") != "/api/operations":
        raise ReleaseError("release forge.operations_path must be /api/operations")
    return config


def load_metadata(root: Path) -> dict[str, Any]:
    return load_json(root / METADATA_PATH)


def validate_metadata(root: Path, config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or load_config(root)
    metadata = load_metadata(root)
    errors: list[str] = []
    if metadata.get("uuid") != UUID:
        errors.append(f"metadata uuid must be {UUID!r}")
    if metadata.get("version-name") != config["version"]:
        errors.append(
            f"metadata version-name {metadata.get('version-name')!r} != release version {config['version']!r}"
        )
    if metadata.get("version") != config["gnome_version"]:
        errors.append(
            f"metadata GNOME version {metadata.get('version')!r} != release gnome_version {config['gnome_version']!r}"
        )
    expected_shell = config.get("shell_versions", [48, 49, 50])
    if metadata.get("shell-version") != [str(v) for v in expected_shell]:
        errors.append(
            f"metadata shell-version {metadata.get('shell-version')!r} != {expected_shell!r}"
        )
    if not isinstance(metadata.get("name"), str) or not metadata["name"].strip():
        errors.append("metadata name must be non-empty")
    if errors:
        raise ReleaseError("metadata contract failed: " + "; ".join(errors))
    return metadata


def git_output(root: Path, *args: str) -> str:
    try:
        return subprocess.check_output(["git", *args], cwd=root, text=True).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ReleaseError(f"git {' '.join(args)} failed: {exc}") from exc


def source_revision(root: Path) -> str:
    revision = git_output(root, "rev-parse", "HEAD")
    if not re.fullmatch(r"[0-9a-f]{40,64}", revision):
        raise ReleaseError(f"git returned an invalid source revision: {revision!r}")
    return revision


def source_dirty(root: Path) -> bool:
    return bool(git_output(root, "status", "--porcelain", "--untracked-files=all"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def zip_names(path: Path) -> list[str]:
    try:
        with zipfile.ZipFile(path) as archive:
            bad = archive.testzip()
            if bad is not None:
                raise ReleaseError(f"ZIP CRC check failed for {bad}")
            names = archive.namelist()
    except FileNotFoundError as exc:
        raise ReleaseError(f"missing artifact: {path}") from exc
    except zipfile.BadZipFile as exc:
        raise ReleaseError(f"invalid extension ZIP {path}: {exc}") from exc
    if len(names) != len(set(names)):
        raise ReleaseError("extension ZIP contains duplicate paths")
    for name in names:
        normalized = name.replace("\\", "/")
        if (normalized != name or "\x00" in name or normalized.startswith("/") or
                normalized.startswith("./") or normalized == ".." or
                "/../" in f"/{normalized}/" or normalized.endswith("/../")):
            raise ReleaseError(f"extension ZIP contains unsafe path: {name!r}")
        if (normalized.startswith(".git/") or "/.git/" in normalized or
                normalized.endswith(".compiled") or normalized.startswith("build/")):
            raise ReleaseError(f"extension ZIP contains build/private file: {name!r}")
    return names


def validate_zip(path: Path, root: Path, config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or load_config(root)
    metadata = validate_metadata(root, config)
    names = zip_names(path)
    required = {
        "metadata.json",
        "extension.js",
        "prefs.js",
        "stylesheet.css",
        "icons/actionview-symbolic.svg",
        "schemas/org.gnome.shell.extensions.actionview.gschema.xml",
        "lib/client.js",
        "lib/store.js",
        "lib/poller.js",
    }
    missing = sorted(required - set(names))
    if missing:
        raise ReleaseError(f"extension ZIP is missing required files: {', '.join(missing)}")
    files = {name for name in names if not name.endswith("/")}
    allowed_prefixes = ("icons/", "schemas/", "lib/")
    unexpected = sorted(
        name for name in files
        if name not in {"metadata.json", "extension.js", "prefs.js", "stylesheet.css"}
        and not name.startswith(allowed_prefixes)
    )
    if unexpected:
        raise ReleaseError(f"extension ZIP contains unexpected top-level files: {', '.join(unexpected)}")
    if "actionview@kanterlabs.dev/metadata.json" in names:
        raise ReleaseError("extension ZIP must use GNOME bundle root files, not a UUID directory")
    with zipfile.ZipFile(path) as archive:
        try:
            packed_metadata = json.loads(archive.read("metadata.json"))
        except (KeyError, json.JSONDecodeError) as exc:
            raise ReleaseError(f"packed metadata.json is unreadable: {exc}") from exc
    if packed_metadata != metadata:
        raise ReleaseError("packed metadata.json differs from the checked-out metadata.json")
    return {"metadata": packed_metadata, "files": names}


def find_artifact_bundle(path: Path, root: Path) -> tuple[Path, Path, Path]:
    """Return (directory, ZIP, manifest) for a downloaded artifact bundle."""
    if path.is_file():
        directory = path.parent
        zip_path = path
    elif path.is_dir():
        directory = path
        zip_path = directory / ARTIFACT_NAME
        if not zip_path.is_file():
            matches = sorted(directory.rglob(ARTIFACT_NAME))
            if len(matches) != 1:
                raise ReleaseError(f"could not locate exactly one {ARTIFACT_NAME} under {path}")
            zip_path = matches[0]
    else:
        raise ReleaseError(f"artifact path does not exist: {path}")
    manifest = directory / MANIFEST_NAME
    if not manifest.is_file():
        matches = sorted(directory.rglob(MANIFEST_NAME))
        if len(matches) == 1:
            manifest = matches[0]
        else:
            raise ReleaseError(f"missing {MANIFEST_NAME} next to downloaded artifact {zip_path}")
    return directory, zip_path, manifest


def validate_manifest(
    bundle: Path,
    zip_path: Path,
    manifest_path: Path,
    root: Path,
    config: dict[str, Any] | None = None,
    expected_source_sha: str | None = None,
    allow_dirty: bool = False,
) -> dict[str, Any]:
    config = config or load_config(root)
    manifest = load_json(manifest_path)
    if manifest.get("schema_version") != 1:
        raise ReleaseError("artifact manifest schema_version must be 1")
    if manifest.get("product") != "ActionView":
        raise ReleaseError("artifact manifest product must be ActionView")
    if manifest.get("version") != config["version"]:
        raise ReleaseError("artifact manifest version differs from ci/release.json")
    source_sha = manifest.get("source_sha")
    if not isinstance(source_sha, str) or not SHA256.fullmatch(source_sha):
        # Git revisions are hex but not necessarily 64 characters. Accept the
        # exact revision length emitted by git while rejecting arbitrary text.
        if not isinstance(source_sha, str) or not re.fullmatch(r"[0-9a-f]{40,64}", source_sha):
            raise ReleaseError("artifact manifest source_sha is invalid")
    if expected_source_sha and source_sha != expected_source_sha:
        raise ReleaseError(
            f"artifact source SHA {source_sha} does not match expected revision {expected_source_sha}"
        )
    if manifest.get("source_dirty") and not allow_dirty:
        raise ReleaseError("artifact was built from a dirty source tree")
    if manifest.get("artifact") != ARTIFACT_NAME:
        raise ReleaseError("artifact manifest names a different ZIP")
    digest = sha256(zip_path)
    if manifest.get("sha256") != digest:
        raise ReleaseError("artifact manifest SHA-256 does not match downloaded ZIP")
    size = manifest.get("size")
    if size != zip_path.stat().st_size:
        raise ReleaseError("artifact manifest size does not match downloaded ZIP")
    checksum_path = bundle / CHECKSUM_NAME
    if not checksum_path.is_file():
        raise ReleaseError(f"missing {CHECKSUM_NAME}")
    checksum_line = next((line.strip() for line in checksum_path.read_text(encoding="utf-8").splitlines()
                          if line.strip()), "")
    expected_checksum = f"{digest}  {ARTIFACT_NAME}"
    if checksum_line != expected_checksum:
        raise ReleaseError(
            f"{CHECKSUM_NAME} does not match downloaded ZIP (expected {expected_checksum!r})"
        )
    validate_zip(zip_path, root, config)
    return manifest


def json_dump(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def env_version() -> str | None:
    for key in ("RELEASE_VERSION", "GITHUB_REF_NAME", "CI_COMMIT_TAG"):
        value = os.environ.get(key, "").strip()
        if value:
            if value.startswith("v"):
                value = value[1:]
            return value
    return None
