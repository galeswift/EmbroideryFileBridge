"use strict";

// ------------------------------------------------------------ helpers

const $ = (sel) => document.querySelector(sel);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

const ICONS = {
  check: '<path d="m5 12 5 5L20 7"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  hoop: '<rect x="10" y="2" width="4" height="3" rx=".8"/><circle cx="12" cy="13.5" r="8.5"/><path class="stitch" d="M7.5 14.5q2.25-3.2 4.5 0t4.5 0"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  home: '<path d="m4 11 8-7 8 7v9h-5v-6H9v6H4z"/>',
  alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
};
function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name];
  return s;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function timeAgo(epoch) {
  const s = Math.max(0, Date.now() / 1000 - epoch);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(epoch * 1000).toLocaleDateString();
}

const fmtDate = (epoch) =>
  new Date(epoch * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const ext = (name) => (name.includes(".") ? name.split(".").pop().toUpperCase() : "");

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private mode etc. */ }
  return null;
}

async function api(url, body) {
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message, kind = "") {
  const el = h("div", { class: `toast ${kind}` }, message);
  $("#toasts").append(el);
  setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 300); },
    kind === "error" ? 6000 : 3500);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// -------------------------------------------------------------- state

const state = {
  path: "",
  entries: [],
  status: null,
  selected: new Set(),
  anchor: null,           // last clicked path, for shift-click ranges
  view: store("view") || "grid",
  sort: store("sort") || "name",
  query: "",
  uploading: false,
  lastPayload: "",
};

// Preview results keyed by path+size+mtime; `null` means "no preview".
const previews = new Map();
const previewKey = (e) => `${e.path}|${e.size}|${e.mtime}`;

function visibleEntries() {
  const q = state.query.trim().toLowerCase();
  const list = state.entries.filter((e) => !q || e.name.toLowerCase().includes(q));
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const cmp = {
    name: byName,
    newest: (a, b) => b.mtime - a.mtime || byName(a, b),
    size: (a, b) => (b.size || 0) - (a.size || 0) || byName(a, b),
  }[state.sort];
  const folders = list.filter((e) => e.type === "folder").sort(state.sort === "newest" ? cmp : byName);
  const files = list.filter((e) => e.type === "file").sort(cmp);
  return [...folders, ...files];
}

// ------------------------------------------------------------ loading

function pathFromHash() {
  return location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent).join("/");
}

function navigate(path) {
  const hash = "#/" + path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  if (location.hash !== hash) location.hash = hash;
  else load();
}

async function load({ quiet = false } = {}) {
  const path = pathFromHash();
  let data;
  try {
    data = await api(`/api/files?path=${encodeURIComponent(path)}`);
  } catch (err) {
    if (quiet) return;
    toast(err.message, "error");
    if (path) navigate("");
    return;
  }
  const changedFolder = path !== state.path;
  const payload = JSON.stringify([data.path, data.entries, data.status]);
  if (!changedFolder && payload === state.lastPayload) return;
  state.lastPayload = payload;
  state.path = data.path;
  state.entries = data.entries;
  state.status = data.status;
  if (changedFolder) {
    state.selected.clear();
    state.anchor = null;
    state.query = "";
    $("#search").value = "";
  } else {
    const present = new Set(data.entries.map((e) => e.path));
    for (const p of state.selected) if (!present.has(p)) state.selected.delete(p);
  }
  render();
  refreshViewer();
}

// Keep an open preview in step with the latest listing (e.g. its status).
function refreshViewer() {
  if (!$("#viewer").open || !viewer.entry) return;
  const path = viewer.entry.path;
  viewer.files = visibleEntries().filter((e) => e.type === "file");
  const i = viewer.files.findIndex((e) => e.path === path);
  if (i < 0) $("#viewer").close();
  else showViewer(i);
}

// ---------------------------------------------------------- rendering

function render() {
  renderStatus();
  renderCrumbs();
  renderItems();
  renderSelection();
}

