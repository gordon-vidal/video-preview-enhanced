'use strict';
// First-time setup Walkthrough constants and AI agent deep-link snippet.
// Pure module (no VS Code dependency) so unit tests can verify package.json and docs/agents.md stay in sync.

const WALKTHROUGH_ID = 'videoPreviewEnhanced.setup';

const AGENT_SNIPPET = [
  '## Video inspection links (VS Code)',
  '',
  'When you generate, transcode, or compare video files, include clickable `vscode://` links so I can inspect them directly in Video Preview Enhanced:',
  '',
  '- Single video (optional `frame` is 1-based, `t` is seconds):',
  '  `vscode://gordon-vidal.video-preview-enhanced/open?frame=<N>&file=<URL_ENCODED_ABS_PATH>`',
  '- Synced comparison of 2+ videos (optional `frame`, `t`, `mode=split|grid|spotlight`):',
  '  `vscode://gordon-vidal.video-preview-enhanced/compare?frame=<N>&mode=split&file=<URL_ENCODED_ABS_PATH_A>&file=<URL_ENCODED_ABS_PATH_B>`',
  '',
  'URL-encode every path (spaces, `#`, `?`, `&`, and Windows backslashes/colons). In a Remote-SSH or WSL workspace, use `uri=<URL_ENCODED_vscode-remote://...>` instead of `file=`.',
].join('\n');

/** Installs the video-preview-links agent skill globally via skills.sh (skills/video-preview-links/SKILL.md). */
const SKILL_COMMAND = 'npx skills add gordon-vidal/video-preview-enhanced -g';

/** globalState key: when the extension opened the setup guide by itself (once per machine). */
const GUIDE_KEY = 'videoPreviewEnhanced.setupGuideOpened';

/**
 * Open the setup guide by itself on this start? Once, on the first start after install. VS Code opens it on its own
 * only after an install from the Extensions view; a VSIX, the command line, Remote-SSH and Settings Sync never do.
 * Not for people who used the extension before this guide existed (they answered the first-video popup), and not when
 * workbench.welcomePage.walkthroughs.openOnInstall is off (the user's own "don't open walkthroughs" choice; the tests
 * and the review launcher turn it off too).
 * @param {{ opened?: unknown, onboarding?: unknown, openOnInstall?: unknown }} ctx
 */
function shouldOpenGuide(ctx) {
  return !ctx.opened && !ctx.onboarding && ctx.openOnInstall !== false;
}

/**
 * Is a step with this `when` clause shown in this window? Only the shapes the walkthrough uses: `remoteName`,
 * `!remoteName` and `remoteName == / != '<kind>'`, joined by `||` and `&&`. Throws on anything else, so a new clause
 * fails the unit test instead of silently showing the wrong steps.
 */
function isShown(when, remoteName) {
  if (!when) return true;
  return when.split('||').some((alt) => alt.split('&&').every((term) => {
    const t = term.trim();
    if (t === '!remoteName') return !remoteName;
    if (t === 'remoteName') return !!remoteName;
    const m = /^remoteName\s*(==|!=)\s*'([^']*)'$/.exec(t);
    if (!m) throw new Error(`walkthrough: unsupported when-clause term "${t}"`);
    return (m[1] === '==') === (remoteName === m[2]);
  }));
}

/** The step after `id` that this window shows, or null after the last one. `steps`: package.json walkthrough steps. */
function nextStep(steps, id, remoteName) {
  const at = steps.findIndex((s) => s.id === id);
  if (at < 0) return null;
  const next = steps.slice(at + 1).find((s) => isShown(s.when, remoteName));
  return next ? next.id : null;
}

/** Context key that marks a step done (its completionEvents list `onContext:` this key). */
const doneKey = (id) => `videoPreviewEnhanced.setupDone.${id}`;

module.exports = { WALKTHROUGH_ID, AGENT_SNIPPET, SKILL_COMMAND, GUIDE_KEY, shouldOpenGuide, isShown, nextStep, doneKey };
