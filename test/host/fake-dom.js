'use strict';
// A small, strict DOM for the millisecond UI tests (test/host/player_ui_test.js): a real element tree parsed from
// the production markup (src/bar.js, src/folder-rail-html.js), simple CSS selectors, closest(), and events that
// bubble up the parent chain (stopPropagation stops them). It is strict on purpose: getElementById returns null for
// an id the markup does not have, and an element has only the members implemented here (a widget that reaches for
// anything else fails loudly instead of getting a silent stand-in). There is no layout: getBoundingClientRect is
// whatever the test set with setRect (else zero), clientWidth / clientHeight follow it.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' })[e]);
const encode = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---- selectors: compound (tag #id .class [attr] [attr=v] [attr^=v] :not(...)), descendant / child, comma lists ----
function splitTop(s, sep) {
  const out = [];
  let depth = 0, quote = '', cur = '';
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = ''; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && sep.test(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function parseCompound(src) {
  const parts = [];
  let s = src;
  while (s) {
    let m;
    if ((m = /^([a-zA-Z*][\w-]*)/.exec(s))) parts.push({ t: 'tag', v: m[1].toLowerCase() });
    else if ((m = /^#([\w-]+)/.exec(s))) parts.push({ t: 'id', v: m[1] });
    else if ((m = /^\.([\w-]+)/.exec(s))) parts.push({ t: 'class', v: m[1] });
    else if ((m = /^\[\s*([\w-]+)\s*(?:([\^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/.exec(s))) {
      parts.push({ t: 'attr', name: m[1], op: m[2] || null, v: m[3] ?? m[4] ?? m[5] ?? '' });
    } else if ((m = /^:not\(/.exec(s))) {
      let depth = 1, i = m[0].length;
      for (; i < s.length && depth; i++) { if (s[i] === '(') depth++; else if (s[i] === ')') depth--; }
      parts.push({ t: 'not', v: parseList(s.slice(m[0].length, i - 1)) });
      m = [s.slice(0, i)];
    } else throw new Error(`fake-dom: unsupported selector "${src}"`);
    s = s.slice(m[0].length);
  }
  return parts;
}
function parseComplex(src) {
  // [compound, combinator, compound, ...] from left to right; combinator ' ' or '>'.
  const tokens = splitTop(src.trim().replace(/\s*>\s*/g, ' > '), /\s/).filter(Boolean);
  const out = [];
  for (const tok of tokens) out.push(tok === '>' ? '>' : parseCompound(tok));
  return out;
}
function parseList(src) { return splitTop(src, /,/).map((x) => parseComplex(x)); }
function matchCompound(el, parts) {
  if (!el || el.nodeType !== 1) return false;
  for (const p of parts) {
    if (p.t === 'tag' && p.v !== '*' && el.localName !== p.v) return false;
    if (p.t === 'id' && el.getAttribute('id') !== p.v) return false;
    if (p.t === 'class' && !el.classList.contains(p.v)) return false;
    if (p.t === 'attr') {
      const a = el.getAttribute(p.name);
      if (a === null) return false;
      if (p.op === '=' && a !== p.v) return false;
      if (p.op === '^=' && !a.startsWith(p.v)) return false;
      if (p.op === '$=' && !a.endsWith(p.v)) return false;
      if (p.op === '*=' && !a.includes(p.v)) return false;
    }
    if (p.t === 'not' && p.v.some((cx) => matchComplex(el, cx))) return false;
  }
  return true;
}
function matchComplex(el, cx) {
  let i = cx.length - 1;
  if (!matchCompound(el, cx[i])) return false;
  let cur = el;
  while (i > 0) {
    const comb = cx[i - 1] === '>' ? '>' : ' ';
    const want = comb === '>' ? cx[i - 2] : cx[i - 1];
    i -= comb === '>' ? 2 : 1;
    if (comb === '>') { cur = cur.parentNode; if (!matchCompound(cur, want)) return false; continue; }
    cur = cur.parentNode;
    while (cur && !matchCompound(cur, want)) cur = cur.parentNode;
    if (!cur) return false;
  }
  return true;
}
const matches = (el, sel) => parseList(sel).some((cx) => matchComplex(el, cx));

// ---- events ----
class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, { bubbles: true, cancelable: true }, init);
    this.type = type;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    this.immediateStopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = true; this.immediateStopped = true; }
}
class Target {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, fn, opts) {
    if (!fn) return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    const l = this._listeners.get(type);
    if (!l.some((x) => x.fn === fn)) l.push({ fn, once: !!(opts && opts.once) });
  }
  removeEventListener(type, fn) {
    const l = this._listeners.get(type) || [];
    const i = l.findIndex((x) => x.fn === fn);
    if (i >= 0) l.splice(i, 1);
  }
  listenerCount(type) { return (this._listeners.get(type) || []).length; }
  _invoke(e) {
    e.currentTarget = this;
    for (const x of (this._listeners.get(e.type) || []).slice()) {
      if (x.once) this.removeEventListener(e.type, x.fn);
      if (typeof x.fn === 'function') x.fn.call(this, e); else x.fn.handleEvent(e);
      if (e.immediateStopped) break;
    }
    const prop = this[`on${e.type}`];
    if (typeof prop === 'function' && !e.immediateStopped) prop.call(this, e);
  }
  /** Dispatch on this node, then (if it bubbles) each ancestor, the document and the window, until stopped. */
  dispatchEvent(e) {
    if (!(e instanceof FakeEvent)) e = Object.assign(new FakeEvent(e.type), e);
    e.target = e.target || this;
    const path = [];
    for (let n = this; n; n = n._parentForEvents ? n._parentForEvents() : null) path.push(n);
    for (const n of path) {
      n._invoke(e);
      if (e.propagationStopped || !e.bubbles) break;
    }
    return !e.defaultPrevented;
  }
  /** Test helper: dispatch a bubbling event of `type` with `init` fields; returns the event. */
  fire(type, init = {}) {
    const e = new FakeEvent(type, init);
    this.dispatchEvent(e);
    return e;
  }
}

// ---- nodes ----
class Node extends Target {
  constructor(doc) { super(); this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  _parentForEvents() { return this.parentNode || (this === this.ownerDocument?.documentElement ? this.ownerDocument : null); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  _sib(d, el) {
    if (!this.parentNode) return null;
    const list = el ? this.parentNode.children : this.parentNode.childNodes;
    return list[list.indexOf(this) + d] || null;
  }
  get nextSibling() { return this._sib(1, false); }
  get previousSibling() { return this._sib(-1, false); }
  get nextElementSibling() { return this._sib(1, true); }
  get previousElementSibling() { return this._sib(-1, true); }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument; }
  _adopt(c) {
    if (typeof c === 'string') c = this.ownerDocument.createTextNode(c);
    if (c.nodeType === 11) { const kids = c.childNodes.slice(); c.childNodes.length = 0; for (const k of kids) k.parentNode = null; return kids; }
    if (c.parentNode) c.parentNode.removeChild(c);
    return [c];
  }
  appendChild(c) { for (const k of this._adopt(c)) { k.parentNode = this; this.childNodes.push(k); } return c; }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    const kids = this._adopt(c);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('fake-dom: insertBefore reference is not a child');
    for (const k of kids) k.parentNode = this;
    this.childNodes.splice(i, 0, ...kids);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i < 0) throw new Error('fake-dom: removeChild of a non-child');
    this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  prepend(...cs) { const ref = this.firstChild; for (const c of cs) this.insertBefore(c, ref); }
  replaceChildren(...cs) { for (const c of this.childNodes.slice()) this.removeChild(c); this.append(...cs); }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v !== '' && v !== null && v !== undefined) this.appendChild(String(v)); }
  _walk(fn) { for (const c of this.childNodes) { if (c.nodeType === 1) { fn(c); c._walk(fn); } } }
  querySelectorAll(sel) { const list = parseList(sel); const out = []; this._walk((el) => { if (list.some((cx) => matchComplex(el, cx))) out.push(el); }); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class Fragment extends Node {
  constructor(doc) { super(doc); this.nodeType = 11; }
}

const BOOL_ATTRS = ['hidden', 'disabled', 'checked'];
const STR_ATTRS = { id: 'id', className: 'class', title: 'title', type: 'type', role: 'role', placeholder: 'placeholder' };
class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.localName = String(tag).toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this._attrs = new Map();
    this._rect = null;
    this._captures = new Set();
    this._value = null;
    const el = this;
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; }, getPropertyValue(k) { return this[k] || ''; } };
    this.dataset = new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? el.getAttribute(`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined : undefined),
      set: (_t, k, v) => { el.setAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v); return true; },
      deleteProperty: (_t, k) => { el.removeAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`); return true; },
      has: (_t, k) => el.hasAttribute(`data-${String(k)}`),
    });
    this.classList = {
      _get: () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean),
      _set: (xs) => el.setAttribute('class', xs.join(' ')),
      contains(c) { return this._get().includes(c); },
      add(...cs) { const xs = this._get(); for (const c of cs) if (!xs.includes(c)) xs.push(c); this._set(xs); },
      remove(...cs) { this._set(this._get().filter((x) => !cs.includes(x))); },
      toggle(c, force) { const on = force === undefined ? !this.contains(c) : !!force; if (on) this.add(c); else this.remove(c); return on; },
    };
  }
  getAttribute(k) { return this._attrs.has(k) ? this._attrs.get(k) : null; }
  setAttribute(k, v) { this._attrs.set(String(k).toLowerCase(), String(v)); }
  removeAttribute(k) { this._attrs.delete(k); }
  hasAttribute(k) { return this._attrs.has(k); }
  toggleAttribute(k, force) { const on = force === undefined ? !this.hasAttribute(k) : !!force; if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
  get value() { return this._value !== null ? this._value : (this.getAttribute('value') || ''); }
  set value(v) { this._value = String(v); }
  get tabIndex() { const t = this.getAttribute('tabindex'); return t === null ? (/^(button|input|select|textarea|a)$/.test(this.localName) ? 0 : -1) : Number(t); }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  get isContentEditable() { const v = this.getAttribute('contenteditable'); return v === '' || v === 'true'; }
  matches(sel) { if (/:focus-visible|:hover|:focus\b/.test(sel)) throw new Error('fake-dom: no focus-visible'); return matches(this, sel); }
  closest(sel) { const list = parseList(sel); for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (list.some((cx) => matchComplex(n, cx))) return n; return null; }
  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) { this.replaceChildren(); for (const n of parseHtml(this.ownerDocument, String(html))) this.appendChild(n); }
  get outerHTML() { return serialize(this); }
  insertAdjacentHTML(pos, html) {
    const nodes = parseHtml(this.ownerDocument, String(html));
    if (pos === 'beforeend') for (const n of nodes) this.appendChild(n);
    else if (pos === 'afterbegin') { const ref = this.firstChild; for (const n of nodes) this.insertBefore(n, ref); }
    else throw new Error(`fake-dom: insertAdjacentHTML ${pos}`);
  }
  getBoundingClientRect() {
    const r = this._rect || { left: 0, top: 0, width: 0, height: 0 };
    return { left: r.left, top: r.top, width: r.width, height: r.height, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height };
  }
  getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
  get clientWidth() { return this._rect ? this._rect.width : 0; }
  get clientHeight() { return this._rect ? this._rect.height : 0; }
  get offsetWidth() { return this.clientWidth; }
  get offsetHeight() { return this.clientHeight; }
  get offsetLeft() { return this._rect ? this._rect.left : 0; }
  get offsetTop() { return this._rect ? this._rect.top : 0; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.fire('click', { button: 0 }); }
  scrollIntoView() {}
  animate() { return { finished: Promise.resolve(), cancel() {}, onfinish: null, addEventListener() {} }; }
  setPointerCapture(id) { this._captures.add(id); }
  releasePointerCapture(id) { this._captures.delete(id); }
  hasPointerCapture(id) { return this._captures.has(id); }
  getContext() { return this.localName === 'canvas' ? { canvas: this } : null; }
}
for (const k of BOOL_ATTRS) {
  Object.defineProperty(Element.prototype, k, {
    get() { return this.hasAttribute(k); },
    set(v) { if (v) this.setAttribute(k, ''); else this.removeAttribute(k); },
  });
}
for (const [prop, attr] of Object.entries(STR_ATTRS)) {
  Object.defineProperty(Element.prototype, prop, {
    get() { return this.getAttribute(attr) || ''; },
    set(v) { this.setAttribute(attr, v); },
  });
}

