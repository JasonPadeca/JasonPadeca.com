"""
Mirror the live koinoniaphx.com pages into the project, byte-faithfully enough
that the group sees their own site.

Assets are pulled down rather than hot-linked: a duplicate that breaks when the
original changes is not a duplicate. Analytics and comment widgets are dropped —
they phone home to the original WordPress.com account and do nothing useful on
a copy — but every stylesheet, font and image is kept.
"""
import os, re, sys, hashlib, urllib.parse, urllib.request, pathlib, collections
from html import unescape as html_unescape

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

# Query parameters that are cache-busters rather than part of an asset's
# identity. wp.com bumps these whenever it feels like it, and they were being
# hashed into local filenames — so an upstream bump renamed every file, left the
# old one behind as an orphan, and rewrote a reference on every page. That is
# most of why a re-mirror produced hundreds of lines of diff that meant nothing.
CACHE_BUSTERS = ("m", "ver", "minify")


def canonical_url(url):
    """The URL as an identity, with the cache-busters dropped.

    Used only for naming and for comparing runs. Fetching still uses the real
    URL — the point is that the same asset keeps the same local name when
    WordPress bumps its version.
    """
    p = urllib.parse.urlparse(url)
    if not p.query:
        return url
    # wp.com's bundles use a bare '??a.css,b.css' form that is not key=value and
    # must survive untouched.
    if p.query.startswith("?"):
        return url
    kept = [(k, v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)
            if k not in CACHE_BUSTERS]
    return urllib.parse.urlunparse(p._replace(query=urllib.parse.urlencode(kept)))


def local_name(url, ctype=""):
    """A stable local filename. wp.com bundles CSS behind '??' query strings, so
    the path alone is not unique — hash the whole URL."""
    url = canonical_url(url)
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

def _matching_close(html, start, tag):
    """Index just past the close tag matching the element opening at `start`."""
    i, depth = start, 1
    open_t, close_t = "<" + tag, "</" + tag + ">"
    while depth and i < len(html):
        o, c = html.find(open_t, i), html.find(close_t, i)
        if c == -1:
            return None
        if o != -1 and o < c:
            depth += 1; i = o + len(open_t)
        else:
            depth -= 1; i = c + len(close_t)
    return i if not depth else None


def remove_element(html, open_pattern, tag, must_contain=None):
    """Remove whole elements, nesting and all.

    `must_contain` makes it conditional: the element is only removed if that
    string appears inside it. Used for wrappers that are generic — a
    wp-block-group carries the dark background for the subscription bar, but the
    same class is used elsewhere for content worth keeping.
    """
    pat = re.compile(open_pattern, re.I)
    pos = 0
    while True:
        m = pat.search(html, pos)
        if not m:
            return html
        end = _matching_close(html, m.end(), tag)
        if end is None:
            return html
        inner = html[m.end():end]
        if must_contain and must_contain not in inner:
            pos = m.end()
            continue
        html = html[:m.start()] + html[end:]
        pos = m.start()


def remove_menu_item(html, slug):
    """Remove the <li> whose link is `slug`, along with any submenu inside it.

    Walks from the opening <li> counting nesting to its matching </li>, so a menu
    item that is itself a dropdown parent comes out whole."""
    pat = re.compile(r'<li\b[^>]*>\s*<a\s+href="(?:\.\./)*' + re.escape(slug) + r'/"', re.I)
    while True:
        m = pat.search(html)
        if not m:
            return html
        i, depth = m.end(), 1
        while depth and i < len(html):
            nxt_open = html.find("<li", i)
            nxt_close = html.find("</li>", i)
            if nxt_close == -1:
                return html                      # malformed; leave it alone
            if nxt_open != -1 and nxt_open < nxt_close:
                depth += 1; i = nxt_open + 3
            else:
                depth -= 1; i = nxt_close + 5
        html = html[:m.start()] + html[i:]


# Pages whose text is NOT made editable.
#
# class-descriptions is 222 blocks listing this semester's classes — data this
# app already holds properly. Making it hand-editable would entrench a copy that
# drifts from the real thing; it should be generated from the semester instead.
NOT_EDITABLE = {"class-descriptions/index.html"}

BLOCK_TAGS = ("p", "h1", "h2", "h3", "h4", "li")

# Collected while mirroring, written out as a seed at the end.
blocks = []


