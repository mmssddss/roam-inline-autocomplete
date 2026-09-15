/**
 * Inline Autocomplete for Roam Research
 *
 * 不用输入 [[ ，边打字边弹出候选。候选分两类，下拉框里有明确标记：
 *   「页」 页面标题 → 插入 [[标题]]
 *   「块」 已有 block → 插入 ((uid))（或 [原文](((uid)))），不会新建页面
 * 弹框左右分栏：左边是候选列表，右边实时预览选中项（页面内容 / block 及其子块）。
 * - Enter / Tab：把光标前的匹配文字替换成对应引用
 * - Esc：关闭候选（同一个词不再重复弹出，直到你换词）
 * - ↑ / ↓：选择候选
 * - 中文/日文/韩文：IME 组词期间不弹出，只在 compositionend 之后匹配；
 *   没有空格分词的语言用「光标前若干字符的最长后缀」去匹配标题。
 * - 在 [[ ]] / (( )) / #tag / /命令 / ``` 代码块 内不触发，避免和 Roam 原生补全打架。
 */

const POPUP_ID = "rr-inline-ac";
const STYLE_ID = "rr-inline-ac-style";
const TITLE_CACHE_TTL = 30 * 1000; // 页面标题缓存 30 秒

const DATE_PAGE_RE =
  /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}$/;