function renderStatus() {
  const s = state.status;
  const box = $("#status");
  box.replaceChildren();
  if (!s) return;
  const machine = s.machine === true ? ["on", "Machine connected"]
    : s.machine === false ? ["", "Machine not connected"] : ["", "Machine status unknown"];
  box.append(h("span", { class: `pill ${machine[0]}` }, h("span", { class: "dot" }), machine[1]));
  if (s.pending) {
    box.append(h("span", { class: "pill wait", title: "Being added to the machine's USB drive; this takes a few seconds." },
      icon("clock"), `Updating USB drive (${s.pending})`));
  } else if (s.last_sync) {
    box.append(h("span", { class: "pill", title: fmtDate(s.last_sync) }, icon("check"), `Drive updated ${timeAgo(s.last_sync)}`));
  }
  box.append(h("span", { class: "pill disk", title: `${fmtSize(s.disk_total - s.disk_free)} used of ${fmtSize(s.disk_total)}` },
    `${fmtSize(s.disk_free)} free`));
}

function renderCrumbs() {
  const nav = $("#crumbs");
  nav.replaceChildren();
  const parts = state.path ? state.path.split("/") : [];
  const trail = [["", "All designs"], ...parts.map((p, i) => [parts.slice(0, i + 1).join("/"), p])];
  trail.forEach(([path, label], i) => {
    if (i) nav.append(h("span", { class: "sep", "aria-hidden": "true" }, "/"));
    const current = i === trail.length - 1;
    const btn = h("button", {
      class: current ? "current" : "",
      "aria-current": current ? "page" : null,
      onclick: () => !current && navigate(path),
    }, label);
    if (!current) makeDropTarget(btn, path);
    nav.append(btn);
  });
  document.title = parts.length ? `${parts[parts.length - 1]} · Embroidery Bridge` : "Embroidery Bridge";
}

function renderItems() {
  const box = $("#items");
  box.className = `items ${state.view}`;
  box.classList.toggle("selecting", state.selected.size > 0);
  $("#view-grid").classList.toggle("active", state.view === "grid");
  $("#view-list").classList.toggle("active", state.view === "list");
  $("#sort").value = state.sort;

  const list = visibleEntries();
  box.replaceChildren(...list.map(card));
  box.hidden = list.length === 0;

  const empty = $("#empty");
  empty.hidden = list.length > 0;
  if (!list.length) {
    const searching = state.query.trim() && state.entries.length;
    $("#empty-title").textContent = searching ? "No matches" : state.path ? "This folder is empty" : "No designs yet";
    $("#empty-text").textContent = searching ? `Nothing here matches “${state.query.trim()}”.`
      : "Drop designs or whole folders anywhere on this page, or";
    $("#empty-upload").hidden = !!searching;
  }
  observePreviews();
}

