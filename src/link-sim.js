'use strict';
// A bidirectional model of a slow or flaky SSH link between the extension host and the webview, for testing
// without a real remote: Layer 1/2 tests drive it with a virtual clock, a developer turns it on in real VS Code
// with VPE_SIMULATE_LINK (src/extension.js, src/compare.js).
//
// Two pipes, `down` (host -> webview) and `up` (webview -> host). Each is a FIFO byte-budget queue: a message
// takes bytes / rate to serialize, and nothing behind it starts before it ends, so one large batch delays every
// later message and several Compare tiles sharing one simulator compete for the same bandwidth. After
// serialization a message travels half the round trip (plus seeded jitter), so a small request and its reply
// pay one full RTT. Blackout windows stall both pipes: nothing is sent or delivered inside one, and the
// backlog drains in order afterwards (nothing is dropped or reordered, like TCP over a hiccuping link).
//
// Env knobs (read by the host, see docs/notes/link-simulator.md):
//   VPE_SIMULATE_LINK    a preset name, or key=val,... (mbps, down, up, rtt, jitter, blackout=dur/every, seed)
//   VPE_SIMULATE_REMOTE  the window kind to pretend (ssh-remote, wsl ...); ssh-remote by default with a link

// Real time, for production; tests inject a virtual clock instead.
const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

// checkJs: start
/**
 * @typedef {object} LinkConfig
 * @property {string} [label]
 * @property {number} downMbps host -> webview, megabits per second
 * @property {number} upMbps webview -> host
 * @property {number} rttMs round trip: half of it each way
 * @property {number} [jitterMs] each message's one-way delay varies by up to +-jitterMs / 2
 * @property {number} [blackoutEveryMs] a blackout opens this often (first one this long after the start)
 * @property {number} [blackoutDurationMs] and lasts this long
 * @property {number} [seed] jitter's random seed (default 1)
 */

/**
 * @typedef {object} LinkClock
 * @property {() => number} now
 * @property {(fn: () => void, ms: number) => any} setTimeout
 * @property {(id: any) => void} clearTimeout
 */

/**
 * @typedef {object} LinkStats
 * @property {number} downBytes sent so far, host -> webview
 * @property {number} upBytes
 * @property {number} downMsgs
 * @property {number} upMsgs
 * @property {number} downPending sent but not delivered yet
 * @property {number} upPending
 * @property {boolean} inBlackout
 */

/** @typedef {{ cancel: () => void, at: number, bytes: number }} LinkSend */

/** Presets: what a developer picks from a name (docs/notes/link-simulator.md). */
const LINK_PRESETS = Object.freeze({
  'fast-ssh': Object.freeze({ label: 'Fast SSH', downMbps: 25, upMbps: 25, rttMs: 15, jitterMs: 3 }),
  'typical-ssh': Object.freeze({ label: 'Typical SSH', downMbps: 8, upMbps: 8, rttMs: 40, jitterMs: 10 }),
  'slow-ssh': Object.freeze({ label: 'Slow SSH', downMbps: 2.5, upMbps: 2.5, rttMs: 80, jitterMs: 20 }),
  'flaky-ssh': Object.freeze({
    label: 'Flaky SSH', downMbps: 4, upMbps: 4, rttMs: 120, jitterMs: 40, blackoutEveryMs: 8000, blackoutDurationMs: 1500,
  }),
});

const OFF_SPECS = new Set(['', 'off', 'none']);

/** @param {string} what @param {unknown} v @param {boolean} positive */
function num(what, v, positive) {
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0 || (positive && n === 0)) {
    throw new Error(`link simulator: ${what} must be a ${positive ? 'positive' : 'non-negative'} number, got "${v}"`);
  }
  return n;
}

/**
 * The full, checked config for any partial one.
 * @param {Partial<LinkConfig>} raw
 * @returns {Required<LinkConfig>}
 */
