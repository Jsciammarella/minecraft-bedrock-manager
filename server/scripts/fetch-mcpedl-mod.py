#!/usr/bin/env python3
"""Create a catalog folder (mod.json + thumbnail) from an MCPEDL project URL.

MCPEDL pages list every hosted file with a CDN URL. This script picks the latest
intended download:

- one combined pack (.mcaddon / .mcworld / .mctemplate) when present
- otherwise the latest matching behavior + resource pair, zipped into an .mcaddon
- otherwise the newest single pack file

Example:
    python scripts/fetch-mcpedl-mod.py https://mcpedl.com/bosyas-japan-echoes-of-war/
    python scripts/fetch-mcpedl-mod.py --skip-download https://mcpedl.com/useful-slime/
    python scripts/fetch-mcpedl-mod.py --root "E:\\Minecraft Manager_Git Catalog" https://mcpedl.com/mobile-phones/
"""

from __future__ import annotations

import argparse
import html
import http.cookiejar
import json
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
HTTP_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
}
SSL_CONTEXT = ssl.create_default_context()
COOKIE_JAR = http.cookiejar.CookieJar()
URL_OPENER = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(COOKIE_JAR),
    urllib.request.HTTPSHandler(context=SSL_CONTEXT),
)
PACK_EXTENSIONS = (".mcaddon", ".mcpack", ".mcworld", ".mctemplate", ".zip")
COMBINED_EXTENSIONS = (".mcaddon", ".mcworld", ".mctemplate")
ALLOWED_TYPES = ("addon", "texture_pack", "world", "skin")
FOLDER_BY_TYPE = {
    "addon": "addons",
    "texture_pack": "texture-packs",
    "world": "maps",
    "skin": "skins",
}
CLASS_CATEGORY = {
    "addon": "addons",
    "texture_pack": "texture-packs",
    "world": "maps",
    "skin": "skins",
}
CATALOG_CATEGORIES = (
    "addons",
    "texture-packs",
    "maps",
    "skins",
    "utility",
    "vanilla",
    "survival",
    "technology",
    "magic",
    "multiplayer",
)
THEME_CATEGORIES = (
    "utility",
    "vanilla",
    "survival",
    "technology",
    "magic",
    "multiplayer",
)
PREFERRED_THUMBNAILS = (
    "thumbnail.png",
    "thumbnail.jpg",
    "thumbnail.jpeg",
    "thumbnail.webp",
    "logo.png",
    "icon.png",
    "pack_icon.png",
)
MCPEDL_CATEGORY_MAP = {
    "addons": "addons",
    "addon": "addons",
    "mods": "addons",
    "data packs": "addons",
    "datapacks": "addons",
    "texture packs": "texture-packs",
    "texture-packs": "texture-packs",
    "resource packs": "texture-packs",
    "maps": "maps",
    "worlds": "maps",
    "skins": "skins",
    "utility": "utility",
    "utilities": "utility",
    "vanilla": "vanilla",
    "vanilla+": "vanilla",
    "survival": "survival",
    "food": "survival",
    "farming": "survival",
    "technology": "technology",
    "tech": "technology",
    "redstone": "technology",
    "magic": "magic",
    "multiplayer": "multiplayer",
}
KEYWORD_CATEGORIES = (
    (re.compile(r"\b(multiplayer|realms?|bedrock dedicated|\bbds\b)\b", re.I), "multiplayer"),
    (re.compile(r"\b(survival|food|cook|farm|crop)\b", re.I), "survival"),
    (re.compile(r"\b(magic|spell|wizard|enchant)\b", re.I), "magic"),
    (re.compile(r"\b(technolog|machine|redstone|automat)\b", re.I), "technology"),
    (re.compile(r"\bvanilla\b", re.I), "vanilla"),
    (re.compile(r"\b(utility|quality of life|qol)\b", re.I), "utility"),
)
TITLE_TYPE_HINTS = (
    (re.compile(r"Minecraft PE Maps", re.I), "world"),
    (re.compile(r"Minecraft PE Texture Packs", re.I), "texture_pack"),
    (re.compile(r"Minecraft PE Skins", re.I), "skin"),
    (re.compile(r"Minecraft PE (Addons|Mods)", re.I), "addon"),
    (re.compile(r"Minecraft PE Scripts", re.I), "addon"),
)
VERSION_IN_NAME = re.compile(
    r"(?:^|[^\d])v(\d+(?:\.\d+){1,3})(?:[^\d]|$)|(?:\(|\s)v?(\d+(?:\.\d+){1,3})(?=\))",
    re.I,
)
CDN_RE = re.compile(
    r"https://edge\.mcpedl\.com/files/(\d+)/(\d+)/([^\"'\s<>]+)",
    re.I,
)
BEHAVIOR_RE = re.compile(
    r"\[bp\]|_bp(?:[_.\s]|$)|(?:^|[_\-\s.\[])bp(?:[_\-\s.\]]|$)|behavior|behaviour|bh[ _.-]?pack",
    re.I,
)
RESOURCE_RE = re.compile(
    r"\[rp\]|_rp(?:[_.\s]|$)|(?:^|[_\-\s.\[])rp(?:[_\-\s.\]]|$)|resource|rs[ _.-]?pack",
    re.I,
)


