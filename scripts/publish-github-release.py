#!/usr/bin/env python3
"""Create or update a GitHub Release and stream one asset into it."""

from __future__ import annotations

import http.client
import json
import mimetypes
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


API_VERSION = "2022-11-28"


def api_request(token: str, method: str, url: str, payload: dict | None = None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "minecraft-bedrock-manager-release-publisher",
        "X-GitHub-Api-Version": API_VERSION,
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=60) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if exc.code == 404:
            return exc.code, None
        raise RuntimeError(f"GitHub API {method} {url} failed with HTTP {exc.code}: {body}") from exc


def upload_asset(token: str, repository: str, release_id: int, asset: Path) -> None:
    content_type = mimetypes.guess_type(asset.name)[0] or "application/octet-stream"
    path = (
        f"/repos/{repository}/releases/{release_id}/assets"
        f"?name={quote(asset.name, safe='')}"
    )
    connection = http.client.HTTPSConnection("uploads.github.com", timeout=120)
    connection.putrequest("POST", path)
    connection.putheader("Accept", "application/vnd.github+json")
    connection.putheader("Authorization", f"Bearer {token}")
    connection.putheader("Content-Type", content_type)
    connection.putheader("Content-Length", str(asset.stat().st_size))
    connection.putheader("User-Agent", "minecraft-bedrock-manager-release-publisher")
    connection.putheader("X-GitHub-Api-Version", API_VERSION)
    connection.endheaders()

    with asset.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            connection.send(chunk)

    response = connection.getresponse()
    body = response.read().decode("utf-8", errors="replace")
    connection.close()
    if response.status != 201:
        raise RuntimeError(f"GitHub asset upload failed with HTTP {response.status}: {body}")


def main() -> int:
    if len(sys.argv) != 4:
        print("Usage: publish-github-release.py OWNER/REPO TAG ASSET", file=sys.stderr)
        return 2

    repository, tag, asset_name = sys.argv[1:]
    token = os.environ.get("GITHUB_RELEASE_TOKEN", "")
    if not token:
        print("GITHUB_RELEASE_TOKEN is required", file=sys.stderr)
        return 2

    asset = Path(asset_name)
    if not asset.is_file() or asset.stat().st_size == 0:
        print(f"Release asset is missing or empty: {asset}", file=sys.stderr)
        return 2

    api_root = f"https://api.github.com/repos/{repository}"
    status, release = api_request(token, "GET", f"{api_root}/releases/tags/{quote(tag, safe='')}")
    if status == 404:
        _, release = api_request(
            token,
            "POST",
            f"{api_root}/releases",
            {"tag_name": tag, "name": tag, "generate_release_notes": True},
        )

    if not isinstance(release, dict) or not isinstance(release.get("id"), int):
        raise RuntimeError("GitHub returned an invalid release response")

    for existing in release.get("assets", []):
        if existing.get("name") == asset.name:
            api_request(token, "DELETE", f"{api_root}/releases/assets/{existing['id']}")

    upload_asset(token, repository, release["id"], asset)
    print(f"Uploaded {asset.name} to {release.get('html_url', tag)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # Keep token-free API errors visible in CI.
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
