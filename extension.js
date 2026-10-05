/**
 * Inline Autocomplete for Roam Research
 *
 * 不用输入 [[ ，边打字边弹出候选。候选分两类，列表里直接用 Roam 自己的写法区分：
 *   页面：显示成 [[标题]]（或 #标题），插入的就是这个
 *   block：显示成圆点 + 所在页面，插入 ((uid))（或 [原文](((uid)))），不会新建页面
 * 弹框左右分栏：左边是候选列表，右边实时预览选中项（页面内容 / block 及其子块），底部是按键提示。
 * - Enter / Tab：把光标前的匹配文字替换成对应引用
 * - Esc：关闭候选（同一个词不再重复弹出，直到你换词）
 * - ← / → / Home / End：照常挪光标，弹层关闭
 * - ↑ / ↓：选择候选
 * - 中文/日文/韩文：IME 组词期间不弹出，只在 compositionend 之后匹配；
 *   没有空格分词的语言用「光标前若干字符的最长后缀」去匹配标题。
 * - 在 [[ ]] / (( )) / #tag / /命令 / ``` 代码块 内不触发，避免和 Roam 原生补全打架。
 */

const POPUP_ID = "rr-inline-ac";
const STYLE_ID = "rr-inline-ac-style";
const TITLE_CACHE_TTL = 30 * 1000; // 页面标题缓存 30 秒
const BLOCK_CACHE_TTL = 30 * 1000; // block 扫描结果也是 30 秒
const LATE_OPEN_GRACE_MS = 200; // 晚到的弹层打开后这段时间内 Enter / Tab 放行给 Roam

const DATE_PAGE_RE =
  /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}$/;