def to_editable_source(inner):
    """The HTML of a block, as text an administrator can safely edit.

    Links become [label](url) so they survive a round trip through a plain
    textarea — 32 blocks on this site contain one, including the FAQ's link to
    the application, and plain-text editing would silently drop them.
    """
    t = re.sub(r'<a\b[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
               lambda m: "[" + re.sub(r"<[^>]+>", "", m.group(2)).strip() + "](" + m.group(1) + ")",
               inner, flags=re.S | re.I)
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    return html_unescape(re.sub(r"[ \t]+", " ", t)).strip()


# Tags that mean a block is machinery rather than prose. WordPress puts whole
# contact forms and Akismet honeypots inside <p>, so matching on the tag alone
# offers somebody the guts of the contact form to reword in a textarea, and the
# first save destroys it. Anything holding one of these is not text.
NOT_PROSE = ("input", "textarea", "select", "button", "script", "form",
             "template", "iframe", "div", "table", "ul", "ol", "img", "svg")

# Inline formatting that wraps a block's whole content rather than part of it.
INLINE = ("mark", "strong", "em", "b", "i", "span", "u", "small")


def innermost_text_element(inner):
    """Where data-k belongs, given a block's inner HTML.

    The front page's heading is not plain text — it is

        <h1><mark style="…" class="has-inline-color"><strong>Koinonia…</strong></mark></h1>

    and the colour and the bold live entirely in that wrapper. Marking the <h1>
    means the first edit replaces the wrapper with bare text, so rewording the
    front-page heading would silently strip its styling. For a group that likes
    its website and did not ask for a redesign, that is the worst thing this
    feature could do.

    So when a block's content is nothing but inline formatting around some text,
    descend and mark the innermost element instead. The wrapper is then never
    touched, and an edit replaces only the words inside it.

    Returns the offset within `inner` at which to splice the attribute, or None
    to mark the block itself. Descent stops as soon as the content is anything
    other than one wrapper — a paragraph with a bolded phrase in the middle is
    ordinary prose and belongs to the block.
    """
    m = re.match(r"\s*<(" + "|".join(INLINE) + r")\b[^>]*>", inner, re.I)
    if not m:
        return None

    tag = m.group(1).lower()
    close = _matching_close(inner, m.end(), tag)

    # Only descend when this one element IS the whole content. If anything but
    # whitespace follows it, the block has other words in it and they belong to
    # the block, not to the wrapper.
    if close is None or inner[close:].strip():
        return None

    here = m.end() - 1                    # just before the ">" of this open tag
    deeper = innermost_text_element(inner[m.end():close - len(tag) - 3])
    return here if deeper is None else m.end() + deeper


def mark_editable(html, page_dest):
    """Tag each text block with data-k so the publishing job can find it."""
    if page_dest in NOT_EDITABLE:
        return html

    i = html.find('class="entry-content')
    if i == -1:
        return html
    end = html.find("</article>", i)
    if end == -1:
        return html

    head, seg, tail = html[:i], html[i:end], html[end:]
    n = 0
    out, pos = [], 0

    for m in re.finditer(r"<(" + "|".join(BLOCK_TAGS) + r")\b([^>]*)>(.*?)</\1>", seg, re.S | re.I):
        tag, attrs, inner = m.group(1), m.group(2), m.group(3)

        if re.search(r"<(" + "|".join(NOT_PROSE) + r")\b", inner, re.I):
            continue

        source = to_editable_source(inner)
        if not source:
            continue

        n += 1
        key = str(n)
        blocks.append((page_dest, key, source, n, tag.lower()))
        out.append(seg[pos:m.start()])

        # Usually the block carries the attribute; where the block is nothing
        # but a styled wrapper around its text, the wrapper carries it instead
        # so editing cannot strip the styling off.
        at = innermost_text_element(inner)
        if at is None:
            out.append(f'<{tag}{attrs} data-k="{key}">{inner}</{tag}>')
        else:
            out.append(f'<{tag}{attrs}>{inner[:at]} data-k="{key}"{inner[at:]}</{tag}>')
        pos = m.end()
    out.append(seg[pos:])
    return head + "".join(out) + tail


