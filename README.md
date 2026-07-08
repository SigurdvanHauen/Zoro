# Zoro — Annotation Exporter for Zotero

Zoro is a small Zotero plugin that exports the annotations from the **currently
open PDF** and copies them to the clipboard as **Markdown** (with a rich‑HTML
copy alongside for Word/Google Docs). It's built for a note‑taking workflow in
**Obsidian**, but the output pastes cleanly anywhere.

Target: **Zotero 7 – 9** (uses the standard bootstrapped‑plugin API that has been
stable since Zotero 7).

---

## Features

- **One‑click export** from a top‑level **Zoro** menu — always acts on the PDF in
  the active reader tab.
- **Highlights & underlines** → quoted text, with the annotation's **comment**
  and **tags**.
- **Color → meaning labels.** Instead of reproducing colors (which Markdown can't
  do), each annotation is labelled by what its Zotero color means:

  | Zotero color | Label |
  |--------------|-------|
  | 🟢 green (`#5fb236`)  | Study note |
  | 🔵 blue (`#2ea8e5`)   | Definition |
  | 🟡 yellow (`#ffd400`) | Minor question |
  | 🔴 red (`#ff6666`)    | Need clarification |

- **Grouped by PDF section.** Annotations are placed under a heading for the
  section (chapter/heading) they fall in, derived from the PDF's table‑of‑contents
  outline.
- **Filtered exports.** Export everything, a single category (color), or only the
  annotations whose comment contains a question mark.
- **Figures.** Area/image annotations are saved as PNG files to a folder you
  choose and embedded as Obsidian `![[figure.png]]` links.
- **Two clipboard flavors at once** — plain‑text Markdown (for Obsidian and any
  text editor) and rich HTML (for Word, Google Docs, OneNote, Outlook).

### The Zoro menu

- **Export all annotations**
- **Export study notes** (green only)
- **Export definitions** (blue only)
- **Export minor questions** (yellow only)
- **Export need clarifications** (red only)
- **Export questions** — any annotation, regardless of color, whose **comment
  contains one or more `?`**
- **Export from a section…** — a resizable dialog lists the PDF's outline with a
  checkbox per heading; tick **one or more** chapters/sections/subsections (with
  "Select all"/"Clear") and export only those parts (nested subsections included)
- **Set figure image folder…** — choose where exported figure PNGs are written

---

## Example output

```markdown
# Annotations — The Selfish Gene

## Chapter 2 · Replicators

### Study note — Page 12
> Genes are the fundamental unit of selection.

**Comment:** core thesis
**Tags:** evolution

### Minor question — Page 13
> Do memes really replicate like genes?

**Comment:** revisit this

### Definition — Page 14
![[The Selfish Gene-p14-ABCD1234.png|320]]

**Comment:** replicator diagram
```

`##` headings are PDF sections; `###` headings are `label — page`. Below each come
the quoted text (or an embedded figure), the comment, and tags. Empty lines are
omitted. Because the Markdown is plain text, a normal **Ctrl+V** works everywhere.

---

## Install

1. Build the package (from this folder, in PowerShell):

   ```powershell
   .\build.ps1
   ```

   This produces `build\zoro.xpi`.

2. In Zotero: **Tools → Plugins** → the gear icon (top‑right) →
   **Install Plugin From File…** → choose `build\zoro.xpi`.

3. Restart Zotero if prompted. A **Zoro** menu appears in the menu bar.

> **Updating:** remove the old Zoro in **Tools → Plugins** first, restart, then
> install the new `zoro.xpi`. The version shown in Tools → Plugins tells you which
> build is live.

---

## Use

1. Open a PDF in Zotero (double‑click a PDF attachment — it opens in a reader tab).
2. Menu bar → **Zoro** → pick **Export all annotations** (or a single category).
3. Paste (**Ctrl+V**) into your notes.

A brief popup confirms how many annotations were copied.

### Exporting figures

1. In the reader, use the **area/image annotation tool** (the rectangle select
   tool) to draw a box around a figure. Zotero renders it to an image.
2. The first time you export a PDF that contains an image annotation, Zoro asks
   for a **folder to save figure images**. Point it at your **Obsidian vault's
   attachments folder** so the `![[…]]` embeds resolve. The choice is remembered;
   change it later via **Zoro → Set figure image folder…**.
3. Export as usual. Each figure is copied into that folder and embedded in the
   Markdown as `![[<pdf title>-p<page>-<key>.png|<width>]]`. By default figures
   are embedded at **50%** of their natural width; change `IMAGE_SCALE` in
   `bootstrap.js` (e.g. `1` for full size).

Text‑only exports never touch the filesystem or prompt for a folder.

---

## Customization

Everything is plain JavaScript in `bootstrap.js`:

- **Menu items / filters** — the `MENU_ITEMS` array. Each entry is a filter spec:
  no key = all, `color: "#hex"` = one color, `questions: true` = comment contains
  `?`. Add or rename freely.
- **Color labels** — the `COLOR_LABELS` map (color hex → label). Add the other
  Zotero colors if you use them (purple `#a28ae5`, magenta `#e56eee`, orange
  `#f19837`, gray `#aaaaaa`). Unmapped colors fall back to their hex code.
- **Which annotation types** — `EXPORTED_TYPES` (currently `highlight`,
  `underline`, `image`).
- **Output layout** — `buildMarkdown()` (plain text) and `buildHtml()` (rich).

---

## Troubleshooting

Zoro logs everything with a `Zoro:` prefix. Turn on **Help → Debug Output
Logging**, run an export, and read the log:

- **Sections missing.** The section comes from the PDF's outline (the TOC tree in
  the reader's left sidebar). If the PDF has no outline, there's nothing to map —
  look for `PDF has no outline/bookmarks`. If it *does* have a TOC but sections
  still don't appear, look for `could not locate pdf.js document …` — the internal
  reader path differs on your Zotero version; the logged key list pins the fix.
- **Figures missing.** Look for `no cached image for annotation …` (the image
  annotation hasn't been rendered/cached — open it in the reader once) or
  `IOUtils/PathUtils unavailable` (unexpected on Zotero 7+).

---

## Development

No build toolchain — it's plain JavaScript. To iterate without re‑zipping, use a
proxy file so Zotero loads the source directly:

1. Find your Zotero profile folder (see `about:profiles` inside Zotero):
   `.../Zotero/Profiles/<random>.default/`.
2. In that profile, create a file `extensions/zoro-annotation-exporter@sigurd.local`
   (no extension) whose single line is the absolute path to this source folder:

   ```
   C:\Users\sivn\Documents\Code\Zoro
   ```

3. You may need, in the profile `prefs.js`:
   `user_pref("extensions.autoDisableScopes", 0);` and
   `user_pref("extensions.enableScopes", 15);` to allow unsigned dev plugins.
4. Restart Zotero. Edits to `bootstrap.js` take effect after **disable → enable**
   on the plugin (or a restart).

---

## Project layout

| File | Purpose |
|------|---------|
| `manifest.json` | Plugin metadata and Zotero version compatibility |
| `bootstrap.js`  | All plugin logic (menu, export, sections, figures) |
| `build.ps1`     | Packages `build/zoro.xpi` |
| `README.md`     | This file |