def http_get(url: str, timeout: int = 30, retries: int = 3) -> bytes:
    last_error: Exception | None = None
    attempts = max(1, retries + 1)
    for attempt in range(attempts):
        try:
            return _http_get_urllib(url, timeout)
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code in {403, 429, 503} and attempt < attempts - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            if exc.code in {403, 429}:
                data = _http_get_curl(url, timeout)
                if data:
                    return data
            raise
        except urllib.error.URLError as exc:
            last_error = exc
            if attempt < attempts - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            data = _http_get_curl(url, timeout)
            if data:
                return data
            raise
    if last_error:
        raise last_error
    raise RuntimeError(f"Failed to fetch {url}")


def _http_get_urllib(url: str, timeout: int) -> bytes:
    headers = dict(HTTP_HEADERS)
    host = urllib.parse.urlparse(url).netloc.lower()
    if "mcpedl.com" in host:
        headers["Referer"] = "https://mcpedl.com/"
        headers["Sec-Fetch-Site"] = "same-origin" if host == "mcpedl.com" else "cross-site"
    request = urllib.request.Request(url, headers=headers)
    with URL_OPENER.open(request, timeout=timeout) as response:
        return response.read()


def _http_get_curl(url: str, timeout: int) -> bytes | None:
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        return None
    try:
        result = subprocess.run(
            [
                curl,
                "-sS",
                "-L",
                "--max-time",
                str(timeout),
                "-A",
                USER_AGENT,
                "-H",
                "Accept-Language: en-US,en;q=0.9",
                "-H",
                "Referer: https://mcpedl.com/",
                url,
            ],
            check=False,
            capture_output=True,
            timeout=timeout + 5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0 or not result.stdout:
        return None
    return result.stdout


def meta_content(page: str, prop: str) -> str:
    match = re.search(
        rf'<meta[^>]+(?:property|name)="{re.escape(prop)}"[^>]+content="([^"]*)"',
        page,
        re.I | re.S,
    )
    if not match:
        match = re.search(
            rf'<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="{re.escape(prop)}"',
            page,
            re.I | re.S,
        )
    return html.unescape(match.group(1)).strip() if match else ""


def unescape_js_string(value: str) -> str:
    text = html.unescape(value or "")
    text = text.replace("\\u002F", "/").replace("\\/", "/")
    text = text.replace("\\n", "\n").replace("\\t", "\t").replace('\\"', '"')
    return text.strip()


def parse_mcpedl_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url.strip())
    host = (parsed.netloc or "").lower()
    if "mcpedl.com" not in host:
        raise ValueError(f"Not an MCPEDL URL: {url}")
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        raise ValueError(f"Not an MCPEDL project URL: {url}")
    skip = {"addons", "maps", "texture-packs", "skins", "scripts", "category", "user"}
    slug = parts[-1] if parts[-1] not in skip else (parts[-2] if len(parts) > 1 else parts[-1])
    if not slug:
        raise ValueError(f"Not an MCPEDL project URL: {url}")
    return slug


def clean_name(title: str) -> str:
    name = html.unescape(title or "").strip()
    name = re.sub(r"\s*\|\s*Minecraft PE.*$", "", name, flags=re.I)
    name = name.replace("&amp;", "and").replace("&", "and")
    name = re.sub(r"\s+", " ", name)
    name = re.sub(r"[!?.]+$", "", name).strip()
    return name or "Untitled Addon"


def folder_name(name: str) -> str:
    cleaned = clean_name(name)
    cleaned = re.sub(r'[<>:"/\\|?*]', "", cleaned)
    return cleaned.strip(" .") or "Untitled Addon"


