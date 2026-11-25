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

module.exports = { WALKTHROUGH_ID, AGENT_SNIPPET };
