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
    """Only rows an administrator has actually changed."""
    url = (f"{SUPABASE_URL}/rest/v1/site_content"
           "?select=page,block_key,text,original&text=not.is.null")
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
        text = text[:m.end()] + render(row["text"]) + text[close:]

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
        print("No edits to publish.")
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