function card(e) {
  const selected = state.selected.has(e.path);
  const thumb = h("div", { class: "thumb" });
  let sub;
  if (e.type === "folder") {
    folderThumb(thumb, e);
    sub =h("div", { class: "sub" },
      h("span", {}, plural(e.count, "file")),
      e.pending ? h("span", { class: "chip wait" }, icon("clock"), `${e.pending} waiting`) : null);
  } else {
    fillThumb(thumb, e);
    sub = h("div", { class: "sub" },
      h("span", { class: "size" }, fmtSize(e.size)),
      e.synced
        ? h("span", { class: "chip ok", title: "On the machine's USB drive" }, icon("check"), "On machine")
        : h("span", { class: "chip wait", title: "Being added to the machine's USB drive" }, icon("clock"), "Updating"));
  }
  const el = h("article", {
    class: `card ${e.type}${selected ? " selected" : ""}`,
    tabindex: "0",
    draggable: "true",
    "aria-selected": String(selected),
    dataset: { path: e.path },
    title: e.name,
  },
  h("button", {
    class: "check",
    "aria-label": selected ? `Deselect ${e.name}` : `Select ${e.name}`,
    onclick: (ev) => { ev.stopPropagation(); toggleSelect(e.path, ev.shiftKey); },
  }, icon("check")),
  thumb,
  h("div", { class: "meta" }, h("div", { class: "name" }, e.name), sub));

  el.addEventListener("click", (ev) => activate(e, ev));
  el.addEventListener("keydown", (ev) => {
    if (ev.target !== el) return;
    if (ev.key === "Enter") activate(e, ev);
    if (ev.key === " ") { ev.preventDefault(); toggleSelect(e.path, ev.shiftKey); }
  });
  el.addEventListener("dragstart", (ev) => {
    const paths = state.selected.has(e.path) ? [...state.selected] : [e.path];
    ev.dataTransfer.setData("application/x-bridge-paths", JSON.stringify(paths));
    ev.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  if (e.type === "folder") makeDropTarget(el, e.path);
  return el;
}

function placeholder(e, big = false) {
  const kind = e.design ? "hoop" : "file";
  return h("div", { class: "ph" }, icon(kind), ext(e.name) || (big ? "FILE" : ""));
}

// The machine won't list a design bigger than its hoop (either way round),
// so say so rather than let it silently not show up.
function oversize(p) {
  const hoop = state.status && state.status.hoop_mm;
  if (!p || !hoop) return null;
  const [w, h] = hoop;
  const fits = (p.width_mm <= w && p.height_mm <= h) || (p.width_mm <= h && p.height_mm <= w);
  if (fits) return null;
  return `The file is too big for your machine: ${p.width_mm} × ${p.height_mm} mm, `
    + `but the hoop is ${w} × ${h} mm. It won't show up on the machine.`;
}

function tooBigBadge(message) {
  return h("span", { class: "too-big", title: message, role: "img", "aria-label": message },
    icon("alert"), h("span", {}, "Too big"));
}

function fillThumb(thumb, e) {
  thumb.replaceChildren();
  thumb.classList.remove("loading");
  const key = previewKey(e);
  if (!e.design || !(state.status && state.status.previews)) {
    thumb.append(placeholder(e));
  } else if (previews.has(key)) {
    const p = previews.get(key);
    if (p) {
      thumb.innerHTML = p.svg;  // server-built SVG: numbers + validated colors only
      const warning = oversize(p);
      if (warning) thumb.append(tooBigBadge(warning));
    } else {
      thumb.append(placeholder(e));
    }
  } else {
    thumb.classList.add("loading");
    thumb.dataset.pending = key;
    pendingEntries.set(key, e);
  }
}

// A folder shows a few of its designs; list view (and a folder without
// designs) keeps the plain folder icon.
function folderThumb(thumb, e) {
  thumb.append(h("div", { class: "ph" }, icon("folder")));
  const samples = (state.status && state.status.previews && e.samples) || [];
  if (!samples.length) return;
  thumb.classList.add("has-collage");
  const tiles = samples.map((s) => {
    const tile = h("div", { class: "tile" });
    fillTile(tile, s);
    return tile;
  });
  thumb.append(h("div", { class: `collage n${samples.length}` }, ...tiles),
    h("span", { class: "folder-badge", "aria-hidden": "true" }, icon("folder")));
}

function fillTile(tile, e) {
  tile.replaceChildren();
  tile.classList.remove("loading");
  const key = previewKey(e);
  if (previews.has(key)) {
    const p = previews.get(key);
    if (p) tile.innerHTML = p.svg;  // server-built SVG, as in fillThumb
    else tile.append(h("div", { class: "ph" }, icon("hoop")));
  } else {
    tile.classList.add("loading");
    tile.dataset.pending = key;
    pendingEntries.set(key, e);
  }
}

// --------------------------------------------------- lazy preview loading

const previewQueue = [];
let previewsInFlight = 0;
const MAX_PREVIEW_FETCHES = 2;  // the Pi Zero renders these one core at a time
// Preview key -> the file waiting for it (a card's own file, or a folder's sample).
const pendingEntries = new Map();

const previewObserver = new IntersectionObserver((items) => {
  for (const it of items) {
    if (!it.isIntersecting) continue;
    previewObserver.unobserve(it.target);
    const entry = pendingEntries.get(it.target.dataset.pending);
    if (entry) queuePreview(entry);
  }
}, { rootMargin: "200px" });

function observePreviews() {
  document.querySelectorAll("[data-pending]").forEach((t) => previewObserver.observe(t));
}

function queuePreview(entry) {
  if (!previewQueue.some((e) => previewKey(e) === previewKey(entry))) previewQueue.push(entry);
  pumpPreviews();
}

function pumpPreviews() {
  while (previewsInFlight < MAX_PREVIEW_FETCHES && previewQueue.length) {
    const entry = previewQueue.shift();
    const key = previewKey(entry);
    if (previews.has(key)) { refreshThumbs(entry); continue; }
    previewsInFlight++;
    getPreview(entry).finally(() => { previewsInFlight--; refreshThumbs(entry); pumpPreviews(); });
  }
}

async function getPreview(entry) {
  const key = previewKey(entry);
  if (previews.has(key)) return previews.get(key);
  let data = null;
  try { data = await api(`/api/preview?path=${encodeURIComponent(entry.path)}`); } catch { /* no preview */ }
  previews.set(key, data);
  return data;
}

function refreshThumbs(entry) {
  const key = previewKey(entry);
  pendingEntries.delete(key);
  document.querySelectorAll("[data-pending]").forEach((t) => {
    if (t.dataset.pending !== key) return;
    delete t.dataset.pending;
    if (t.classList.contains("tile")) fillTile(t, entry);
    else fillThumb(t, entry);
  });
  if (viewer.entry && previewKey(viewer.entry) === key) showViewer(viewer.index);
}

// ---------------------------------------------------------- selection

function activate(e, ev) {
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey || state.selected.size) {
    toggleSelect(e.path, ev.shiftKey);
  } else if (e.type === "folder") {
    navigate(e.path);
  } else {
    openViewer(e.path);
  }
}

function toggleSelect(path, range = false) {
  const list = visibleEntries().map((e) => e.path);
  if (range && state.anchor && list.includes(state.anchor)) {
    const [a, b] = [list.indexOf(state.anchor), list.indexOf(path)].sort((x, y) => x - y);
    list.slice(a, b + 1).forEach((p) => state.selected.add(p));
  } else if (state.selected.has(path)) {
    state.selected.delete(path);
  } else {
    state.selected.add(path);
  }
  state.anchor = path;
  renderItems();
  renderSelection();
}

function selectAll() {
  const list = visibleEntries();
  const all = list.length && list.every((e) => state.selected.has(e.path));
  state.selected = all ? new Set() : new Set(list.map((e) => e.path));
  renderItems();
  renderSelection();
}

function clearSelection() {
  if (!state.selected.size) return;
  state.selected.clear();
  renderItems();
  renderSelection();
}

function selectedEntries() {
  return state.entries.filter((e) => state.selected.has(e.path));
}

function renderSelection() {
  const sel = selectedEntries();
  const bar = $("#selection-bar");
  bar.hidden = sel.length === 0;
  if (!sel.length) return;
  $("#selection-count").textContent = `${sel.length} selected`;
  const all = visibleEntries().every((e) => state.selected.has(e.path));
  $("#sel-all").textContent = all ? "Select none" : "Select all";
  $("#sel-rename").hidden = sel.length !== 1;
  $("#sel-download").hidden = !sel.every((e) => e.type === "file");
}

// ------------------------------------------------------------- dialogs

function ask({ title, text = "", value = null, folders = null, disabled = () => false, ok = "OK", danger = false }) {
  const dlg = $("#ask");
  const input = $("#ask-input");
  const list = $("#ask-list");
  const okBtn = $("#ask-ok");
  $("#ask-title").textContent = title;
  $("#ask-text").textContent = text;
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? "danger" : "primary"}`;
  input.hidden = value === null;
  input.required = value !== null;
  input.value = value ?? "";
  list.replaceChildren();
  let picked = null;

  if (folders) {
    okBtn.disabled = true;
    for (const f of folders) {
      const depth = f ? f.split("/").length : 0;
      const btn = h("button", {
        type: "button", role: "option", "aria-selected": "false", disabled: disabled(f),
        style: `padding-left:${12 + depth * 18}px`,
        onclick: () => {
          picked = f;
          list.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
          okBtn.disabled = false;
        },
        ondblclick: () => { if (!btn.disabled) { picked = f; dlg.close("ok"); } },
      }, icon(f ? "folder" : "home"), f ? f.split("/").pop() : "All designs");
      list.append(btn);
    }
  } else {
    okBtn.disabled = false;
  }

  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      if (dlg.returnValue !== "ok") return resolve(null);
      resolve(folders ? picked : value !== null ? input.value.trim() : true);
    }, { once: true });
    dlg.returnValue = "";
    dlg.showModal();
    if (value !== null) {
      input.focus();
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }
  });
}

// ------------------------------------------------------------- actions

async function newFolder() {
  const name = await ask({ title: "New folder", value: "", ok: "Create" });
  if (!name) return;
  try {
    await api("/api/mkdir", { path: state.path, name });
    toast(`Created “${name}”`);
    await load();
  } catch (err) { toast(err.message, "error"); }
}

async function rename(entry) {
  const name = await ask({ title: `Rename ${entry.type}`, value: entry.name, ok: "Rename" });
  if (!name || name === entry.name) return null;
  try {
    const res = await api("/api/rename", { path: entry.path, name });
    state.selected.delete(entry.path);
    toast(`Renamed to “${res.path.split("/").pop()}”`);
    await load();
    return res.path;
  } catch (err) { toast(err.message, "error"); return null; }
}

async function remove(entries) {
  if (!entries.length) return false;
  const folders = entries.filter((e) => e.type === "folder");
  const what = entries.length === 1 ? `“${entries[0].name}”` : plural(entries.length, "item");
  const ok = await ask({
    title: `Delete ${what}?`,
    text: (folders.length ? "Folders are deleted with everything in them. " : "")
      + "They'll also disappear from the machine's USB drive.",
    ok: "Delete", danger: true,
  });
  if (!ok) return false;
  try {
    const res = await api("/api/delete", { paths: entries.map((e) => e.path) });
    res.deleted.forEach((p) => state.selected.delete(p));
    toast(`Deleted ${res.deleted.length === 1 ? `“${entries[0].name}”` : plural(res.deleted.length, "item")}`);
    await load();
    return true;
  } catch (err) { toast(err.message, "error"); return false; }
}

async function moveTo(paths, dest) {
  try {
    const res = await api("/api/move", { paths, dest });
    res.moved.length && toast(`Moved ${plural(res.moved.length, "item")} to ${dest ? `“${dest.split("/").pop()}”` : "All designs"}`);
    res.failed.forEach(([name, why]) => toast(`Couldn't move “${name}”: ${why}`, "error"));
    paths.forEach((p) => state.selected.delete(p));
    await load();
  } catch (err) { toast(err.message, "error"); }
}