function normalizeConfig(raw) {
  const downMbps = num('downMbps', raw.downMbps ?? raw.upMbps, true);
  const upMbps = num('upMbps', raw.upMbps ?? raw.downMbps, true);
  const blackoutEveryMs = num('blackoutEveryMs', raw.blackoutEveryMs ?? 0, false);
  const blackoutDurationMs = num('blackoutDurationMs', raw.blackoutDurationMs ?? 0, false);
  if (blackoutEveryMs > 0 && blackoutDurationMs >= blackoutEveryMs) {
    throw new Error(`link simulator: a ${blackoutDurationMs} ms blackout needs a period longer than that (got ${blackoutEveryMs} ms)`);
  }
  return {
    label: raw.label || `${downMbps}/${upMbps} Mb/s`,
    downMbps, upMbps,
    rttMs: num('rttMs', raw.rttMs ?? 0, false),
    jitterMs: num('jitterMs', raw.jitterMs ?? 0, false),
    blackoutEveryMs: blackoutDurationMs > 0 ? blackoutEveryMs : 0,
    blackoutDurationMs: blackoutEveryMs > 0 ? blackoutDurationMs : 0,
    seed: Math.floor(num('seed', raw.seed ?? 1, false)) || 1,
  };
}

/**
 * A preset name (any case), `off` / `none` / '' (null: no simulation), or `key=val,...`:
 * mbps (both ways) or down / up (Mb/s), rtt and jitter (ms), blackout=<ms>/<every ms>, seed, preset=<name> as a base.
 * Throws an Error that says what was wrong.
 * @param {string | null | undefined} spec
 * @returns {Required<LinkConfig> | null}
 */
function parseLinkSpec(spec) {
  const text = String(spec ?? '').trim();
  const name = text.toLowerCase();
  if (OFF_SPECS.has(name)) return null;
  if (Object.hasOwn(LINK_PRESETS, name)) return normalizeConfig(LINK_PRESETS[name]);
  if (!text.includes('=')) {
    throw new Error(`link simulator: unknown spec "${text}" (presets: ${Object.keys(LINK_PRESETS).join(', ')}; or key=val,... with mbps, down, up, rtt, jitter, blackout=<ms>/<every ms>, seed)`);
  }
  /** @type {Partial<LinkConfig>} */
  const cfg = {};
  /** @type {Array<[string, string]>} */
  const pairs = text.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const at = part.indexOf('=');
    if (at < 1) throw new Error(`link simulator: expected key=val, got "${part}"`);
    return [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()];
  });
  // A preset is the base; the other keys override it whatever their order.
  for (const [key, val] of pairs) {
    if (key !== 'preset') continue;
    if (!Object.hasOwn(LINK_PRESETS, val.toLowerCase())) throw new Error(`link simulator: unknown preset "${val}"`);
    Object.assign(cfg, LINK_PRESETS[val.toLowerCase()]);
  }
  for (const [key, val] of pairs) {
    switch (key) {
      case 'preset': break;
      case 'mbps': cfg.downMbps = cfg.upMbps = num(key, val, true); break;
      case 'down': cfg.downMbps = num(key, val, true); break;
      case 'up': cfg.upMbps = num(key, val, true); break;
      case 'rtt': cfg.rttMs = num(key, val, false); break;
      case 'jitter': cfg.jitterMs = num(key, val, false); break;
      case 'seed': cfg.seed = num(key, val, false); break;
      case 'label': cfg.label = val; break;
      case 'blackout': {
        const [dur, every, extra] = val.split('/');
        if (extra !== undefined || every === undefined) throw new Error(`link simulator: blackout needs <ms>/<every ms>, got "${val}"`);
        cfg.blackoutDurationMs = num('blackout duration', dur, false);
        cfg.blackoutEveryMs = num('blackout period', every, false);
        break;
      }
      default: throw new Error(`link simulator: unknown key "${key}" in "${text}"`);
    }
  }
  if (cfg.downMbps === undefined && cfg.upMbps === undefined) throw new Error(`link simulator: "${text}" has no bandwidth (mbps=, down= or up=)`);
  return normalizeConfig(cfg);
}

/** UTF-8 length of a string without Buffer or TextEncoder (this file also runs where only ES is typed). @param {string} s */
function utf8Length(s) {
  if (/^[\x00-\x7f]*$/.test(s)) return s.length; // base64 and most JSON keys
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { n += 4; i++; } // a surrogate pair is one 4-byte code point
    else n += 3;
  }
  return n;
}