def slugify(name: str, fallback: str) -> str:
    text = clean_name(name).lower()
    text = text.replace("&", "and")
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    if text:
        return text
    fallback = re.sub(r"[^a-z0-9]+", "-", fallback.lower()).strip("-")
    return fallback or "addon"


def html_to_text(value: str) -> str:
    text = html.unescape(value or "")
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def is_pack_file(name: str) -> bool:
    return name.lower().endswith(PACK_EXTENSIONS)


def extract_version(filename: str) -> str | None:
    match = re.search(r"\(v(\d+(?:\.\d+){1,3})\)", filename, re.I)
    if match:
        return match.group(1)
    match = re.search(r"(?:^|[_\-\s])v(\d+(?:\.\d+){1,3})(?:[_\-\s.]|$)", filename, re.I)
    if match:
        return match.group(1)
    match = VERSION_IN_NAME.search(filename)
    if match:
        return match.group(1) or match.group(2)
    return None


def classify_pack(filename: str) -> str:
    stem = Path(filename).stem
    is_behavior = bool(BEHAVIOR_RE.search(stem))
    is_resource = bool(RESOURCE_RE.search(stem))
    if is_behavior and not is_resource:
        return "behavior"
    if is_resource and not is_behavior:
        return "resource"
    lower = filename.lower()
    if lower.endswith(COMBINED_EXTENSIONS):
        return "combined"
    if is_behavior:
        return "behavior"
    if is_resource:
        return "resource"
    return "other"


def catalog_mod(raw: dict) -> dict:
    catalog_type = raw.get("type") if raw.get("type") in ALLOWED_TYPES else "addon"
    categories = [item for item in raw.get("categories") or [] if item in CATALOG_CATEGORIES]
    class_category = CLASS_CATEGORY[catalog_type]
    if class_category not in categories:
        categories.insert(0, class_category)

    filename = str(raw.get("file") or "")
    if filename and not is_pack_file(filename):
        filename = ""

    thumbnail = str(raw.get("thumbnail") or "")
    if thumbnail.lower() not in PREFERRED_THUMBNAILS:
        thumbnail = ""

    slug = slugify(str(raw.get("slug") or raw.get("name") or ""), "addon")
    mod = {
        "name": str(raw.get("name") or "").strip() or "Untitled Addon",
        "slug": slug,
        "type": catalog_type,
        "version": str(raw.get("version") or "").strip(),
        "description": str(raw.get("description") or "").strip(),
        "author": str(raw.get("author") or "").strip(),
        "categories": categories,
        "file": filename,
    }
    if thumbnail:
        mod["thumbnail"] = thumbnail
    website = str(raw.get("websiteUrl") or "").strip()
    if website:
        mod["websiteUrl"] = website
    downloads = raw.get("downloads")
    if isinstance(downloads, int) and downloads > 0:
        mod["downloads"] = downloads
    updated = str(raw.get("updated") or "").strip()
    if updated:
        mod["updated"] = updated
    return {key: value for key, value in mod.items() if value or key in {"name", "slug", "type", "categories"}}


def guess_categories(catalog_type: str, page_categories: list[str], text: str) -> list[str]:
    guessed: list[str] = []

    def add(category: str) -> None:
        if category in CATALOG_CATEGORIES and category not in guessed:
            guessed.append(category)

    add(CLASS_CATEGORY.get(catalog_type, "addons"))
    for raw in page_categories:
        mapped = MCPEDL_CATEGORY_MAP.get(str(raw).strip().lower())
        if mapped:
            add(mapped)
    for pattern, category in KEYWORD_CATEGORIES:
        if pattern.search(text):
            add(category)
    if catalog_type in {"addon", "texture_pack"} and not any(item in THEME_CATEGORIES for item in guessed):
        add("utility")
    return guessed


def infer_type(page: str, tag_hrefs: list[str]) -> str:
    title = meta_content(page, "og:title") or ""
    heading = ""
    match = re.search(r"<title>([^<]+)</title>", page, re.I)
    if match:
        heading = html.unescape(match.group(1))
    blob = f"{title} {heading}"
    for pattern, catalog_type in TITLE_TYPE_HINTS:
        if pattern.search(blob):
            return catalog_type
    joined = " ".join(tag_hrefs).lower()
    if re.search(r"(^|/)maps(/|$)", joined):
        return "world"
    if re.search(r"texture-packs|resource-packs", joined):
        return "texture_pack"
    if re.search(r"(^|/)skins(/|$)", joined):
        return "skin"
    return "addon"