// 词的边界：空白、括号、常见中英标点
const DELIM_RE =
  /[\s\[\]\(\)\{\}<>#@:：,，.。!！?？;；、"“”'‘’`~\/\\|·—]/;

const DEFAULTS = {
  enabled: true,
  minChars: 2,
  maxLookback: 24,
  maxResults: 25,
  debounceMs: 0,
  excludeDates: true,
  insertMode: "[[page]]",
  blockSearch: true,
  blockMinChars: 3,
  blockMinCharsLatin: 4,
  blockDelayMs: 250,
  blockMaxResults: 10,
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
  blockTimer: null, // block 搜索自己的定时器
  seq: 0, // 每次 evaluate() 加一，晚到的 block 结果靠它认出自己过时了
  lateOpenAt: 0, // 弹层是被晚到的 block 结果打开的时刻；立刻打开的是 0
  ignoreNextInput: false,
};
let titleCache = { list: [], ts: 0 };
let popup = null;
let listeners = [];

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

// 延迟类设置填 0 是有意义的（不等），其他数字设置 0 没意义，回退默认值
const ZERO_OK = new Set(["debounceMs", "blockDelayMs"]);

function setting(id) {
  const v = api && api.settings.get(id);
  if (v === undefined || v === null || v === "") return DEFAULTS[id];
  if (typeof DEFAULTS[id] === "number") {
    const n = Number(v);
    const ok = Number.isFinite(n) && (ZERO_OK.has(id) ? n >= 0 : n > 0);
    return ok ? n : DEFAULTS[id];
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
      // 标题和这段完全一样也要留着：打完「机器学习」正想把它变成链接，这才是
      // 「不用先输 [[」的意义。跳过它的话这一轮会空，循环退到更短的后缀，同一个
      // 页面又被 includes 捞回来，q 却短了一截 —— 插入时就变成「机[[机器学习]]」
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

const BLOCK_QUERY = `[:find ?uid ?s ?pt
   :in $ ?pat
   :where
     [(re-pattern ?pat) ?re]
     [?b :block/string ?s]
     [(re-find ?re ?s)]
     [?b :block/uid ?uid]
     [?b :block/page ?p]
     [?p :node/title ?pt]]`;

// re-pattern 认 (?i) 前缀（ClojureScript 会把它转成 RegExp 的 flag），万一哪天不认了
// 就降级成大小写敏感的搜，总比一条 block 都搜不出来强
let blockQueryCaseFlag = true;

function runBlockQuery(pat) {
  try {
    return window.roamAlphaAPI.q(BLOCK_QUERY, pat) || [];
  } catch (err) {
    console.warn("[inline-ac] block query failed", pat, err);
    return null;
  }
}

// 中日韩文字：汉字、平假名、片假名、谚文
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// 含中日韩字的用 blockMinChars；纯拉丁字母一个字信息量小，3 个字母能命中大半个图谱，
// 默认要到 4 个才搜
function blockMinFor(q) {
  return setting(CJK_RE.test(q) ? "blockMinChars" : "blockMinCharsLatin");
}

// 和 datascript 里 (?i) 正则同一个语义：不区分大小写的子串。降级成大小写敏感后也跟着变。
// r[3] 是扫描时就转好的小写原文，缓存命中时每个键都要筛上万行，别每次再 toLowerCase
function filterRows(rows, q) {
  if (!blockQueryCaseFlag) return rows.filter((r) => r[1].includes(q));
  const ql = q.toLowerCase();
  return rows.filter((r) => r[3].includes(ql));
}

// 上一次扫描的完整结果（没过滤、没截断，只留前 N 条会丢匹配）。词变长时（mach → machi）
// 新词包含旧词，结果一定是旧结果的子集，直接在 JS 里筛，不再扫一遍全图谱。
// 换 textarea、close()、新词不包含旧词、超过 30 秒都作废
let blockCache = null; // { q, rows, ts, textarea, caseless }

// 缓存能不能直接回答 q：同一个 textarea、没过期、q 包含上次扫描的词
function blockCacheCovers(q, textarea) {
  const c = blockCache;
  return (
    !!c &&
    c.textarea === textarea &&
    c.caseless === blockQueryCaseFlag &&
    Date.now() - c.ts <= BLOCK_CACHE_TTL &&
    (c.caseless ? q.toLowerCase().includes(c.q.toLowerCase()) : q.includes(c.q))
  );
}

// block：让 datascript 用正则做不区分大小写的子串匹配，避免把全图谱拉到 JS 里
function scanBlocks(q, textarea) {
  if (blockCacheCovers(q, textarea)) {
    const c = blockCache;
    return q === c.q ? c.rows : filterRows(c.rows, q);
  }
  const esc = escapeRegex(q);
  let rows = null;
  if (blockQueryCaseFlag) {
    rows = runBlockQuery("(?i)" + esc);
    if (rows === null) blockQueryCaseFlag = false;
  }
  if (rows === null) rows = runBlockQuery(esc);
  if (rows === null) return [];
  // 另存一份带小写原文的行，不往 Roam API 返回的数组上写字段（冻结的数组在严格模式下会抛错）
  const own = rows.map(([uid, s, pt]) => [uid, s, pt, s.toLowerCase()]);
  blockCache = { q, rows: own, ts: Date.now(), textarea, caseless: blockQueryCaseFlag };
  return own;
}

// 过滤、挑最短的几条都放在缓存筛完之后做，缓存里永远是完整的结果。
// 结果可能上万行而只要 limit 条，不整体排序，边扫边维护一个按长度排好的小数组；
// 等长的先到先得，和原来的稳定排序结果一样
function toBlockItems(rows, q, excludeUid, limit) {
  const ql = q.toLowerCase();
  const top = [];
  for (const r of rows) {
    const [uid, s] = r;
    const len = s.length;
    if (top.length === limit && len >= top[limit - 1][1].length) continue;
    if (uid === excludeUid || s.trim() === "" || r[3] === ql) continue;
    let i = top.length;
    while (i > 0 && top[i - 1][1].length > len) i--;
    top.splice(i, 0, r);
    if (top.length > limit) top.pop();
  }
  return top.map(([uid, s, pt]) => ({ type: "block", uid, text: s, page: pt, q }));
}

// block 搜什么：光标前的整个词，和页面命中的那段，短于各自门槛的不要
function blockCandidates(tail, pages) {
  const out = [];
  for (const q of [tail, pages.length ? pages[0].q : null]) {
    if (q && q.length >= blockMinFor(q) && !out.includes(q)) out.push(q);
  }
  return out;
}

// block 先用光标前的整个词，这是最精确的意图；搜不到（或短于门槛）再退到「页面命中的那段」，
// 中文不分词时那段通常更像一个词。反过来会出事：打「动态的效果」时页面只命中了后缀「效果」，
// block 就跟着只搜「效果」，把真正想要的那条漏掉。
// 页面命中的那段是整个词的后缀，它的结果是整个词结果的超集，所以只拿短的那个扫一次，
// 整个词的结果在 JS 里从中筛出来 —— 一次求值最多扫一遍图谱。item.q 必须是 commit() 要替换的那段
function shortestCandidate(cands) {
  return cands.reduce((a, b) => (b.length < a.length ? b : a));
}

function findBlockMatches(tail, cands, textarea) {
  const limit = setting("blockMaxResults");
  const uid = currentBlockUid(textarea);
  const shortest = shortestCandidate(cands);
  const rows = scanBlocks(shortest, textarea);
  if (shortest !== tail && cands.includes(tail)) {
    const whole = toBlockItems(filterRows(rows, tail), tail, uid, limit);
    if (whole.length) return whole;
  }
  return toBlockItems(rows, shortest, uid, limit);
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
  popup.innerHTML = `
    <div class="rr-ac-main">
      <div class="rr-ac-list" role="listbox" aria-label="Link suggestions"></div>
      <div class="rr-ac-preview"></div>
    </div>
    <div class="rr-ac-foot">
      <span><kbd>↑</kbd><kbd>↓</kbd> Select</span>
      <span><kbd>↵</kbd> Insert</span>
      <span><kbd>Esc</kbd> Dismiss</span>
    </div>`;
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
    // 悬停不滚动列表，免得列表在鼠标底下跳
    if (li) setActive(Number(li.dataset.idx), { scroll: false });
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

// 页面候选只显示标题，用页面链接色和 block 行区分；tag 模式留一个 # 提示插入格式
function pageLabel(item) {
  const title = `<span class="rr-ac-title">${highlight(item.title, item.q)}</span>`;
  if (setting("insertMode") !== "#tag") return title;
  return `<span class="rr-ac-sigil">#</span>` + title;
}

function renderItem(item, i, prev) {
  const cls = [
    "rr-ac-item",
    item.type === "page" ? "rr-ac-page" : "rr-ac-block",
    i === state.index ? "is-active" : "",
    prev && prev.type !== item.type ? "rr-ac-group-start" : "", // 页面和 block 之间画分隔线
  ].filter(Boolean).join(" ");
  const attrs = `class="${cls}" data-idx="${i}" role="option" aria-selected="${i === state.index}"`;
  if (item.type === "page") return `<div ${attrs}>${pageLabel(item)}</div>`;
  return `<div ${attrs} title="${escHtml(item.text)}">
    <span class="rr-ac-dot"></span>
    <span class="rr-ac-body">
      <span class="rr-ac-snippet">${highlight(snippet(item.text, item.q), item.q)}</span>
      <span class="rr-ac-where">${escHtml(item.page)}</span>
    </span>
  </div>`;
}

// 候选变了才重建 DOM
function render() {
  ensurePopup();
  listEl.innerHTML = state.items.map((item, i) => renderItem(item, i, state.items[i - 1])).join("");
  renderPreview(state.items[state.index]);
}

// block 结果晚到，接在已有候选后面：已有的行和当前选中项都不动，正按 ↓ 的人不会看到高亮跳走
function appendItems(items) {
  const start = state.items.length;
  state.items = state.items.concat(items);
  let html = "";
  for (let i = start; i < state.items.length; i++) {
    html += renderItem(state.items[i], i, state.items[i - 1]);
  }
  listEl.insertAdjacentHTML("beforeend", html);
  place(); // 列表变长了，窄窗口下重新定位，免得弹层顶出屏幕底
}

// 只换高亮那一行。候选可以有几十条，↑↓ 每按一次都重建整个列表会肉眼可见地卡
function setActive(index, { scroll = true } = {}) {
  if (!state.items[index] || index === state.index) return;
  const rows = listEl.children;
  const prev = rows[state.index];
  if (prev) {
    prev.classList.remove("is-active");
    prev.setAttribute("aria-selected", "false");
  }
  state.index = index;
  const next = rows[index];
  if (next) {
    next.classList.add("is-active");
    next.setAttribute("aria-selected", "true");
    if (scroll) next.scrollIntoView({ block: "nearest" });
  }
  renderPreview(state.items[index]);
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

// 把子树渲染成嵌套的圆点大纲（子块左边有 Roam 那样的竖线），超过预算就截断
function outlineHtml(nodes, depth, budget) {
  let html = "";
  for (const n of nodes) {
    if (budget.left <= 0 || depth >= PREVIEW_MAX_DEPTH) break;
    budget.left--;
    const kids = outlineHtml(childrenOf(n), depth + 1, budget);
    html +=
      `<div class="rr-pv-line"><span class="rr-pv-dot"></span><span>${formatInline(n[":block/string"] || "")}</span></div>` +
      (kids ? `<div class="rr-pv-kids">${kids}</div>` : "");
  }
  return html;
}

function countNodes(nodes) {
  let n = 0;
  const walk = (list) => list.forEach((x) => { n++; walk(childrenOf(x)); });
  walk(nodes);
  return n;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// 大纲 + 没显示完的条数；没有子块时返回空串，预览里就不画分隔线
function outlineBody(kids, total) {
  if (!kids.length) return "";
  const budget = { left: PREVIEW_MAX_LINES };
  const html = outlineHtml(kids, 0, budget);
  const hidden = total - (PREVIEW_MAX_LINES - budget.left);
  const more = hidden > 0 ? `<div class="rr-pv-more">${plural(hidden, "more block")}</div>` : "";
  return `<div class="rr-pv-body">${html}${more}</div>`;
}

function buildPreview(item) {
  if (item.type === "page") {
    const kids = childrenOf(pullTree([":node/title", item.title]));
    const total = countNodes(kids);
    const refs = plural(backlinkCount(item.title), "linked reference");
    return `
      <div class="rr-pv-title">${escHtml(item.title)}</div>
      <div class="rr-pv-meta">${total ? `${plural(total, "block")}, ${refs}` : refs}</div>
      ${outlineBody(kids, total) || '<div class="rr-pv-empty">No blocks on this page yet.</div>'}`;
  }

  const kids = childrenOf(pullTree([":block/uid", item.uid]));
  return `
    <div class="rr-pv-crumb">${escHtml(item.page)}</div>
    <div class="rr-pv-root">${formatInline(item.text)}</div>
    ${outlineBody(kids, countNodes(kids))}`;
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
  const w = el.offsetWidth || 660;
  const h = el.offsetHeight || 340;
  let left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.top + r.height + 4;
  if (top + h > window.innerHeight - 8) top = r.top - h - 4; // 放不下就往上翻
  el.style.left = Math.max(8, left) + "px";
  el.style.top = Math.max(8, top) + "px";
}

function openWith(textarea, tail, items) {
  state.open = true;
  state.lateOpenAt = 0;
  state.textarea = textarea;
  state.query = tail; // 当前整个词，Esc 时记住它
  state.items = items;
  state.index = 0;
  ensurePopup();
  applyTheme();
  render();
  place();
}

// keepBlockCache：evaluate() 里页面没命中、只是先藏起弹层等 block 结果时用，
// 不然 mach → machi 每次都会把缓存清掉
function close(opts = {}) {
  cancelBlockSearch();
  if (!opts.keepBlockCache) blockCache = null;
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

// 带空格或方括号的标题做标签时要写成 #[[标题]]
function tagNeedsBrackets(title) {
  return /[\s\[\]]/.test(title);
}

function buildInsert(item) {
  if (item.type === "page") {
    const t = item.title;
    if (setting("insertMode") === "#tag") return tagNeedsBrackets(t) ? `#[[${t}]]` : `#${t}`;
    return `[[${t}]]`;
  }
  // block：永远引用 uid，不会创建新页面
  if (setting("blockInsertMode") === "[text](((uid)))") {
    const label = item.text.replace(/\s+/g, " ").trim().replace(/[\[\]]/g, "");
    return `[${label}](((${item.uid})))`;
  }
  return `((${item.uid}))`;
}

// 光标前那段对不上 item.q 就不插（挪过光标、Delay > 0 时匹配还没跟上），返回 false 让按键照常生效。
// 不校验的话 cursor < q.length 时 slice(0, 负数) 会从末尾截，整段文字都会被换掉
function commit() {
  const ta = state.textarea;
  const item = state.items[state.index];
  const cursor = ta ? ta.selectionStart : 0;
  if (
    !ta ||
    !item ||
    cursor !== ta.selectionEnd ||
    cursor < item.q.length ||
    ta.value.slice(cursor - item.q.length, cursor) !== item.q
  ) {
    close();
    return false;
  }

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
  return true;
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

function isBlockTextarea(el) {
  return el && el.tagName === "TEXTAREA" && el.classList.contains("rm-block-input");
}

function cancelBlockSearch() {
  clearTimeout(state.blockTimer);
  state.blockTimer = null;
}

// 定时器触发时这次求值可能已经过时：换了 block、又打了字、挪了光标、正在组词、按了 Esc
function blockRequestLive(req) {
  const ta = req.textarea;
  if (req.seq !== state.seq || state.composing || !setting("enabled")) return false;
  if (document.activeElement !== ta || roamAutocompleteVisible()) return false;
  if (ta.selectionStart !== req.cursor || ta.selectionEnd !== req.cursor) return false;
  if (tailBeforeCursor(ta.value, req.cursor) !== req.tail) return false;
  if (state.dismissedTail && req.tail.startsWith(state.dismissedTail)) return false;
  if (state.open && (state.textarea !== ta || state.query !== req.tail)) return false;
  return true;
}

// block 搜索单独排一个定时器：页面候选查的是缓存好的标题列表，每个键都算也不卡，弹层照旧
// 立刻出来；block 要扫全图谱，等停手 blockDelayMs 再搜，结果追加在页面候选后面。
// 页面没命中的话这时才打开弹层。只有真要扫图谱才走这里，缓存能回答的在 evaluate() 里当场算
function scheduleBlockSearch(req) {
  cancelBlockSearch();
  state.blockTimer = setTimeout(() => {
    state.blockTimer = null;
    if (!blockRequestLive(req)) return;
    const blocks = findBlockMatches(req.tail, req.cands, req.textarea);
    if (!blocks.length) return;
    if (state.open) return appendItems(blocks); // 追加不重置 lateOpenAt
    openWith(req.textarea, req.tail, blocks);
    // 这个弹层是用户停手之后才冒出来的，他可能正按下 Enter 想换行。先放行一小会儿
    state.lateOpenAt = Date.now();
  }, setting("blockDelayMs"));
}

function evaluate(textarea) {
  state.seq++;
  cancelBlockSearch();
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

  // 页面马上出。block 能从上次扫描的缓存里筛出来（mach → machi）也当场算，几毫秒的事，
  // 列表不会每打一个字就闪一下；要真去扫图谱的才交给定时器
  const pages = findPageMatches(tail);
  const cands = setting("blockSearch") ? blockCandidates(tail, pages) : [];
  const cached = cands.length > 0 && blockCacheCovers(shortestCandidate(cands), textarea);
  const items = cached ? pages.concat(findBlockMatches(tail, cands, textarea)) : pages;
  if (items.length) openWith(textarea, tail, items);
  else close({ keepBlockCache: cands.length > 0 });
  if (cands.length && !cached) scheduleBlockSearch({ seq: state.seq, textarea, tail, cursor, cands });
}

function schedule(textarea) {
  clearTimeout(state.timer);
  cancelBlockSearch();
  // 默认 0：这次输入先上屏，紧接着就匹配。弹层晚一拍出现最恼人 —— 你以为在换行，
  // 它刚好冒出来把 Enter 抢走。大图谱里嫌打字发涩再把 Delay 调回 90
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
  // 组词只是同一个词还没打完，留着 block 缓存：知识 → 知识管理 可以直接筛
  close({ keepBlockCache: true });
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
      setActive((state.index + 1) % state.items.length);
      break;
    case "ArrowUp":
      setActive((state.index - 1 + state.items.length) % state.items.length);
      break;
    case "Enter":
    case "Tab":
      // 弹层是 block 结果晚到才打开的、刚冒出来不到 200ms：这一下多半是冲着 Roam 按的，放行
      if (state.lateOpenAt && Date.now() - state.lateOpenAt < LATE_OPEN_GRACE_MS) {
        close();
        return;
      }
      if (!commit()) return; // 没插入就放行，Enter 照常换行
      break;
    case "ArrowLeft":
    case "ArrowRight":
    case "Home":
    case "End":
      // 光标一挪，候选就对不上光标前的字了。关掉弹层、按键放行，接着按 Enter 就是 Roam 自己的换行
      clearTimeout(state.timer);
      close();
      return;
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

// 页面滚动或窗口变化时关掉；弹层自己的列表 / 预览在滚动不算
function onScroll(e) {
  if (!state.open) return;
  if (popup && e.target instanceof Node && popup.contains(e.target)) return;
  close();
}

function on(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  listeners.push(() => target.removeEventListener(type, fn, opts));
}

/* ------------------------------------------------------------------ */
/* 样式                                                                */
/* ------------------------------------------------------------------ */

// 浅色 / 深色两套兜底变量：探测不出主题时用，探测出来了就被内联变量盖掉
const DARK_VARS = `
  --ac-bg: #30404d;
  --ac-pane: #293742;
  --ac-text: #f5f8fa;
  --ac-muted: #b8c5cf;
  --ac-faint: #738694;
  --ac-bullet: #8a9ba8;
  --ac-line: rgba(255, 255, 255, 0.12);
  --ac-accent: #7ac5f5;
  --ac-active: rgba(72, 175, 240, 0.12);
  --ac-mark: #7a5b00;
  --ac-shadow: 0 0 0 1px rgba(16, 22, 26, 0.4), 0 2px 4px rgba(16, 22, 26, 0.4), 0 10px 30px -6px rgba(16, 22, 26, 0.7);`;

const LIGHT_VARS = `
  --ac-bg: #ffffff;
  --ac-pane: #f5f8fa;
  --ac-text: #182026;
  --ac-muted: #5c7080;
  --ac-faint: #a7b6c2;
  --ac-bullet: #8a9ba8;
  --ac-line: rgba(16, 22, 26, 0.1);
  --ac-accent: #106ba3;
  --ac-active: rgba(19, 124, 189, 0.1);
  --ac-mark: #fef09f;
  --ac-shadow: 0 0 0 1px rgba(16, 22, 26, 0.1), 0 2px 4px rgba(16, 22, 26, 0.1), 0 10px 30px -6px rgba(16, 22, 26, 0.25);`;

// 颜色都是 #rr-inline-ac 上的 CSS 变量，换主题只覆盖变量
const CSS = `
#${POPUP_ID} {
  ${LIGHT_VARS}
  --ac-radius: 8px;

  position: fixed;
  z-index: 9999;
  display: none;
  flex-direction: column;
  width: 660px;
  max-width: calc(100vw - 16px);
  height: 340px;
  max-height: calc(100vh - 16px);
  overflow: hidden;
  border-radius: var(--ac-radius);
  background: var(--ac-bg);
  color: var(--ac-text);
  box-shadow: var(--ac-shadow);
  font-size: 14px;
  line-height: 1.4;
}

#${POPUP_ID} .rr-ac-main { display: flex; flex: 1 1 auto; min-height: 0; }

/* 左：候选列表 */
#${POPUP_ID} .rr-ac-list {
  flex: 0 0 280px;
  overflow-y: auto;
  padding: 4px;
  scrollbar-width: thin;
}
#${POPUP_ID} .rr-ac-item {
  position: relative;
  padding: 5px 8px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
#${POPUP_ID} .rr-ac-item.is-active { background: var(--ac-active); }
/* 命中的那段一律加粗 + 中性底色，不借颜色 —— 颜色只用来分页面和 block */
#${POPUP_ID} .rr-ac-item b {
  padding: 0 2px;
  margin: 0 -1px;
  border-radius: 3px;
  background: var(--ac-line);
  font-weight: 700;
}
#${POPUP_ID} .rr-ac-item.rr-ac-group-start { margin-top: 9px; }
#${POPUP_ID} .rr-ac-group-start::before {
  content: "";
  position: absolute;
  top: -5px;
  left: 8px;
  right: 8px;
  border-top: 1px solid var(--ac-line);
}

/* 页面行：整行用页面链接色 —— 这个颜色只给页面候选，一眼和下面的 block 行分开 */
#${POPUP_ID} .rr-ac-page { display: flex; align-items: baseline; color: var(--ac-accent); }
#${POPUP_ID} .rr-ac-sigil { flex: none; opacity: 0.6; }
#${POPUP_ID} .rr-ac-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* block 行：圆点 + 两行（原文 / 所在页面），原文一律正文色 */
#${POPUP_ID} .rr-ac-block { display: flex; align-items: flex-start; gap: 9px; color: var(--ac-text); }
#${POPUP_ID} .rr-ac-dot {
  flex: none;
  width: 5px;
  height: 5px;
  margin: calc(0.7em - 2.5px) 0 0 2px;
  border-radius: 50%;
  background: var(--ac-bullet);
}
#${POPUP_ID} .rr-ac-body { display: flex; flex-direction: column; min-width: 0; }
#${POPUP_ID} .rr-ac-snippet, #${POPUP_ID} .rr-ac-where { overflow: hidden; text-overflow: ellipsis; }
#${POPUP_ID} .rr-ac-where { font-size: 12px; color: var(--ac-muted); }

/* 右：预览，排得像一个缩小的 Roam 页面 */
#${POPUP_ID} .rr-ac-preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 14px 16px;
  border-left: 1px solid var(--ac-line);
  background: var(--ac-pane);
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
  scrollbar-width: thin;
}
#${POPUP_ID} .rr-pv-title { font-size: 17px; font-weight: 600; line-height: 1.3; }
#${POPUP_ID} .rr-pv-meta, #${POPUP_ID} .rr-pv-crumb { font-size: 12px; color: var(--ac-muted); }
#${POPUP_ID} .rr-pv-meta { margin-top: 3px; }
#${POPUP_ID} .rr-pv-crumb { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${POPUP_ID} .rr-pv-root { margin-top: 2px; font-size: 14px; font-weight: 500; }
#${POPUP_ID} .rr-pv-body { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--ac-line); }
#${POPUP_ID} .rr-pv-line { display: flex; gap: 8px; padding: 1px 0; }
#${POPUP_ID} .rr-pv-dot {
  flex: none;
  width: 5px;
  height: 5px;
  margin-top: calc(0.75em - 2.5px);
  border-radius: 50%;
  background: var(--ac-bullet);
}
#${POPUP_ID} .rr-pv-kids { margin-left: 2px; padding-left: 13px; border-left: 1px solid var(--ac-line); }
#${POPUP_ID} .rr-pv-link { color: var(--ac-accent); }
#${POPUP_ID} .rr-pv-ref { border-bottom: 1px solid var(--ac-faint); }
#${POPUP_ID} .rr-pv-empty, #${POPUP_ID} .rr-pv-more { margin-top: 8px; font-size: 12px; color: var(--ac-muted); }
#${POPUP_ID} code { padding: 0 3px; border-radius: 3px; background: var(--ac-line); font-size: 12px; }
#${POPUP_ID} mark { padding: 0 1px; border-radius: 2px; background: var(--ac-mark); color: var(--ac-mark-text, inherit); }

/* 底部：按键提示 */
#${POPUP_ID} .rr-ac-foot {
  display: flex;
  flex: none;
  gap: 16px;
  padding: 6px 12px;
  overflow: hidden;
  border-top: 1px solid var(--ac-line);
  color: var(--ac-muted);
  font-size: 12px;
  white-space: nowrap;
}
#${POPUP_ID} kbd {
  display: inline-block;
  box-sizing: border-box;
  min-width: 17px;
  margin-right: 3px;
  padding: 0 4px;
  border: 1px solid var(--ac-line);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--ac-bg);
  color: var(--ac-text);
  font: inherit;
  font-size: 11px;
  line-height: 15px;
  text-align: center;
}

@media (max-width: 640px) {
  #${POPUP_ID} { width: min(320px, calc(100vw - 16px)); height: auto; max-height: 300px; }
  #${POPUP_ID} .rr-ac-list { flex: 1 1 auto; }
  #${POPUP_ID} .rr-ac-preview { display: none; }
}

/* 深浅色：applyTheme() 判定出来后加 .rr-ac-light / .rr-ac-dark 为准（写在最后，
   优先级同分靠后者胜）；它还没跑或判不出来时，退回看祖先上的主题 class */
.bp3-dark #${POPUP_ID}, .dark-theme #${POPUP_ID}, [data-theme="dark"] #${POPUP_ID}, .rs-dark #${POPUP_ID} { ${DARK_VARS} }
@media (prefers-color-scheme: dark) { .rs-auto #${POPUP_ID} { ${DARK_VARS} } }
#${POPUP_ID}.rr-ac-light { ${LIGHT_VARS} }
#${POPUP_ID}.rr-ac-dark { ${DARK_VARS} }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------------ */
/* 主题适配                                                             */
/* ------------------------------------------------------------------ */

// 弹层颜色有三个来源，优先级从高到低：
//   1. Roam Studio 注入的 --bc-*（背景）/ --co-*（文字）/ --sd-*（阴影）/
//      --bd-*（圆角）变量，语义最准，读得到就用；
//   2. 页面里真实 Roam 元素的 computed style，页面上没有的元素用离屏探针补
//      （原版浅色 / 深色、以及用户自己写的 roam/css 主题都靠这条）；
//   3. CSS 里硬编码的浅色 / 深色兜底。深浅由 JS 判定后加 .rr-ac-dark，
//      不指望 .bp3-dark 一定是弹层的祖先。
// 前两条合并成一组 --ac-* 内联写在弹层上。每次打开弹层时调 applyTheme()，
// 主题 key（class + Studio 样式长度 + 系统深浅）没变就用缓存，不重复采样。

const RS_STYLE_ID = "roamstudio-css-theme";
const AC_VARS = [
  "--ac-bg", "--ac-pane", "--ac-text", "--ac-muted", "--ac-faint",
  "--ac-bullet", "--ac-line", "--ac-accent", "--ac-active",
  "--ac-mark", "--ac-mark-text", "--ac-shadow", "--ac-radius",
];
const BLACK = [0, 0, 0, 1];
const WHITE = [255, 255, 255, 1];
// 两个颜色差到这个对比度以上才算肉眼分得开
const SEPARATE = 1.03;

/* --- 颜色工具：统一表示为 [r, g, b, a]，a 省略时当 1 --- */

function parseColor(str) {
  const s = (str || "").trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    const h = m[1];
    if (h.length !== 3 && h.length !== 4 && h.length !== 6 && h.length !== 8) return null;
    const ch = h.length <= 4 ? (i) => h[i] + h[i] : (i) => h.slice(i * 2, i * 2 + 2);
    const v = (i) => parseInt(ch(i), 16);
    return [v(0), v(1), v(2), h.length === 4 || h.length === 8 ? v(3) / 255 : 1];
  }
  m = /^rgba?\(\s*([^)]*?)\s*\)$/i.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const n = parts.map(Number);
    if (n.some((x) => !Number.isFinite(x))) return null;
    return [n[0], n[1], n[2], parts.length === 4 ? n[3] : 1];
  }
  return null;
}

// fg 叠在 bg 上，两边都可以是半透明的
function blend(fg, bg) {
  const a = fg[3] + bg[3] * (1 - fg[3]);
  if (a === 0) return [0, 0, 0, 0];
  const ch = (i) => (fg[i] * fg[3] + bg[i] * bg[3] * (1 - fg[3])) / a;
  return [ch(0), ch(1), ch(2), a];
}

// fg 按自己的 alpha 叠在不透明的 bg 上，返回不透明色
function over(fg, bg) {
  const c = blend(fg, bg);
  return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 1];
}

// 逐通道线性插值，t = 1 时全取 a，返回不透明色
function mix(a, b, t) {
  return [
    Math.round(b[0] + (a[0] - b[0]) * t),
    Math.round(b[1] + (a[1] - b[1]) * t),
    Math.round(b[2] + (a[2] - b[2]) * t),
    1,
  ];
}

// WCAG 相对亮度与对比度（都按不透明算）
function luminance(c) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

function contrast(a, b) {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

function cssColor(c) {
  const r = Math.round(c[0]), g = Math.round(c[1]), b = Math.round(c[2]);
  return c[3] < 1 ? `rgba(${r}, ${g}, ${b}, ${c[3]})` : `rgb(${r}, ${g}, ${b})`;
}

function alpha(c, a) {
  return [c[0], c[1], c[2], a];
}

// 保住色相，往黑或白推到在所有给定底色上都够 target 为止；推到头还不够返回 null。
// 主题给的强调色、高亮色常常差一点点（Roam 自带深色的链接蓝在弹层底色上只有
// 4.4:1），直接丢掉就不像原主题了，微调明度比换成正文色更贴。
function fitContrast(c, bgs, target) {
  const toward = luminance(bgs[0]) > 0.5 ? BLACK : WHITE;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const v = t === 0 ? c : mix(toward, c, t);
    if (bgs.every((b) => contrast(v, b) >= target)) return v;
  }
  return null;
}

/* --- 从页面上量颜色 --- */

// 元素自己某个属性的颜色，完全透明当没有
function colorOf(el, prop) {
  if (!el) return null;
  const c = parseColor(getComputedStyle(el)[prop]);
  return c && c[3] > 0 ? c : null;
}

// 元素实际看上去的背景：自己透明就往祖先找，半透明就一层层叠下去
function bgOf(el) {
  let acc = null;
  for (let n = el; n; n = n.parentElement) {
    const c = parseColor(getComputedStyle(n).backgroundColor);
    if (!c || c[3] === 0) continue;
    acc = acc ? blend(acc, c) : c;
    if (acc[3] >= 0.99) return [Math.round(acc[0]), Math.round(acc[1]), Math.round(acc[2]), 1];
  }
  return null;
}

// 页面上不一定有页面引用、高亮这些元素，就照着 Roam 的结构搭一份离屏的，
// 让 Roam / Roam Studio / 用户 CSS 的选择器照常命中，量完立刻删掉
const PROBE_HTML = `
<div class="roam-app"><div class="roam-main"><div class="roam-body-main">
<div class="rm-article-wrapper"><div class="roam-article"><div class="rm-block-children">
<div class="rm-block-main rm-block__self">
<span class="rm-bullet"><span class="rm-bullet__inner" data-probe="bullet"></span></span>
<div class="rm-block-text roam-block">
<span class="rm-page-ref rm-page-ref--link" data-probe="accent">A</span>
<span class="rm-highlight" data-probe="mark">A</span>
</div></div></div></div></div></div></div></div>
<div class="rm-autocomplete__results bp3-elevation-3 bp3-menu" data-probe="popover">A</div>
<div class="bp3-popover"><div class="bp3-popover-content" data-probe="popover2">A</div></div>`;

// 弹层背景 / 阴影 / 圆角都从同一个「弹层类」元素上抄
function readPopover(el, out, ancestors) {
  if (!el) return false;
  const cs = getComputedStyle(el);
  let bg = null;
  if (ancestors) {
    bg = bgOf(el);
  } else {
    const c = parseColor(cs.backgroundColor);
    if (c && c[3] >= 0.99) bg = [c[0], c[1], c[2], 1];
  }
  if (!bg) return false;
  out.popover = bg;
  if (cs.boxShadow && cs.boxShadow !== "none") out.shadow = cs.boxShadow;
  const r = parseFloat(cs.borderRadius);
  if (Number.isFinite(r) && r >= 2 && r <= 24) out.radius = r + "px";
  return true;
}

// 采一次当前主题：先用页面上真实的元素，缺的再插探针
function sampleRoamDom() {
  const out = {
    text: null, pageBg: null, popover: null, accent: null,
    bullet: null, mark: null, markText: null, shadow: "", radius: "",
  };

  const article =
    document.querySelector(".roam-article") ||
    document.querySelector(".roam-body-main") ||
    document.querySelector(".roam-main") ||
    document.body;
  out.pageBg = bgOf(article);
  out.text = colorOf(document.querySelector(".rm-block-text") || article, "color");

  const realPop = document.querySelector(".rm-autocomplete__results, .bp3-popover-content");
  if (realPop) readPopover(realPop, out, true);
  out.accent = colorOf(document.querySelector(".rm-page-ref--link"), "color");
  out.bullet = colorOf(document.querySelector(".rm-bullet__inner, .rm-bullet"), "backgroundColor");
  const realMark = document.querySelector(".rm-highlight");
  if (realMark) {
    out.mark = colorOf(realMark, "backgroundColor");
    out.markText = colorOf(realMark, "color");
  }

  if (out.text && out.popover && out.accent && out.bullet && out.mark) return out;

  const probe = document.createElement("div");
  probe.setAttribute("data-rr-ac-probe", "");
  probe.style.cssText =
    "position:fixed;left:-10000px;top:0;width:400px;height:200px;" +
    "overflow:hidden;visibility:hidden;pointer-events:none;contain:layout paint size;";
  probe.innerHTML = PROBE_HTML;
  document.body.appendChild(probe);
  try {
    const at = (name) => probe.querySelector(`[data-probe="${name}"]`);
    if (!out.popover) readPopover(at("popover"), out, false) || readPopover(at("popover2"), out, false);
    if (!out.text) out.text = colorOf(probe.querySelector(".rm-block-text"), "color");
    if (!out.accent) out.accent = colorOf(at("accent"), "color");
    if (!out.bullet) out.bullet = colorOf(at("bullet"), "backgroundColor");
    if (!out.mark) {
      out.mark = colorOf(at("mark"), "backgroundColor");
      out.markText = colorOf(at("mark"), "color");
    }
  } finally {
    probe.remove();
  }
  return out;
}

/* --- Roam Studio 的变量 --- */

// Roam Studio 往 <head> 注入 <style id="roamstudio-css-theme">，里面是 :root 上的
// --bc-* / --co-* / --sd-* / --bd-* 变量；<html> 上带 rs-light / rs-dark / rs-auto。
// 它不把主题名写进 DOM，所以只能读变量现算。
function readStudioVars() {
  const out = {
    text: null, pageBg: null, popover: null, accent: null,
    bullet: null, mark: null, markText: null, active: null, shadow: "", radius: "",
  };
  if (!document.getElementById(RS_STYLE_ID)) return out;
  const cs = getComputedStyle(document.documentElement);
  // 有些主题把变量声明成空值，所以逐个候选读，第一个能解析且不透明的胜出
  const color = (...names) => {
    for (const n of names) {
      const c = parseColor(cs.getPropertyValue(n));
      if (c && c[3] === 1) return c;
    }
    return null;
  };
  const raw = (n) => cs.getPropertyValue(n).trim();

  out.popover = color("--bc-popover", "--bc-commandpalette__menu");
  out.pageBg = color("--bc-app");
  out.text = color("--co-popover", "--co-app");
  out.accent = color("--co-main__page-link");
  out.bullet = color("--bc-main__bullet-inner");
  out.active = color("--bc-block-search__menu-item--hover", "--bc-commandpalette__menu-item--active");
  out.mark = parseColor(raw("--bc-main__highlight")); // 高亮底色允许半透明
  out.markText = color("--co-main__highlight");
  out.shadow = raw("--sd-popover");
  const r = parseFloat(raw("--bd-popover"));
  if (Number.isFinite(r) && r >= 2 && r <= 24) out.radius = r + "px";
  return out;
}

/* --- 合并、校验、写变量 --- */

function isDarkUI(src) {
  const base = src.popover || src.pageBg;
  if (base) return luminance(base) < 0.25;
  if (src.text) return luminance(src.text) > 0.5;
  if (document.querySelector(".bp3-dark, .dark-theme, .rs-dark, [data-theme='dark']")) return true;
  if (document.querySelector(".rs-auto")) return matchMedia("(prefers-color-scheme: dark)").matches;
  return false;
}

// src 里的颜色 → 一组 --ac-*。底色和正文对比不够就返回 null，交给 CSS 兜底
function deriveTheme(src) {
  const bg = src.popover || src.pageBg;
  const text = src.text;
  if (!bg || !text || contrast(text, bg) < 4.5) return null;

  // 预览栏要和列表分得开：主题给了不一样的页面底色就用它，否则自己压暗一点
  let pane = src.pageBg && contrast(src.pageBg, bg) >= SEPARATE ? src.pageBg : null;
  if (!pane) {
    const darker = mix(BLACK, bg, 0.06);
    pane = contrast(darker, bg) >= SEPARATE ? darker : mix(text, bg, 0.08);
  }

  let muted = text;
  for (const t of [0.7, 0.8, 0.9, 1]) {
    const c = mix(text, bg, t);
    if (contrast(c, bg) >= 4.5) {
      muted = c;
      break;
    }
  }
  const faint = mix(text, bg, 0.45);
  const line = alpha(text, 0.12);
  const bullet = src.bullet ? over(src.bullet, bg) : faint;

  let active = src.active;
  if (!active || contrast(text, over(active, bg)) < 4.5) active = alpha(text, 0.08);
  const activeSolid = over(active, bg);

  // 命中高亮和预览里的链接都用强调色，选中行和普通行上都要读得清
  let accent = src.accent && fitContrast(src.accent, [bg, activeSolid], 4.5);
  if (!accent) accent = text;

  // 高亮底色原样用（允许半透明），文字色跟着调到够对比；调不出来才换自己的底色
  const vars = {};
  let mark = alpha(accent, 0.18);
  if (src.mark && src.mark[3] > 0) {
    const solid = over(src.mark, bg);
    const markText = fitContrast(src.markText || text, [solid], 4.5);
    if (markText) {
      mark = src.mark;
      if (cssColor(markText) !== cssColor(text)) vars["--ac-mark-text"] = cssColor(markText);
    }
  }

  vars["--ac-bg"] = cssColor(bg);
  vars["--ac-pane"] = cssColor(pane);
  vars["--ac-text"] = cssColor(text);
  vars["--ac-muted"] = cssColor(muted);
  vars["--ac-faint"] = cssColor(faint);
  vars["--ac-line"] = cssColor(line);
  vars["--ac-bullet"] = cssColor(bullet);
  vars["--ac-accent"] = cssColor(accent);
  vars["--ac-active"] = cssColor(active);
  vars["--ac-mark"] = cssColor(mark);
  if (src.shadow) vars["--ac-shadow"] = src.shadow;
  if (src.radius) vars["--ac-radius"] = src.radius;
  return vars;
}

let themeCache = null;

// 主题一变这串就变：Roam 深浅色改 body class，Roam Studio 换主题换整段 CSS
function themeKey() {
  const rs = document.getElementById(RS_STYLE_ID);
  return [
    document.documentElement.className,
    document.body.className,
    rs ? rs.textContent.length : 0,
    matchMedia("(prefers-color-scheme: dark)").matches ? "d" : "l",
  ].join("|");
}

function invalidateTheme() {
  themeCache = null;
  if (state.open) applyTheme();
}

function resolveTheme() {
  const key = themeKey();
  if (themeCache && themeCache.key === key) return themeCache.value;
  const dom = sampleRoamDom();
  const rs = readStudioVars();
  // Studio 的变量更准，它没给的用页面上量到的补
  const src = {};
  for (const k of Object.keys(dom)) src[k] = rs[k] || dom[k];
  src.active = rs.active || null;
  const value = { dark: isDarkUI(src), vars: deriveTheme(src) };
  themeCache = { key, value };
  return value;
}

// 每次打开弹层时调
function applyTheme() {
  if (!popup) return;
  for (const v of AC_VARS) popup.style.removeProperty(v);
  let theme;
  try {
    theme = resolveTheme();
  } catch (_) {
    return; // 量不出来就维持上一次的判定，颜色交给 CSS
  }
  popup.classList.toggle("rr-ac-dark", theme.dark);
  popup.classList.toggle("rr-ac-light", !theme.dark);
  if (!theme.vars) return;
  for (const k of Object.keys(theme.vars)) popup.style.setProperty(k, theme.vars[k]);
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
        name: "Enable",
        description: "Suggest pages and blocks as you type, without typing [[ first.",
        action: { type: "switch" },
      },
      {
        id: "minChars",
        name: "Minimum characters",
        description: "Characters needed before the cursor to start matching. 1–2 works well for Chinese, Japanese, and Korean; 2–3 for English. Default: 2.",
        action: { type: "input", placeholder: "2" },
      },
      {
        id: "maxLookback",
        name: "Lookback length",
        description: "For languages written without spaces (Chinese, Japanese, Korean), how many characters before the cursor to search for the longest matching page title. Default: 24.",
        action: { type: "input", placeholder: "24" },
      },
      {
        id: "maxResults",
        name: "Max page suggestions",
        description: "Default: 25. The list scrolls; ↑ / ↓ walk the whole thing.",
        action: { type: "input", placeholder: "25" },
      },
      {
        id: "debounceMs",
        name: "Delay (ms)",
        description: "How long to wait after you stop typing before looking for matches. Default: 0, so the popup is already there before your next keystroke. Raise it (90 or so) if typing feels sluggish in a large graph.",
        action: { type: "input", placeholder: "0" },
      },
      {
        id: "excludeDates",
        name: "Skip daily notes pages",
        description: "Don't suggest date pages like January 1st, 2026.",
        action: { type: "switch" },
      },
      {
        id: "insertMode",
        name: "Page link format",
        description: "What to insert when you pick a page: [[page]] or #tag.",
        action: { type: "select", items: ["[[page]]", "#tag"] },
      },
      {
        id: "blockSearch",
        name: "Suggest blocks",
        description: "Also suggest existing blocks that match, listed after pages. Picking one inserts a block reference, so no new page is created.",
        action: { type: "switch" },
      },
      {
        id: "blockMinChars",
        name: "Minimum characters for blocks",
        description: "For text with Chinese, Japanese, or Korean characters. Block matches are noisier than page matches, so a higher threshold helps. Default: 3.",
        action: { type: "input", placeholder: "3" },
      },
      {
        id: "blockMinCharsLatin",
        name: "Minimum characters for blocks (other text)",
        description: "Same, for text without Chinese, Japanese, or Korean characters, such as English. A few letters match a large part of the graph, so this starts higher. Default: 4.",
        action: { type: "input", placeholder: "4" },
      },
      {
        id: "blockDelayMs",
        name: "Block search delay (ms)",
        description: "How long to wait after you stop typing before searching blocks. Page suggestions don't wait; block results are added below them when they arrive, without moving the selection. 0 searches on every keystroke, which can make typing sluggish in a large graph. Default: 250.",
        action: { type: "input", placeholder: "250" },
      },
      {
        id: "blockMaxResults",
        name: "Max block suggestions",
        description: "Default: 10.",
        action: { type: "input", placeholder: "10" },
      },
      {
        id: "blockInsertMode",
        name: "Block reference format",
        description: "((uid)) inserts a plain block reference. [text](((uid))) uses the block's text as the link label.",
        action: { type: "select", items: ["((uid))", "[text](((uid)))"] },
      },
      {
        id: "author",
        name: "Author",
        description: "Thoughts, projects, and writing at maverickli.org.",
        action: {
          type: "button",
          content: "Maverick Li ↗",
          onClick: () => window.open("https://maverickli.org", "_blank", "noopener,noreferrer"),
        },
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
  extensionAPI.ui.commandPalette.addCommand({
    label: "Inline Autocomplete: Refresh theme colors",
    callback: invalidateTheme,
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
  cancelBlockSearch();
  blockCache = null;
  if (popup) popup.remove();
  popup = null;
  themeCache = null;
  listEl = null;
  previewEl = null;
  const s = document.getElementById(STYLE_ID);
  if (s) s.remove();
  api = null;
}

export default { onload, onunload };
