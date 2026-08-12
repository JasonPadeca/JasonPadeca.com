// =============================================================================
// Website — editing the words on the public pages.
//
// The audience for this screen is a homeschool mother who wants to change a
// date on the front page and has no intention of learning HTML. So it shows the
// page as a list of the paragraphs and headings that are actually on it, each
// in a plain box, in the order they appear. There is no layout to rearrange, no
// blocks to add or delete, and nothing that can leave a page half-built.
//
// Two things this screen has to say out loud, because getting either wrong
// makes somebody think the software is broken:
//
//   1. Changes take a few minutes to appear. A Save that seems to do nothing
//      gets pressed again, and then somebody rings Ben.
//   2. Every block can be put back. People edit much more freely once they know
//      the original is kept, and "I've ruined the front page" is the failure
//      that would stop them using this at all.
// =============================================================================

import { api } from "../../assets/api.js";
import {
  esc, $, $$, render, relTime, plural, toastOk, toastErr, confirmDialog,
} from "../../assets/ui.js";
import { refresh } from "../app.js";

// The pages, in the order somebody would think of them rather than
// alphabetically. class-descriptions is deliberately absent: it is 222 blocks
// of class listings that should come out of the semester data, and hand-editing
// it would be a second copy of the truth.
const PAGES = [
  ["index.html",                            "Front page"],
  ["about/index.html",                      "About"],
  ["about-koinonia-faq/index.html",         "FAQ"],
  ["our-beliefs/index.html",                "Our beliefs"],
  ["contact/index.html",                    "Contact"],
  ["apply/index.html",                      "Application for membership"],
  ["classes-signup/index.html",             "Classes & sign-up"],
  ["registration/index.html",               "Registration"],
  ["newfamilyregistration/index.html",      "New family registration"],
  ["returning-family-registration/index.html", "Returning family registration"],
  ["class-proposal-form/index.html",        "Class proposal form"],
  ["student-class-proposal-form/index.html", "Student class proposal form"],
  ["class-description-form/index.html",     "Class description form"],
  ["fieldtrip-suggestion-form/index.html",  "Field trip suggestion form"],
];

const TITLE = Object.fromEntries(PAGES);

/** Where the live page sits, relative to /admin/. */
const publicHref = (page) => "../" + page.replace(/index\.html$/, "");