/**
 * About how many bytes a message costs on the wire: binary payloads at their size, strings as UTF-8, the rest as
 * JSON would write it. Never throws (cycles, getters, exotic objects count what can be counted).
 * @param {unknown} msg
 * @returns {number}
 */
function estimateMessageBytes(msg) {
  const seen = new WeakSet();
  /** @param {unknown} v @param {number} depth @returns {number} */
  const size = (v, depth) => {
    switch (typeof v) {
      case 'string': return utf8Length(v) + 2;
      case 'number': case 'bigint': return Math.max(1, String(v).length);
      case 'boolean': return v ? 4 : 5;
      case 'object': break;
      default: return 0; // undefined, function, symbol: JSON drops them
    }
    if (v === null) return 4;
    if (depth > 32) return 0;
    const o = /** @type {any} */ (v);
    // Typed arrays, Buffers, DataViews and ArrayBuffers: structured clone moves their bytes as they are.
    if (ArrayBuffer.isView(o)) return o.byteLength;
    if (o instanceof ArrayBuffer) return o.byteLength;
    if (typeof SharedArrayBuffer !== 'undefined' && o instanceof SharedArrayBuffer) return o.byteLength;
    if (o instanceof Date) return 8;
    if (seen.has(o)) return 0;
    seen.add(o);
    try {
      let n = 2;
      if (Array.isArray(o)) {
        for (const item of o) n += size(item, depth + 1) + 1;
      } else if (o instanceof Map) {
        for (const [k, item] of o) n += size(k, depth + 1) + size(item, depth + 1) + 2;
      } else if (o instanceof Set) {
        for (const item of o) n += size(item, depth + 1) + 1;
      } else {
        for (const key of Object.keys(o)) {
          let item;
          try { item = o[key]; } catch { continue; }
          n += utf8Length(key) + 3 + size(item, depth + 1);
        }
      }
      return n;
    } finally {
      seen.delete(o); // a repeated (not cyclic) object counts each time, like a clone would
    }
  };
  try { return size(msg, 0); } catch { return 0; }
}

/** A small seeded PRNG (mulberry32): the same seed gives the same jitter, run after run. @param {number} seed */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {object} Dir one direction of the link
 * @property {number} bytesPerMs
 * @property {number} free when the pipe finishes what is queued
 * @property {number} last arrival of the newest message (arrivals never go backwards: FIFO)
 * @property {Array<{ at: number, deliver: (() => void) | null }>} queue sent, not yet delivered (a cancelled one leaves it)
 * @property {any} timer
 * @property {number} bytes
 * @property {number} msgs
 */

/**
 * @param {Partial<LinkConfig> | string} config a config object (see LINK_PRESETS) or a spec string
 * @param {{ clock?: LinkClock, seed?: number, onError?: (e: unknown) => void }} [opts]
 */
