#!/usr/bin/env node
// End-to-end frame path in headless Edge/Chromium: decoder-worker.js (or the
// DecoderPool) -> postMessage -> GLRenderer.drawYuv, as the webview runs it.
//
//   node test/perf/browser_path.js [--modes=single,pool] [--draw=1] [--workers=N] [--repeat=3]
//        [--recycle=1] [--shot=N --out=<dir>] [--roots=new=.,old=<dir>] [--browser=<exe>] <file|dir>...
//
// --roots compares checkouts (each dir holds media/engine.js, decoder-worker.js,
// pool.js, libav-vpe/). --draw=0 receives frames without drawing them.
// --shot=N hashes the canvas after frame N (and saves a PNG to --out) to compare renderers.
// Prints fps (median of --repeat), main-thread ms per drawYuv, and the GPU string.
// Time it through the queue: node test/benchq.js node test/perf/browser_path.js ...
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const repo = path.resolve(__dirname, '..', '..');
const opt = { modes: 'single,pool', draw: '1', recycle: '1', shot: '', out: '', workers: '', repeat: 3, roots: `cur=${repo}`, browser: '', timeout: 600 };
const inputs = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) opt[m[1]] = m[2] === undefined ? '1' : m[2]; else inputs.push(a);
}
const files = [];
for (const i of inputs) {
  if (fs.statSync(i).isDirectory()) { for (const f of fs.readdirSync(i).sort()) if (/\.(mp4|mkv|mov|webm|mpg|avi|wmv|m2ts|mxf)$/i.test(f)) files.push(path.join(i, f)); } else files.push(i);
}
const roots = opt.roots.split(',').map((x) => { const [k, d] = x.split('='); return { k, d: path.resolve(d) }; });
const browser = opt.browser || ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
if (!browser) { console.error('no Edge/Chrome found; pass --browser='); process.exit(2); }

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.mjs': 'text/javascript' };
let mediaMap = new Map();
let pending = null;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/log' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.end('ok'); if (opt.verbose) console.log(`  page: ${body}`); });
    return;
  }
  if (u.pathname === '/result' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.end('ok'); if (pending) pending(JSON.parse(body)); });
    return;
  }
  let file = null;
  if (u.pathname === '/page.html') file = path.join(__dirname, 'browser_path.html');
  else if (u.pathname.startsWith('/media/')) file = mediaMap.get(decodeURIComponent(u.pathname.slice(7)));
  else {
    const m = /^\/r(\d+)\/(.*)$/.exec(u.pathname);
    if (m && roots[+m[1]]) file = path.join(roots[+m[1]].d, decodeURIComponent(m[2]));
  }
  if (!file || !fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
  const size = fs.statSync(file).size;
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
  if (req.method === 'HEAD') { res.setHeader('Content-Length', size); res.end(); return; }
  if (r) {
    const a = +r[1];
    const b = Math.min(+r[2], size - 1);
    res.statusCode = 206;
    res.setHeader('Content-Length', b - a + 1);
    fs.createReadStream(file, { start: a, end: b }).pipe(res);
  } else { res.setHeader('Content-Length', size); fs.createReadStream(file).pipe(res); }
});