// 词的边界：空白、括号、常见中英标点
const DELIM_RE =
  /[\s\[\]\(\)\{\}<>#@:：,，.。!！?？;；、"“”'‘’`~\/\\|·—]/;

const DEFAULTS = {
  enabled: true,
  minChars: 2,
  maxLookback: 24,
  maxResults: 8,
  debounceMs: 90,
  excludeDates: true,
  insertMode: "[[page]]",
  blockSearch: true,
  blockMinChars: 3,
  blockMaxResults: 5,
  blockInsertMode: "((uid))",
};

let api = null;
let state = {
  open: false,
  items: [],
  index: 0,
  textarea: null,
  query: "", // 被匹配的那段文字（光标前的后缀）
  dismissedTail: null, // Esc 之后记住当前词，避免继续弹
  composing: false,
  timer: null,
  ignoreNextInput: false,
};
let titleCache = { list: [], ts: 0 };
let popup = null;
let listeners = [];

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

function setting(id) {
  const v = api && api.settings.get(id);
  if (v === undefined || v === null || v === "") return DEFAULTS[id];
  if (typeof DEFAULTS[id] === "number") {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULTS[id];
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* 标题缓存与匹配                                                        */
/* ------------------------------------------------------------------ */

function getTitles() {
  const now = Date.now();
  if (now - titleCache.ts > TITLE_CACHE_TTL) {
    const excludeDates = setting("excludeDates");
    const raw =
      window.roamAlphaAPI.q(
        "[:find [?t ...] :where [?p :node/title ?t]]"
      ) || [];
    titleCache.list = raw
      .filter((t) => typeof t === "string" && t.length > 0)
      .filter((t) => !(excludeDates && DATE_PAGE_RE.test(t)))
      .map((t) => ({ title: t, lower: t.toLowerCase() }));
    titleCache.ts = now;
  }
  return titleCache.list;
}

function invalidateTitles() {
  titleCache.ts = 0;
}

// 光标前、直到最近一个分隔符的一段文字（最多 maxLookback 个字符）
function tailBeforeCursor(text, cursor) {
  const maxLookback = setting("maxLookback");
  let start = cursor;
  while (start > 0 && cursor - start < maxLookback) {
    if (DELIM_RE.test(text[start - 1])) break;
    start--;
  }
  return text.slice(start, cursor);
}

// 是否处在 Roam 自己会接管的语法里
function insideRoamSyntax(before) {
  const openPair = (o, c) => {
    const i = before.lastIndexOf(o);
    return i !== -1 && before.indexOf(c, i + o.length) === -1;
  };
  if (openPair("[[", "]]")) return true;
  if (openPair("((", "))")) return true;
  if (openPair("{{", "}}")) return true;
  if ((before.match(/```/g) || []).length % 2 === 1) return true;
  if (/(^|\s)[\/#][^\s]*$/.test(before)) return true; // /命令 或 #tag
  if (/::\s*$/.test(before)) return true; // 属性
  return false;
}

function roamAutocompleteVisible() {
  return !!document.querySelector(".rm-autocomplete__results");
}

// 页面：从最长后缀开始找，找到就停
function findPageMatches(tail) {
  const minChars = setting("minChars");
  const maxResults = setting("maxResults");
  if (tail.length < minChars) return [];
  const titles = getTitles();
  const lowerTail = tail.toLowerCase();

  for (let k = lowerTail.length; k >= minChars; k--) {
    const q = lowerTail.slice(lowerTail.length - k);
    const starts = [];
    const contains = [];
    for (const t of titles) {
      if (t.lower === q) continue; // 已经完整敲出标题，没必要提示
      if (t.lower.startsWith(q)) starts.push(t.title);
      else if (t.lower.includes(q)) contains.push(t.title);
    }
    if (starts.length || contains.length) {
      const byLen = (a, b) => a.length - b.length || a.localeCompare(b);
      const rawQ = tail.slice(tail.length - k);
      return starts
        .sort(byLen)
        .concat(contains.sort(byLen))
        .slice(0, maxResults)
        .map((title) => ({ type: "page", title, q: rawQ }));
    }
  }
  return [];
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// block：让 datascript 用正则做不区分大小写的子串匹配，避免把全图谱拉到 JS 里
function queryBlocks(q, excludeUid, limit) {
  const pat = "(?i)" + escapeRegex(q);
  let rows = [];
  try {
    rows =
      window.roamAlphaAPI.q(
        `[:find ?uid ?s ?pt
          :in $ ?pat
          :where
            [(re-pattern ?pat) ?re]
            [?b :block/string ?s]
            [(re-find ?re ?s)]
            [?b :block/uid ?uid]
            [?b :block/page ?p]
            [?p :node/title ?pt]]`,
        pat
      ) || [];
  } catch (err) {
    console.warn("[inline-ac] block query failed", err);
    return [];
  }
  const ql = q.toLowerCase();
  return rows
    .filter(([uid, s]) => uid !== excludeUid && s.trim() !== "" && s.toLowerCase() !== ql)
    .map(([uid, s, pt]) => ({ type: "block", uid, text: s, page: pt, q }))
    .sort((a, b) => a.text.length - b.text.length)
    .slice(0, limit);
}

// 页面在前，block 在后。block 用「页面命中的那段」或整个词去搜
function findMatches(tail, currentUid) {
  const pages = findPageMatches(tail);
  let blocks = [];
  if (setting("blockSearch")) {
    const q = pages.length ? pages[0].q : tail;
    if (q.length >= setting("blockMinChars")) {
      blocks = queryBlocks(q, currentUid, setting("blockMaxResults"));
    }
  }
  return pages.concat(blocks);
}

function currentBlockUid(textarea) {
  const id = textarea.id || "";
  return id.length >= 9 ? id.slice(-9) : null;
}

/* ------------------------------------------------------------------ */
/* 光标坐标（mirror div 法）                                             */
/* ------------------------------------------------------------------ */

const MIRROR_PROPS = [
  "boxSizing", "width", "height", "overflowX", "overflowY",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize",
  "fontSizeAdjust", "lineHeight", "fontFamily", "textAlign", "textTransform",
  "textIndent", "textDecoration", "letterSpacing", "wordSpacing", "tabSize",
  "whiteSpace", "wordBreak", "overflowWrap",
];

function caretRect(textarea, position) {
  const mirror = document.createElement("div");
  const cs = window.getComputedStyle(textarea);
  MIRROR_PROPS.forEach((p) => (mirror.style[p] = cs[p]));
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.textContent = textarea.value.substring(0, position);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.substring(position) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const ta = textarea.getBoundingClientRect();
  const top =
    ta.top + marker.offsetTop - textarea.scrollTop + parseInt(cs.borderTopWidth || 0, 10);
  const left =
    ta.left + marker.offsetLeft - textarea.scrollLeft + parseInt(cs.borderLeftWidth || 0, 10);
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  document.body.removeChild(mirror);
  return { top, left, height: lineHeight };
}

/* ------------------------------------------------------------------ */
/* 弹层                                                                */
/* ------------------------------------------------------------------ */

let listEl = null;
let previewEl = null;

function ensurePopup() {
  if (popup) return popup;
  popup = document.createElement("div");
  popup.id = POPUP_ID;
  popup.innerHTML =
    '<div class="rr-ac-list" role="listbox"></div><div class="rr-ac-preview"></div>';
  listEl = popup.querySelector(".rr-ac-list");
  previewEl = popup.querySelector(".rr-ac-preview");
  popup.addEventListener("mousedown", (e) => {
    // 别让 textarea 失焦
    e.preventDefault();
    const li = e.target.closest("[data-idx]");
    if (li) {
      state.index = Number(li.dataset.idx);
      commit();
    }
  });
  popup.addEventListener("mouseover", (e) => {
    const li = e.target.closest("[data-idx]");
    if (li && Number(li.dataset.idx) !== state.index) {
      state.index = Number(li.dataset.idx);
      render();
    }
  });
  document.body.appendChild(popup);
  return popup;
}

function escHtml(str) {
  return str.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function highlight(text, query) {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i === -1) return escHtml(text);
  return (
    escHtml(text.slice(0, i)) +
    "<b>" +
    escHtml(text.slice(i, i + query.length)) +
    "</b>" +
    escHtml(text.slice(i + query.length))
  );
}

// block 太长时截取命中位置附近的一段
function snippet(text, query, max = 70) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const i = t.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, Math.min(i - 20, t.length - max));
  const piece = t.slice(start, start + max);
  return (start > 0 ? "…" : "") + piece + (start + max < t.length ? "…" : "");
}

function renderItem(item, i) {
  const active = i === state.index ? " is-active" : "";
  if (item.type === "page") {
    return `<div class="rr-ac-item rr-ac-page${active}" data-idx="${i}" role="option">
      <span class="rr-ac-kind">页</span>
      <span class="rr-ac-text">${highlight(item.title, item.q)}</span>
    </div>`;
  }
  return `<div class="rr-ac-item rr-ac-block${active}" data-idx="${i}" role="option" title="${escHtml(item.text)}">
    <span class="rr-ac-kind">块</span>
    <span class="rr-ac-text">${highlight(snippet(item.text, item.q), item.q)}</span>
    <span class="rr-ac-where">${escHtml(item.page)}</span>
  </div>`;
}

function render() {
  ensurePopup();
  listEl.innerHTML = state.items.map(renderItem).join("");
  const active = listEl.querySelector(".is-active");
  if (active) active.scrollIntoView({ block: "nearest" });
  renderPreview(state.items[state.index]);
}

/* ------------------------------------------------------------------ */
/* 预览                                                                */
/* ------------------------------------------------------------------ */

const PREVIEW_MAX_LINES = 28;
const PREVIEW_MAX_DEPTH = 4;
const PREVIEW_LINE_CHARS = 160;
const TREE_PATTERN = "[:node/title :block/string :block/uid :block/order {:block/children ...}]";

let previewCache = new Map();
let refCache = new Map();

function pullTree(lookup) {
  try {
    return window.roamAlphaAPI.pull(TREE_PATTERN, lookup);
  } catch (err) {
    console.warn("[inline-ac] pull failed", err);
    return null;
  }
}

function resolveRef(uid) {
  if (refCache.has(uid)) return refCache.get(uid);
  let text = `((${uid}))`;
  try {
    const r = window.roamAlphaAPI.pull("[:block/string]", [":block/uid", uid]);
    if (r && r[":block/string"]) text = r[":block/string"];
  } catch (_) {}
  refCache.set(uid, text);
  return text;
}

function backlinkCount(title) {
  try {
    const rows = window.roamAlphaAPI.q(
      "[:find ?b :in $ ?t :where [?p :node/title ?t] [?b :block/refs ?p]]",
      title
    );
    return rows ? rows.length : 0;
  } catch (_) {
    return 0;
  }
}

// 轻量把 Roam 标记转成可读 HTML（先转义再加样式）
function formatInline(raw) {
  let t = raw.length > PREVIEW_LINE_CHARS ? raw.slice(0, PREVIEW_LINE_CHARS) + "…" : raw;
  t = escHtml(t);
  t = t.replace(/\(\(([A-Za-z0-9_-]{9})\)\)/g, (m, uid) => `<span class="rr-pv-ref">${escHtml(resolveRef(uid))}</span>`);
  t = t.replace(/\{\{\[\[TODO\]\]\}\}/g, "☐").replace(/\{\{\[\[DONE\]\]\}\}/g, "☑");
  t = t.replace(/\[\[([^\[\]]+)\]\]/g, '<span class="rr-pv-link">$1</span>');
  t = t.replace(/(^|\s)#([^\s#\[\]]+)/g, '$1<span class="rr-pv-link">#$2</span>');
  t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  t = t.replace(/__(.+?)__/g, "<i>$1</i>");
  t = t.replace(/\^\^(.+?)\^\^/g, "<mark>$1</mark>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  return t;
}

function childrenOf(node) {
  return (node && node[":block/children"] ? node[":block/children"] : [])
    .slice()
    .sort((a, b) => (a[":block/order"] || 0) - (b[":block/order"] || 0));
}

// 把子树渲染成缩进的圆点列表，超过预算就截断
function outlineHtml(nodes, depth, budget) {
  const lines = [];
  const walk = (list, d) => {
    for (const n of list) {
      if (budget.left <= 0) return;
      if (d >= PREVIEW_MAX_DEPTH) return;
      budget.left--;
      const str = n[":block/string"] || "";
      lines.push(`<div class="rr-pv-line" style="padding-left:${d * 14}px"><span class="rr-pv-dot"></span>${formatInline(str)}</div>`);
      walk(childrenOf(n), d + 1);
    }
  };
  walk(nodes, depth);
  return lines.join("");
}

function countNodes(nodes) {
  let n = 0;
  const walk = (list) => list.forEach((x) => { n++; walk(childrenOf(x)); });
  walk(nodes);
  return n;
}

function buildPreview(item) {
  if (item.type === "page") {
    const tree = pullTree([":node/title", item.title]);
    const kids = childrenOf(tree);
    const total = countNodes(kids);
    const refs = backlinkCount(item.title);
    const budget = { left: PREVIEW_MAX_LINES };
    const body = kids.length
      ? outlineHtml(kids, 0, budget)
      : '<div class="rr-pv-empty">空页面</div>';
    const more = total > PREVIEW_MAX_LINES ? `<div class="rr-pv-more">…还有 ${total - PREVIEW_MAX_LINES} 条</div>` : "";
    return `
      <div class="rr-pv-head">
        <div class="rr-pv-title">${escHtml(item.title)}</div>
        <div class="rr-pv-meta">${refs} 处引用 · ${total} 个 block</div>
      </div>
      <div class="rr-pv-body">${body}${more}</div>`;
  }

  const tree = pullTree([":block/uid", item.uid]);
  const kids = childrenOf(tree);
  const total = countNodes(kids);
  const budget = { left: PREVIEW_MAX_LINES };
  const more = total > PREVIEW_MAX_LINES ? `<div class="rr-pv-more">…还有 ${total - PREVIEW_MAX_LINES} 条</div>` : "";
  return `
    <div class="rr-pv-head">
      <div class="rr-pv-meta">在 <span class="rr-pv-link">${escHtml(item.page)}</span></div>
      <div class="rr-pv-root">${formatInline(item.text)}</div>
    </div>
    <div class="rr-pv-body">${kids.length ? outlineHtml(kids, 0, budget) : ""}${more}</div>`;
}

function renderPreview(item) {
  if (!item) {
    previewEl.innerHTML = "";
    return;
  }
  const key = item.type === "page" ? "page:" + item.title : "block:" + item.uid;
  if (!previewCache.has(key)) previewCache.set(key, buildPreview(item));
  previewEl.innerHTML = previewCache.get(key);
  previewEl.scrollTop = 0;
}

function place() {
  const el = ensurePopup();
  const ta = state.textarea;
  const r = caretRect(ta, ta.selectionStart);
  el.style.display = "flex";
  const w = el.offsetWidth || 620;
  const h = el.offsetHeight || 320;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.top + r.height + 4;
  if (top + h > window.innerHeight - 8) top = r.top - h - 4; // 放不下就往上翻
  el.style.left = Math.max(8, left) + "px";
  el.style.top = Math.max(8, top) + "px";
}

function openWith(textarea, tail, items) {
  state.open = true;
  state.textarea = textarea;
  state.query = tail; // 当前整个词，Esc 时记住它
  state.items = items;
  state.index = 0;
  render();
  place();
}

function close(opts = {}) {
  if (!state.open) return;
  state.open = false;
  state.items = [];
  if (popup) popup.style.display = "none";
  previewCache.clear();
  refCache.clear();
  if (opts.dismiss) state.dismissedTail = state.query;
}

/* ------------------------------------------------------------------ */
/* 写回 textarea                                                        */
/* ------------------------------------------------------------------ */

const nativeSetValue = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "value"
).set;

function buildInsert(item) {
  if (item.type === "page") {
    const t = item.title;
    if (setting("insertMode") === "#tag") return /[\s\[\]]/.test(t) ? `#[[${t}]]` : `#${t}`;
    return `[[${t}]]`;
  }
  // block：永远引用 uid，不会创建新页面
  if (setting("blockInsertMode") === "[text](((uid)))") {
    const label = item.text.replace(/\s+/g, " ").trim().replace(/[\[\]]/g, "");
    return `[${label}](((${item.uid})))`;
  }
  return `((${item.uid}))`;
}

function commit() {
  const ta = state.textarea;
  const item = state.items[state.index];
  if (!ta || !item) return close();

  const cursor = ta.selectionStart;
  const before = ta.value.slice(0, cursor - item.q.length);
  const after = ta.value.slice(cursor);
  const link = buildInsert(item);
  const next = before + link + after;
  const newCursor = before.length + link.length;

  state.ignoreNextInput = true;
  nativeSetValue.call(ta, next);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  close();
  state.dismissedTail = null;
  requestAnimationFrame(() => {
    try {
      ta.setSelectionRange(newCursor, newCursor);
    } catch (_) {}
  });
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

function isBlockTextarea(el) {
  return el && el.tagName === "TEXTAREA" && el.classList.contains("rm-block-input");
}

function evaluate(textarea) {
  if (!setting("enabled")) return close();
  if (state.composing) return;
  if (document.activeElement !== textarea) return close();
  if (roamAutocompleteVisible()) return close();

  const text = textarea.value;
  const cursor = textarea.selectionStart;
  if (cursor !== textarea.selectionEnd) return close();

  const before = text.slice(0, cursor);
  if (insideRoamSyntax(before)) return close();

  const tail = tailBeforeCursor(text, cursor);
  if (!tail) {
    state.dismissedTail = null;
    return close();
  }
  if (state.dismissedTail && tail.startsWith(state.dismissedTail)) return close();
  state.dismissedTail = null;

  const items = findMatches(tail, currentBlockUid(textarea));
  if (!items.length) return close();
  openWith(textarea, tail, items);
}

function schedule(textarea) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => evaluate(textarea), setting("debounceMs"));
}

function onInput(e) {
  if (!isBlockTextarea(e.target)) return;
  if (state.ignoreNextInput) {
    state.ignoreNextInput = false;
    return;
  }
  schedule(e.target);
}

function onCompositionStart(e) {
  if (!isBlockTextarea(e.target)) return;
  state.composing = true;
  close();
}

function onCompositionEnd(e) {
  if (!isBlockTextarea(e.target)) return;
  state.composing = false;
  schedule(e.target);
}

function onKeyDown(e) {
  if (!state.open || e.target !== state.textarea) return;
  if (state.composing) return;
  switch (e.key) {
    case "ArrowDown":
      state.index = (state.index + 1) % state.items.length;
      render();
      break;
    case "ArrowUp":
      state.index = (state.index - 1 + state.items.length) % state.items.length;
      render();
      break;
    case "Enter":
    case "Tab":
      commit();
      break;
    case "Escape":
      close({ dismiss: true });
      break;
    default:
      return; // 其余按键放行
  }
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

function onFocusOut(e) {
  if (e.target === state.textarea) setTimeout(() => close(), 120);
}

function onGlobalMouseDown(e) {
  if (state.open && popup && !popup.contains(e.target)) close();
}

function onScroll() {
  if (state.open) close();
}

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  listeners.push(() => target.removeEventListener(type, fn, opts));
}

/* ------------------------------------------------------------------ */
/* 样式                                                                */
/* ------------------------------------------------------------------ */

const CSS = `
#${POPUP_ID} {
  position: fixed;
  z-index: 9999;
  display: none;
  width: 640px;
  max-width: calc(100vw - 16px);
  height: 320px;
  border-radius: 4px;
  background: #fff;
  color: #202b33;
  box-shadow: 0 0 0 1px rgba(16,22,26,.1), 0 2px 8px rgba(16,22,26,.2);
  font-size: 14px;
  line-height: 1.4;
  overflow: hidden;
}

/* 左：候选列表 */
#${POPUP_ID} .rr-ac-list {
  flex: 0 0 260px;
  overflow-y: auto;
  padding: 4px 0;
  border-right: 1px solid rgba(16,22,26,.12);
}
#${POPUP_ID} .rr-ac-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  white-space: nowrap;
}
#${POPUP_ID} .rr-ac-kind {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  padding: 0 5px;
  border-radius: 3px;
  background: #e1e8ed;
  color: #5c7080;
}
#${POPUP_ID} .rr-ac-block .rr-ac-kind { background: #fff3d6; color: #a05a00; }
#${POPUP_ID} .rr-ac-text { flex: 1; overflow: hidden; text-overflow: ellipsis; }
#${POPUP_ID} .rr-ac-where { flex: none; max-width: 90px; overflow: hidden; text-overflow: ellipsis; font-size: 12px; opacity: .6; }
#${POPUP_ID} .rr-ac-item b { font-weight: 600; color: #137cbd; }
#${POPUP_ID} .rr-ac-item.is-active { background: #137cbd; color: #fff; }
#${POPUP_ID} .rr-ac-item.is-active b { color: #fff; }
#${POPUP_ID} .rr-ac-item.is-active .rr-ac-kind { background: rgba(255,255,255,.25); color: #fff; }
#${POPUP_ID} .rr-ac-item.is-active .rr-ac-where { opacity: .85; }

/* 右：预览 */
#${POPUP_ID} .rr-ac-preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 10px 12px;
  background: #f8f9fa;
  font-size: 13px;
}
#${POPUP_ID} .rr-pv-head { margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid rgba(16,22,26,.1); }
#${POPUP_ID} .rr-pv-title { font-size: 15px; font-weight: 600; word-break: break-word; }
#${POPUP_ID} .rr-pv-meta { font-size: 12px; opacity: .65; margin-top: 2px; }
#${POPUP_ID} .rr-pv-root { margin-top: 4px; font-weight: 500; word-break: break-word; }
#${POPUP_ID} .rr-pv-line { position: relative; padding-right: 4px; margin: 1px 0; word-break: break-word; white-space: normal; }
#${POPUP_ID} .rr-pv-dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: #8a9ba8; margin: 0 7px 3px 0; }
#${POPUP_ID} .rr-pv-link { color: #137cbd; }
#${POPUP_ID} .rr-pv-ref { border-bottom: 1px solid rgba(19,124,189,.4); }
#${POPUP_ID} .rr-pv-empty, #${POPUP_ID} .rr-pv-more { opacity: .55; font-style: italic; margin-top: 4px; }
#${POPUP_ID} code { font-size: 12px; padding: 0 3px; background: rgba(16,22,26,.07); border-radius: 3px; }
#${POPUP_ID} mark { background: #ffe39f; color: inherit; }

@media (max-width: 640px) {
  #${POPUP_ID} { width: auto; height: auto; max-height: 300px; }
  #${POPUP_ID} .rr-ac-list { flex: 1 1 auto; border-right: 0; }
  #${POPUP_ID} .rr-ac-preview { display: none; }
}

/* 深色主题 */
.bp3-dark #${POPUP_ID}, .dark-theme #${POPUP_ID}, [data-theme="dark"] #${POPUP_ID} {
  background: #30404d;
  color: #f5f8fa;
  box-shadow: 0 0 0 1px rgba(16,22,26,.4), 0 2px 8px rgba(16,22,26,.6);
}
.bp3-dark #${POPUP_ID} .rr-ac-list { border-right-color: rgba(255,255,255,.12); }
.bp3-dark #${POPUP_ID} .rr-ac-preview { background: #293742; }
.bp3-dark #${POPUP_ID} .rr-pv-head { border-bottom-color: rgba(255,255,255,.12); }
.bp3-dark #${POPUP_ID} .rr-ac-item b, .bp3-dark #${POPUP_ID} .rr-pv-link { color: #48aff0; }
.bp3-dark #${POPUP_ID} .rr-ac-kind { background: #394b59; color: #a7b6c2; }
.bp3-dark #${POPUP_ID} .rr-ac-block .rr-ac-kind { background: #5c4a1a; color: #ffc940; }
.bp3-dark #${POPUP_ID} code { background: rgba(255,255,255,.1); }
.bp3-dark #${POPUP_ID} mark { background: #7a5b00; color: #fff; }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                              */
/* ------------------------------------------------------------------ */

function onload({ extensionAPI }) {
  api = extensionAPI;

  extensionAPI.settings.panel.create({
    tabTitle: "Inline Autocomplete",
    settings: [
      {
        id: "enabled",
        name: "启用",
        description: "打字时自动弹出页面标题候选（不需要输入 [[）。",
        action: { type: "switch" },
      },
      {
        id: "minChars",
        name: "最少触发字符数",
        description: "光标前至少有多少个字符才开始匹配。中文建议 1 或 2，英文建议 2 或 3。默认 2。",
        action: { type: "input", placeholder: "2" },
      },
      {
        id: "maxLookback",
        name: "向前回看的最大字符数",
        description: "没有空格的语言（中日韩）会从光标往前取这么多字符去找最长匹配。默认 24。",
        action: { type: "input", placeholder: "24" },
      },
      {
        id: "maxResults",
        name: "最多显示候选数",
        description: "默认 8。",
        action: { type: "input", placeholder: "8" },
      },
      {
        id: "debounceMs",
        name: "延迟（毫秒）",
        description: "停止输入多少毫秒后再匹配。默认 90。",
        action: { type: "input", placeholder: "90" },
      },
      {
        id: "excludeDates",
        name: "排除日期页面",
        description: "不把 Daily Notes 的日期页面当作候选。",
        action: { type: "switch" },
      },
      {
        id: "insertMode",
        name: "页面插入格式",
        description: "选中页面候选后插入 [[页面]] 还是 #标签。",
        action: { type: "select", items: ["[[page]]", "#tag"] },
      },
      {
        id: "blockSearch",
        name: "同时搜索 block",
        description: "在页面候选后面附上匹配的 block，标记为「块」，选中后插入 block 引用而不是新建页面。",
        action: { type: "switch" },
      },
      {
        id: "blockMinChars",
        name: "block 最少触发字符数",
        description: "block 数量多、噪音大，建议比页面高一些。默认 3。",
        action: { type: "input", placeholder: "3" },
      },
      {
        id: "blockMaxResults",
        name: "block 最多显示数",
        description: "默认 5。",
        action: { type: "input", placeholder: "5" },
      },
      {
        id: "blockInsertMode",
        name: "block 插入格式",
        description: "((uid)) 是普通块引用；[text](((uid))) 会把块原文作为显示文字。",
        action: { type: "select", items: ["((uid))", "[text](((uid)))"] },
      },
    ],
  });

  // 第一次安装时把 switch 默认设为开
  if (extensionAPI.settings.get("enabled") === undefined) extensionAPI.settings.set("enabled", true);
  if (extensionAPI.settings.get("excludeDates") === undefined) extensionAPI.settings.set("excludeDates", true);
  if (extensionAPI.settings.get("blockSearch") === undefined) extensionAPI.settings.set("blockSearch", true);

  extensionAPI.ui.commandPalette.addCommand({
    label: "Inline Autocomplete: Toggle",
    callback: () => {
      const next = !setting("enabled");
      extensionAPI.settings.set("enabled", next);
      if (!next) close();
    },
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Inline Autocomplete: Refresh page titles",
    callback: invalidateTitles,
  });

  injectStyle();
  ensurePopup();

  on(document, "input", onInput, true);
  on(document, "compositionstart", onCompositionStart, true);
  on(document, "compositionend", onCompositionEnd, true);
  on(document, "keydown", onKeyDown, true);
  on(document, "focusout", onFocusOut, true);
  on(document, "mousedown", onGlobalMouseDown, true);
  on(window, "scroll", onScroll, true);
  on(window, "resize", onScroll);
}

function onunload() {
  listeners.forEach((off) => off());
  listeners = [];
  clearTimeout(state.timer);
  if (popup) popup.remove();
  popup = null;
  listEl = null;
  previewEl = null;
  const s = document.getElementById(STYLE_ID);
  if (s) s.remove();
  api = null;
}

export default { onload, onunload };
