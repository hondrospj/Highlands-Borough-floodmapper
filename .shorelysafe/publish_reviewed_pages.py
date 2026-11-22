#!/usr/bin/env python3
"""Stage reviewed mapper bytes and deploy an exact GitHub Pages artifact ID."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

CLIENTS = {
    "hondrospj/Avalon-Borough-floodmapper": ("avalon", "8535419", "01411355", -2.58),
    "hondrospj/Cape-May-floodmapper": ("cape-may", "8535901", "01411390", -2.77),
    "hondrospj/Highlands-Borough-floodmapper": ("highlands", "8531804", "01407600", -2.13),
}
ROOTS = ("index.html", "forecast.json", "observed.json", "toptides.json",
         "petss_station_index.json", "usgs_crests.json", "Boundaries", "assets", "data")
DATA_FILES = ("forecast.json", "observed.json", "toptides.json")
RECEIPT = "reviewed-pages-receipt.json"
API = "https://api.github.com"
MAX_SITE = 1024 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return {"sha256": h.hexdigest(), "bytes": path.stat().st_size}


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root).decode().strip()


def context(root):
    repo = os.environ.get("GITHUB_REPOSITORY")
    require(repo in CLIENTS, "Only the three confirmed client mapper repositories are allowed")
    require(os.environ.get("GITHUB_REF") == "refs/heads/main", "Only trusted main may publish")
    actual = git(root, "rev-parse", "HEAD")
    workflow_commit = os.environ.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[0-9a-f]{40}", actual) and re.fullmatch(r"[0-9a-f]{40}", workflow_commit),
            "Expected complete workflow and checkout commit identities")
    mode = os.environ.get("SOURCE_MODE", "reviewed")
    if mode == "current-main":
        require(repo == "hondrospj/Cape-May-floodmapper"
                and os.environ.get("GITHUB_WORKFLOW_REF") == repo + "/.github/workflows/six-hour-refresh.yml@refs/heads/main"
                and os.environ.get("GITHUB_EVENT_NAME") in {"schedule", "workflow_dispatch"},
                "Current-main mode is restricted to the existing Cape May refresh workflow")
        require(not os.environ.get("SOURCE_COMMIT") and not os.environ.get("EXPECTED_INDEX_SHA256"),
                "Scheduled publication cannot override the checked-out source identity")
        source, expected = actual, digest(root / "index.html")["sha256"]
    else:
        require(mode == "reviewed", "Unknown publication source mode")
        source = os.environ.get("SOURCE_COMMIT", "")
        expected = os.environ.get("EXPECTED_INDEX_SHA256", "")
        require(re.fullmatch(r"[0-9a-f]{40}", source), "Expected a full reviewed source commit")
        require(re.fullmatch(r"[0-9a-f]{64}", expected), "Expected a full reviewed index SHA-256")
        require(actual == source == workflow_commit,
                "Workflow and checkout must match the reviewed source commit")
    index = root / "index.html"
    require(index.is_file() and not index.is_symlink(), "Missing or symlink index")
    require(digest(index)["sha256"] == expected, "Index differs from the reviewed SHA-256")
    require(git(root, "hash-object", "--", "index.html") == git(root, "rev-parse", "HEAD:index.html"),
            "Index worktree bytes differ from the checked-out Git commit")
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    require(run.isdigit() and attempt.isdigit(), "Invalid workflow run identity")
    artifact = f"client-mapper-pages-{run}-{attempt}"
    require(os.environ.get("ARTIFACT_NAME") == artifact, "Artifact name must identify this run attempt")
    return {"repository": repo, "town": CLIENTS[repo][0], "source_commit": source,
            "workflow_commit": workflow_commit, "source_mode": mode,
            "index_sha256": expected, "run_id": int(run), "run_attempt": int(attempt),
            "artifact_name": artifact}


def api(path, method="GET", data=None, attempts=1):
    """Retry explicit read404/429/5xx responses only; never ambiguous writes."""
    require(path.startswith("/repos/"), "Unexpected GitHub API path")
    token = os.environ.get("GH_TOKEN", "")
    require(token, "The workflow GitHub token is unavailable")
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"},
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
            require(len(raw) <= 4 * 1024 * 1024, "Unexpected GitHub response size")
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            # A write error may have committed before the response was lost.
            code = error.code
            error.close()
            retry = method == "GET" and code in {404, 429, 500, 502, 503, 504}
            if not retry or attempt + 1 == attempts:
                raise RuntimeError(f"GitHub {method} request failed with HTTP {code}") from None
            time.sleep(min(2 ** attempt, 8))


def current_source(info):
    ref = api(f"/repos/{info['repository']}/git/ref/heads/main")
    require(ref.get("object", {}).get("sha") == info["source_commit"],
            "Main changed after review; inspect the new source before publishing")


def native_config(root, info):
    text = (root / "index.html").read_text()
    matches = re.findall(r'<template[^>]+id="floodmapperTownData"[^>]*>([\s\S]*?)</template>', text)
    require(len(matches) == 1, "Expected one modern mapper town configuration")
    config = json.loads(matches[0])
    town, petss, usgs, offset = CLIENTS[info["repository"]]
    if town in {"avalon", "cape-may"}:
        require("hydraulic-connectivity-v1" not in text and "hydraulic-connectivity-v1" not in json.dumps(config)
                and config.get("compatibility", {}).get("hydraulicCatalog") in {"phase-v2", "phase-v2-sparse"},
                "Cannot omit retired v1 assets while the reviewed mapper still references them")
    forecast = json.loads((root / "forecast.json").read_text())
    observed = json.loads((root / "observed.json").read_text())
    require(str(config["site"]["petssGaugeId"]) == str(forecast["stationId"]) == petss,
            "PETSS station differs from the reviewed client")
    require(str(config["site"]["usgsGaugeId"]) == str(forecast["usgsGaugeId"]) == str(observed["site"]) == usgs,
            "Observation gauge differs from the reviewed client")
    require(forecast["mapDatum"] == observed["datum"] == "NAVD88", "Unexpected native datum")
    require(config["datums"]["navd88OffsetFromMllwFt"] == forecast["navd88OffsetFromMllwFt"] == observed["navd88OffsetFromMllwFt"] == offset,
            "Native datum conversion changed")
    expected_thresholds = {key + "Low": value for key, value in config["thresholds"]["navd88"].items()}
    require(forecast["thresholdsNAVD88"] == observed["thresholdsNAVD88"] == expected_thresholds,
            "Native flood thresholds differ between index and data")
    return config


def validate_data(root, info):
    """Use the existing town contract; never regenerate forecast or observation data."""
    if info["town"] == "avalon":
        spec = importlib.util.spec_from_file_location("pages_validator", root / ".shorelysafe/validate_refresh.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.validate_source(root, "floodmapper--avalon")
    script, args = ((".shorelysafe/verify_data_freshness.py", ["--product", "floodmapper", "--check-only"])
                    if info["town"] == "cape-may" else
                    ("tools/refresh_contract.py", ["--profile", "mapper", "--check"]))
    return json.loads(subprocess.check_output(["python3", script, *args], cwd=root))


def stage(root):
    info = context(root)
    current_source(info)
    native_config(root, info)
    facts = validate_data(root, info)
    destination = root / "_site"
    require(not destination.exists(), "Refusing to reuse a previous Pages staging directory")
    names = subprocess.check_output(["git", "ls-files", "-z", "--", *ROOTS], cwd=root).decode().split("\0")
    files, total = {}, 0
    destination.mkdir()
    for name in sorted(filter(None, names)):
        if info["town"] in {"avalon", "cape-may"} and name.startswith("assets/hydraulic-connectivity-v1/"):
            continue  # Both current configurations exclusively use the v2 model.
        path = Path(name)
        require(not path.is_absolute() and ".." not in path.parts and not any(p.startswith(".") for p in path.parts),
                "Unexpected private or unsafe staged path")
        source = root / path
        require(source.is_file() and not source.is_symlink(), "Missing or symlink staged file: " + name)
        require(all(not parent.is_symlink() for parent in source.parents if parent != root.parent),
                "Symlink parent in staged path")
        with source.open("rb") as stream:
            require(not stream.read(150).startswith(b"version https://git-lfs.github.com/spec/"), "LFS pointer: " + name)
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        files[name] = digest(target)
        total += files[name]["bytes"]
        require(total < MAX_SITE, "Staged mapper exceeds the GitHub Pages 1GB limit")
    require(all(name in files for name in (*DATA_FILES, "index.html")), "Required mapper files missing")
    require(files["index.html"]["sha256"] == info["index_sha256"], "Staged index changed")
    (destination / ".nojekyll").touch()
    info.update(files=files, staged_bytes=total, source_validation=facts)
    (root / RECEIPT).write_text(json.dumps(info, indent=2) + "\n")
    print(json.dumps({k: v for k, v in info.items() if k != "files"}))
    return info


def artifact_metadata(info, artifact_id):
    require(re.fullmatch(r"[1-9][0-9]*", artifact_id), "Invalid uploaded artifact ID")
    item = api(f"/repos/{info['repository']}/actions/artifacts/{artifact_id}", attempts=6)
    run = item.get("workflow_run", {})
    require(item.get("id") == int(artifact_id) and item.get("name") == info["artifact_name"]
            and item.get("expired") is False and 0 < item.get("size_in_bytes", 0) < MAX_SITE
            and run.get("id") == info["run_id"] and run.get("head_sha") == info["workflow_commit"]
            and run.get("head_branch") == "main", "Artifact identity differs from this reviewed run attempt")
    return item


def oidc_token():
    # The same runner-provided endpoint and default audience used by @actions/core.getIDToken().
    url = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL", "")
    token = os.environ.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN", "")
    parsed = urllib.parse.urlparse(url)
    require(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password
            and (parsed.hostname.endswith(".actions.githubusercontent.com") or parsed.hostname == "vstoken.actions.githubusercontent.com")
            and token, "The configured runner OIDC endpoint is unavailable")
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=30) as response:
        result = json.load(response)
    require(isinstance(result.get("value"), str) and result["value"], "GitHub returned no OIDC token")
    return result["value"]


def verify_public(info, fetch=None):
    def default_fetch(url):
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-cache"}), timeout=90) as response:
            h, size = hashlib.sha256(), 0
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                h.update(chunk)
                size += len(chunk)
                require(size <= MAX_SITE, "Unexpected public file size")
        return {"sha256": h.hexdigest(), "bytes": size}
    fetch = fetch or default_fetch
    base = "https://hondrospj.github.io/" + info["repository"].split("/")[1] + "/"
    for name in ("", "index.html", *DATA_FILES):
        entry = info["files"][name or "index.html"]
        require(fetch(base + name + "?sha256=" + entry["sha256"]) == entry,
                "Public Pages bytes do not match the reviewed artifact: " + (name or "/"))
    return base


def deploy(root):
    info = context(root)
    staged = json.loads((root / RECEIPT).read_text())
    require(all(staged.get(key) == value for key, value in info.items()), "Staging receipt identity changed")
    info = staged
    current_source(info)
    artifact_id = os.environ.get("ARTIFACT_ID", "")
    artifact_metadata(info, artifact_id)
    payload = {"artifact_id": int(artifact_id), "pages_build_version": info["workflow_commit"], "oidc_token": oidc_token()}
    current_source(info)
    # Use the official Pages API payload directly. No Results-service name lookup and no ambiguous POST retry.
    result = api(f"/repos/{info['repository']}/pages/deployments", "POST", payload)
    deployment = str(result.get("id") or result.get("status_url", "").rstrip("/").split("/")[-1])
    require(re.fullmatch(r"[A-Za-z0-9_-]+", deployment), "GitHub returned an invalid deployment ID")
    info.update(artifact_id=int(artifact_id), deployment_id=deployment, published=False)
    (root / RECEIPT).write_text(json.dumps(info, indent=2) + "\n")
    status_path = f"/repos/{info['repository']}/pages/deployments/{deployment}"
    for _ in range(36):
        status = api(status_path, attempts=3).get("status")
        if status == "succeed":
            break
        require(status not in {"deployment_failed", "deployment_content_failed", "deployment_cancelled", "deployment_lost"},
                "GitHub Pages deployment failed: " + str(status))
        time.sleep(5)
    else:
        api(status_path + "/cancel", "POST", {})
        raise RuntimeError("GitHub Pages deployment timed out and was cancelled")
    for attempt in range(6):
        try:
            page_url = verify_public(info)
            break
        except (RuntimeError, urllib.error.URLError, TimeoutError):
            if attempt == 5:
                raise
            time.sleep(min(2 ** attempt, 8))
    info.update(published=True, page_url=page_url)
    (root / RECEIPT).write_text(json.dumps(info, indent=2) + "\n")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write("page_url=" + page_url + "\n")
    print(json.dumps({k: v for k, v in info.items() if k != "files"}))
    return info


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("stage", "deploy"))
    args = parser.parse_args()
    {"stage": stage, "deploy": deploy}[args.command](Path.cwd())