// Browser profiles (tens of MB each) live in one directory per run, removed on
// every exit path: normal end, error, Ctrl+C / kill. Profiles of runs that died
// hard (no handler ran) are swept at the next start, once their owner is gone.
const PREFIX = 'vpe-perf-';
for (const d of fs.readdirSync(os.tmpdir())) {
  if (!d.startsWith(PREFIX)) continue;
  const full = path.join(os.tmpdir(), d);
  let alive = false;
  try { process.kill(+fs.readFileSync(path.join(full, 'owner.pid'), 'utf8'), 0); alive = true; } catch {
    // Owner gone, or a per-launch profile from an older version: keep those for an hour (maybe in use).
    try { alive = !fs.existsSync(path.join(full, 'owner.pid')) && Date.now() - fs.statSync(full).mtimeMs < 3600e3; } catch { /* removed meanwhile */ }
  }
  if (alive) continue;
  killProfile(full);
  try { fs.rmSync(full, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked: next time */ }
}
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
fs.writeFileSync(path.join(runDir, 'owner.pid'), String(process.pid));
let child = null; // the running browser
let profiles = 0;

function killTree(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  // The launcher leaves its children running: end the whole tree.
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(p.pid)], { stdio: 'ignore' }); else p.kill('SIGKILL');
}
// Edge's launcher can hand over to a browser outside its process tree, which then
// keeps running (and holds its profile) after taskkill /T. End every process that
// uses a profile under dir.
function killProfile(dir) {
  if (process.platform !== 'win32') { spawnSync('pkill', ['-9', '-f', `--user-data-dir=${dir}`], { stdio: 'ignore' }); return; }
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${path.basename(browser)}'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir.replace(/'/g, "''")}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 30000 });
}
const rmDir = (d) => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* still locked */ } };

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  killTree(child);
  killProfile(runDir);
  rmDir(runDir);
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });

function once(url) {
  return new Promise((resolve) => {
    const dir = path.join(runDir, `p${profiles++}`);
    fs.mkdirSync(dir);
    const p = spawn(browser, ['--headless=new', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', url], { stdio: 'ignore' });
    child = p;
    const timer = setTimeout(() => finish({ error: 'timeout' }), +opt.timeout * 1000);
    function finish(r) {
      clearTimeout(timer);
      pending = null;
      const after = (fn) => (p.exitCode !== null || p.signalCode !== null ? fn() : p.once('exit', fn));
      after(() => { child = null; setTimeout(() => { killProfile(dir); rmDir(dir); resolve(r); }, 300); });
      killTree(p);
    }
    pending = finish;
  });
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

server.listen(0, '127.0.0.1', async () => {
  let code = 0;
  try { await main(); } catch (e) { console.error(e); code = 1; } finally { server.close(); cleanup(); }
  process.exit(code);
});

async function main() {
  const port = server.address().port;
  mediaMap = new Map(files.map((f) => [path.basename(f), f]));
  console.log(`browser ${path.basename(browser)}; draw ${opt.draw}; repeat ${opt.repeat} (median); roots ${roots.map((r) => `${r.k}=${r.d}`).join(' ')}`);
  let gpu = null;
  for (const f of files) {
    for (const mode of opt.modes.split(',')) {
      const row = [path.basename(f).padEnd(22), mode.padEnd(6)];
      for (let ri = 0; ri < roots.length; ri++) {
        const fps = [];
        const dms = [];
        const shots = [];
        let err = null;
        for (let i = 0; i < +opt.repeat; i++) {
          const url = `http://127.0.0.1:${port}/page.html?root=/r${ri}/&file=${encodeURIComponent(path.basename(f))}&mode=${mode}&draw=${opt.draw}&recycle=${opt.recycle}${opt.shot ? `&shot=${opt.shot}` : ''}${opt.trace ? "&trace=1" : ""}${opt.workers ? `&workers=${opt.workers}` : ''}`;
          // eslint-disable-next-line no-await-in-loop
          const r = await once(url);
          if (r.error) { err = r.error.split('\n')[0]; break; }
          if (!gpu && r.gpu) { gpu = r.gpu; console.log(`gpu ${gpu}`); }
          if (r.shot) {
            shots.push(`${r.shot.hash}${r.shot.glError ? ` glError ${r.shot.glError}` : ''}`);
            if (opt.out && r.png && i === 0) fs.writeFileSync(path.join(opt.out, `${path.basename(f)}.${roots[ri].k}.${mode}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
          }
          fps.push(r.fps);
          dms.push(r.drawMs);
        }
        row.push(err ? `${roots[ri].k} ERROR ${err}` : `${roots[ri].k} ${String(median(fps)).padStart(6)} fps [${fps.join(' ')}] draw ${median(dms)} ms${shots.length ? ` shot ${[...new Set(shots)].join('/')}` : ''}`);
      }
      console.log(row.join('  '));
    }
  }
}
