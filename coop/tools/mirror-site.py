"""
Mirror the live koinoniaphx.com pages into the project, byte-faithfully enough
that the group sees their own site.

Assets are pulled down rather than hot-linked: a duplicate that breaks when the
original changes is not a duplicate. Analytics and comment widgets are dropped —
they phone home to the original WordPress.com account and do nothing useful on
a copy — but every stylesheet, font and image is kept.
"""
import os, re, sys, hashlib, urllib.parse, urllib.request, pathlib, collections

BASE = "https://koinoniaphx.com"
OUT  = pathlib.Path(sys.argv[1])
ASSETS = OUT / "site"
ASSETS.mkdir(parents=True, exist_ok=True)

PAGES = {
    "":                             "index.html",
    "about-koinonia-faq":           "about-koinonia-faq/index.html",
    "our-beliefs":                  "our-beliefs/index.html",
    "about":                        "about/index.html",
    "contact":                      "contact/index.html",
    "calendar":                     "calendar/index.html",
    "registration":                 "registration/index.html",
    "returning-family-registration":"returning-family-registration/index.html",
    "newfamilyregistration":        "newfamilyregistration/index.html",
    "classes-signup":               "classes-signup/index.html",
    "class-descriptions":           "class-descriptions/index.html",
    "class-proposal-form":          "class-proposal-form/index.html",
    "student-class-proposal-form":  "student-class-proposal-form/index.html",
    "class-description-form":       "class-description-form/index.html",
    "fieldtrip-suggestion-form":    "fieldtrip-suggestion-form/index.html",
    "application-for-membership":   "apply/index.html",
}

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"}
cache = {}
downloaded = collections.Counter()

def fetch(url):
    if url in cache: return cache[url]
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            data = r.read()
            ctype = r.headers.get("Content-Type", "")
    except Exception as e:
        print("  ! could not fetch", url[:90], e)
        cache[url] = (None, "")
        return cache[url]
    cache[url] = (data, ctype)
    return cache[url]

def local_name(url, ctype=""):
    """A stable local filename. wp.com bundles CSS behind '??' query strings, so
    the path alone is not unique — hash the whole URL."""
    p = urllib.parse.urlparse(url)
    stem = pathlib.Path(p.path).name or "asset"
    stem = re.sub(r"[^\w.\-]", "_", stem)[:60]
    ext = pathlib.Path(stem).suffix.lower()
    if not ext:
        if "css" in ctype: ext = ".css"
        elif "javascript" in ctype: ext = ".js"
        elif "font" in ctype or "woff" in ctype: ext = ".woff2"
        elif "png" in ctype: ext = ".png"
        elif "jpeg" in ctype or "jpg" in ctype: ext = ".jpg"
        elif "svg" in ctype: ext = ".svg"
        else: ext = ".bin"
        stem += ext
    h = hashlib.sha1(url.encode()).hexdigest()[:8]
    return f"{pathlib.Path(stem).stem}-{h}{ext}"

def absolutise(u, page_url):
    u = u.strip().replace("&#038;", "&").replace("&amp;", "&")
    if not u or u.startswith(("data:", "mailto:", "tel:", "#", "javascript:")):
        return None
    return urllib.parse.urljoin(page_url, u)

def grab_asset(url, page_url, depth=0):
    """Download one asset, and anything a stylesheet points at."""
    abs_url = absolutise(url, page_url)
    if not abs_url: return None
    host = urllib.parse.urlparse(abs_url).netloc
    # Their own domain, wp.com's CDNs, and the font API. Anything else stays a
    # remote URL rather than being pulled into the repo.
    if not re.search(r"(koinoniaphx\.com|wp\.com|wordpress\.com|gravatar\.com)$", host):
        return None

    data, ctype = fetch(abs_url)
    if data is None: return None

    name = local_name(abs_url, ctype)
    path = ASSETS / name

    if "css" in ctype and depth < 2:
        text = data.decode("utf-8", "replace")
        for m in set(re.findall(r'url\(\s*["\']?([^"\')]+)', text)):
            sub = grab_asset(m, abs_url, depth + 1)
            if sub:
                text = text.replace(m, sub)
        # Fonts imported by URL inside CSS.
        for m in set(re.findall(r'@import\s+url\(\s*["\']?([^"\')]+)', text)):
            sub = grab_asset(m, abs_url, depth + 1)
            if sub:
                text = text.replace(m, sub)
        path.write_text(text, encoding="utf-8")
    else:
        path.write_bytes(data)

    downloaded[ctype.split(";")[0] or "other"] += 1
    return name

# --- Things that have no business on a copy -----------------------------------
# Analytics, hovercards, and the comment/like widgets all report to the original
# WordPress.com account. Removing them changes nothing a visitor sees.
# Only external scripts, matched on their src, and only the analytics ones.
#
# The first version of this used `jetpack.*subscriptions` with DOTALL, and `.*`
# happily crossed tag boundaries — it ate 48KB of the page including every <ul>,
# which is to say the entire navigation. Anchored to the src attribute, it
# cannot run away. Everything else the theme loads is left alone: on a copy of
# somebody's site, "leave it as it was" is the right default.
DROP_SCRIPT = re.compile(
    r'<script[^>]+src=["\'][^"\']*(?:stats\.wp\.com|bilmur)[^"\']*["\'][^>]*>\s*</script>',
    re.I)