def normalize_updated(value: str) -> str:
    text = str(value or "").strip()
    if re.match(r"\d{4}-\d{2}-\d{2}", text):
        return text[:10]
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y/%m/%d", "%d %b %Y"):
        try:
            from datetime import datetime

            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def looks_like_pack(data: bytes) -> bool:
    if len(data) < 64:
        return False
    start = data[:16].lstrip()
    if start.startswith((b"<", b"{", b"<!")):
        return False
    return data.startswith(b"PK")


def convert_to_png(source: Path, dest: Path) -> bool:
    try:
        from PIL import Image
    except ImportError:
        return False
    try:
        with Image.open(source) as image:
            image.convert("RGBA").save(dest, format="PNG")
        return dest.is_file()
    except Exception:
        return False


def download_image(urls: list[str], dest_dir: Path) -> str | None:
    last_error: Exception | None = None
    for url in urls:
        try:
            data = http_get(url)
        except (urllib.error.URLError, urllib.error.HTTPError) as exc:
            last_error = exc
            continue
        if len(data) < 32:
            continue
        suffix = Path(urllib.parse.urlparse(url).path).suffix.lower() or ".bin"
        if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            if data.startswith(b"\x89PNG"):
                suffix = ".png"
            elif data[:2] == b"\xff\xd8":
                suffix = ".jpg"
            elif data.startswith(b"RIFF") and b"WEBP" in data[:16]:
                suffix = ".webp"
            else:
                suffix = ".png"
        raw_path = dest_dir / f"thumbnail{suffix}"
        raw_path.write_bytes(data)
        png_path = dest_dir / "thumbnail.png"
        if suffix == ".png":
            return png_path.name
        if convert_to_png(raw_path, png_path):
            if raw_path != png_path:
                raw_path.unlink(missing_ok=True)
            return png_path.name
        return raw_path.name
    if last_error:
        print(f"Warning: could not download thumbnail ({last_error})", file=sys.stderr)
    return None


def current_pack_paths(dest_dir: Path) -> list[Path]:
    if not dest_dir.is_dir():
        return []
    paths: list[Path] = []
    for path in dest_dir.iterdir():
        if not path.is_file() or path.name.lower().endswith(".old"):
            continue
        if is_pack_file(path.name):
            paths.append(path)
    return paths


def archive_existing_pack(path: Path) -> Path:
    archived = path.with_name(path.name + ".old")
    if archived.exists():
        archived.unlink()
    path.rename(archived)
    print(f"Renamed {path.name} -> {archived.name}")
    return archived


def decode_cdn_filename(raw: str) -> str:
    text = raw.replace("\\u002F", "/").replace("\\/", "/")
    text = urllib.parse.unquote(text)
    return Path(text).name


def parse_cdn_files(page: str) -> list[dict]:
    files: list[dict] = []
    seen: set[str] = set()
    normalized = page.replace("\\u002F", "/").replace("\\/", "/")
    for match in CDN_RE.finditer(normalized):
        folder, rest, raw_name = match.groups()
        filename = decode_cdn_filename(raw_name)
        if not is_pack_file(filename):
            continue
        file_id = int(folder) * 1000 + int(rest)
        url = f"https://edge.mcpedl.com/files/{folder}/{rest}/{urllib.parse.quote(filename)}"
        key = url.lower()
        if key in seen:
            continue
        seen.add(key)
        files.append(
            {
                "id": file_id,
                "name": filename,
                "url": url,
                "role": classify_pack(filename),
                "version": extract_version(filename) or "",
            }
        )
    return files


def newest_group(files: list[dict]) -> list[dict]:
    if not files:
        return []
    newest = max(files, key=lambda item: int(item.get("id") or 0))
    version = str(newest.get("version") or "")
    if version:
        grouped = [item for item in files if str(item.get("version") or "") == version]
        if grouped:
            return grouped
    newest_id = int(newest.get("id") or 0)
    return [item for item in files if abs(int(item.get("id") or 0) - newest_id) <= 20] or [newest]