async function moveSelected() {
  const sel = selectedEntries();
  if (!sel.length) return;
  let folders;
  try { ({ folders } = await api("/api/folders")); } catch (err) { return toast(err.message, "error"); }
  const moving = sel.filter((e) => e.type === "folder").map((e) => e.path);
  const dest = await ask({
    title: `Move ${sel.length === 1 ? `“${sel[0].name}”` : plural(sel.length, "item")} to…`,
    folders,
    disabled: (f) => f === state.path || moving.some((m) => f === m || f.startsWith(m + "/")),
    ok: "Move here",
  });
  if (dest !== null) await moveTo(sel.map((e) => e.path), dest);
}

function download(entries) {
  entries.forEach((e, i) => setTimeout(() => {
    const a = h("a", { href: `/api/download?path=${encodeURIComponent(e.path)}`, download: e.name });
    document.body.append(a);
    a.click();
    a.remove();
  }, i * 300));
}

// ---------------------------------------------------------- drag & drop

function makeDropTarget(el, destPath) {
  el.addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer.types.includes("application/x-bridge-paths")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    el.classList.add("drop-hover");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-hover"));
  el.addEventListener("drop", (ev) => {
    const raw = ev.dataTransfer.getData("application/x-bridge-paths");
    el.classList.remove("drop-hover");
    if (!raw) return;
    ev.preventDefault();
    ev.stopPropagation();
    const paths = JSON.parse(raw).filter((p) => p !== destPath && !destPath.startsWith(p + "/"));
    if (paths.length) moveTo(paths, destPath);
  });
}