# Nothing else is stripped. A non-greedy .*?</div> does not find the MATCHING
# close tag, it finds the next one, so removing a wrapper this way reliably
# takes the wrong half of the page with it.
DROP_TAGS = []

def rewrite(html, page_url, depth):
    up = "../" * depth
    site = up + "site/"

    # Every asset reference: href=, src=, srcset=, and url() in inline styles.
    def swap_attr(m):
        attr, quote, url = m.group(1), m.group(2), m.group(3)
        name = grab_asset(url, page_url)
        return f'{attr}={quote}{site}{name}{quote}' if name else m.group(0)

    html = re.sub(r'\b(href|src)=(["\'])([^"\']+\.(?:css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)[^"\']*)\2',
                  swap_attr, html, flags=re.I)
    # wp.com's bundled stylesheets have no extension in the path.
    html = re.sub(r'\b(href)=(["\'])(/_static/[^"\']+|[^"\']*fonts-api\.wp\.com[^"\']*)\2',
                  swap_attr, html, flags=re.I)

    def swap_srcset(m):
        parts = []
        for chunk in m.group(2).split(","):
            bits = chunk.strip().split()
            if not bits: continue
            name = grab_asset(bits[0], page_url)
            parts.append(" ".join([site + name if name else bits[0]] + bits[1:]))
        return f'srcset={m.group(1)}{", ".join(parts)}{m.group(1)}'
    html = re.sub(r'srcset=(["\'])(.*?)\1', swap_srcset, html, flags=re.S)

    # Internal page links point at the local copies.
    for slug, dest in PAGES.items():
        target = up + (dest[:-len("index.html")] if dest.endswith("index.html") else dest)
        target = target or "./"
        for pat in (f"{BASE}/{slug}/" if slug else f"{BASE}/", f"/{slug}/" if slug else "/"):
            html = html.replace(f'href="{pat}"', f'href="{target}"')

    # These are category archives that exist only to be dropdown parents.
    # Pointing them anywhere real would mean mirroring a blog archive nobody
    # asked for; leaving them sends people off the copy and back to the live
    # site mid-journey.
    html = html.replace(f'href="{BASE}/category/uncategorized/"', 'href="#"')

    html = DROP_SCRIPT.sub("", html)
    for pat in DROP_TAGS:
        html = pat.sub("", html)
    return html

# --- The two changes we are actually making -----------------------------------
def apply_changes(html, depth):
    up = "../" * depth or "./"
    changes = []

    # 1. The membership application points at ours instead of the WordPress form.
    before = html
    html = re.sub(r'href="[^"]*application-for-membership/?"',
                  f'href="{up}apply/"', html, flags=re.I)
    if html != before:
        changes.append("application link")

    # 2. A member sign-in beside the nav. Added as a nav item so it inherits the
    #    theme's own styling rather than looking bolted on — which is the whole
    #    point for a group that likes the site it has.
    before = html
    signin = ('<li class="menu-item menu-item-type-post_type menu-item-object-page">'
              f'<a href="{up}portal/">Member Sign In</a></li>')

    # The theme's own menu: <ul class="main-menu">. The new item is inserted as
    # a plain <li class="menu-item">, so it inherits the theme's styling exactly
    # and reads as though it was always there — which is the point.
    m = re.search(r'<ul[^>]*class="[^"]*main-menu[^"]*"[^>]*>', html, re.I)
    if m:
        start = m.end()
        depth_ul, i = 1, start
        while i < len(html) and depth_ul:
            nxt_open, nxt_close = html.find("<ul", i), html.find("</ul>", i)
            if nxt_close == -1:
                break
            if nxt_open != -1 and nxt_open < nxt_close:
                depth_ul += 1; i = nxt_open + 3
            else:
                depth_ul -= 1; i = nxt_close + 5
        if not depth_ul:
            html = html[:i - 5] + signin + html[i - 5:]
            changes.append("sign-in item")

    return html, changes

def main():
    for slug, dest in PAGES.items():
        url = f"{BASE}/{slug}/" if slug else f"{BASE}/"
        print(f"-- /{slug or ''}")
        data, ctype = fetch(url)
        if data is None:
            print("   skipped"); continue
        html = data.decode("utf-8", "replace")
        depth = dest.count("/")
        html = rewrite(html, url, depth)
        html, changes = apply_changes(html, depth)

        path = OUT / dest
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
        print(f"   {len(html):>7,} bytes   changes: {', '.join(changes) or 'none'}")

    print("\nassets downloaded:")
    for k, v in downloaded.most_common():
        print(f"  {v:>4}  {k}")

main()