def choose_files(files: list[dict]) -> tuple[list[dict], str]:
    if not files:
        return [], "MCPEDL listed no pack files on this page."

    combined = [item for item in files if item.get("role") == "combined"]
    if combined:
        group = newest_group(combined)
        chosen = [max(group, key=lambda item: int(item.get("id") or 0))]
        version = chosen[0].get("version") or "latest"
        return chosen, f"Latest combined pack ({version}): {chosen[0]['name']}"

    group = newest_group(files)
    behaviors = [item for item in group if item.get("role") == "behavior"]
    resources = [item for item in group if item.get("role") == "resource"]
    version = next((str(item.get("version") or "") for item in group if item.get("version")), "latest")
    if behaviors and resources:
        chosen = [
            max(behaviors, key=lambda item: int(item.get("id") or 0)),
            max(resources, key=lambda item: int(item.get("id") or 0)),
        ]
        names = " + ".join(item["name"] for item in chosen)
        return chosen, f"Latest BP/RP pair ({version}): {names}"
    if behaviors:
        chosen = [max(behaviors, key=lambda item: int(item.get("id") or 0))]
        return chosen, f"Latest behavior pack only ({version}): {chosen[0]['name']}"
    if resources:
        chosen = [max(resources, key=lambda item: int(item.get("id") or 0))]
        return chosen, f"Latest resource pack only ({version}): {chosen[0]['name']}"
    chosen = [max(group, key=lambda item: int(item.get("id") or 0))]
    return chosen, f"Latest pack ({version}): {chosen[0]['name']}"


def scrape_mcpedl_page(url: str) -> dict:
    page = http_get(url.split("?")[0]).decode("utf-8", errors="replace")
    if re.search(r"just a moment|attention required|cf-challenge|cdn-cgi/challenge", page[:4000], re.I):
        raise ValueError("MCPEDL temporarily blocked this request. Wait a minute and try again.")
    title = meta_content(page, "og:title") or meta_content(page, "twitter:title")
    summary = ""
    short = re.search(r'short_description:"((?:\\.|[^"\\])*)"', page)
    if short:
        summary = html_to_text(unescape_js_string(short.group(1)))
    if not summary:
        summary = html_to_text(
            meta_content(page, "og:description") or meta_content(page, "twitter:description")
        )
    thumbnail = meta_content(page, "og:image") or meta_content(page, "twitter:image")
    author = ""
    author_match = re.search(r'By\s+<a href="/user/[^"]*">([^<]+)</a>', page, re.I)
    if author_match:
        author = html_to_text(author_match.group(1))

    tag_hrefs = re.findall(r'class="fancybox__tag__sub"><a href="([^"]+)"', page, re.I)
    tag_names = re.findall(r'class="fancybox__tag__sub"><a href="[^"]+">([^<]+)</a>', page, re.I)
    tag_names = [html.unescape(name).strip() for name in tag_names]
    catalog_type = infer_type(page, tag_hrefs)
    files = parse_cdn_files(page)
    chosen, reason = choose_files(files)
    downloads = 0
    count_match = re.search(r"download_count:(\d+)", page)
    if count_match:
        downloads = int(count_match.group(1))
    updated = ""
    date_match = re.search(r'update_date:"([^"]+)"', page)
    if date_match:
        updated = normalize_updated(date_match.group(1))
    version = ""
    for item in chosen:
        version = str(item.get("version") or version)
    return {
        "title": title,
        "summary": summary,
        "thumbnail": thumbnail,
        "author": author,
        "type": catalog_type,
        "categories": tag_names,
        "files": files,
        "chosen": chosen,
        "reason": reason,
        "downloads": downloads,
        "updated": updated,
        "version": version,
        "website": url.split("?")[0],
    }


def download_pack(url: str, dest: Path) -> Path | None:
    try:
        data = http_get(url, timeout=120)
    except (urllib.error.URLError, urllib.error.HTTPError) as exc:
        print(f"Warning: pack download failed ({exc})", file=sys.stderr)
        return None
    if not looks_like_pack(data):
        print(f"Warning: {url} did not look like a pack archive", file=sys.stderr)
        return None
    dest.write_bytes(data)
    return dest


def combine_packs(pack_paths: list[Path], dest: Path) -> Path:
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in pack_paths:
            archive.write(path, arcname=path.name)
    for path in pack_paths:
        if path != dest and path.exists():
            path.unlink()
    return dest