// --------------------------------------------------------------- upload

const JUNK = new Set(["thumbs.db", "desktop.ini"]);

function uploadable(items) {
  return items.filter(({ rel }) => {
    const parts = rel.split("/");
    return !parts.some((p) => p.startsWith(".")) && !JUNK.has(parts[parts.length - 1].toLowerCase());
  });
}

// Big uploads go in batches: each request stays small enough for a Pi
// Zero (and under the server's limit on form fields), and one failed
// batch doesn't lose the rest. Tests can shrink the batch size.
const BATCH_BYTES = 20 * 1024 * 1024;
const BATCH_FILES = 100;

function batches(items) {
  const limit = window.UPLOAD_BATCH_BYTES || BATCH_BYTES;
  const out = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    if (current.length && (size + item.file.size > limit || current.length >= BATCH_FILES)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.file.size;
  }
  if (current.length) out.push(current);
  return out;
}

function sendBatch(base, batch, final, onProgress) {
  return new Promise((resolve) => {
    const fd = new FormData();
    fd.append("path", base);
    // Only the last batch asks the Pi to update the machine's USB drive.
    fd.append("final", final ? "1" : "0");
    for (const { file, rel } of batch) {
      fd.append("file", file, file.name);
      fd.append("relpath", rel);
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
    xhr.onload = () => {
      let res = null;
      try { res = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status < 400 && res) resolve({ ok: true, res });
      else resolve({ ok: false, error: (res && res.error) || `the Pi answered ${xhr.status}` });
    };
    xhr.onerror = () => resolve({ ok: false, error: "lost connection to the Pi" });
    xhr.send(fd);
  });
}

async function upload(items) {
  items = uploadable(items);
  if (!items.length) return;
  if (state.uploading) return toast("Wait for the current upload to finish.", "error");
  state.uploading = true;

  const base = state.path;  // files land in the folder that was open when the upload started
  const sizeOf = (list) => list.reduce((n, { file }) => n + file.size, 0);
  const total = sizeOf(items) || 1;
  const groups = batches(items);
  const panel = $("#uploads");
  const progress = (done) => {
    const pct = Math.min(100, Math.round((done / total) * 100));
    $("#uploads-pct").textContent = `${pct}%`;
    $("#uploads-bar").style.width = `${pct}%`;
  };
  progress(0);
  panel.hidden = false;

  let sent = 0;
  let saved = 0;
  let failedBytes = 0;
  const renamed = [];
  const skipped = [];
  const failed = [];
  const errors = new Set();
  for (const [i, batch] of groups.entries()) {
    const size = sizeOf(batch);
    $("#uploads-label").textContent = groups.length > 1
      ? `Uploading ${plural(items.length, "file")} (part ${i + 1} of ${groups.length})`
      : `Uploading ${plural(items.length, "file")}`;
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await sendBatch(base, batch, i === groups.length - 1, (f) => progress(sent + f * size));
      if (result.ok) break;
    }
    sent += size;
    progress(sent);
    if (result.ok) {
      saved += result.res.saved.length;
      renamed.push(...result.res.renamed);
      skipped.push(...result.res.skipped);
      load({ quiet: true });  // show files as each batch lands
    } else {
      failed.push(...batch.map(({ rel }) => rel));
      failedBytes += size;
      errors.add(result.error);
    }
  }

  state.uploading = false;
  panel.hidden = true;
  load();

  if (saved) toast(`Uploaded ${plural(saved, "file")} (${fmtSize(sizeOf(items) - failedBytes)})`);
  if (renamed.length > 3) {
    toast(`${plural(renamed.length, "file")} were renamed to plain characters the machine supports`);
  } else {
    renamed.forEach(([from, to]) => toast(`“${from}” was saved as “${to}” (the machine only supports plain characters)`));
  }
  if (skipped.length) toast(`Skipped ${plural(skipped.length, "file")} with unusable names`, "error");
  if (failed.length) {
    const which = failed.length <= 3 ? `: ${failed.map((r) => `“${r}”`).join(", ")}` : "";
    toast(`${plural(failed.length, "file")} didn't upload (${[...errors].join("; ")})${which}. Try those again.`, "error");
  }
}

