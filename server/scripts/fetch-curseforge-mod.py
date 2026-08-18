#!/usr/bin/env python3
"""Create a catalog folder (mod.json + thumbnail) from a CurseForge project URL.

Example:
    python scripts/fetch-curseforge-mod.py https://www.curseforge.com/minecraft-bedrock/addons/pickup-carry-cf
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
ALLOWED_TYPES = ("addon", "texture_pack", "world", "skin")
CATALOG_TYPES = {
    "addons": "addon",
    "addon": "addon",
    "texture-packs": "texture_pack",
    "texturepacks": "texture_pack",
    "resource-packs": "texture_pack",
    "maps": "world",
    "worlds": "world",
    "world": "world",
    "skins": "skin",
    "scripts": "addon",
}
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
# Exact IDs from the manager category dropdown. Anything else pollutes the filter list.
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
# CurseForge labels mapped only when they match a catalog dropdown ID.
CF_CATEGORY_MAP = {
    "addons": "addons",
    "addon": "addons",
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
VERSION_IN_NAME = re.compile(
    r"(?:^|[^\d])v(\d+(?:\.\d+){1,3})(?:[^\d]|$)|(?:\(|\s)v?(\d+(?:\.\d+){1,3})(?=\))",
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
    if "curseforge.com" in host or "forgecdn.net" in host:
        headers["Referer"] = "https://www.curseforge.com/"
        headers["Sec-Fetch-Site"] = "same-origin" if "curseforge.com" in host else "cross-site"
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
                "Referer: https://www.curseforge.com/",
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


def http_get_json(url: str) -> dict:
    raw = http_get(url)
    return json.loads(raw.decode("utf-8"))


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


def parse_compact_count(text: str) -> int:
    match = re.search(r"([\d,.]+)\s*([KMB])?\s*Downloads", text, re.I)
    if not match:
        return 0
    number = float(match.group(1).replace(",", ""))
    suffix = (match.group(2) or "").upper()
    multiplier = {"": 1, "K": 1_000, "M": 1_000_000, "B": 1_000_000_000}[suffix]
    return int(number * multiplier)


def clean_summary(text: str) -> str:
    summary = html_to_text(text)
    summary = re.sub(r"\s*[\d,.]+[KMB]?\s*Downloads\s*\|.*$", "", summary, flags=re.I)
    return summary.strip()


def parse_curseforge_url(url: str) -> tuple[str, str, str]:
    parsed = urllib.parse.urlparse(url.strip())
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 3:
        raise ValueError(f"Not a CurseForge project URL: {url}")
    game, class_slug, project_slug = parts[0], parts[1], parts[2]
    return game, class_slug, project_slug


def clean_name(title: str) -> str:
    name = html.unescape(title or "").strip()
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


def infer_type(class_slug: str, cf_type: str | None) -> str:
    for key in (class_slug, (cf_type or "").lower().replace(" ", "-")):
        if key in CATALOG_TYPES:
            catalog_type = CATALOG_TYPES[key]
            if catalog_type in ALLOWED_TYPES:
                return catalog_type
    return "addon"


def guess_categories(class_slug: str, catalog_type: str, cf_categories: list[str], text: str) -> list[str]:
    guessed: list[str] = []

    def add(category: str) -> None:
        if category in CATALOG_CATEGORIES and category not in guessed:
            guessed.append(category)

    add(CLASS_CATEGORY.get(catalog_type, "addons"))

    for raw in cf_categories:
        mapped = CF_CATEGORY_MAP.get(str(raw).strip().lower())
        if mapped:
            add(mapped)

    blob = f"{class_slug} {text}"
    for pattern, category in KEYWORD_CATEGORIES:
        if pattern.search(blob):
            add(category)

    if catalog_type in {"addon", "texture_pack"} and not any(item in THEME_CATEGORIES for item in guessed):
        add("utility")
    return guessed


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


def normalize_updated(value: str) -> str:
    text = str(value or "").strip()
    if re.match(r"\d{4}-\d{2}-\d{2}", text):
        return text[:10]
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%Y/%m/%d"):
        try:
            from datetime import datetime

            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


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


def is_pack_file(name: str) -> bool:
    return name.lower().endswith(PACK_EXTENSIONS)


def choose_file(files: list[dict]) -> dict | None:
    packs = [item for item in files if is_pack_file(str(item.get("name") or item.get("display") or ""))]
    if not packs:
        return None

    def sort_key(item: dict) -> tuple:
        name = str(item.get("name") or "")
        lower = name.lower()
        uploaded = str(item.get("uploaded_at") or "")
        downloads = int(item.get("downloads") or 0)
        ext_rank = 0 if lower.endswith(".mcaddon") else 1
        role_rank = 0
        if re.search(r"\[rp\]|_rp\b|\brp\b", lower) and not lower.endswith(".mcaddon"):
            role_rank = 1
        if re.search(r"\[bp\]|_bp\b|\bbp\b", lower):
            role_rank = 2
        return (uploaded, downloads, -ext_rank, -role_rank)

    latest_upload = max(str(item.get("uploaded_at") or "") for item in packs)
    latest_group = [
        item
        for item in packs
        if str(item.get("uploaded_at") or "")[:10] == latest_upload[:10]
    ] or packs
    return sorted(latest_group, key=sort_key, reverse=True)[0]


def upgrade_image_url(url: str) -> list[str]:
    if not url:
        return []
    urls = [url]
    full = re.sub(r"/avatars/thumbnails/(\d+)/(\d+)/\d+/\d+/", r"/avatars/\1/\2/", url)
    if full != url:
        urls.insert(0, full)
        png = re.sub(r"\.(webp|jpg|jpeg)$", ".png", full, flags=re.I)
        if png != full:
            urls.insert(0, png)
    return list(dict.fromkeys(urls))


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


def looks_like_pack(data: bytes) -> bool:
    if len(data) < 64:
        return False
    start = data[:16].lstrip()
    if start.startswith((b"<", b"{", b"<!")):
        return False
    return data.startswith(b"PK")


def current_pack_paths(dest_dir: Path, new_filename: str = "") -> list[Path]:
    names: list[str] = []
    mod_json = dest_dir / "mod.json"
    if mod_json.is_file():
        try:
            existing = json.loads(mod_json.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}
        listed = str(existing.get("file") or "")
        if listed:
            names.append(listed)
    if new_filename:
        names.append(new_filename)
    paths: list[Path] = []
    seen: set[str] = set()
    for name in names:
        path = dest_dir / name
        key = str(path).lower()
        if key in seen or not path.is_file():
            continue
        if path.name.lower().endswith(".old") or not is_pack_file(path.name):
            continue
        seen.add(key)
        paths.append(path)
    return paths


def archive_existing_pack(path: Path) -> Path:
    archived = path.with_name(path.name + ".old")
    if archived.exists():
        archived.unlink()
    path.rename(archived)
    print(f"Renamed {path.name} -> {archived.name}")
    return archived


def forgecdn_urls(file_id: int, filename: str) -> list[str]:
    folder, rest = divmod(int(file_id), 1000)
    encoded = urllib.parse.quote(filename)
    urls = []
    for name in dict.fromkeys([encoded, filename]):
        urls.append(f"https://mediafilez.forgecdn.net/files/{folder}/{rest}/{name}")
        urls.append(f"https://edge.forgecdn.net/files/{folder}/{rest}/{name}")
    return urls


def extract_cdn_url(page: str) -> str:
    match = re.search(
        r"https://(?:mediafilez?|edge)\.forgecdn\.net/files/\d+/\d+/[^\"'\s<>]+",
        page,
        re.I,
    )
    if not match:
        match = re.search(r'"downloadUrl":"([^"]+)"', page)
        if match and match.group(1):
            return match.group(1).replace("\\u002F", "/")
        return ""
    return html.unescape(match.group(0))


def download_pack(
    dest_dir: Path,
    filename: str,
    file_id: int | None = None,
    extra_urls: list[str] | None = None,
    project_url: str = "",
) -> Path | None:
    if not filename or not is_pack_file(filename):
        return None
    target = dest_dir / filename
    urls: list[str] = []
    needle = filename.lower()
    for url in extra_urls or []:
        if needle in urllib.parse.unquote(url).lower():
            urls.append(html.unescape(url))
    if file_id:
        urls.extend(forgecdn_urls(file_id, filename))
        if project_url:
            parsed = urllib.parse.urlparse(project_url)
            base = f"{parsed.scheme}://{parsed.netloc}{parsed.path.rstrip('/')}"
            urls.append(f"{base}/download/{file_id}")
    if not urls:
        urls.extend(extra_urls or [])

    seen: set[str] = set()
    last_error: Exception | None = None
    for url in urls:
        if not url or url in seen:
            continue
        seen.add(url)
        try:
            data = http_get(url)
        except (urllib.error.URLError, urllib.error.HTTPError) as exc:
            last_error = exc
            continue
        if not looks_like_pack(data):
            page = data.decode("utf-8", errors="replace")
            cdn = extract_cdn_url(page)
            if cdn and cdn not in seen:
                urls.append(cdn)
            continue
        target.write_bytes(data)
        return target
    if last_error:
        print(f"Warning: pack download failed ({last_error})", file=sys.stderr)
    return None


def fetch_cfwidget(game: str, class_slug: str, project_slug: str) -> dict | None:
    url = f"https://api.cfwidget.com/{game}/{class_slug}/{project_slug}"
    try:
        data = json.loads(_http_get_urllib(url, timeout=20).decode("utf-8"))
    except Exception:
        return None
    if not isinstance(data, dict) or not data.get("title"):
        return None
    return data


def scrape_file_name(file_url: str) -> str:
    try:
        page = http_get(file_url).decode("utf-8", errors="replace")
    except (urllib.error.HTTPError, urllib.error.URLError):
        return ""
    match = re.search(
        r'class="file-meta-filename-value"[^>]*title="([^"]+)"',
        page,
        re.I,
    )
    if match and is_pack_file(match.group(1)):
        return html.unescape(match.group(1)).strip()
    match = re.search(
        r'class="file-meta-filename-value"[^>]*>([^<]+)',
        page,
        re.I,
    )
    if match and is_pack_file(match.group(1).strip()):
        return html.unescape(match.group(1)).strip()
    return ""


def scrape_curseforge_page(url: str, class_slug: str) -> dict:
    page = http_get(url.split("?")[0]).decode("utf-8", errors="replace")
    if re.search(r"just a moment|attention required|cf-challenge|cdn-cgi/challenge", page[:4000], re.I):
        raise ValueError("CurseForge temporarily blocked this request. Wait a minute and try again.")
    title = meta_content(page, "og:title") or meta_content(page, "twitter:title")
    summary = clean_summary(meta_content(page, "og:description") or meta_content(page, "twitter:description"))
    thumbnail = meta_content(page, "og:image") or meta_content(page, "twitter:image")
    author = ""
    owner = re.search(
        r'class="author-name">\s*<a[^>]+href="/members/([^"]+)"[^>]*>([^<]+)</a>.*?Owner',
        page,
        re.I | re.S,
    )
    if owner:
        author = html.unescape(owner.group(2)).strip() or owner.group(1)
    else:
        member = re.search(r'href="/members/([^"]+)"[^>]*>([^<]+)</a>', page, re.I)
        if member:
            author = html.unescape(member.group(2)).strip() or member.group(1)

    file_path = ""
    file_id = None
    latest = re.search(
        r'class="file-card" href="(/minecraft-bedrock/[^"]+/files/(\d+))"',
        page,
        re.I,
    )
    if latest and "/files/all" not in latest.group(1):
        parsed = urllib.parse.urlparse(url)
        file_id = int(latest.group(2))
        file_path = scrape_file_name(f"{parsed.scheme}://{parsed.netloc}{latest.group(1)}")

    if not file_path:
        pack_names = re.findall(
            r'([^\"\'/\\>]+\.(?:mcaddon|mcpack|mcworld|mctemplate|zip))',
            page,
            re.I,
        )
        if pack_names:
            file_path = html.unescape(pack_names[0]).strip()

    display = ""
    card = re.search(r'class="file-card"[^>]*>.*?class="name"[^>]*title="([^"]+)"', page, re.I | re.S)
    if card:
        display = html.unescape(card.group(1)).strip()
    date_match = re.search(r'class="file-card"[^>]*>.*?<time><span>([^<]+)</span></time>', page, re.I | re.S)
    uploaded_at = ""
    if date_match:
        uploaded_at = html.unescape(date_match.group(1)).strip()

    files = []
    if file_path:
        files.append(
            {
                "id": file_id,
                "name": file_path,
                "display": display or file_path,
                "uploaded_at": uploaded_at,
                "downloads": 0,
            }
        )

    page_categories = re.findall(r'class="[^"]*categories[^"]*"[^>]*>([^<]+)', page, re.I)
    return {
        "title": title,
        "summary": summary,
        "description": summary,
        "thumbnail": thumbnail,
        "type": class_slug.replace("-", " ").title(),
        "urls": {"curseforge": url.split("?")[0]},
        "members": [{"title": "Owner", "username": author}] if author else [],
        "categories": page_categories,
        "files": files,
        "download": files[0] if files else {},
        "downloads": {"total": parse_compact_count(page)},
        "cdn_urls": re.findall(
            r"https://(?:mediafilez?|edge)\.forgecdn\.net/files/\d+/\d+/[^\"'\s<>]+",
            page,
            re.I,
        ),
    }


def fetch_project_data(url: str, game: str, class_slug: str, project_slug: str) -> dict:
    data = fetch_cfwidget(game, class_slug, project_slug)
    if data:
        return data
    return scrape_curseforge_page(url, class_slug)


def build_mod_json(url: str, data: dict, game: str, class_slug: str, project_slug: str) -> dict:
    name = clean_name(str(data.get("title") or project_slug))
    summary = html_to_text(str(data.get("summary") or ""))
    description = summary or html_to_text(str(data.get("description") or ""))
    members = data.get("members") or []
    author = ""
    if members:
        owner = next((item for item in members if str(item.get("title")).lower() == "owner"), members[0])
        author = str(owner.get("username") or "")
    files = data.get("files") or []
    chosen = choose_file(files) or data.get("download")
    filename = ""
    version = ""
    if chosen:
        filename = str(chosen.get("name") or chosen.get("display") or "")
        version = extract_version(filename) or ""
    catalog_type = infer_type(class_slug, str(data.get("type") or ""))
    long_description = html_to_text(str(data.get("description") or ""))
    categories = guess_categories(
        class_slug,
        catalog_type,
        [str(item) for item in (data.get("categories") or [])],
        f"{name} {description}",
    )
    if re.search(r"\b(multiplayer|realms?|\bbds\b|bedrock dedicated)\b", long_description, re.I):
        if "multiplayer" not in categories:
            categories.append("multiplayer")
    downloads = 0
    download_stats = data.get("downloads")
    if isinstance(download_stats, dict):
        downloads = int(download_stats.get("total") or 0)
    elif isinstance(download_stats, int):
        downloads = download_stats
    updated = ""
    if chosen and chosen.get("uploaded_at"):
        updated = normalize_updated(str(chosen["uploaded_at"]))
    return catalog_mod(
        {
            "name": name,
            "slug": slugify(name, project_slug),
            "type": catalog_type,
            "version": version,
            "description": description,
            "author": author,
            "categories": categories,
            "file": filename,
            "websiteUrl": data.get("urls", {}).get("curseforge") or url.split("?")[0],
            "downloads": downloads,
            "updated": updated,
        }
    )


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


def fetch_project(url: str, repo_root: Path, download: bool = True) -> Path:
    game, class_slug, project_slug = parse_curseforge_url(url)
    data = fetch_project_data(url, game, class_slug, project_slug)
    if not data.get("title"):
        raise ValueError(f"Could not read CurseForge project data from {url}")
    mod = build_mod_json(url, data, game, class_slug, project_slug)
    thumbnail_urls = upgrade_image_url(str(data.get("thumbnail") or ""))
    type_folder = FOLDER_BY_TYPE.get(mod["type"], "addons")
    dest = repo_root / type_folder / folder_name(mod["name"])
    chosen = choose_file(data.get("files") or []) or data.get("download") or {}
    filename = str(mod.get("file") or chosen.get("name") or "")
    existing_packs = current_pack_paths(dest, filename) if dest.is_dir() else []
    dest = write_mod_folder(mod, thumbnail_urls, repo_root)
    if download:
        file_id = chosen.get("id")
        try:
            file_id = int(file_id) if file_id is not None else None
        except (TypeError, ValueError):
            file_id = None
        archived = [archive_existing_pack(path) for path in existing_packs if path.is_file()]
        pack = download_pack(
            dest,
            filename,
            file_id=file_id,
            extra_urls=list(data.get("cdn_urls") or []),
            project_url=url,
        )
        if pack:
            print(f"Downloaded {pack.name} ({pack.stat().st_size:,} bytes)")
        else:
            if archived:
                for old in archived:
                    restored = dest / old.name.removesuffix(".old")
                    if not restored.exists():
                        old.rename(restored)
                        print(f"Restored {restored.name} after download failed")
            print("Warning: could not download the pack file; metadata was still saved.", file=sys.stderr)
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Scrape a CurseForge project into a catalog folder with mod.json, thumbnail, and pack file."
    )
    parser.add_argument("urls", nargs="+", help="CurseForge project URL(s)")
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
    args = parser.parse_args()
    repo_root = Path(args.root).resolve()
    for url in args.urls:
        dest = fetch_project(url, repo_root, download=not args.skip_download)
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