function createLinkSimulator(config, opts = {}) {
  const parsed = typeof config === 'string' ? parseLinkSpec(config) : normalizeConfig(config);
  if (!parsed) throw new Error('link simulator: nothing to simulate (spec is off)');
  const cfg = opts.seed === undefined ? parsed : { ...parsed, seed: Math.floor(opts.seed) || 1 };
  const clock = opts.clock || realClock;
  const rand = prng(cfg.seed);
  const t0 = clock.now();
  const every = cfg.blackoutEveryMs;
  const duration = cfg.blackoutDurationMs;
  let disposed = false;

  /** When the blackout covering t ends, or -1 when t is not inside one. @param {number} t */
  const blackoutEnd = (t) => {
    if (!every || t - t0 < every) return -1;
    const start = t0 + Math.floor((t - t0) / every) * every;
    return t < start + duration ? start + duration : -1;
  };
  /** The start of the first blackout after t (t itself is outside one). @param {number} t */
  const nextBlackout = (t) => t0 + (Math.floor(Math.max(0, t - t0) / every) + 1) * every;
  /** When `need` ms of sending, started at `start`, are done: blackouts pause it. @param {number} start @param {number} need */
  const sendEnd = (start, need) => {
    if (!every || need <= 0) return start + need;
    let t = start;
    const out = blackoutEnd(t);
    if (out >= 0) t = out;
    const room = nextBlackout(t) - t; // open time before the next blackout
    if (need <= room) return t + need;
    // Every later period is open for `open` ms and dark for `duration`: whole periods are skipped by arithmetic, so a
    // transfer of any length counts all its blackouts. (The epsilon keeps an exact multiple from rounding up a period.)
    const left = need - room;
    const open = every - duration;
    const skipped = Math.max(0, Math.ceil(left / open - 1e-9) - 1);
    return nextBlackout(t) + duration + skipped * every + (left - skipped * open);
  };

  /** @param {number} mbps @returns {Dir} */
  const dir = (mbps) => ({ bytesPerMs: mbps * 125, free: 0, last: 0, queue: [], timer: null, bytes: 0, msgs: 0 });
  const down = dir(cfg.downMbps);
  const up = dir(cfg.upMbps);

  /** @param {Dir} d */
  const arm = (d) => {
    if (d.timer !== null || !d.queue.length || disposed) return;
    schedule(d, d.queue[0].at - clock.now());
  };

  /** @param {Dir} d @param {number} ms */
  const schedule = (d, ms) => { d.timer = clock.setTimeout(() => tick(d), Math.max(0, Math.ceil(ms))); };

  /** The timer fired: deliver what is due, in order, then wait for the next. @param {Dir} d */
  const tick = (d) => {
    d.timer = null;
    if (disposed) return;
    const now = clock.now();
    // Late, and inside a blackout (a timer can overshoot): nothing arrives until the link is back.
    const end = blackoutEnd(now);
    if (end >= 0) { schedule(d, end - now); return; }
    while (d.queue.length && d.queue[0].at <= now && !disposed) {
      const item = /** @type {NonNullable<typeof d.queue[0]>} */ (d.queue.shift());
      const deliver = item.deliver;
      item.deliver = null;
      if (!deliver) continue;
      try { deliver(); } catch (e) { if (opts.onError) opts.onError(e); }
    }
    arm(d);
  };

  /**
   * @param {Dir} d @param {unknown} msg @param {() => void} deliver
   * @returns {LinkSend | null}
   */
  const send = (d, msg, deliver) => {
    if (disposed) return null;
    const bytes = estimateMessageBytes(msg);
    const now = clock.now();
    const done = sendEnd(Math.max(now, d.free), bytes / d.bytesPerMs);
    d.free = done;
    const flight = cfg.rttMs / 2 + (cfg.jitterMs ? (rand() - 0.5) * cfg.jitterMs : 0);
    // Whole milliseconds first, then the blackout test on that final deadline: rounding up must not land on a blackout's
    // first millisecond. (A blackout end is rounded up too, and the test repeats for a period shorter than a millisecond.)
    let at = Math.ceil(done + Math.max(0, flight));
    for (let end = blackoutEnd(at); end >= 0; end = blackoutEnd(at)) at = Math.ceil(end); // down: delivered when it is back
    at = Math.max(at, d.last, now);
    d.last = at;
    d.bytes += bytes;
    d.msgs++;
    /** @type {{ at: number, deliver: (() => void) | null }} */
    const item = { at, deliver };
    d.queue.push(item);
    arm(d);
    // Cancelling frees the callback (and what it captured) at once, and the timer when it was waiting for this message.
    const cancel = () => {
      item.deliver = null;
      const i = d.queue.indexOf(item);
      if (i < 0) return;
      d.queue.splice(i, 1);
      if (i === 0 && d.timer !== null) { clock.clearTimeout(d.timer); d.timer = null; arm(d); }
    };
    return { at, bytes, cancel };
  };

  /** Stops every pending delivery: nothing arrives after this, and the simulator takes no more messages. */
  const dispose = () => {
    disposed = true;
    for (const d of [down, up]) {
      if (d.timer !== null) clock.clearTimeout(d.timer);
      d.timer = null;
      for (const item of d.queue) item.deliver = null;
      d.queue.length = 0;
    }
  };

  /** @param {Dir} d */
  const pending = (d) => d.queue.length;

  return {
    config: cfg,
    /** Host -> webview. `deliver` runs when the message arrives. Returns a handle (cancel), or null once disposed. */
    sendDown: (/** @type {unknown} */ msg, /** @type {() => void} */ deliver) => send(down, msg, deliver),
    /** Webview -> host. */
    sendUp: (/** @type {unknown} */ msg, /** @type {() => void} */ deliver) => send(up, msg, deliver),
    /**
     * One user of the shared link (a player or a Compare panel): its messages queue with everyone's, and dispose()
     * drops the ones it still has in flight, without a callback after it. (The bytes they already took from the pipe
     * stay spent, as on a real connection.)
     */
    wrapChannel: (/** @type {string} */ id) => {
      /** @type {Set<LinkSend>} */
      const mine = new Set();
      let closed = false;
      /** @param {Dir} d */
      const via = (d) => (/** @type {unknown} */ msg, /** @type {() => void} */ deliver) => {
        if (closed) return null;
        /** @type {LinkSend} */
        let handle;
        const h = send(d, msg, () => { mine.delete(handle); deliver(); });
        if (!h) return null;
        // A cancelled send leaves the set (and frees its callback) at once, not when its deadline would have come.
        handle = { at: h.at, bytes: h.bytes, cancel: () => { mine.delete(handle); h.cancel(); } };
        mine.add(handle);
        return handle;
      };
      return {
        id,
        sendDown: via(down),
        sendUp: via(up),
        /** Messages of this channel still in flight. */
        pending: () => mine.size,
        dispose: () => { closed = true; for (const h of [...mine]) h.cancel(); },
      };
    },
    /** @returns {LinkStats} */
    stats: () => ({
      downBytes: down.bytes, upBytes: up.bytes, downMsgs: down.msgs, upMsgs: up.msgs,
      downPending: pending(down), upPending: pending(up), inBlackout: blackoutEnd(clock.now()) >= 0,
    }),
    dispose,
  };
}