// Folders dropped from the desktop arrive as directory entries; walk them
// so their structure is kept.
async function droppedFiles(dt) {
  const entries = [...dt.items].filter((i) => i.kind === "file")
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  const plain = [...dt.files];
  if (!entries.length) return plain.map((file) => ({ file, rel: file.name }));

  const out = [];
  const readAll = (reader) => new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      next();
    }, reject);
    next();
  });
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, rel: prefix + file.name });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, `${prefix}${entry.name}/`);
    }
  }
  for (const entry of entries) await walk(entry, "");
  return out;
}

let dragDepth = 0;
const isFileDrag = (ev) => ev.dataTransfer && [...ev.dataTransfer.types].includes("Files");

window.addEventListener("dragenter", (ev) => {
  if (!isFileDrag(ev)) return;
  dragDepth++;
  $("#drop-target").textContent = state.path ? `“${state.path.split("/").pop()}”` : "All designs";
  $("#drop-overlay").hidden = false;
});
window.addEventListener("dragleave", (ev) => {
  if (!isFileDrag(ev)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $("#drop-overlay").hidden = true; }
});
window.addEventListener("dragover", (ev) => { if (isFileDrag(ev)) ev.preventDefault(); });
window.addEventListener("drop", async (ev) => {
  if (!isFileDrag(ev)) return;
  ev.preventDefault();
  dragDepth = 0;
  $("#drop-overlay").hidden = true;
  upload(await droppedFiles(ev.dataTransfer));
});