# The inline half of the WordPress.com analytics beacon. The loader it feeds
# (stats.wp.com) is already dropped, so _stq is never flushed and this is dead
# code — but it carries an encrypted payload that is regenerated on every single
# request, so it rewrote six pages on every mirror run. Reporting this site's
# traffic to somebody else's analytics account was never wanted anyway.
STQ_SCRIPT = re.compile(
    r"<script[^>]*>(?:(?!</script>).)*?_stq\.push(?:(?!</script>).)*?</script>",
    re.I | re.S)


def stabilise(html, previous=None):
    """Blank out values WordPress regenerates on every single request.

    None of these do anything on a copy — admin-ajax.php is not reachable from
    this site, so a nonce is a token for a door that is not there. But they
    change on every fetch, so leaving them in meant each mirror run rewrote them
    across all sixteen pages and buried the real change in noise. A diff nobody
    can read is a diff nobody checks.

    Deliberately narrow. Generated class names like wp-container-…-b9bba262 and
    field ids like g128-email are NOT touched: the stylesheets and the <label
    for=…> attributes point at them, so normalising them here would quietly
    break the layout and the contact form's labels.
    """
    # Per-request tokens for the original site's admin endpoints.
    html = re.sub(r'("(?:nonce|_wpnonce|api_nonce)":")[0-9a-f]{6,}(")',
                  r"\1\2", html, flags=re.I)
    html = re.sub(r'(\b(?:_wpnonce|nonce)=)[0-9a-f]{6,}', r"\1", html, flags=re.I)

    # Cache-busters left on URLs that stayed remote (the ones we downloaded are
    # already renamed by canonical_url).
    html = re.sub(r'([?&])m=\d+i(?=[&"\'\s>])', r"\1", html)
    html = re.sub(r'([?&])ver=[\w.\-]+(?=[&"\'\s>])', r"\1", html)
    html = re.sub(r'\?&', "?", html)
    html = re.sub(r'([?&])(["\'])', r"\2", html)

    # Analytics for somebody else's account, regenerated per request.
    html = STQ_SCRIPT.sub("", html)

    # WordPress's own cache footer: how long their server took, this time.
    html = re.sub(r"<!--\s*generated in [\d.]+ seconds.*?-->", "", html, flags=re.S)

    # Akismet stamps how many milliseconds the page took to render, as part of
    # its bot detection. On a static copy it is a number that changes for no
    # reason a reader could ever observe.
    html = re.sub(r'(name="ak_js" value=")\d+(")', r"\g<1>0\2", html)

    # wp.com serves its plugin assets from rotating buckets (…/sun/…, …/moon/…)
    # and picks one per request. Same files either way.
    html = re.sub(r'(jetpack-mu-wpcom-plugin/)\w+(/jetpack_vendor/)', r"\1sun\2", html)

    # The contact form's signed token. It carries no expiry and its meaning is
    # identical between runs — only the encryption IV differs — so keeping the
    # one already on disk leaves a working form and stops a 4KB line changing
    # every time. Refetching it would be no fresher, only noisier.
    if previous:
        old = re.search(r"jetpack_contact_form_jwt' value='([^']+)'", previous)
        if old:
            html = re.sub(r"(jetpack_contact_form_jwt' value=')[^']+'",
                          lambda m: m.group(1) + old.group(1) + "'", html)

    return html


