/* Zoro Annotation Exporter — Zotero 7 bootstrapped plugin
 *
 * Adds a top-level "Zoro" menu with an action that reads all
 * highlight/underline annotations from the currently open PDF,
 * formats them as Markdown (text + comment + color + type), and
 * copies the result to the system clipboard.
 */

var Zoro = {
	id: null,
	version: null,
	rootURI: null,

	MENU_ID: "zoro-menubar",

	// Annotation types we export. "image" = area/figure annotations, whose
	// rendered PNG is saved to disk and embedded (see IMAGE_FOLDER_PREF).
	EXPORTED_TYPES: ["highlight", "underline", "image"],

	// Pref (full name) holding the folder where figure images are written.
	IMAGE_FOLDER_PREF: "extensions.zoro.imageFolder",

	// Figure embeds are scaled to this fraction of the image's natural width
	// (0.5 = half size / "50% smaller"). Set to 1 to embed at full size.
	IMAGE_SCALE: 0.5,

	// Map each Zotero annotation color to a semantic label. Keys are lowercase
	// hex. Zotero's defaults: green #5fb236, blue #2ea8e5, yellow #ffd400,
	// red #ff6666, purple #a28ae5, magenta #e56eee, orange #f19837, gray #aaaaaa.
	COLOR_LABELS: {
		"#5fb236": "Study note",         // green
		"#2ea8e5": "Definition",         // blue
		"#ffd400": "Minor question",     // yellow
		"#ff6666": "Need clarification", // red
	},

	// The items shown under the "Zoro" menu. Each item is a filter spec passed
	// to exportCurrent(): no `color`/`questions` key exports everything; `color`
	// restricts to that Zotero color; `questions: true` restricts to annotations
	// whose comment contains a "?". A `separator` entry renders a divider.
	MENU_ITEMS: [
		{ label: "Export all annotations" },
		{ separator: true },
		{ label: "Export study notes", color: "#5fb236" },
		{ label: "Export definitions", color: "#2ea8e5" },
		{ label: "Export minor questions", color: "#ffd400" },
		{ label: "Export need clarifications", color: "#ff6666" },
		{ separator: true },
		{ label: "Export questions", questions: true },
		{ label: "Export from a section…", chooseSection: true },
		{ separator: true },
		{ label: "Set figure image folder…", action: "setFolder" },
	],

	log(msg) {
		Zotero.debug("Zoro: " + msg);
	},

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
	},

	// ---- UI wiring -------------------------------------------------------

	addToWindow(window) {
		const doc = window.document;
		if (doc.getElementById(this.MENU_ID)) return; // already added

		const menubar = doc.getElementById("main-menubar");
		if (!menubar) {
			this.log("main-menubar not found; skipping window");
			return;
		}

		const menu = doc.createXULElement("menu");
		menu.id = this.MENU_ID;
		menu.setAttribute("label", "Zoro");

		const popup = doc.createXULElement("menupopup");
		menu.appendChild(popup);

		for (const spec of this.MENU_ITEMS) {
			if (spec.separator) {
				popup.appendChild(doc.createXULElement("menuseparator"));
				continue;
			}
			const item = doc.createXULElement("menuitem");
			item.setAttribute("label", spec.label);
			item.addEventListener("command", () => {
				const run = spec.action === "setFolder"
					? this.setImageFolder(window)
					: this.exportCurrent(window, spec);
				Promise.resolve(run).catch((e) => {
					this.log("action failed: " + e + "\n" + (e && e.stack));
					this.popup(window, "Zoro — Error", String(e && e.message || e));
				});
			});
			popup.appendChild(item);
		}

		menubar.appendChild(menu);
		this.log("menu added to window");
	},

	removeFromWindow(window) {
		const doc = window.document;
		const menu = doc.getElementById(this.MENU_ID);
		if (menu) menu.remove();
	},

	addToAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) this.addToWindow(win);
		}
	},

	removeFromAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) this.removeFromWindow(win);
		}
	},

	// ---- Export logic ----------------------------------------------------

	// spec: a filter from MENU_ITEMS. {} exports every highlight/underline;
	// { color } restricts to a Zotero color; { questions: true } restricts to
	// annotations whose comment contains a "?"; { chooseSection: true } prompts
	// for an outline section and exports only that section (and its subsections).
	async exportCurrent(window, spec) {
		spec = spec || {};
		const Zotero_Tabs = window.Zotero_Tabs;
		if (!Zotero_Tabs || Zotero_Tabs.selectedType !== "reader") {
			this.popup(window, "Zoro", "No PDF is open. Open a PDF in a reader tab first.");
			return;
		}

		const reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
		if (!reader) {
			this.popup(window, "Zoro", "Could not find the reader for the current tab.");
			return;
		}

		const attachment = Zotero.Items.get(reader.itemID);
		if (!attachment) {
			this.popup(window, "Zoro", "Could not resolve the PDF attachment item.");
			return;
		}

		let annotations = attachment.getAnnotations();
		// Reading order.
		annotations.sort((a, b) =>
			String(a.annotationSortIndex).localeCompare(String(b.annotationSortIndex))
		);

		const filterColor = spec.color ? spec.color.toLowerCase() : null;
		const wanted = annotations.filter((a) => {
			if (!this.EXPORTED_TYPES.includes(a.annotationType)) return false;
			if (filterColor
				&& String(a.annotationColor || "").toLowerCase() !== filterColor) return false;
			if (spec.questions && !/\?/.test(a.annotationComment || "")) return false;
			return true;
		});

		if (wanted.length === 0) {
			let none;
			if (filterColor) {
				none = `No "${this.colorLabel(filterColor)}" annotations found in this PDF.`;
			}
			else if (spec.questions) {
				none = `No annotations with a question mark in the comment found in this PDF.`;
			}
			else {
				none = `No highlight, underline, or image annotations found in this PDF.`;
			}
			this.popup(window, "Zoro", none);
			return;
		}

		// Best-effort: map each annotation's page to a PDF outline section.
		let sectionMap = null;
		try {
			sectionMap = await this.buildSectionMap(reader);
		}
		catch (e) {
			this.log("section map failed: " + e + "\n" + (e && e.stack));
		}

		// Restrict to a single outline section (plus its subsections) if asked.
		let selected = wanted;
		let chosenTitle = "";
		if (spec.chooseSection) {
			if (!sectionMap || !sectionMap.length) {
				this.popup(window, "Zoro",
					"This PDF has no table-of-contents outline, so there are no sections to choose from.");
				return;
			}
			const choice = await this.promptSectionSelection(window, sectionMap);
			if (!choice || choice.sections.length === 0) return; // cancelled / none

			const ranges = choice.sections.map((i) => this.sectionRange(sectionMap, i));
			const colorSet = (choice.colors || []).map((c) => c.toLowerCase());
			selected = wanted.filter((a) => {
				const p = this.pageIndexOf(a);
				if (p === null || !ranges.some((r) => p >= r.start && p < r.end)) return false;
				if (colorSet.length
					&& !colorSet.includes(String(a.annotationColor || "").toLowerCase())) {
					return false;
				}
				return true;
			});
			chosenTitle = choice.sections.length === 1
				? sectionMap[choice.sections[0]].title
				: `${choice.sections.length} sections`;

			if (selected.length === 0) {
				this.popup(window, "Zoro", `No matching annotations in the selected section(s).`);
				return;
			}
		}
		const wantedFinal = selected;

		// Save any figure/area annotation images to the configured folder.
		let imageMap = {};
		try {
			imageMap = await this.saveImages(wantedFinal, attachment, window);
		}
		catch (e) {
			this.log("saving images failed: " + e + "\n" + (e && e.stack));
		}

		const plain = this.buildMarkdown(attachment, wantedFinal, sectionMap, imageMap);
		const html = this.buildHtml(attachment, wantedFinal, sectionMap, imageMap);
		this.copyRichText(html, plain);

		const sectionNote = chosenTitle
			? ` from "${chosenTitle}"`
			: (sectionMap && sectionMap.length ? ` (with sections)` : "");
		this.popup(
			window,
			"Zoro",
			`Copied ${wantedFinal.length} annotation${wantedFinal.length === 1 ? "" : "s"} to the clipboard${sectionNote}.`
		);
	},

	// Markdown version. Each annotation is labelled by what its Zotero color
	// means (see COLOR_LABELS) and its text is shown as a blockquote.
	// Annotations are grouped under a heading for the PDF section they fall in.
	buildMarkdown(attachment, annotations, sectionMap, imageMap) {
		imageMap = imageMap || {};
		const parent = attachment.parentItem;
		const title = parent ? parent.getDisplayTitle() : attachment.getDisplayTitle();

		const lines = [`# Annotations — ${title}`, ""];

		let lastSection = null;
		for (const a of annotations) {
			const section = this.sectionFor(a, sectionMap);
			if (section !== lastSection) {
				lastSection = section;
				if (section) {
					lines.push(`## ${section}`);
					lines.push("");
				}
			}

			const label = this.colorLabel(a.annotationColor);
			const page = a.annotationPageLabel || this.pageFromPosition(a);
			const pageStr = page ? `Page ${page}` : "Page ?";

			lines.push(`### ${label} — ${pageStr}`);

			if (a.annotationType === "image") {
				const img = imageMap[a.key];
				if (img) {
					lines.push(img.width
						? `![[${img.name}|${img.width}]]`
						: `![[${img.name}]]`);
				}
			}
			else {
				const text = (a.annotationText || "").trim();
				if (text) {
					for (const ln of text.split(/\r?\n/)) {
						lines.push(`> ${ln}`);
					}
				}
			}

			const comment = (a.annotationComment || "").trim();
			const tags = this.getTagText(a);
			if (comment || tags) {
				lines.push("");
				if (comment) lines.push(`**Comment:** ${comment}`);
				if (tags) lines.push(`**Tags:** ${tags}`);
			}

			lines.push("");
		}

		return lines.join("\n").trimEnd() + "\n";
	},

	// Rich-text (HTML) version for Word / Google Docs / OneNote / Outlook.
	// Each annotation is labelled by its Zotero color meaning (COLOR_LABELS)
	// and grouped under a heading for the PDF section it falls in.
	buildHtml(attachment, annotations, sectionMap, imageMap) {
		imageMap = imageMap || {};
		const parent = attachment.parentItem;
		const title = parent ? parent.getDisplayTitle() : attachment.getDisplayTitle();

		const parts = [`<h2>Annotations — ${this.escapeHtml(title)}</h2>`];

		let lastSection = null;
		for (const a of annotations) {
			const rawSection = this.sectionFor(a, sectionMap);
			if (rawSection !== lastSection) {
				lastSection = rawSection;
				if (rawSection) {
					parts.push(`<h3>${this.escapeHtml(rawSection)}</h3>`);
				}
			}

			const label = this.escapeHtml(this.colorLabel(a.annotationColor));
			const text = this.escapeHtml((a.annotationText || "").trim());
			const comment = this.escapeHtml((a.annotationComment || "").trim());
			const tags = this.escapeHtml(this.getTagText(a));
			const page = a.annotationPageLabel || this.pageFromPosition(a);
			const pageStr = page ? `Page ${page}` : "Page ?";

			let block = `<p style="margin:0 0 10px 0;">`;
			block += `<strong>${label}</strong> `;
			block += `<span style="color:#888888; font-size:0.9em;">— ${pageStr}</span><br>`;
			if (a.annotationType === "image") {
				const img = imageMap[a.key];
				if (img) {
					const wattr = img.width ? ` width="${img.width}"` : "";
					block += `<img src="${this.fileUrl(img.path)}" alt="figure"${wattr} `
						+ `style="max-width:100%;">`;
				}
			}
			else if (text) {
				block += `<em>${text}</em>`;
			}
			if (comment) {
				block += `<br><span style="color:#888888;">Comment:</span> ${comment}`;
			}
			if (tags) {
				block += `<br><span style="color:#888888;">Tags:</span> ${tags}`;
			}
			block += `</p>`;
			parts.push(block);
		}

		return parts.join("\n");
	},

	// Comma-separated list of the annotation's tags (empty string if none).
	getTagText(annotation) {
		try {
			return (annotation.getTags() || [])
				.map((t) => t.tag)
				.filter(Boolean)
				.join(", ");
		}
		catch (e) {
			return "";
		}
	},

	escapeHtml(s) {
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;");
	},

	// Semantic label for an annotation's color (see COLOR_LABELS). Unmapped
	// colors fall back to their hex value so nothing is silently dropped.
	colorLabel(hex) {
		const key = String(hex || "").toLowerCase();
		return this.COLOR_LABELS[key] || key || "Note";
	},

	// 0-based page index of an annotation (null if unknown).
	pageIndexOf(annotation) {
		try {
			const pos = annotation.annotationPosition;
			const obj = typeof pos === "string" ? JSON.parse(pos) : pos;
			if (obj && typeof obj.pageIndex === "number") {
				return obj.pageIndex;
			}
		} catch (e) {
			/* ignore */
		}
		return null;
	},

	pageFromPosition(annotation) {
		const idx = this.pageIndexOf(annotation);
		return idx === null ? "" : String(idx + 1);
	},

	// ---- PDF outline / section detection --------------------------------
	//
	// The section an annotation sits in is NOT stored on the annotation. We
	// derive it from the PDF's outline (table of contents): for each outline
	// heading we resolve its destination page, then each annotation inherits
	// the nearest heading at or before its page. Requires the PDF to actually
	// have an embedded outline, and reaches into the reader's internal pdf.js
	// document — hence best-effort with logging and graceful fallback.

	// Returns a sorted array of { pageIndex, title } or null if unavailable.
	async buildSectionMap(reader) {
		const pdfDocument = await this.getPdfDocument(reader);
		if (!pdfDocument) {
			this.log("no pdf.js document found on reader; skipping sections");
			return null;
		}

		let outline;
		try {
			outline = await pdfDocument.getOutline();
		}
		catch (e) {
			this.log("getOutline() threw: " + e);
			return null;
		}
		if (!outline || !outline.length) {
			this.log("PDF has no outline/bookmarks; skipping sections");
			return null;
		}

		const entries = [];
		const walk = async (items, depth) => {
			for (const it of items) {
				const pageIndex = await this.resolveDestPage(pdfDocument, it.dest);
				if (pageIndex !== null && it.title) {
					entries.push({ pageIndex, title: String(it.title).trim(), depth });
				}
				if (it.items && it.items.length) {
					await walk(it.items, depth + 1);
				}
			}
		};
		await walk(outline, 0);

		entries.sort((a, b) => a.pageIndex - b.pageIndex);
		this.log(`built section map with ${entries.length} heading(s)`);
		return entries;
	},

	// Resolve a pdf.js outline destination to a 0-based page index (or null).
	async resolveDestPage(pdfDocument, dest) {
		try {
			let explicit = dest;
			if (typeof dest === "string") {
				explicit = await pdfDocument.getDestination(dest);
			}
			if (!Array.isArray(explicit) || !explicit.length) return null;
			const ref = explicit[0];
			if (typeof ref === "number") return ref;
			if (ref && typeof ref === "object") {
				return await pdfDocument.getPageIndex(ref);
			}
		}
		catch (e) {
			/* unresolved destination — ignore */
		}
		return null;
	},

	// Probe the reader for its internal pdf.js document (something exposing
	// getOutline + getPageIndex). Paths differ across Zotero versions, so we
	// try several and log what we see.
	async getPdfDocument(reader) {
		try {
			if (reader._initPromise) await reader._initPromise;
		}
		catch (e) { /* ignore */ }

		const ir = reader._internalReader
			|| (reader._iframeWindow && reader._iframeWindow.wrappedJSObject
				&& reader._iframeWindow.wrappedJSObject._reader);
		if (!ir) {
			this.log("reader._internalReader not found; keys: "
				+ this.safeKeys(reader));
			return null;
		}

		const views = [
			ir._primaryView,
			ir._view,
			ir._lastView,
			ir._secondaryView,
		].filter(Boolean);

		if (!views.length) {
			this.log("no view on internal reader; keys: " + this.safeKeys(ir));
		}

		const candidates = [];
		for (const v of views) {
			candidates.push(v._pdfDocument, v._pdfjsDocument, v.pdfDocument, v._document);
			const iw = v._iframeWindow;
			if (iw) {
				const w = iw.wrappedJSObject || iw;
				candidates.push(
					w.PDFViewerApplication && w.PDFViewerApplication.pdfDocument,
					w.pdfDocument,
					w._pdfDocument
				);
			}
		}

		for (const c of candidates) {
			if (c && typeof c.getOutline === "function") {
				this.log("found pdf.js document");
				return c;
			}
		}

		this.log("could not locate pdf.js document; view keys: "
			+ views.map((v) => this.safeKeys(v)).join(" | "));
		return null;
	},

	safeKeys(obj) {
		try {
			return Object.keys(obj).slice(0, 40).join(",");
		}
		catch (e) {
			return "<unavailable>";
		}
	},

	// Nearest outline heading at or before the annotation's page.
	sectionFor(annotation, sectionMap) {
		if (!sectionMap || !sectionMap.length) return "";
		const p = this.pageIndexOf(annotation);
		if (p === null) return "";
		let current = "";
		for (const e of sectionMap) {
			if (e.pageIndex <= p) current = e.title;
			else break;
		}
		return current;
	},

	// Multi-select picker. Returns { sections: [indices], colors: [hex] } or null
	// if cancelled. Uses a custom resizable dialog with checkboxes; falls back to
	// the single-select prompt (no category filter) if that can't be shown.
	async promptSectionSelection(window, sectionMap) {
		try {
			return await this._sectionDialog(window, sectionMap);
		}
		catch (e) {
			this.log("custom section dialog failed, using single-select: " + e);
			const idx = await this.promptSection(window, sectionMap);
			return idx === null ? null : { sections: [idx], colors: [] };
		}
	},

	_sectionDialog(window, sectionMap) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const done = (val) => { if (!settled) { settled = true; resolve(val); } };

			let dlg;
			try {
				dlg = window.openDialog(
					"about:blank", "zoro-sections",
					"chrome,dialog,resizable,centerscreen,width=580,height=720"
				);
			}
			catch (e) { reject(e); return; }
			if (!dlg) { reject(new Error("openDialog returned null")); return; }

			const build = () => {
				try {
					const doc = dlg.document;
					doc.title = "Zoro — Export sections";
					const b = doc.body;
					b.style.margin = "0";
					b.style.height = "100vh";
					b.style.display = "flex";
					b.style.flexDirection = "column";
					b.style.font = "13px sans-serif";
					b.style.color = "CanvasText";
					b.style.background = "Canvas";
					b.style.colorScheme = "light dark";

					const header = doc.createElement("div");
					header.textContent =
						"Choose one or more sections to export (subsections are included):";
					header.style.padding = "10px 12px";
					b.appendChild(header);

					// Category (color) filter — optional.
					const catWrap = doc.createElement("div");
					catWrap.style.padding = "0 12px 8px";
					const catTitle = doc.createElement("div");
					catTitle.textContent =
						"Categories (leave all unchecked to include every category):";
					catTitle.style.margin = "0 0 4px";
					catWrap.appendChild(catTitle);
					const catBox = doc.createElement("div");
					catBox.style.display = "flex";
					catBox.style.flexWrap = "wrap";
					catBox.style.gap = "14px";
					const catChecks = [];
					for (const [hex, label] of Object.entries(this.COLOR_LABELS)) {
						const cl = doc.createElement("label");
						cl.style.whiteSpace = "nowrap";
						const cc = doc.createElement("input");
						cc.type = "checkbox";
						cc.value = hex;
						cc.style.marginRight = "5px";
						cl.appendChild(cc);
						cl.appendChild(doc.createTextNode(label));
						catBox.appendChild(cl);
						catChecks.push(cc);
					}
					catWrap.appendChild(catBox);
					b.appendChild(catWrap);

					const listWrap = doc.createElement("div");
					listWrap.style.flex = "1";
					listWrap.style.overflow = "auto";
					listWrap.style.borderTop = "1px solid #8886";
					listWrap.style.borderBottom = "1px solid #8886";
					listWrap.style.padding = "6px 12px";
					b.appendChild(listWrap);

					const checkboxes = [];
					sectionMap.forEach((e, i) => {
						const row = doc.createElement("label");
						row.style.display = "block";
						row.style.padding = "3px 0";
						row.style.whiteSpace = "nowrap";
						const cb = doc.createElement("input");
						cb.type = "checkbox";
						cb.value = String(i);
						cb.style.marginRight = "8px";
						cb.style.marginLeft = (e.depth * 20) + "px";
						row.appendChild(cb);
						row.appendChild(
							doc.createTextNode(`${e.title}  (p.${e.pageIndex + 1})`));
						listWrap.appendChild(row);
						checkboxes.push(cb);
					});

					const footer = doc.createElement("div");
					footer.style.display = "flex";
					footer.style.justifyContent = "space-between";
					footer.style.padding = "10px 12px";

					const left = doc.createElement("div");
					const selAll = doc.createElement("button");
					selAll.textContent = "Select all";
					selAll.onclick = () => checkboxes.forEach((c) => { c.checked = true; });
					const selNone = doc.createElement("button");
					selNone.textContent = "Clear";
					selNone.style.marginLeft = "6px";
					selNone.onclick = () => checkboxes.forEach((c) => { c.checked = false; });
					left.appendChild(selAll);
					left.appendChild(selNone);

					const right = doc.createElement("div");
					const cancel = doc.createElement("button");
					cancel.textContent = "Cancel";
					cancel.onclick = () => { done(null); dlg.close(); };
					const ok = doc.createElement("button");
					ok.textContent = "Export";
					ok.style.marginLeft = "6px";
					ok.style.fontWeight = "bold";
					ok.onclick = () => {
						const sections = checkboxes
							.filter((c) => c.checked)
							.map((c) => parseInt(c.value, 10));
						const colors = catChecks
							.filter((c) => c.checked)
							.map((c) => c.value);
						done({ sections, colors });
						dlg.close();
					};
					right.appendChild(cancel);
					right.appendChild(ok);

					footer.appendChild(left);
					footer.appendChild(right);
					b.appendChild(footer);

					dlg.addEventListener("unload", () => done(null));
				}
				catch (e) {
					reject(e);
					try { dlg.close(); } catch (_) { /* ignore */ }
				}
			};

			if (dlg.document && dlg.document.readyState === "complete") {
				build();
			}
			else {
				dlg.addEventListener("load", build, { once: true });
			}
		});
	},

	// Show the outline as a picker; returns the chosen index into sectionMap
	// (in page order) or null if cancelled. Titles are indented by depth.
	async promptSection(window, sectionMap) {
		const list = sectionMap.map((e) =>
			`${"    ".repeat(e.depth)}${e.title}  (p.${e.pageIndex + 1})`
		);
		const prompts = (typeof Services !== "undefined" && Services.prompt)
			? Services.prompt
			: Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
				.getService(Components.interfaces.nsIPromptService);

		const out = { value: 0 };
		const title = "Zoro — Export from section";
		const text = "Choose a section to export (includes its subsections):";

		let ok;
		try {
			// Classic scriptable signature includes the count argument.
			ok = prompts.select(window, title, text, list.length, list, out);
		}
		catch (e) {
			// Newer Gecko dropped the count argument.
			ok = prompts.select(window, title, text, list, out);
		}
		return ok ? out.value : null;
	},

	// Page range [start, end) covered by the section at sectionMap[idx],
	// extending until the next heading at the same or shallower depth so that
	// nested subsections are included.
	sectionRange(sectionMap, idx) {
		const chosen = sectionMap[idx];
		let end = Infinity;
		for (let i = idx + 1; i < sectionMap.length; i++) {
			if (sectionMap[i].depth <= chosen.depth) {
				end = sectionMap[i].pageIndex;
				break;
			}
		}
		return { start: chosen.pageIndex, end };
	},

	// ---- Figure / image annotations -------------------------------------
	//
	// Zotero renders each area/image annotation to a cached PNG. We copy that
	// PNG into the user's chosen folder (ideally an Obsidian attachments
	// folder) and return a map of annotation key -> { name, path } so the
	// builders can embed it. Prompts for the folder only if image annotations
	// are actually present. Best-effort with logging.
	async saveImages(annotations, attachment, window) {
		const images = annotations.filter((a) => a.annotationType === "image");
		if (!images.length) return {};

		if (typeof IOUtils === "undefined" || typeof PathUtils === "undefined") {
			this.log("IOUtils/PathUtils unavailable; cannot save images");
			return {};
		}

		const folder = await this.getImageFolder(window, true);
		if (!folder) {
			this.log("no image folder chosen; skipping figure images");
			return {};
		}

		const parent = attachment.parentItem;
		const base = this.sanitizeFilename(
			(parent ? parent.getDisplayTitle() : attachment.getDisplayTitle()) || "pdf"
		);

		const map = {};
		for (const a of images) {
			try {
				let src = Zotero.Annotations && Zotero.Annotations.getCacheImagePath
					? Zotero.Annotations.getCacheImagePath(a)
					: null;
				src = await src; // tolerate a promise or a plain string
				if (!src || !(await IOUtils.exists(src))) {
					this.log("no cached image for annotation " + a.key + " (" + src + ")");
					continue;
				}
				const page = a.annotationPageLabel || this.pageFromPosition(a) || "x";

				// Detect the format + natural size so the embed can be scaled.
				let info = { format: "", width: 0, height: 0 };
				try {
					const header = await IOUtils.read(src, { maxBytes: 65536 });
					info = this.imageSize(header);
				}
				catch (e) {
					this.log("could not read image header for " + a.key + ": " + e);
				}

				const ext = info.format === "jpeg" ? "jpg" : "png";
				const name = `${base}-p${page}-${a.key}.${ext}`;
				const dest = PathUtils.join(folder, name);
				await IOUtils.copy(src, dest);

				const width = info.width > 0
					? Math.max(1, Math.round(info.width * this.IMAGE_SCALE))
					: null;
				this.log(`image ${a.key}: format=${info.format || "?"} `
					+ `natW=${info.width} scaledW=${width}`);
				map[a.key] = { name, path: dest, width };
			}
			catch (e) {
				this.log("failed to save image for " + a.key + ": " + e);
			}
		}

		this.log(`saved ${Object.keys(map).length}/${images.length} figure image(s)`);
		return map;
	},

	// Detect image format and natural pixel dimensions from the leading bytes.
	// Supports PNG and JPEG (the two formats Zotero uses for annotation images).
	// Returns { format, width, height }; width/height are 0 if undetermined.
	imageSize(bytes) {
		// PNG: 8-byte signature, then IHDR with width/height as big-endian uint32.
		if (bytes.length >= 24
			&& bytes[0] === 0x89 && bytes[1] === 0x50
			&& bytes[2] === 0x4E && bytes[3] === 0x47) {
			const w = (bytes[16] * 0x1000000) + (bytes[17] << 16)
				+ (bytes[18] << 8) + bytes[19];
			const h = (bytes[20] * 0x1000000) + (bytes[21] << 16)
				+ (bytes[22] << 8) + bytes[23];
			return { format: "png", width: w, height: h };
		}

		// JPEG: scan segments for a Start-Of-Frame marker (SOFn).
		if (bytes.length > 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
			let off = 2;
			while (off + 9 < bytes.length) {
				if (bytes[off] !== 0xFF) { off++; continue; }
				const marker = bytes[off + 1];
				if (marker === 0xFF) { off++; continue; }
				const isSOF = marker >= 0xC0 && marker <= 0xCF
					&& marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
				if (isSOF) {
					const h = (bytes[off + 5] << 8) + bytes[off + 6];
					const w = (bytes[off + 7] << 8) + bytes[off + 8];
					return { format: "jpeg", width: w, height: h };
				}
				const len = (bytes[off + 2] << 8) + bytes[off + 3];
				if (len < 2) break;
				off += 2 + len;
			}
			return { format: "jpeg", width: 0, height: 0 };
		}

		return { format: "", width: 0, height: 0 };
	},

	async getImageFolder(window, promptIfMissing) {
		let folder = "";
		try {
			folder = Zotero.Prefs.get(this.IMAGE_FOLDER_PREF, true) || "";
		}
		catch (e) { /* not set */ }

		if (folder) {
			try {
				if (await IOUtils.exists(folder)) return folder;
			}
			catch (e) { /* fall through to prompt */ }
		}
		return promptIfMissing ? await this.setImageFolder(window) : null;
	},

	async setImageFolder(window) {
		const path = await this.pickFolder(
			window,
			"Choose a folder for exported figure images (e.g. your Obsidian attachments folder)"
		);
		if (!path) return null;
		Zotero.Prefs.set(this.IMAGE_FOLDER_PREF, path, true);
		this.popup(window, "Zoro", "Figure images will be saved to:\n" + path);
		return path;
	},

	async pickFolder(window, title) {
		const Ci = Components.interfaces;
		const fp = Components.classes["@mozilla.org/filepicker;1"]
			.createInstance(Ci.nsIFilePicker);
		try {
			fp.init(window, title, Ci.nsIFilePicker.modeGetFolder);
		}
		catch (e) {
			// Newer Gecko wants a browsingContext instead of a window.
			fp.init(window.browsingContext, title, Ci.nsIFilePicker.modeGetFolder);
		}
		const result = await new Promise((resolve) => fp.open(resolve));
		if (result !== Ci.nsIFilePicker.returnOK) return null;
		return fp.file.path;
	},

	sanitizeFilename(name) {
		return String(name)
			.replace(/[\\/:*?"<>|]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 80) || "pdf";
	},

	fileUrl(path) {
		try {
			const f = Components.classes["@mozilla.org/file/local;1"]
				.createInstance(Components.interfaces.nsIFile);
			f.initWithPath(path);
			return Services.io.newFileURI(f).spec;
		}
		catch (e) {
			return "file:///" + String(path).replace(/\\/g, "/");
		}
	},

	// Plain-text-only fallback.
	copyToClipboard(text) {
		Components.classes["@mozilla.org/widget/clipboardhelper;1"]
			.getService(Components.interfaces.nsIClipboardHelper)
			.copyString(text);
	},

	// Put BOTH an HTML flavor and a plain-text flavor on the clipboard so that
	// rich editors get real colored highlighting while plain editors still get
	// readable text. Falls back to plain-only if the transferable API misbehaves.
	copyRichText(html, plain) {
		const Cc = Components.classes;
		const Ci = Components.interfaces;

		try {
			const trans = Cc["@mozilla.org/widget/transferable;1"]
				.createInstance(Ci.nsITransferable);
			trans.init(null);

			const add = (flavor, data) => {
				const s = Cc["@mozilla.org/supports-string;1"]
					.createInstance(Ci.nsISupportsString);
				s.data = data;
				trans.addDataFlavor(flavor);
				// Newer Gecko drops the length arg; older wants it. Try both.
				try {
					trans.setTransferData(flavor, s, data.length * 2);
				}
				catch (e) {
					trans.setTransferData(flavor, s);
				}
			};

			add("text/html", html);
			// Flavor name for plain text changed across Gecko versions; try both.
			try { add("text/plain", plain); }
			catch (e) { add("text/unicode", plain); }

			const clipboard = (typeof Services !== "undefined" && Services.clipboard)
				? Services.clipboard
				: Cc["@mozilla.org/widget/clipboard;1"].getService(Ci.nsIClipboard);

			clipboard.setData(trans, null, Ci.nsIClipboard.kGlobalClipboard);
		}
		catch (e) {
			this.log("rich copy failed, using plain text: " + e);
			this.copyToClipboard(plain);
		}
	},

	popup(window, headline, body) {
		try {
			const pw = new Zotero.ProgressWindow({ window });
			pw.changeHeadline(headline);
			pw.addDescription(body);
			pw.show();
			pw.startCloseTimer(4000);
		} catch (e) {
			this.log("popup failed, falling back to alert: " + e);
			window.alert(headline + "\n\n" + body);
		}
	},
};

// ---- Bootstrap lifecycle -------------------------------------------------

function install() {}

async function startup({ id, version, rootURI }) {
	await Zotero.initializationPromise;
	Zoro.init({ id, version, rootURI });
	Zoro.addToAllWindows();
	Zoro.log("started");
}

function onMainWindowLoad({ window }) {
	Zoro.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	Zoro.removeFromWindow(window);
}

function shutdown() {
	Zoro.removeFromAllWindows();
	Zoro.log("shut down");
	Zoro = undefined;
}

function uninstall() {}
