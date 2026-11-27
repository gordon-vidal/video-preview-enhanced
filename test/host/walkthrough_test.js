'use strict';
// Verifies package.json contributes.walkthroughs, media/walkthrough/*.md files, and src/walkthrough.js.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const walkthrough = require('../../src/walkthrough');

const ROOT = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const agentsDoc = fs.readFileSync(path.join(ROOT, 'docs', 'agents.md'), 'utf8');

const wts = pkg.contributes && pkg.contributes.walkthroughs;
assert.ok(Array.isArray(wts) && wts.length === 1, 'one walkthrough contributed');
const wt = wts[0];
assert.strictEqual(wt.id, walkthrough.WALKTHROUGH_ID);
assert.ok(wt.title && wt.description, 'walkthrough has title and description');
assert.ok(Array.isArray(wt.steps) && wt.steps.length === 6, 'walkthrough has 6 steps (5 shown per window kind)');

const registered = new Set((pkg.contributes.commands || []).map((c) => c.command));
assert.ok(registered.has('videoPreviewEnhanced.openSetupGuide'), 'openSetupGuide command registered');
assert.ok(registered.has('videoPreviewEnhanced.copyAgentSnippet'), 'copyAgentSnippet command registered');

const ids = new Set();
for (const step of wt.steps) {
  assert.ok(step.id && !ids.has(step.id), `unique step id: ${step.id}`);
  ids.add(step.id);
  assert.ok(step.title && step.description, `step ${step.id} has title and description`);
  assert.ok(step.media && step.media.markdown, `step ${step.id} has markdown media`);
  const mdPath = path.join(ROOT, step.media.markdown);
  assert.ok(fs.existsSync(mdPath), `media file exists: ${step.media.markdown}`);
  assert.ok(fs.readFileSync(mdPath, 'utf8').trim().length > 20, `media file non-empty: ${step.media.markdown}`);

  for (const m of step.description.matchAll(/command:([a-zA-Z0-9._-]+)/g)) {
    const cmd = m[1];
    if (cmd.startsWith('videoPreviewEnhanced.')) {
      assert.ok(registered.has(cmd), `command link in step ${step.id} is registered: ${cmd}`);
    }
  }
}

assert.ok(agentsDoc.includes(walkthrough.AGENT_SNIPPET), 'AGENT_SNIPPET matches docs/agents.md');
assert.ok(fs.readFileSync(path.join(ROOT, 'media', 'walkthrough', 'agents.md'), 'utf8').includes(walkthrough.AGENT_SNIPPET), 'AGENT_SNIPPET is shown verbatim in media/walkthrough/agents.md');

// Every step has its own Next / Got it / Done button (setupNext with the step's id), and that marks it done.
for (const cmd of ['videoPreviewEnhanced.setupNext', 'videoPreviewEnhanced.setupFfmpegFromGuide', 'videoPreviewEnhanced.chooseTranscode']) {
  assert.ok(registered.has(cmd), `${cmd} registered`);
}
for (const step of wt.steps) {
  const link = 'command:videoPreviewEnhanced.setupNext?' + encodeURIComponent(JSON.stringify([step.id]));
  assert.ok(step.description.includes(link), `step ${step.id} has its own next button`);
  assert.ok(step.completionEvents.includes('onContext:' + walkthrough.doneKey(step.id)), `step ${step.id} is done after its button`);
}
assert.ok(/\[Show instructions\]/.test(wt.steps.find((x) => x.id === 'agents').description.split('\n')[1]), 'showing the instructions is the first button');
assert.ok(registered.has('videoPreviewEnhanced.openSampleVideo'), 'openSampleVideo command registered');
assert.ok(/\[Try it out\]\(command:videoPreviewEnhanced\.openSampleVideo\)/.test(wt.steps.find((x) => x.id === 'later').description), 'final step has Try it out button');
assert.ok(fs.existsSync(path.join(ROOT, 'media', 'probe', 'h264_8_1080.mkv')), 'bundled sample clip exists');

