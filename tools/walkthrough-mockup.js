#!/usr/bin/env node
'use strict';
// Click-through mock-up of the "Set up Video Preview Enhanced" walkthrough, for talking about the copy
// without starting VS Code. It reads the real walkthrough (package.json contributes.walkthroughs and
// media/walkthrough/*.md), so editing the copy there and re-running this updates the mock-up too.
//
//   node tools/walkthrough-mockup.js [out.html]     default: <temp>/vpe-walkthrough-mockup.html
//
// The look copies VS Code 1.147's Welcome editor (dark theme). It is a sketch, not a pixel match: the
// real thing is checked with review.cmd / review.sh.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const wt = pkg.contributes.walkthroughs[0];
const commands = {};
for (const c of pkg.contributes.commands || []) commands[c.command] = (c.category ? c.category + ': ' : '') + c.title;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline Markdown: code, bold, links (command: links become data-cmd anchors). */
function inline(s) {
  const parts = String(s).split(/(`[^`]+`)/);
  return parts.map((p) => {
    if (/^`[^`]+`$/.test(p)) return '<code>' + esc(p.slice(1, -1)) + '</code>';
    return esc(p)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, href) => link(t, href.replace(/&amp;/g, '&'), false));
  }).join('');
}

function link(text, href, button) {
  const cmd = /^command:/.test(href) ? decodeURIComponent(href.slice(8)) : '';
  return `<a class="${button ? 'btn' : 'lnk'}" href="#" data-cmd="${esc(cmd || href)}">${text}</a>`;
}

/** Step description: like VS Code, a line that is only a link becomes a button. */
function description(d) {
  return d.split('\n').map((line) => {
    const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(line.trim());
    return m ? '<p>' + link(esc(m[1]), m[2], true) + '</p>' : '<p>' + inline(line) + '</p>';
  }).join('');
}

/** Block Markdown, just what media/walkthrough/*.md uses: headings, lists, tables, fences, paragraphs. */
/** A picture next to the Markdown file, inlined so the mock-up is one self-contained file. */
function picture(alt, src, dir) {
  const file = path.join(dir, src);
  const type = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.svg': 'svg+xml', '.gif': 'gif', '.webp': 'webp' }[path.extname(file).toLowerCase()];
  if (!type || !fs.existsSync(file)) return '<p class="missing">missing picture: ' + esc(src) + '</p>';
  return '<p><img alt="' + esc(alt) + '" src="data:image/' + type + ';base64,' + fs.readFileSync(file).toString('base64') + '"></p>';
}

function markdown(src, dir) {
  const out = [];
  const lines = src.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push('<pre>' + esc(body.join('\n')) + '</pre>');
    } else if (/^#{1,6} /.test(l)) {
      const n = /^#+/.exec(l)[0].length;
      out.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`); i++;
    } else if (/^\s*- /.test(l)) {
      const items = [];
      for (; i < lines.length && /^\s*- /.test(lines[i]); i++) items.push('<li>' + inline(lines[i].replace(/^\s*- /, '')) + '</li>');
      out.push('<ul>' + items.join('') + '</ul>');
    } else if (/^\|/.test(l)) {
      const rows = [];
      for (; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(lines[i]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]).map((c) => '<th>' + inline(c) + '</th>').join('');
      const body = rows.slice(2).map((r) => '<tr>' + cells(r).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('');
      out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
    } else if (/^!\[[^\]]*\]\([^)]+\)\s*$/.test(l)) {
      const m = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(l);
      out.push(picture(m[1], m[2], dir)); i++;
    } else if (/^<sub>.*<\/sub>\s*$/.test(l)) {
      out.push('<p class="cap">' + inline(l.replace(/<\/?sub>/g, '').replace(/\*([^*]+)\*/g, '$1')) + '</p>'); i++;
    } else if (!l.trim()) {
      i++;
    } else {
      const para = [];
      for (; i < lines.length && lines[i].trim() && !/^(#|```|\||\s*- )/.test(lines[i]); i++) para.push(lines[i]);
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
  }
  return out.join('\n');
}