// --------------------------------------------------------------- viewer

const viewer = { index: -1, entry: null, files: [] };

function openViewer(path) {
  viewer.files = visibleEntries().filter((e) => e.type === "file");
  const i = viewer.files.findIndex((e) => e.path === path);
  if (i < 0) return;
  showViewer(i);
  const dlg = $("#viewer");
  if (!dlg.open) dlg.showModal();
}

function showViewer(i) {
  const e = viewer.files[i];
  if (!e) return;
  viewer.index = i;
  viewer.entry = e;
  $("#viewer-name").textContent = e.name;
  $("#viewer-download").href = `/api/download?path=${encodeURIComponent(e.path)}`;
  $("#viewer-download").setAttribute("download", e.name);
  $("#viewer-pos").textContent = `${i + 1} of ${viewer.files.length}`;
  $("#viewer-prev").disabled = i === 0;
  $("#viewer-next").disabled = i === viewer.files.length - 1;

  const art = $("#viewer-art");
  const key = previewKey(e);
  const canPreview = e.design && state.status && state.status.previews;
  const p = previews.get(key);
  art.classList.remove("loading");
  if (canPreview && !previews.has(key)) {
    art.replaceChildren();
    art.classList.add("loading");
    getPreview(e).then(() => { if (viewer.entry === e) showViewer(viewer.index); });
  } else if (p) {
    art.innerHTML = p.svg;
  } else {
    art.replaceChildren(placeholder(e, true));
  }

  const facts = [
    ["Status", e.synced
      ? h("span", { class: "chip ok" }, icon("check"), "On machine")
      : h("span", { class: "chip wait" }, icon("clock"), "Updating USB drive…")],
    ["File size", fmtSize(e.size)],
    ["Uploaded", fmtDate(e.mtime)],
  ];
  if (p) {
    const inches = (mm) => (mm / 25.4).toFixed(2);
    facts.push(
      ["Design size", `${p.width_mm} × ${p.height_mm} mm (${inches(p.width_mm)} × ${inches(p.height_mm)} in)`],
      ["Hoop", oversize(p)
        ? h("span", { class: "warn-text" }, icon("alert"), oversize(p))
        : `Fits the ${state.status.hoop_mm.join(" × ")} mm hoop`],
      ["Stitches", p.stitches.toLocaleString()],
      ["Colors", h("div", { class: "swatches" },
        p.colors.map((c) => h("span", { class: "swatch", style: `background:${c}`, title: c })))],
    );
  }
  $("#viewer-facts").replaceChildren(...facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}

$("#viewer").addEventListener("click", (ev) => {
  if (ev.target === ev.currentTarget || ev.target.closest("[data-close]")) $("#viewer").close();
});
$("#viewer-prev").onclick = () => showViewer(viewer.index - 1);
$("#viewer-next").onclick = () => showViewer(viewer.index + 1);
$("#viewer-rename").onclick = async () => {
  const newPath = await rename(viewer.entry);
  if (newPath) openViewer(newPath);
};
$("#viewer-delete").onclick = async () => {
  if (await remove([viewer.entry])) $("#viewer").close();
};
$("#viewer").addEventListener("close", () => { viewer.entry = null; });

// ------------------------------------------------------------- wiring

$("#upload").onclick = () => $("#file-input").click();
$("#empty-upload").onclick = () => $("#file-input").click();
$("#upload-folder").onclick = () => $("#folder-input").click();
$("#file-input").onchange = (ev) => {
  upload([...ev.target.files].map((file) => ({ file, rel: file.name })));
  ev.target.value = "";
};
$("#folder-input").onchange = (ev) => {
  upload([...ev.target.files].map((file) => ({ file, rel: file.webkitRelativePath || file.name })));
  ev.target.value = "";
};
$("#new-folder").onclick = newFolder;

$("#search").addEventListener("input", (ev) => { state.query = ev.target.value; renderItems(); renderSelection(); });
$("#sort").onchange = (ev) => { state.sort = ev.target.value; store("sort", state.sort); renderItems(); };
$("#view-grid").onclick = () => { state.view = "grid"; store("view", "grid"); renderItems(); };
$("#view-list").onclick = () => { state.view = "list"; store("view", "list"); renderItems(); };

$("#sel-all").onclick = selectAll;
$("#sel-clear").onclick = clearSelection;
$("#sel-delete").onclick = () => remove(selectedEntries());
$("#sel-move").onclick = moveSelected;
$("#sel-download").onclick = () => download(selectedEntries());
$("#sel-rename").onclick = () => { const [e] = selectedEntries(); if (e) rename(e); };

document.addEventListener("keydown", (ev) => {
  const typing = ev.target.matches("input, select, textarea");
  if ($("#viewer").open) {
    if (ev.key === "ArrowLeft" && viewer.index > 0) showViewer(viewer.index - 1);
    if (ev.key === "ArrowRight" && viewer.index < viewer.files.length - 1) showViewer(viewer.index + 1);
    return;
  }
  if (document.querySelector("dialog[open]") || typing) {
    if (typing && ev.key === "Escape") ev.target.blur();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") { ev.preventDefault(); selectAll(); }
  else if (ev.key === "Escape") clearSelection();
  else if ((ev.key === "Delete" || ev.key === "Backspace") && state.selected.size) { ev.preventDefault(); remove(selectedEntries()); }
  else if (ev.key === "/") { ev.preventDefault(); $("#search").focus(); }
});

window.addEventListener("hashchange", () => load());

// Keep sync status fresh while the page is visible.
setInterval(() => {
  // Not while a rename/move/delete dialog is up; an open preview is fine.
  if (document.visibilityState === "visible" && !state.uploading && !$("#ask").open) {
    load({ quiet: true });
  }
}, 4000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load({ quiet: true }); });

load();