// Next goes to the next step this window shows; after the last one the guide closes (null).
const order = (remote) => { const out = ['start']; for (let id = 'start'; (id = walkthrough.nextStep(wt.steps, id, remote));) out.push(id); return out; };
assert.deepStrictEqual(order(undefined), ['start', 'ffmpeg', 'remoteLater', 'agents', 'later']);
assert.deepStrictEqual(order('ssh-remote'), ['start', 'remote', 'agents', 'later']);
assert.strictEqual(walkthrough.nextStep(wt.steps, 'later', undefined), null);
assert.strictEqual(walkthrough.nextStep(wt.steps, 'nope', undefined), null);
assert.throws(() => walkthrough.isShown("remoteName =~ /ssh/", 'ssh-remote'), /unsupported/);

// Local/WSL windows get the ffmpeg step and the remote hint; remote windows get the remote setup step instead.
const shown = (remote) => wt.steps.filter((x) => walkthrough.isShown(x.when, remote)).map((x) => x.id);
assert.deepStrictEqual(shown(undefined), ['start', 'ffmpeg', 'remoteLater', 'agents', 'later']);
assert.deepStrictEqual(shown('wsl'), ['start', 'ffmpeg', 'remoteLater', 'agents', 'later']);
assert.deepStrictEqual(shown('ssh-remote'), ['start', 'remote', 'agents', 'later']);

// Pictures referenced from the step Markdown exist, are small, and every picture is credited.
for (const step of wt.steps) {
  const md = fs.readFileSync(path.join(ROOT, step.media.markdown), 'utf8');
  for (const m of md.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    assert.ok(m[1].length > 10, `picture in ${step.id} has alt text`);
    const img = path.join(ROOT, path.dirname(step.media.markdown), m[2]);
    assert.ok(fs.existsSync(img), `picture exists: ${m[2]}`);
    assert.ok(fs.statSync(img).size < 150 * 1024, `picture under 150 KB: ${m[2]}`);
    assert.ok(fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes(path.basename(m[2])), `picture credited: ${m[2]}`);
  }
}

// The agents step offers both the skill install and the copy-paste snippet.
assert.ok(registered.has('videoPreviewEnhanced.installAgentSkill'), 'installAgentSkill command registered');
assert.strictEqual(walkthrough.SKILL_COMMAND, 'npx skills add gordon-vidal/video-preview-enhanced --skill video-preview-links -g');
assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'video-preview-links', 'SKILL.md')), 'public video-preview-links skill exists');
for (const dir of fs.readdirSync(path.join(ROOT, '.claude', 'skills'))) {
  const skillFile = path.join(ROOT, '.claude', 'skills', dir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) continue;
  const fm = fs.readFileSync(skillFile, 'utf8').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm && /\binternal:\s*true\b/.test(fm[1]), `internal skill ${dir} is hidden from npx skills`);
}

// First start: the guide opens once, never for earlier users or with VS Code's "open walkthroughs on install" off.
const open = walkthrough.shouldOpenGuide;
assert.strictEqual(open({}), true, 'fresh install, setting at its default');
assert.strictEqual(open({ openOnInstall: true }), true);
assert.strictEqual(open({ openOnInstall: false }), false, 'user (or test profile) turned walkthroughs off');
assert.strictEqual(open({ opened: 1764000000000 }), false, 'only once');
assert.strictEqual(open({ onboarding: { at: 1, choice: 'later' } }), false, 'used the extension before the guide existed');

// The guide never offers VS Code's own video preview (maintainer's decision): no undo-default button or wording.
for (const step of wt.steps) {
  const md = fs.readFileSync(path.join(ROOT, step.media.markdown), 'utf8');
  assert.ok(!/undoDefault|VS Code's (own |built-in )?preview/i.test(step.description + md), `step ${step.id} never offers VS Code's own preview`);
}

console.log('walkthrough tests passed');