def write_mod_folder(mod: dict, thumbnail_urls: list[str], output_root: Path) -> Path:
    type_folder = FOLDER_BY_TYPE.get(mod["type"], "addons")
    dest = output_root / type_folder / folder_name(mod["name"])
    dest.mkdir(parents=True, exist_ok=True)
    image_name = download_image(thumbnail_urls, dest)
    if image_name:
        mod["thumbnail"] = image_name
    mod = catalog_mod(mod)
    (dest / "mod.json").write_text(json.dumps(mod, indent=2) + "\n", encoding="utf-8")
    return dest


def fetch_project(url: str, repo_root: Path, download: bool = True, keep_split: bool = False) -> Path:
    slug = parse_mcpedl_url(url)
    data = scrape_mcpedl_page(url)
    if not data.get("title"):
        raise ValueError(f"Could not read MCPEDL project data from {url}")
    chosen = list(data.get("chosen") or [])
    print(f"Found {len(data.get('files') or [])} pack file(s) on MCPEDL")
    print(data.get("reason") or "No download selected.")
    catalog_type = data.get("type") if data.get("type") in ALLOWED_TYPES else "addon"
    categories = guess_categories(
        catalog_type,
        list(data.get("categories") or []),
        f"{data.get('title')} {data.get('summary')}",
    )
    filename = str(chosen[0]["name"]) if len(chosen) == 1 else ""
    if len(chosen) > 1 and not keep_split:
        version = str(data.get("version") or "")
        suffix = f" v{version}" if version else ""
        filename = f"{folder_name(clean_name(str(data.get('title') or slug)))}{suffix}.mcaddon"
    elif len(chosen) > 1:
        filename = str(chosen[0]["name"])
    mod = catalog_mod(
        {
            "name": clean_name(str(data.get("title") or slug)),
            "slug": slugify(str(data.get("title") or slug), slug),
            "type": catalog_type,
            "version": str(data.get("version") or ""),
            "description": str(data.get("summary") or ""),
            "author": str(data.get("author") or ""),
            "categories": categories,
            "file": filename,
            "websiteUrl": data.get("website") or url.split("?")[0],
            "downloads": int(data.get("downloads") or 0),
            "updated": str(data.get("updated") or ""),
        }
    )
    dest = repo_root / FOLDER_BY_TYPE.get(mod["type"], "addons") / folder_name(mod["name"])
    existing_packs = current_pack_paths(dest)
    dest = write_mod_folder(mod, [str(data.get("thumbnail") or "")], repo_root)
    if not download:
        return dest
    archived = [archive_existing_pack(path) for path in existing_packs if path.is_file()]
    downloaded: list[Path] = []
    for item in chosen:
        target = dest / str(item["name"])
        pack = download_pack(str(item["url"]), target)
        if pack:
            print(f"Downloaded {pack.name} ({pack.stat().st_size:,} bytes)")
            downloaded.append(pack)
    catalog_file = filename
    if len(downloaded) >= 2 and not keep_split:
        combined = dest / filename
        combine_packs(downloaded, combined)
        print(f"Combined {len(downloaded)} packs into {combined.name}")
        catalog_file = combined.name
    elif downloaded:
        catalog_file = downloaded[0].name
    else:
        if archived:
            for old in archived:
                restored = dest / old.name.removesuffix(".old")
                if not restored.exists():
                    old.rename(restored)
                    print(f"Restored {restored.name} after download failed")
        print("Warning: could not download the pack file; metadata was still saved.", file=sys.stderr)
        return dest
    if catalog_file != mod.get("file"):
        mod["file"] = catalog_file
        (dest / "mod.json").write_text(json.dumps(catalog_mod(mod), indent=2) + "\n", encoding="utf-8")
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Scrape an MCPEDL project into a catalog folder with mod.json, thumbnail, and pack file."
    )
    parser.add_argument("urls", nargs="+", help="MCPEDL project URL(s)")
    parser.add_argument(
        "--root",
        default=str(Path(__file__).resolve().parents[1]),
        help="Catalog repository root (default: parent of scripts/)",
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Save metadata and thumbnail only; do not download the pack file.",
    )
    parser.add_argument(
        "--keep-split",
        action="store_true",
        help="When a page has separate BP and RP files, keep both instead of wrapping them in an .mcaddon.",
    )
    args = parser.parse_args()
    repo_root = Path(args.root).resolve()
    for url in args.urls:
        dest = fetch_project(
            url,
            repo_root,
            download=not args.skip_download,
            keep_split=args.keep_split,
        )
        mod = json.loads((dest / "mod.json").read_text(encoding="utf-8"))
        print(f"Wrote {dest}")
        print(json.dumps(mod, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