/** One line for the log: what is being simulated. @param {Required<LinkConfig>} c */
function describeLink(c) {
  const rate = c.downMbps === c.upMbps ? `${c.downMbps} Mb/s` : `${c.downMbps} down / ${c.upMbps} up Mb/s`;
  const dark = c.blackoutEveryMs ? `, ${c.blackoutDurationMs} ms blackout every ${c.blackoutEveryMs} ms` : '';
  return `${c.label}: ${rate}, ${c.rttMs} ms RTT, ${c.jitterMs} ms jitter${dark}, seed ${c.seed}`;
}

/**
 * The simulator the environment asks for, or null: VPE_SIMULATE_LINK unset, off or none. A bad spec logs why and
 * simulates nothing (so a typo never changes the window silently into something else).
 * @param {Record<string, string | undefined>} env
 * @param {(msg: string) => void} [log]
 * @param {Parameters<typeof createLinkSimulator>[1]} [opts]
 */
function linkSimulatorFromEnv(env, log, opts) {
  const spec = env.VPE_SIMULATE_LINK;
  if (spec === undefined) return null;
  try {
    const cfg = parseLinkSpec(spec);
    if (!cfg) return null;
    const sim = createLinkSimulator(cfg, opts);
    if (log) log(`[link-sim] active: ${describeLink(sim.config)}`);
    return sim;
  } catch (e) {
    if (log) log(`[link-sim] ignored VPE_SIMULATE_LINK: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}
// checkJs: end

/**
 * The remote window kind policy should see: VPE_SIMULATE_REMOTE when set (`off` = the real one), 'ssh-remote' while
 * VPE_SIMULATE_LINK is on, else vscode.env.remoteName. For what a window can do (native raw frames, Live transcode,
 * link-limited streaming); real remote paths and URIs keep using vscode.env.remoteName.
 * @param {{ env: { remoteName?: string } }} vscode
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
function effectiveRemoteName(vscode, env = process.env) {
  const forced = (env.VPE_SIMULATE_REMOTE || '').trim();
  if (forced && forced.toLowerCase() !== 'off') return forced;
  if (!forced && linkSpecActive(env.VPE_SIMULATE_LINK)) return 'ssh-remote';
  return vscode.env.remoteName;
}

/** True when the spec turns a simulation on (a spec that does not parse does not). @param {string | undefined} spec */
function linkSpecActive(spec) {
  if (spec === undefined) return false;
  try { return parseLinkSpec(spec) !== null; } catch { return false; }
}

module.exports = {
  LINK_PRESETS, parseLinkSpec, estimateMessageBytes, createLinkSimulator, linkSimulatorFromEnv, effectiveRemoteName,
};