function serialize(n) {
  if (n.nodeType === 3) return encode(n.data);
  if (n.nodeType !== 1) return n.childNodes.map(serialize).join('');
  const attrs = [...n._attrs].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${encode(v)}"`)).join('');
  return VOID.has(n.localName) ? `<${n.localName}${attrs}>` : `<${n.localName}${attrs}>${n.childNodes.map(serialize).join('')}</${n.localName}>`;
}

/** Parse well-formed markup (what src/bar.js and the widgets write) into nodes. */
function parseHtml(doc, html) {
  const root = new Fragment(doc);
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[1]) {
      const tag = m[1].toLowerCase();
      if (top.localName !== tag) throw new Error(`fake-dom: </${tag}> closes <${top.localName || '#root'}>`);
      stack.pop();
    } else if (m[2]) {
      const el = doc.createElement(m[2]);
      for (const a of m[3].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ''));
      top.appendChild(el);
      if (!m[4] && !VOID.has(el.localName)) stack.push(el);
    } else if (m[5] && !m[0].startsWith('<!--')) {
      top.appendChild(doc.createTextNode(decode(m[5])));
    }
  }
  if (stack.length !== 1) throw new Error(`fake-dom: <${stack[stack.length - 1].localName}> is not closed`);
  return root.childNodes.slice();
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.documentElement = new Element(this, 'html');
    this.appendChild(this.documentElement);
    this.body = new Element(this, 'body');
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.defaultView = null;
  }
  _parentForEvents() { return this.defaultView; }
  get isConnected() { return true; }
  createElement(tag) { return new Element(this, tag); }
  createElementNS(_ns, tag) { return new Element(this, tag); }
  createTextNode(s) { return new Text(this, String(s)); }
  createDocumentFragment() { return new Fragment(this); }
  /** Strict: null for any id the document does not contain. */
  getElementById(id) { let hit = null; this._walk((el) => { if (!hit && el.getAttribute('id') === id) hit = el; }); return hit; }
}

