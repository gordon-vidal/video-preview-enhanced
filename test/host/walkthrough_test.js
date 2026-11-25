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
assert.ok(Array.isArray(wt.steps) && wt.steps.length === 5, 'walkthrough has 5 steps');

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

console.log('walkthrough tests passed');
