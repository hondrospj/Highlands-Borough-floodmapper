#!/usr/bin/env python3
"""Publish the reviewed Highlands contour UI without replacing other live files."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

from publish_data_overlay import request


APP = "floodmapper--highlands"
REPOSITORY = "hondrospj/Highlands-Borough-floodmapper"
SITE = "https://cupajoe.live"
PUBLIC_PATH = "/shorelysafe/floodmapper/highlands/"
UI_PATHS = (
    "index.html",
    "assets/highlands-contours.js",
    "data/highlands-elevation-contours.json",
)
RECEIPT = Path("highlands-contours-publication-receipt.json")
BACKUP = Path("highlands-contours-base-manifest.json")
MAX_BYTES = 64 * 1024 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def overlay(base, source, replacements):
    before = base["files"]
    if not isinstance(before, dict) or "index.html" not in before:
        raise ValueError("Published UI manifest is missing")
    after = {name: dict(entry) for name, entry in before.items()}
    payloads, changed = {}, []
    for name in UI_PATHS:
        path = source / name
        if path.is_symlink() or not path.is_file():
            raise ValueError("Required reviewed asset missing or symlink: " + name)
        raw = path.read_bytes()
        if not raw or len(raw) >= MAX_BYTES:
            raise ValueError("Unexpected asset size: " + name)
        if raw.startswith(b"version https://git-lfs.github.com/spec/v1"):
            raise ValueError("Git LFS pointer is not a deployable asset: " + name)
        text = raw.decode("utf-8")
        if name.endswith(".json"):
            data = json.loads(text)
            if (data.get("verticalDatum") != "NAVD88"
                    or data.get("generation", {}).get("calculationCellSizeFt") != 1
                    or not data.get("lines")):
                raise ValueError("Expected the reviewed one-foot contour dataset")
        if name == "index.html" and (
                text.count('id="contoursToggle"') != 1
                or "Ground Elevation Contours" not in text
                or "highlands-contours.js" not in text):
            raise ValueError("Expected the reviewed Highlands contour control")
        for old, new in replacements:
            text = text.replace(old, new)
        content = text.encode("utf-8")
        digest = sha256(content)
        entry = {"sha256": digest, "size": len(content)}
        if before.get(name) != entry:
            changed.append(name)
            payloads[digest] = content
        after[name] = entry
    for name, entry in before.items():
        if name not in UI_PATHS and after[name] != entry:
            raise AssertionError("Unrelated live file changed: " + name)
    return after, payloads, changed


def save_receipt(result):
    RECEIPT.write_text(json.dumps(result, indent=2) + "\n")


def verify_public(after):
    verified = {}
    for name in UI_PATHS:
        entry = after[name]
        url = SITE + PUBLIC_PATH + name + "?contour_verify=" + entry["sha256"][:16]
        digest, size = hashlib.sha256(), 0
        req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=120) as response:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size >= MAX_BYTES:
                    raise RuntimeError("Hosted asset unexpectedly large: " + name)
                digest.update(chunk)
        if size != entry["size"] or digest.hexdigest() != entry["sha256"]:
            raise RuntimeError("Hosted bytes differ from reviewed asset: " + name)
        verified[name] = {"sha256": digest.hexdigest(), "size": size}
    return verified


def publish(root, expected_index_sha256, dry_run=False):
    if os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ValueError("This publisher is restricted to the Highlands repository")
    source_sha = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    if os.environ.get("SHORELYSAFE_UI_SOURCE_COMMIT") != source_sha:
        raise ValueError("Checked-out source does not match the reviewed source commit")
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("Expected a complete source commit SHA")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_index_sha256):
        raise ValueError("Expected the current published index SHA-256")
    apps = json.loads((root / ".shorelysafe/apps.json").read_text())
    app = next(app for app in apps if app["id"] == APP)
    if app["repository"] != REPOSITORY or app["path"] != PUBLIC_PATH:
        raise ValueError("Highlands app catalog mismatch")
    token = os.environ["SHORELYSAFE_TOKEN"]
    if not token:
        raise ValueError("Publisher credential missing")
    state = request(SITE, APP, token, "state?manifest=1")
    if not state.get("published") or not state.get("manifest"):
        raise ValueError("No existing published Highlands app to update")
    base = state["manifest"]
    replacements = [
        ("https://hondrospj.github.io/" + item["repository"].split("/")[1] + "/",
         item["path"]) for item in apps
    ]
    after, payloads, changed = overlay(base, root, replacements)
    before_index = base["files"]["index.html"]["sha256"]
    if before_index not in {expected_index_sha256, after["index.html"]["sha256"]}:
        raise RuntimeError("Published index changed since review; refusing to overwrite it")
    BACKUP.write_text(json.dumps({
        "deployment": state.get("deployment"), "commit": state.get("commit"),
        "files": base["files"],
    }, indent=2) + "\n")
    result = {
        "app": APP, "mode": "reviewed-three-file-ui-overlay",
        "source_commit": source_sha, "base_deployment": state.get("deployment"),
        "base_commit": state.get("commit"), "changed_paths": changed,
        "preserved_live_files": sum(name not in UI_PATHS for name in base["files"]),
        "index_sha256_before": before_index,
        "index_sha256_after": after["index.html"]["sha256"],
        "dry_run": dry_run, "published": False,
    }
    save_receipt(result)
    try:
        if changed and not dry_run:
            manifest = {"files": [{"path": name, **entry}
                                  for name, entry in sorted(after.items())],
                        "commit": source_sha}
            # The existing helper fails immediately on a hosting write gate.
            plan = request(SITE, APP, token, "plan", "POST", manifest)
            result["planned_deployment"] = plan["deployment"]
            save_receipt(result)
            for digest in plan["missing"]:
                if digest not in payloads:
                    raise RuntimeError("Server is missing a preserved live blob; refusing to replace it")
                content, offset = payloads[digest], 0
                while True:
                    chunk = content[offset:offset + 512 * 1024]
                    endpoint = f'blobs/{digest}?deployment={plan["deployment"]}&offset={offset}'
                    uploaded = request(SITE, APP, token, endpoint, "PUT", chunk, True)
                    if uploaded.get("complete"):
                        break
                    next_offset = int(uploaded["offset"])
                    if not offset < next_offset <= len(content):
                        raise RuntimeError("Blob upload made no valid progress")
                    offset = next_offset
            latest = request(SITE, APP, token, "state")
            if latest.get("deployment") != state.get("deployment"):
                raise RuntimeError("Live deployment changed during upload; refusing to switch it")
            published = request(SITE, APP, token, "commit", "POST",
                                {"deployment": plan["deployment"]})
            verify = request(SITE, APP, token, "state?manifest=1")
            if (verify.get("deployment") != plan["deployment"]
                    or verify.get("manifest", {}).get("files") != after):
                raise RuntimeError("Published manifest verification failed")
            result.update({"published": published.get("published"),
                           "deployment": plan["deployment"], "url": published.get("url"),
                           "unrelated_live_files_preserved": True})
            save_receipt(result)
        else:
            result["no_op"] = not changed
        if not dry_run:
            result["hosted_assets_verified"] = verify_public(after)
        save_receipt(result)
        return result
    except Exception as error:
        result["error"] = str(error)
        save_receipt(result)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-index-sha256", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(publish(Path.cwd(), args.expected_index_sha256, args.dry_run)))


if __name__ == "__main__":
    main()