// =============================================================================
// The page list
// =============================================================================
export async function show(app) {
  let edited = [], images = [];
  try {
    edited = await api.siteEditedPages();
    images = await api.siteImages().catch(() => []);
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div>
      <p class="muted mt">If this says the table does not exist, the database
      update that adds it has not been run yet.</p></div>`);
  }

  const counts = {};
  for (const r of edited) counts[r.page] = (counts[r.page] ?? 0) + 1;
  const total = edited.length;

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div>
        <h1>Website</h1>
        <div class="sub">The wording on the public pages</div>
      </div>
    </div>

    ${publishNote(total)}

    <div class="card mt">
      <table class="table">
        <thead><tr><th>Page</th><th>Changed</th><th></th></tr></thead>
        <tbody>
          ${PAGES.map(([page, label]) => `
            <tr>
              <td><a href="#/website/${encodeURIComponent(page)}"><strong>${esc(label)}</strong></a></td>
              <td>${counts[page]
                ? `<span class="badge badge-ok">${plural(counts[page], "change")}</span>`
                : `<span class="muted">—</span>`}</td>
              <td class="right">
                <a class="btn btn-sm" href="#/website/${encodeURIComponent(page)}">Edit wording</a>
                <a class="btn btn-sm" href="${esc(publicHref(page))}" target="_blank" rel="noopener">View page</a>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>

    ${imagesCard(images)}

    <div class="note mt">
      <strong>What this can and cannot change.</strong>
      You can reword any paragraph, heading or list item on these pages, and
      replace the photographs listed above. You cannot add new sections or move
      things around — those still need Ben. The class descriptions page is not listed because it is
      built from the classes you set up under Semesters.
    </div>
  </div>`);

  wireImages(app);
}

function publishNote(total) {
  return `<div class="note">
    <strong>Changes are not instant.</strong>
    Anything you save here appears on the real website within about ten minutes.
    That is normal — you do not need to save again, and you do not need to do
    anything else to publish it.
    ${total ? `<div class="mt">${plural(total, "block")} currently reworded.</div>` : ""}
  </div>`;
}

// =============================================================================
// One page
// =============================================================================
export async function page(app, params) {
  const pageName = decodeURIComponent(params.page ?? "");
  if (!TITLE[pageName]) {
    return render(app, `<div class="wrap page">
      <div class="empty"><h3>Not an editable page</h3>
      <p><a href="#/website">Back to the list</a></p></div></div>`);
  }

  let blocks = [];
  try {
    blocks = await api.siteBlocks(pageName);
  } catch (e) {
    return render(app, `<div class="wrap page">
      <div class="note note-danger">${esc(e.message)}</div></div>`);
  }

  const changed = blocks.filter((b) => b.text !== null).length;

  render(app, `<div class="wrap page">
    <div class="page-head">
      <div>
        <div class="crumbs"><a href="#/website">Website</a><span>›</span>${esc(TITLE[pageName])}</div>
        <h1>${esc(TITLE[pageName])}</h1>
        <div class="sub">${plural(blocks.length, "block")}${
          changed ? ` · ${changed} reworded` : ""}</div>
      </div>
      <div class="btn-row">
        <a class="btn" href="${esc(publicHref(pageName))}" target="_blank" rel="noopener">View page</a>
      </div>
    </div>

    ${publishNote(0)}

    ${blocks.length
      ? `<div class="blocks mt">${blocks.map(blockCard).join("")}</div>`
      : `<div class="empty"><h3>Nothing editable on this page</h3>
         <p>It has no text blocks that were imported.</p></div>`}
  </div>`);

  wire(app, pageName, blocks);
}

// Blocks that contain a link are the ones most easily broken, because the link
// is written in a shorthand rather than shown as a link. Say so on the block
// itself — a note at the top of the page is a note nobody reads.
const HAS_LINK = /\[[^\]]*\]\([^)]*\)/;

function blockCard(b) {
  const current = b.text ?? b.original;
  const isChanged = b.text !== null;

  return `<div class="card block" data-block="${esc(b.block_key)}">
    <div class="block-head">
      <span class="muted mono">${esc(b.tag ?? "")}</span>
      ${isChanged
        ? `<span class="badge badge-ok">Reworded${
            b.updated_at ? ` ${esc(relTime(b.updated_at))}` : ""}</span>`
        : ""}
    </div>

    <textarea class="block-text" rows="${rowsFor(current)}"
      aria-label="Wording">${esc(current)}</textarea>

    ${HAS_LINK.test(current)
      ? `<div class="hint">This block contains a link, written as
         <code>[the words people click](where it goes)</code>. Reword the part in
         square brackets freely; leave the part in round brackets alone unless
         you mean to point it somewhere else.</div>`
      : ""}

    ${isChanged
      ? `<details class="mt">
           <summary class="muted">What it said before</summary>
           <div class="was">${esc(b.original)}</div>
         </details>`
      : ""}

    <div class="btn-row mt">
      <button class="btn btn-primary btn-sm" data-save disabled>Save</button>
      ${isChanged
        ? `<button class="btn btn-sm" data-revert>Put the original back</button>`
        : ""}
      <span class="muted block-state"></span>
    </div>
  </div>`;
}

const rowsFor = (s) => Math.min(14, Math.max(2, Math.ceil((s?.length ?? 0) / 90) + 1));

function wire(app, pageName, blocks) {
  const byKey = Object.fromEntries(blocks.map((b) => [b.block_key, b]));

  $$(".block", app).forEach((card) => {
    const key = card.dataset.block;
    const box = $(".block-text", card);
    const save = $("[data-save]", card);
    const state = $(".block-state", card);
    const original = byKey[key].text ?? byKey[key].original;

    // Save stays disabled until the words actually differ, so nobody saves a
    // no-op and then wonders why the page did not change.
    const check = () => {
      const dirty = box.value !== original;
      save.disabled = !dirty;
      state.textContent = dirty ? "Not saved yet" : "";
      state.className = dirty ? "block-state warn" : "block-state muted";
    };
    box.addEventListener("input", check);

    save.addEventListener("click", async () => {
      save.disabled = true;
      state.textContent = "Saving…";
      try {
        const res = await api.setSiteText(pageName, key, box.value);
        toastOk(res?.reverted
          ? "Back to the original wording."
          : "Saved. It will be on the website within about ten minutes.");
        await refresh();
      } catch (e) {
        state.textContent = "";
        save.disabled = false;
        toastErr(e.message);
      }
    });

    const revert = $("[data-revert]", card);
    if (revert) {
      revert.addEventListener("click", async () => {
        const ok = await confirmDialog(
          "Put the original wording back?",
          "This block will go back to what it said before anybody edited it. " +
          "Your version will not be kept.",
          "Put it back");
        if (!ok) return;
        try {
          // Blank means "revert" — the same path the database already takes for
          // an emptied box, rather than a second way of doing one thing.
          await api.setSiteText(pageName, key, "");
          toastOk("Original wording restored.");
          await refresh();
        } catch (e) {
          toastErr(e.message);
        }
      });
    }
  });
}


// =============================================================================
// Photographs
//
// One card, because there is one photograph anybody wants to change: the group
// picture on the front page, which is replaced about once a year. Anything the
// importer judged to be furniture — the logo, a tracking pixel — is not offered,
// because "which of these 40 images did you mean" is a worse screen than this.
// =============================================================================
function imagesCard(images) {
  if (!images.length) return "";

  return `<div class="card mt">
    <div class="card-head"><h3>Photographs</h3></div>
    <p class="muted">Pick a new picture and it appears on the website within
      about ten minutes, the same as the wording. Large photographs straight
      from a phone are fine — they are shrunk for you.</p>

    <div class="imagelist mt">${images.map((im) => {
      const changed = !!im.upload_path;
      return `<div class="imagerow" data-page="${esc(im.page)}" data-key="${esc(im.img_key)}">
        <img class="imagethumb"
             src="${changed ? esc(api.siteImageUrl(im.upload_path))
                            : esc("../" + im.original_src)}" alt="">
        <div class="imagemeta">
          <strong>${esc(TITLE[im.page] ?? im.page)}</strong>
          ${changed
            ? `<div><span class="badge badge-ok">New picture chosen</span></div>`
            : `<div class="muted tiny">The picture the site was set up with</div>`}
          <div class="btn-row mt">
            <label class="btn btn-sm btn-primary">
              Choose a picture…
              <input type="file" accept="image/jpeg,image/png,image/webp" hidden>
            </label>
            ${changed
              ? `<button class="btn btn-sm" data-revert-img>Put the old one back</button>`
              : ""}
            <span class="muted imagestate"></span>
          </div>
        </div>
      </div>`;
    }).join("")}</div>
  </div>`;
}

function wireImages(app) {
  $$(".imagerow", app).forEach((row) => {
    const { page, key } = row.dataset;
    const state = $(".imagestate", row);

    $('input[type="file"]', row)?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // 15MB is the bucket's own limit; saying so here saves a failed upload.
      if (file.size > 15 * 1024 * 1024) {
        return toastErr("That picture is too big — 15MB is the most it can take.");
      }

      state.textContent = "Uploading…";
      try {
        await api.uploadSiteImage(page, key, file);
        toastOk("Picture chosen. It will be on the website within about ten minutes.");
        await refresh();
      } catch (err) {
        state.textContent = "";
        toastErr(err.message);
      }
    });

    $("[data-revert-img]", row)?.addEventListener("click", async () => {
      const ok = await confirmDialog(
        "Put the original picture back?",
        "The website will go back to the photograph it was set up with.",
        "Put it back");
      if (!ok) return;
      try {
        await api.revertSiteImage(page, key);
        toastOk("Original picture restored.");
        await refresh();
      } catch (err) { toastErr(err.message); }
    });
  });
}