def prune_orphans():
    """Delete downloaded assets nothing points at any more.

    When wp.com changes a bundle, the new one arrives under a new name and the
    old one sits in the repository forever. Left alone this only grows, and it
    grows in a directory nobody is ever going to audit by hand.
    """
    referenced = set()
    for page in PAGES.values():
        f = OUT / page
        if f.exists():
            referenced.update(re.findall(r"[\w.\-]+-[0-9a-f]{8}\.[a-z0-9]+",
                                         f.read_text(encoding="utf-8", errors="replace")))
    # Stylesheets point at fonts and images of their own.
    for f in ASSETS.glob("*.css"):
        referenced.update(re.findall(r"[\w.\-]+-[0-9a-f]{8}\.[a-z0-9]+",
                                     f.read_text(encoding="utf-8", errors="replace")))

    removed, freed = 0, 0
    for f in sorted(ASSETS.iterdir()):
        if f.is_file() and f.name not in referenced:
            freed += f.stat().st_size
            f.unlink()
            removed += 1
    return removed, freed


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

    # --- WordPress fingerprints ------------------------------------------------
    #
    # Visible branding first: the footer reads "Koinonia, Website Built with
    # WordPress.com". The co-op's own name stays; the credit and its link go.
    html = re.sub(
        r'<span class="comma">,</span>\s*<a[^>]*wordpress\.com[^>]*>[^<]*</a>\.?',
        "", html, flags=re.I)
    html = re.sub(r'<a[^>]*(?:wordpress\.com|wp\.com)[^>]*>[^<]*(?:WordPress|Blog at|Design a site)[^<]*</a>\.?',
                  "", html, flags=re.I)

    # Then the machine-readable ones. These are invisible, but they announce the
    # platform to anything that reads the page — and the feeds, RSD and oEmbed
    # links all point back at the original site, which on a copy is worse than
    # useless.
    for pat in (
        r'<meta name="generator"[^>]*>',
        r'<link[^>]+rel="EditURI"[^>]*>',
        r'<link[^>]+wlwmanifest[^>]*>',
        r'<link[^>]+rel="alternate"[^>]+(?:rss\+xml|atom\+xml)[^>]*>',
        r'<link[^>]+api\.w\.org[^>]*>',
        r'<link[^>]+rel="[^"]*shortlink[^"]*"[^>]*>',
        r'<link[^>]+oembed[^>]*>',
    ):
        html = re.sub(pat, "", html, flags=re.I)

    # --- The Join dropdown -----------------------------------------------------
    #
    # Everything under Join except the application is either already in this app
    # or on its way there.
    #
    # Removed by BALANCED matching, not by regex. Step 2 and Step 3 each have
    # their own nested submenu, and a pattern ending in `.*?</a>\\s*</li>` skips
    # past the nesting to a later `</a></li>` — it takes the opening tags and
    # leaves the closes behind. That put three `</ul></li>` where one belonged,
    # which threw Participate, About and Member Sign In out of the horizontal
    # menu and onto the page as a bare bulleted list.
    for slug in ("registration", "classes-signup",
                 "returning-family-registration", "newfamilyregistration",
                 "class-descriptions"):
        html = remove_menu_item(html, slug)

    # --- WordPress.com widgets that do not belong on a copy --------------------
    #
    # The "Get new content delivered directly to your inbox" bar posts to
    # WordPress.com and would sign families up to a blog this project does not
    # publish. Its black background sits on the wrapping group, not the form, so
    # removing only the form leaves an empty black band across the page.
    html = remove_element(
        html,
        r'<div[^>]*class="[^"]*wp-block-group[^"]*has-background[^"]*"[^>]*>',
        "div", must_contain="wp-block-jetpack-subscriptions")

    # The Like / share footer. Its iframe comes from widgets.wp.com, and with
    # that blocked it sits there showing a spinner and the word "Loading..."
    # forever — which is what a visitor actually sees.
    html = remove_element(html, r'<div[^>]*id="jp-post-flair"[^>]*>', "div")
    html = remove_element(html, r'<div[^>]*class="[^"]*sharedaddy[^"]*"[^>]*>', "div")
    html = remove_element(html, r'<iframe[^>]*widgets\.wp\.com[^>]*>', "iframe")

    # WordPress.com's floating action bar — the Follow / Report this content
    # widget that hovers over a corner of every page on a wp.com-hosted site.
    # It ships hidden and is revealed by a script we do not load, so on a copy it
    # is either invisible or a spinner that never resolves.
    html = remove_element(html, r'<div[^>]*id="actionbar"[^>]*>', "div")

    # Remaining head fingerprints: prefetch hints, the wp.me shortlink, and
    # WordPress's own OpenSearch document. All invisible, all pointing at
    # somewhere this copy has nothing to do with.
    for pat in (
        r"<link[^>]+rel=['\"]dns-prefetch['\"][^>]*>",
        r"<link[^>]+rel=['\"]shortlink['\"][^>]*>",
        r"<link[^>]+opensearch[^>]*>",
        r"<link[^>]+rel=['\"]profile['\"][^>]*gmpg\.org[^>]*>",
    ):
        html = re.sub(pat, "", html, flags=re.I)

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

    # The theme's own menu. The new item goes at the END of the top-level list,
    # as a plain <li class="menu-item"> so the theme styles it.
    #
    # Anchored to the close of the menu container rather than found by counting
    # <ul> nesting. The counting version worked until the Join items were
    # stripped, then mis-landed the item INSIDE the Join submenu — which
    # swallowed Participate and About, because everything after the insertion
    # point ended up nested one level too deep. Searching backwards from a fixed
    # landmark cannot drift like that.
    for m in re.finditer(r'<div class="main-menu-container">', html):
        tail = html.find("</nav>", m.end())
        if tail == -1:
            continue
        close = html.rfind("</ul>", m.end(), tail)
        if close == -1:
            continue
        html = html[:close] + signin + html[close:]
        changes.append("sign-in item")
        break

    return html, changes


