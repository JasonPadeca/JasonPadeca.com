#!/usr/bin/env python3
"""
Bake administrator edits into the public HTML files.

Run by .github/workflows/coop-publish-site.yml on a schedule. Fetches whatever
has been changed in site_content, rewrites the matching blocks in the real
files, and commits only if something actually differs.

Why bake rather than fetch at page load: a visitor then gets a plain static page
with the current wording already in it. No request to Supabase, no dependency on
it being awake, and no moment where the old text is on screen before the new
text replaces it. The trade is that an edit takes a few minutes to appear, which
the admin screen says out loud.

Reads with the publishable key. site_content is the one anonymous-readable table
in the schema, deliberately, because its contents are the words printed on a
public website — see the note in 0021. That means this job needs no secret.
"""

import hashlib
import html as html_mod
import json
import os
import pathlib
import re
import sys
import urllib.request

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://ydmybkpojqpzvlqkpcah.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY",
                              "sb_publishable_LVsa3ZDs_Oy75SU-Q-L6lA_4JkwfNxc")
ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")


def fetch_overrides():
    """Rows an administrator has changed: reworded, hidden, or both."""
    url = (f"{SUPABASE_URL}/rest/v1/site_content"
           "?select=page,block_key,text,original,hidden"
           "&or=(text.not.is.null,hidden.is.true)")
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def render(source):
    """Editable text -> HTML.

    The inverse of to_editable_source() in mirror-site.py. Everything is escaped
    first, so an administrator typing an ampersand or an angle bracket produces
    those characters rather than broken markup — then the two things we
    deliberately support are put back.
    """
    out = html_mod.escape(source, quote=False)

    # [label](url) -> a link. Only http(s) and mailto: a javascript: URL typed
    # into a text box should not become a live link on the front page.
    def link(m):
        label, href = m.group(1), m.group(2).strip()
        if not re.match(r"^(https?://|mailto:|/|\./|\.\./|#)", href, re.I):
            return label
        return f'<a href="{html_mod.escape(href, quote=True)}">{label}</a>'

    out = re.sub(r"\[([^\]]*)\]\(([^)]*)\)", link, out)
    out = out.replace("\n", "<br>")
    return out


def matching_close(text, start, tag):
    i, depth = start, 1
    open_t, close_t = f"<{tag}", f"</{tag}>"
    while depth and i < len(text):
        o, c = text.lower().find(open_t, i), text.lower().find(close_t, i)
        if c == -1:
            return None
        if o != -1 and o < c:
            depth += 1
            i = o + len(open_t)
        else:
            depth -= 1
            i = c + len(close_t)
    return None if depth else i - len(close_t)


def apply_to_page(path, rows):
    """Replace the inner HTML of each edited block. Returns True if changed."""
    text = path.read_text(encoding="utf-8")
    before = text

    for row in rows:
        key = row["block_key"]
        m = re.search(r'<(\w+)([^>]*\bdata-k="' + re.escape(key) + r'")([^>]*)>', text)
        if not m:
            print(f"    ! block {key} not found in {path} — skipped")
            continue
        tag = m.group(1)
        close = matching_close(text, m.end(), tag.lower())
        if close is None:
            print(f"    ! block {key} has no matching </{tag}> — skipped")
            continue

        # --- taken off the page, or put back on -------------------------------
        #
        # The element is kept either way. A hidden element is given no space by
        # the browser, so the page closes up as if the paragraph were gone —
        # and it still carries its data-k, which is the only way it could ever
        # be brought back.
        open_tag = m.group(0)
        without = re.sub(r'\s+hidden(?=[\s>])', "", open_tag)
        new_open = (without[:-1].rstrip() + " hidden>") if row.get("hidden") else without

        inner = render(row["text"]) if row.get("text") is not None \
                else text[m.end():close]

        text = text[:m.start()] + new_open + inner + text[close:]

    if text != before:
        path.write_text(text, encoding="utf-8")
        return True
    return False


def main():
    try:
        rows = fetch_overrides()
    except Exception as e:
        print("Could not read site_content:", e)
        return 1

    if not rows:
        print("No text edits to publish.")
        print("\nPhotographs:")
        publish_images(ROOT)
        return 0

    by_page = {}
    for r in rows:
        by_page.setdefault(r["page"], []).append(r)

    changed = 0
    for page, page_rows in sorted(by_page.items()):
        path = ROOT / page
        if not path.exists():
            print(f"  ! {page} does not exist — skipped")
            continue
        print(f"  {page}: {len(page_rows)} edited block(s)")
        if apply_to_page(path, page_rows):
            changed += 1

    print(f"\n{changed} file(s) rewritten from {len(rows)} edit(s).")

    print("\nPhotographs:")
    changed += publish_images(ROOT)
    return 0



