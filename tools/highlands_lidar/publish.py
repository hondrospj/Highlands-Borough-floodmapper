#!/usr/bin/env python3
"""Upload this Highlands release to a new Bunny path and verify its contents."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ZONE = "floodmapperv1"
CDN = "https://floodmapperv1.b-cdn.net"
PREFIX = "HighlandsBorough/highlands-lidar-2022-2014-v2"
COG_PATH = "MasterRasters/cog-cors/highlands-borough-2022-2014-1m-v2.png"


def credential():
    key = os.environ.get("BUNNY_STORAGE_PASSWORD", "") or os.environ.get("BUNNY_STORAGE_KEY", "")
    if not key:
        result = subprocess.run(["/usr/bin/security", "find-generic-password", "-w", "-s",
                                 f"shorelysafe.bunny.storage.{ZONE}", "-a", ZONE], capture_output=True, text=True)
        key = result.stdout.strip() if result.returncode == 0 else ""
    if not key:
        raise RuntimeError("Bunny credential is not configured")
    return key


def request(url, data=None, headers=None, method="GET"):
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
            with urllib.request.urlopen(req, timeout=45) as response:
                return response.read(), dict(response.headers), response.status
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == 4:
                # Never include request headers or the credential in failures.
                raise RuntimeError(f"{method} failed: {url}: {type(error).__name__}") from None
            time.sleep(2 ** attempt)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--catalog", type=Path, required=True)
    p.add_argument("--cog", type=Path, required=True)
    p.add_argument("--report", type=Path, required=True)
    p.add_argument("--verify-only", action="store_true")
    args = p.parse_args()
    files = [(path, PREFIX + "/" + path.relative_to(args.catalog).as_posix())
             for path in sorted(args.catalog.rglob("*")) if path.is_file()]
    files.append((args.cog, COG_PATH))
    assert sum("/DepthPNGs/" in remote or "/StagePNGs/" in remote for _, remote in files) == 2010
    key = None if args.verify_only else credential()

    def upload(record):
        path, remote = record
        body = path.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        if not args.verify_only:
            _, _, status = request(f"https://storage.bunnycdn.com/{ZONE}/" + urllib.parse.quote(remote, safe="/"),
                                   data=body, method="PUT", headers={"AccessKey": key, "Content-Type": "image/png" if remote.endswith(".png") else "application/json"})
            if status not in (200, 201):
                raise RuntimeError(f"Unexpected upload status {status} for {remote}")
        return {"path": remote, "bytes": len(body), "sha256": digest}

    records = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        for count, record in enumerate(pool.map(upload, files), 1):
            records.append(record)
            if count % 200 == 0 or count == len(files):
                print(f"Uploaded {count}/{len(files)}", flush=True)

    # Verify every public raster and query by content, with the production
    # Origin header. Versioned paths avoid reliance on cache invalidation.
    selected = [r for r in records if r["path"].endswith(".png")]

    def verify(record):
        url = CDN + "/" + urllib.parse.quote(record["path"], safe="/")
        body, headers, status = request(url, headers={"Origin": "https://cupajoe.live"})
        if hashlib.sha256(body).hexdigest() != record["sha256"]:
            raise AssertionError(f"Public content mismatch: {record['path']}")
        headers = {k.lower(): v for k, v in headers.items()}
        if headers.get("access-control-allow-origin") not in ("*", "https://cupajoe.live"):
            raise AssertionError(f"Missing public CORS: {record['path']}")
        return record["path"]

    verified = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        for count, result in enumerate(pool.map(verify, selected), 1):
            verified.append(result)
            if count % 200 == 0 or count == len(selected):
                print(f"Public SHA-256 verified {count}/{len(selected)}", flush=True)
    body, headers, status = request(CDN + "/" + COG_PATH, headers={"Range": "bytes=0-15", "Origin": "https://cupajoe.live"})
    if status != 206 or body != args.cog.read_bytes()[:16]:
        raise AssertionError("DEM byte-range access failed")
    report = {"status": "passed", "prefix": PREFIX, "uploadedCount": len(records),
              "uploadedBytes": sum(r["bytes"] for r in records), "publicRasterHashesVerified": len(verified),
              "corsVerified": True, "demRangeRequestVerified": True, "files": records}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "files"}), flush=True)


if __name__ == "__main__":
    main()
