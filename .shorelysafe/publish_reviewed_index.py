#!/usr/bin/env python3
"""Publish the exact reviewed index through the existing Cup overlay API."""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

from publish_data_overlay import request


CLIENTS = {
    "hondrospj/Avalon-Borough-floodmapper": "avalon",
    "hondrospj/Cape-May-floodmapper": "cape-may",
    "hondrospj/Highlands-Borough-floodmapper": "highlands",
}
SITE = "https://cupajoe.live"
MAX_INDEX_BYTES = 2 * 1024 * 1024
CHUNK_BYTES = 512 * 1024


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def validate_digest(value):
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("Expected a complete index SHA-256")
    return value


def read_public_index(path, entry):
    for suffix in ("", "index.html"):
        url = SITE + path + suffix + "?sha256=" + entry["sha256"]
        req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=120) as response:
            content = response.read(MAX_INDEX_BYTES + 1)
        if (len(content) > MAX_INDEX_BYTES or len(content) != entry["size"]
                or sha256(content) != entry["sha256"]):
            raise RuntimeError("The public mapper root or index differs from the active manifest")
    return content


def validated_files(state):
    if not isinstance(state, dict):
        raise ValueError("The host returned an invalid published state")
    deployment = state.get("deployment")
    manifest = state.get("manifest")
    if (not state.get("published") or not isinstance(deployment, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]+", deployment)
            or not isinstance(manifest, dict)):
        raise ValueError("The existing live mapper manifest is unavailable")
    if manifest.get("deployment", deployment) != deployment:
        raise ValueError("The active deployment and manifest disagree")
    files = manifest.get("files")
    if not isinstance(files, dict) or "index.html" not in files:
        raise ValueError("The active index manifest is missing")
    for name, entry in files.items():
        if (not isinstance(name, str) or not name or name.startswith("/")
                or ".." in name.split("/") or not isinstance(entry, dict)
                or not isinstance(entry.get("sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])
                or type(entry.get("size")) is not int or entry["size"] < 0):
            raise ValueError("The active mapper contains an invalid file descriptor")
    return files


def overlay(before, content, expected_before, expected_after):
    validate_digest(expected_before)
    validate_digest(expected_after)
    if not isinstance(before, dict) or not isinstance(before.get("index.html"), dict):
        raise ValueError("The active index manifest is missing")
    digest = sha256(content)
    if not content or len(content) > MAX_INDEX_BYTES or digest != expected_after:
        raise ValueError("Source index does not match the reviewed final SHA-256")
    content.decode("utf-8")
    entry = {"sha256": digest, "size": len(content)}
    if before["index.html"] == entry:
        return copy.deepcopy(before), {}, []
    if before["index.html"].get("sha256") != expected_before:
        raise RuntimeError("The deployed index changed after review")
    after = copy.deepcopy(before)
    after["index.html"] = entry
    if {name for name in before if before[name] != after[name]} != {"index.html"}:
        raise AssertionError("The index overlay changed an unexpected file")
    return after, {digest: content}, ["index.html"]


def upload_index(app, token, plan, payloads):
    missing = plan.get("missing")
    if not isinstance(missing, list) or any(digest not in payloads for digest in missing):
        raise RuntimeError("The host is missing a retained live blob")
    deployment = plan.get("deployment")
    if not isinstance(deployment, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", deployment):
        raise RuntimeError("The host returned an invalid deployment identifier")
    for digest in set(missing):
        content = payloads[digest]
        offset = 0
        while offset < len(content):
            chunk = content[offset:offset + CHUNK_BYTES]
            uploaded = request(
                SITE, app, token,
                f"blobs/{digest}?deployment={deployment}&offset={offset}",
                "PUT", chunk, True,
            )
            next_offset = offset + len(chunk)
            if uploaded.get("complete"):
                if next_offset != len(content):
                    raise RuntimeError("The host completed a partial index upload")
                break
            if uploaded.get("offset") != next_offset or next_offset >= len(content):
                raise RuntimeError("The host did not acknowledge the exact index chunk")
            offset = next_offset
    return deployment


def publish(root, expected_before, expected_after, source_commit, dry_run):
    repo = os.environ.get("GITHUB_REPOSITORY")
    if repo not in CLIENTS:
        raise ValueError("This workflow is restricted to the three client mappers")
    if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise ValueError("Expected the full reviewed source commit SHA")
    actual_commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    if actual_commit != source_commit:
        raise ValueError("Checkout differs from the reviewed source commit")
    town = CLIENTS[repo]
    app = "floodmapper--" + town
    public_path = "/shorelysafe/floodmapper/" + town + "/"
    catalog = json.loads((root / ".shorelysafe/apps.json").read_text())
    matches = [entry for entry in catalog if entry.get("id") == app]
    if (len(matches) != 1 or matches[0].get("repository") != repo
            or matches[0].get("path") != public_path
            or matches[0].get("product") != "floodmapper"):
        raise ValueError("Client app registry differs from the reviewed mapper")
    source = root / "index.html"
    if source.is_symlink() or not source.is_file():
        raise ValueError("The source index is missing or a symlink")
    content = source.read_bytes()
    validate_digest(expected_before)
    validate_digest(expected_after)
    if sha256(content) != expected_after:
        raise ValueError("Source index differs from the reviewed final SHA-256")
    token = os.environ.get("SHORELYSAFE_TOKEN")
    if not token:
        raise ValueError("The configured repository publisher secret is unavailable")
    state = request(SITE, app, token, "state?manifest=1")
    before = validated_files(state)
    if before["index.html"].get("sha256") not in {expected_before, expected_after}:
        raise RuntimeError("The deployed index changed after review")
    read_public_index(public_path, before["index.html"])
    after, payloads, changed = overlay(before, content, expected_before, expected_after)
    result = {
        "app": app, "source_commit": source_commit,
        "base_deployment": state["deployment"], "changed_paths": changed,
        "old_index_sha256": before["index.html"]["sha256"],
        "new_index_sha256": expected_after,
        "preserved_live_files": len(after) - 1,
        "dry_run": dry_run, "published": False,
    }
    if changed and not dry_run:
        manifest = {
            "files": [{"path": name, **entry} for name, entry in sorted(after.items())],
            "commit": source_commit,
        }
        plan = request(SITE, app, token, "plan", "POST", manifest)
        deployment = upload_index(app, token, plan, payloads)
        latest = request(SITE, app, token, "state")
        if latest.get("deployment") != state["deployment"]:
            raise RuntimeError("The live deployment changed during index upload")
        committed = request(SITE, app, token, "commit", "POST", {"deployment": deployment})
        final = request(SITE, app, token, "state?manifest=1")
        if (not committed.get("published") or final.get("deployment") != deployment
                or validated_files(final) != after):
            raise RuntimeError("The published overlay manifest could not be verified")
        result.update(published=True, deployment=deployment)
    result["no_op"] = not changed
    if not dry_run:
        read_public_index(public_path, after["index.html"])
        result["public_index_verified"] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-before", required=True)
    parser.add_argument("--expected-after", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    result = publish(
        Path.cwd(), args.expected_before, args.expected_after, args.source_commit, args.dry_run
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