# =============================================================================
# Photographs
#
# An administrator uploads to Supabase Storage; this brings the file down,
# shrinks it, writes it beside the other site assets and points the page at it.
#
# Shrinking is not optional. These are uploaded from phones by people who have
# no reason to think about file size, and a 12MB portrait-mode photograph on the
# front page would be slower to load than the entire rest of the site put
# together. 1600px wide is more than a full-width banner needs.
#
# Idempotent by construction: the local filename is derived from the image's own
# bytes, so a run that changes nothing writes the same file and rewrites the
# same tag, and git sees no change. That is what lets this repeat every ten
# minutes without a way to mark an upload as done.
# =============================================================================
MAX_WIDTH = 1600
JPEG_QUALITY = 82


def fetch_images():
    url = (f"{SUPABASE_URL}/rest/v1/site_images"
           "?select=page,img_key,original_src,upload_path,alt")
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def shrink(raw):
    """Down to something sane for a web page. Returns (bytes, extension)."""
    try:
        from PIL import Image
    except ImportError:
        # No Pillow: publish it untouched rather than not at all. The size
        # warning in the admin screen is the other half of this.
        print("    (Pillow not available — using the file as uploaded)")
        return raw, ".jpg"

    import io
    im = Image.open(io.BytesIO(raw))

    # Phone photographs carry their rotation in EXIF rather than in the pixels.
    try:
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass

    if im.width > MAX_WIDTH:
        im = im.resize((MAX_WIDTH, round(im.height * MAX_WIDTH / im.width)),
                       Image.LANCZOS)

    if im.mode in ("RGBA", "P", "LA"):
        im = im.convert("RGB")

    out = io.BytesIO()
    im.save(out, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    return out.getvalue(), ".jpg"


def publish_images(root):
    try:
        rows = fetch_images()
    except Exception as e:
        print("Could not read site_images:", e)
        return 0

    changed = 0
    for row in rows:
        page, key = row["page"], row["img_key"]
        path = root / page
        if not path.exists():
            continue

        html = path.read_text(encoding="utf-8")

        # Which file should this tag point at?
        if row.get("upload_path"):
            obj = f"{SUPABASE_URL}/storage/v1/object/public/site-images/{row['upload_path']}"
            try:
                with urllib.request.urlopen(obj, timeout=120) as r:
                    raw = r.read()
            except Exception as e:
                print(f"    ! could not fetch {row['upload_path']}: {e}")
                continue

            data, ext = shrink(raw)
            name = f"site/{pathlib.Path(page).parent.name or 'index'}-" \
                   f"{key}-{hashlib.sha1(data).hexdigest()[:8]}{ext}"
            dest = root / name
            if not dest.exists() or dest.read_bytes() != data:
                dest.write_bytes(data)
                print(f"    wrote {name} ({len(data):,} bytes, was {len(raw):,})")
        else:
            name = row["original_src"]        # put the imported one back

        # Point the tag at it. The src is rewritten in place; everything else
        # about the tag — width, height, classes, the theme's own attributes —
        # is left exactly as it was.
        depth = len(pathlib.Path(page).parts) - 1
        rel = ("../" * depth) + name if depth else name

        m = re.search(r'<img\b[^>]*\bdata-img="' + re.escape(key) + r'"[^>]*>', html)
        if not m:
            print(f"    ! image {key} not found in {page}")
            continue

        tag = m.group(0)
        new_tag = re.sub(r'src="[^"]*"', f'src="{rel}"', tag)
        # srcset would otherwise keep serving the old picture on a big screen.
        new_tag = re.sub(r'\s+(?:srcset|data-orig-file|data-large-file|'
                         r'data-medium-file|data-small-file)="[^"]*"', "", new_tag)

        if new_tag != tag:
            html = html[:m.start()] + new_tag + html[m.end():]
            path.write_text(html, encoding="utf-8")
            changed += 1
            print(f"  {page}: image {key} -> {name}")

    return changed


if __name__ == "__main__":
    sys.exit(main())