def swap_application_form(html):
    """Put our application form where the WordPress one was.

    Only on apply/. Everything around it — header, navigation, the questions'
    own wording above the form, footer — stays exactly as it is; the single
    <div class='jetpack-contact-form-container'> holding the form is swapped for
    a mount point, and app.js builds the real form inside it.

    This has to live in the mirror rather than being done by hand once. It was
    done by hand once, and re-running the mirror silently put the WordPress form
    back: the page looked right, and applications would have gone to whichever
    inbox Jetpack mails instead of into the applications table. Anything the
    mirror does not know how to redo is a change that quietly undoes itself.
    """
    m = re.search(r"<div[^>]*class='jetpack-contact-form-container[^']*'", html)
    if not m:
        return html, None

    start = html.rfind("<", 0, m.start() + 1)
    end = _matching_close(html, m.end(), "div")
    if end is None:
        return html, None

    html = html[:start] + '<div id="coop-apply-form"></div>' + html[end:]

    # The form's own stylesheet, and the script that builds it. form.css rather
    # than the app's stylesheet on purpose — app.css opens with a global margin
    # and padding reset, which would restyle the co-op's theme on this page.
    head = html.find("</head>")
    if head != -1:
        html = (html[:head]
                + '<link rel="stylesheet" href="./form.css">\n'
                + html[head:])

    body = html.rfind("</body>")
    if body != -1:
        html = (html[:body]
                + '<div id="toasts"></div>\n'
                + '<script type="module" src="./app.js"></script>\n'
                + html[body:])

    return html, "application form"

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

        if dest == "apply/index.html":
            html, swapped = swap_application_form(html)
            if swapped:
                changes.append(swapped)
            else:
                # Loud, because the page still looks perfectly fine when this
                # fails — it just quietly goes on being WordPress's form.
                print("   !! the application form was NOT swapped — check the markup")

        # After the form swap, so the mount point is never offered as prose.
        html = mark_editable(html, dest)

        path = OUT / dest
        previous = path.read_text(encoding="utf-8") if path.exists() else None
        html = stabilise(html, previous)

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(html, encoding="utf-8")
        print(f"   {len(html):>7,} bytes   changes: {', '.join(changes) or 'none'}")

    # The seed for site_content: every editable block, with what it says today.
    seed = pathlib.Path(sys.argv[1]) / "supabase" / "seed" / "site-content.sql"
    seed.parent.mkdir(parents=True, exist_ok=True)
    with seed.open("w") as f:
        f.write("-- Generated by tools/mirror-site.py. Every editable text block on the\n")
        f.write("-- public pages, with the wording it was imported with.\n--\n")
        f.write("-- Safe to re-run: existing rows keep their `text` override and only the\n")
        f.write("-- original is refreshed, so re-importing the site does not silently throw\n")
        f.write("-- away somebody's edits.\n\n")
        for page, key, source, order, tag in blocks:
            q = lambda v: "'" + str(v).replace("'", "''") + "'"
            f.write("insert into public.site_content (page, block_key, original, sort_order, tag) values\n")
            f.write(f"  ({q(page)}, {q(key)}, {q(source)}, {order}, {q(tag)})\n")
            f.write("on conflict (page, block_key) do update set original = excluded.original,\n")
            f.write("  sort_order = excluded.sort_order, tag = excluded.tag;\n")
    print(f"\nseed written: {len(blocks)} editable blocks -> {seed}")

    removed, freed = prune_orphans()
    print(f"orphaned assets removed: {removed} ({freed:,} bytes)")

    print("\nassets downloaded:")
    for k, v in downloaded.most_common():
        print(f"  {v:>4}  {k}")

main()