const steps = wt.steps.map((s) => ({
  id: s.id,
  title: s.title,
  when: s.when || '',
  desc: description(s.description),
  media: s.media && s.media.markdown ? markdown(fs.readFileSync(path.join(ROOT, s.media.markdown), 'utf8'), path.dirname(path.join(ROOT, s.media.markdown))) : '',
  done: (s.completionEvents || []).filter((e) => e.startsWith('onCommand:')).map((e) => e.slice(10)),
}));

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Walkthrough mock-up</title>
<style>
:root{--bg:#1f1f1f;--side:#181818;--fg:#cccccc;--dim:#9d9d9d;--hi:#ffffff;--line:#2b2b2b;--card:#252526;--focus:#0078d4;
--btn:#0078d4;--btnh:#026ec1;--link:#4daafc;--code:#2b2b2b;--ok:#3fb950}
*{box-sizing:border-box}
/* fixed-height frame, not viewport units, so it also renders inline in a chat preview */
body{margin:0}
.vsc{background:var(--bg);color:var(--fg);font:13px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif;height:780px;display:flex;flex-direction:column;border-radius:6px;overflow:hidden;position:relative;border:1px solid #2b2b2b}
.bar{height:35px;background:var(--side);display:flex;align-items:center;gap:14px;padding:0 10px;border-bottom:1px solid var(--line);font-size:12px;flex:none}
.bar .ctx{color:var(--dim)}
.bar select{background:#313131;color:var(--fg);border:1px solid #3c3c3c;border-radius:2px;font:inherit;padding:1px 4px}
.bar label{display:flex;gap:6px;align-items:center}
.bar .spacer{flex:1}
.tabs{height:35px;background:var(--side);display:flex;flex:none}
.tab{background:var(--bg);display:flex;align-items:center;gap:8px;padding:0 12px;font-style:italic;border-top:1px solid var(--focus);color:var(--hi)}
.tab .x{font-style:normal;color:var(--dim)}
main{flex:1;overflow:auto;padding:56px 24px 40px}
.wrap{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:minmax(240px,380px) 1fr;gap:clamp(24px,6vw,72px)}
.back{color:var(--dim);font-size:13px;margin-bottom:14px;display:inline-block;text-decoration:none}
.back:hover{color:var(--fg)}
h1{font-weight:400;font-size:30px;line-height:1.4;color:var(--fg);margin:0 0 30px}
.sub{font-size:20px;color:var(--dim);font-weight:400;line-height:1.6;margin:0 0 26px}
.prog{height:4px;background:#3c3c3c;border-radius:2px;margin:0 0 6px;overflow:hidden}
.prog i{display:block;height:100%;background:var(--focus);transition:width .2s}
.progt{font-size:12px;color:var(--dim);margin-bottom:22px}
.step{border:1px solid transparent;border-radius:6px;padding:14px 18px 14px 20px;margin:0 0 6px;cursor:pointer;display:grid;grid-template-columns:22px 1fr;gap:6px}
.step:hover:not(.open){background:#2a2d2e55}
.step.open{background:var(--card);border-color:#5f7f9f;cursor:default;padding-bottom:20px}
.step .ck{width:16px;height:16px;border:1.5px solid var(--dim);border-radius:50%;margin-top:3px;display:flex;align-items:center;justify-content:center;font-size:11px}
.step.open .ck{border-color:var(--link)}
.step.done .ck{background:var(--ok);border-color:var(--ok);color:#000}
.step .t{font-size:14px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.step.open .t{color:var(--hi);font-weight:600;white-space:normal}
.step .d{display:none;grid-column:2}
.step.open .d{display:block}
.d p{margin:8px 0 0;font-size:13.5px;line-height:1.6}
.btn{display:inline-block;background:var(--btn);color:#fff;text-decoration:none;padding:5px 11px;border-radius:2px;margin:6px 0 4px}
.btn:hover{background:var(--btnh)}
.lnk{color:var(--link);text-decoration:none}.lnk:hover{text-decoration:underline}
.media{font-size:14px;line-height:1.7;max-width:620px}
.media h1,.media h2,.media h3{font-weight:400;font-size:18px;color:var(--fg);margin:0 0 26px}
.media p{margin:0 0 16px}
.media img{max-width:100%;border-radius:4px;display:block}
.media p.cap{font-size:11px;color:var(--dim);margin:-10px 0 16px}
.media .missing{color:#f48771}
.media ul{padding-left:20px;margin:0 0 16px}
.media li{margin:0 0 6px}
.media table{border-collapse:collapse;margin:0 0 16px;width:100%}
.media th{text-align:left;font-weight:600;padding:10px 12px;border-bottom:1px solid #6b6b6b}
.media td{padding:10px 12px;border-top:1px solid var(--line);vertical-align:middle}
.media tr td:first-child{font-weight:600}
code{font-family:Consolas,"Courier New",monospace;background:var(--code);padding:1px 4px;border-radius:3px;font-size:12.5px}
pre{font-family:Consolas,"Courier New",monospace;background:var(--code);padding:10px 12px;border-radius:3px;font-size:12px;white-space:pre-wrap;word-break:break-all;margin:0 0 16px}
.toast{position:absolute;right:14px;bottom:14px;width:380px;background:#252526;border:1px solid #3c3c3c;box-shadow:0 2px 8px #0008;border-radius:4px;padding:10px 12px;display:none;gap:8px;font-size:13px}
.toast.on{display:flex}
.toast .i{color:var(--link)}
.toast small{display:block;color:var(--dim);margin-top:4px}
@media (max-width:600px){.wrap{grid-template-columns:1fr;gap:28px}h1{font-size:24px}.sub{font-size:16px}}
</style></head><body><div class="vsc">
<div class="bar">
  <span class="ctx">Mock-up · text from package.json + media/walkthrough/</span>
  <span class="spacer"></span>
  <label>Window <select id="env"><option value="">Local</option><option value="wsl">WSL</option><option value="ssh-remote">Remote-SSH</option></select></label>
  <a class="lnk" href="#" id="reset">Reset</a>
</div>
<div class="tabs"><div class="tab"><span style="color:#3794ff;font-style:normal">⧉</span> Welcome <span class="x">✕</span></div></div>
<main><div class="wrap">
  <div>
    <a class="back" href="#" data-cmd="__back">‹ Go Back</a>
    <h1>${esc(wt.title)}</h1>
    <p class="sub">${inline(wt.description)}</p>
    <div class="prog"><i id="bar"></i></div><div class="progt" id="progt"></div>
    <div id="steps"></div>
  </div>
  <div class="media" id="media"></div>
</div></main>
<div class="toast" id="toast"><span class="i">ⓘ</span><div id="toastt"></div></div></div>
<script>
'use strict';
const STEPS = ${JSON.stringify(steps).replace(/</g, '\\u003c')};
const CMDS = ${JSON.stringify(commands).replace(/</g, '\\u003c')};
const BUILTIN = { 'workbench.action.openSettings': 'Opens VS Code Settings' };
let open = 0, done = new Set(), remoteName = '';
const visible = () => STEPS.filter((s) => !s.when || evalWhen(s.when));
// Only the when-clause shapes the walkthrough uses: remoteName tests joined by || and &&.
function evalWhen(w) {
  return w.split('||').some((alt) => alt.split('&&').every((t) => {
    t = t.trim();
    if (t === '!remoteName') return !remoteName;
    if (t === 'remoteName') return !!remoteName;
    const m = /^remoteName\\s*(==|!=)\\s*'([^']*)'$/.exec(t);
    return m ? (m[1] === '==') === (remoteName === m[2]) : true;
  }));
}
function render() {
  const vs = visible();
  if (open >= vs.length) open = 0;
  document.getElementById('steps').innerHTML = vs.map((s, i) =>
    '<div class="step' + (i === open ? ' open' : '') + (done.has(s.id) ? ' done' : '') + '" data-i="' + i + '" tabindex="0" role="button" aria-expanded="' + (i === open) + '">' +
    '<span class="ck">' + (done.has(s.id) ? '✓' : '') + '</span><div><div class="t">' + s.title + '</div><div class="d">' + s.desc + '</div></div></div>').join('');
  document.getElementById('media').innerHTML = vs[open].media;
  const n = vs.filter((s) => done.has(s.id)).length;
  document.getElementById('bar').style.width = (100 * n / vs.length) + '%';
  document.getElementById('progt').textContent = n + ' of ' + vs.length + ' steps complete';
}
let toastTimer;
function toast(html) {
  const t = document.getElementById('toast');
  document.getElementById('toastt').innerHTML = html;
  t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 4500);
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-cmd]');
  if (a) {
    e.preventDefault();
    const raw = a.dataset.cmd;
    if (raw === '__back') return toast('Would go back to the Welcome page.');
    const id = raw.split('?')[0], arg = raw.includes('?') ? JSON.parse(raw.slice(raw.indexOf('?') + 1)) : '';
    const name = CMDS[id] || BUILTIN[id] || id;
    const stepArg = Array.isArray(arg) ? String(arg[0]) : '';
    // Like src/extension.js setupNext: mark the step done, show the next step this window has, close after the last.
    const advance = () => {
      done.add(stepArg);
      const vs = visible(), i = vs.findIndex((x) => x.id === stepArg);
      if (i === vs.length - 1) toast('Would close the setup guide.');
      else if (i >= 0) open = i + 1;
    };
    if (id === 'videoPreviewEnhanced.setupNext') { advance(); return render(); }
    if (id === 'videoPreviewEnhanced.setupFfmpegFromGuide') {
      toast('Would set up ffmpeg (download or use an existing one), then move on by itself.');
      advance(); return render();
    }
    if (id === 'videoPreviewEnhanced.chooseTranscode') {
      toast('Would show a list: <b>Auto (recommended)</b> · <b>Always</b> · <b>Off</b>, each with one line saying what it does.');
      return render();
    }
    toast('Would run <b>' + name + '</b>' + (arg ? ' <code>' + String(arg).replace(/</g, '&lt;') + '</code>' : '') + '<small>command: ' + id + '</small>');
    for (const st of STEPS) if (st.done.includes(id)) done.add(st.id);
    return render();
  }
  if (e.target.id === 'reset') { e.preventDefault(); done.clear(); open = 0; return render(); }
  const st = e.target.closest('.step');
  if (st) { open = +st.dataset.i; render(); }
});
document.addEventListener('keydown', (e) => {
  const st = e.target.closest && e.target.closest('.step');
  if (st && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open = +st.dataset.i; render(); }
});
document.getElementById('env').addEventListener('change', (e) => { remoteName = e.target.value; render(); });
render();
</script></body></html>
`;

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'vpe-walkthrough-mockup.html'));
fs.writeFileSync(out, html);
console.log('wrote', out);
