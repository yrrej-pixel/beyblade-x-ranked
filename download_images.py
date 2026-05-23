#!/usr/bin/env python3
"""
Download Creative Commons / public-domain Beyblade X training images.

Creates folders: Normal, Burst, Over_Finish
Sources: Openverse API + Wikimedia Commons API (no API keys required)
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import certifi
import requests
import truststore

truststore.inject_into_ssl()

IMAGES_PER_CATEGORY = 30
REQUEST_TIMEOUT = 30
DOWNLOAD_DELAY_SEC = 1.5
WIKIMEDIA_DELAY_SEC = 2.0
USER_AGENT = "BeybladeX-AI-Dataset/1.0 (educational; local script)"

# CC0, Public Domain Mark, CC BY, CC BY-SA
LICENSE_FILTER = "cc0,pdm,by,by-sa"

OPENVERSE_URL = "https://api.openverse.org/v1/images/"
WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php"

CATEGORIES: dict[str, list[str]] = {
    "Normal": [
        "beyblade",
        "beyblade x",
        "beyblade stadium",
        "beyblade battle",
        "beyblade spinning",
        "spinning top toy",
    ],
    "Burst": [
        "beyblade burst",
        "beyblade broken",
        "beyblade parts",
        "beyblade disassembled",
        "spinning top broken",
    ],
    "Over_Finish": [
        "beyblade stadium",
        "beyblade arena",
        "spinning top stadium",
        "beyblade pocket",
        "beyblade finish",
    ],
}

FREE_LICENSE_HINTS = (
    "cc",
    "creative commons",
    "public domain",
    "pd",
    "gfdl",
    "free art",
    "mit",
    "apache",
)


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    session.verify = certifi.where()  # fallback; truststore handles Windows certs
    return session


def get_with_retry(
    session: requests.Session, url: str, *, params: dict | None = None, stream: bool = False
) -> requests.Response:
    for attempt in range(4):
        response = session.get(
            url, params=params, timeout=REQUEST_TIMEOUT, stream=stream
        )
        if response.status_code != 429:
            response.raise_for_status()
            return response
        wait = 5 * (attempt + 1)
        print(f"  Rate limited — waiting {wait}s...")
        time.sleep(wait)
    response.raise_for_status()
    return response


def strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "").strip()


def extension_from_url(url: str) -> str:
    path = urlparse(url).path.lower()
    for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        if path.endswith(ext):
            return ext.lstrip(".")
    return "jpg"


def is_free_license(license_name: str) -> bool:
    name = (license_name or "").lower()
    if not name:
        return True
    if "copyright" in name or "all rights" in name:
        return False
    return any(hint in name for hint in FREE_LICENSE_HINTS)


def search_openverse(
    session: requests.Session, query: str, page: int, page_size: int = 20
) -> list[dict]:
    params = {
        "q": query,
        "license": LICENSE_FILTER,
        "page": page,
        "page_size": page_size,
        "filter_dead": "true",
        "mature": "false",
    }
    response = get_with_retry(session, OPENVERSE_URL, params=params)
    return response.json().get("results", [])


def search_wikimedia(session: requests.Session, query: str) -> list[dict]:
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": f"filetype:bitmap {query}",
        "gsrlimit": 40,
        "gsrnamespace": 6,
        "prop": "imageinfo",
        "iiprop": "url|extmetadata|mime",
        "iiurlwidth": 1200,
    }
    response = get_with_retry(session, WIKIMEDIA_API, params=params)
    pages = response.json().get("query", {}).get("pages", {})

    results: list[dict] = []
    for page in pages.values():
        image_info = page.get("imageinfo")
        if not image_info:
            continue
        info = image_info[0]
        meta = info.get("extmetadata", {})
        license_name = strip_html(meta.get("LicenseShortName", {}).get("value", ""))
        if not is_free_license(license_name):
            continue
        url = info.get("thumburl") or info.get("url")
        if not url:
            continue
        results.append(
            {
                "url": url,
                "title": page.get("title", ""),
                "license": license_name,
                "creator": strip_html(meta.get("Artist", {}).get("value", "")),
                "source": "wikimedia",
                "landing_page": strip_html(
                    meta.get("LicenseUrl", {}).get("value", "")
                ),
            }
        )
    return results


def openverse_to_record(item: dict) -> dict:
    return {
        "url": item.get("url"),
        "title": item.get("title", ""),
        "license": item.get("license", ""),
        "creator": item.get("creator", ""),
        "source": item.get("source", "openverse"),
        "landing_page": item.get("foreign_landing_url", ""),
    }


def collect_candidates(
    session: requests.Session, queries: list[str], seen_urls: set[str]
) -> list[dict]:
    candidates: list[dict] = []

    for query in queries:
        for page in range(1, 8):
            try:
                batch = search_openverse(session, query, page=page)
            except requests.RequestException as exc:
                print(f"  Openverse '{query}' page {page}: {exc}")
                break
            if not batch:
                break
            for item in batch:
                url = item.get("url")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                candidates.append(openverse_to_record(item))
            time.sleep(0.5)

        try:
            for item in search_wikimedia(session, query):
                url = item.get("url")
                if not url or url in seen_urls:
                    continue
                seen_urls.add(url)
                candidates.append(item)
        except requests.RequestException as exc:
            print(f"  Wikimedia '{query}': {exc}")
        time.sleep(WIKIMEDIA_DELAY_SEC)

    return candidates


def download_image(session: requests.Session, url: str, dest: Path) -> bool:
    response = get_with_retry(session, url, stream=True)
    content_type = (response.headers.get("Content-Type") or "").lower()
    if content_type and "image" not in content_type and "octet-stream" not in content_type:
        return False

    with dest.open("wb") as handle:
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                handle.write(chunk)

    return dest.exists() and dest.stat().st_size > 1024


def save_attribution(folder: Path, records: list[dict]) -> None:
    path = folder / "attribution.json"
    with path.open("w", encoding="utf-8") as handle:
        json.dump(records, handle, indent=2, ensure_ascii=False)


def download_category(
    session: requests.Session,
    category: str,
    queries: list[str],
    base_dir: Path,
    target: int,
) -> int:
    folder = base_dir / category
    folder.mkdir(parents=True, exist_ok=True)

    existing = sorted(
        p for p in folder.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".gif", ".webp"}
    )
    already = len(existing)
    need = max(0, target - already)

    print(f"\n=== {category} (goal: {target}, already have {already}) ===")
    if need == 0:
        print("  Folder full — skipping.")
        return already

    seen_urls: set[str] = set()
    att_path = folder / "attribution.json"
    if att_path.exists():
        try:
            for row in json.loads(att_path.read_text(encoding="utf-8")):
                if row.get("url"):
                    seen_urls.add(row["url"])
        except json.JSONDecodeError:
            pass

    candidates = collect_candidates(session, queries, seen_urls)
    print(f"  {len(candidates)} new URLs found; downloading up to {need}...")

    saved: list[dict] = []
    if att_path.exists():
        try:
            saved = json.loads(att_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            saved = []
    file_index = already + 1

    for meta in candidates:
        if len(saved) >= target:
            break
        url = meta["url"]
        ext = extension_from_url(url)
        filename = f"{category.lower()}_{file_index:03d}.{ext}"
        dest = folder / filename

        try:
            if download_image(session, url, dest):
                record = {**meta, "filename": filename}
                saved.append(record)
                print(f"  [{len(saved)}/{target}] {filename}  (+{len(saved) - already} this run)")
                file_index += 1
                time.sleep(DOWNLOAD_DELAY_SEC)
            else:
                dest.unlink(missing_ok=True)
        except requests.RequestException as exc:
            dest.unlink(missing_ok=True)
            title = (meta.get("title") or url)[:70]
            print(f"  skipped: {title} ({exc})")

    save_attribution(folder, saved)

    new_count = len(saved) - already
    if len(saved) < target:
        print(
            f"  Note: {len(saved)}/{target} total ({new_count} new). "
            "Wait 10 minutes and run again, or add your own photos to this folder."
        )
    return new_count


def main() -> None:
    base_dir = Path(__file__).resolve().parent
    print("Beyblade X image downloader")
    print(f"Output folder: {base_dir}\n")

    session = make_session()
    total = 0

    for category, queries in CATEGORIES.items():
        total += download_category(
            session, category, queries, base_dir, IMAGES_PER_CATEGORY
        )

    print(f"\nFinished. {total} images saved.")
    print("Each folder contains attribution.json with license details.")


if __name__ == "__main__":
    main()