class Window extends Target {
  constructor(doc) {
    super();
    this.document = doc;
    doc.defaultView = this;
    this.innerWidth = 1024;
    this.innerHeight = 768;
    this.devicePixelRatio = 1;
    this.timers = [];
    this.ResizeObserver = undefined;
  }
  _parentForEvents() { return null; }
  setInterval(fn, ms) { this.timers.push({ fn, ms }); return this.timers.length; }
  clearInterval(id) { this.timers[id - 1] = null; }
  setTimeout(fn, ms) { return this.setInterval(fn, ms); }
  clearTimeout(id) { this.clearInterval(id); }
  matchMedia() { return { matches: true, addEventListener() {}, removeEventListener() {} }; }
  requestAnimationFrame() { return 0; }
  cancelAnimationFrame() {}
  getComputedStyle(el) { return el.style; }
}

/**
 * A document whose body is `html` (parsed), plus its window.
 * @param {string} html
 */
function createDom(html) {
  const doc = new Document();
  const win = new Window(doc);
  for (const n of parseHtml(doc, html)) doc.body.appendChild(n);
  const $ = (id) => doc.getElementById(id);
  const setRect = (el, r) => { el._rect = { left: 0, top: 0, ...r }; };
  return { doc, win, $, setRect, timers: win.timers, FakeEvent };
}

module.exports = { createDom, parseHtml, matches, FakeEvent, Element, Node };
