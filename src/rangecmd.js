'use strict';
// A-B range helpers for the export commands: the ffmpeg command line equivalent to
// the player's A-B frames, frame stride math, and the PNG names of exported frames. Pure, for tests.
const path = require('path');

const defaultPlatform = process.platform;
const winPath = path.win32;
const posixPath = path.posix;

// checkJs: start
/**
 * @typedef {{ fa: number, fb: number, fps: number, stride?: unknown }} ExportRange
 */

const MAX_FRAMES = 2000;
const CONFIRM_FRAMES = 300;

/** `<video>_f000123.png` (frame numbers as the player shows them: 1 = first). */
function frameFileName(/** @type {string} */ base, /** @type {number} */ frame1) {
  return `${base}_f${String(frame1).padStart(6, '0')}.png`;
}

/**
 * @param {string} base
 * @param {string} ext
 * @param {string} [letter]
 */
function clipFileName(base, ext, letter) {
  return `${letter ? letter + '_' : ''}${base}_A-B${ext}`;
}

/** Parses a frame stride (positive integer >= 1) from a number or input string; null when invalid. */
function parseStride(/** @type {unknown} */ value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1 ? value : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Checks a frame stride value: null when valid (integer >= 1), else a user-facing message. */
function strideProblem(/** @type {unknown} */ value) {
  return parseStride(value) !== null ? null : 'Enter a whole number of frames (1 or more).';
}

/** Number of frames exported from `r` (`fa..fb` inclusive) at `stride` (every Nth frame, starting at `fa`). */
function rangeFrameCount(/** @type {{ fa?: unknown, fb?: unknown, stride?: unknown } | null | undefined} */ r, /** @type {unknown} */ stride = r && r.stride !== undefined ? r.stride : 1) {
  const st = parseStride(stride);
  if (!st || !r || typeof r.fa !== 'number' || typeof r.fb !== 'number' || !Number.isInteger(r.fa) || !Number.isInteger(r.fb) || r.fa < 0 || r.fb < r.fa) return 0;
  return Math.floor((r.fb - r.fa) / st) + 1;
}

/** 0-based frame indices exported from `r` (`fa, fa + stride, ... <= fb`). */
function rangeFrames(/** @type {{ fa?: unknown, fb?: unknown, stride?: unknown } | null | undefined} */ r, /** @type {unknown} */ stride = r && r.stride !== undefined ? r.stride : 1) {
  const count = rangeFrameCount(r, stride);
  if (!count || !r) return [];
  const st = /** @type {number} */ (parseStride(stride));
  const fa = /** @type {number} */ (r.fa);
  const out = [];
  for (let i = 0; i < count; i++) out.push(fa + i * st);
  return out;
}

/**
 * Next 0-based target frame in a strided export after requesting `k` and displaying `shown`.
 * Advances in multiples of `stride` so VFR gaps that jump past `k + stride` never re-seek backward.
 */
function nextRangeFrame(/** @type {number} */ k, /** @type {unknown} */ shown, /** @type {unknown} */ stride = 1) {
  const st = parseStride(stride) || 1;
  if (typeof shown !== 'number' || !Number.isInteger(shown) || shown < k + st) return k + st;
  return k + (Math.floor((shown - k) / st) + 1) * st;
}

/** InputBox options for prompting the frame stride before an A-B frame export. */
function strideInputOptions(/** @type {{ fa: number, fb: number }} */ range) {
  const span = range.fb - range.fa + 1;
  return {
    title: `Export Frames ${range.fa + 1}–${range.fb + 1} (${span} frame${span === 1 ? '' : 's'})`,
    prompt: 'Frame stride (1 = every frame, 2 = every 2nd frame, N = every Nth frame)',
    value: '1',
    validateInput: (/** @type {string} */ v) => strideProblem(v),
  };
}

/** Seconds for a command line: up to 4 decimals, no trailing zeros. */
const secs = (/** @type {number} */ t) => String(Math.round(Math.max(0, t) * 1e4) / 1e4);

/**
 * Which shell the command is pasted into: VS Code's default terminal shell (`vscode.env.shell`).
 * Named by the shell's executable on any platform (pwsh on Linux and macOS too; fish anywhere);
 * otherwise Windows defaults to PowerShell and other platforms to POSIX quoting.
 */
function shellKind(platform = defaultPlatform, shell = '') {
  const exe = String(shell || '').split(/[\\/]/).pop().toLowerCase();
  if (/^(pwsh|powershell)(\.exe)?$/.test(exe)) return 'powershell';
  if (/^fish(\.exe)?$/.test(exe)) return 'fish';
  if (platform !== 'win32') return 'posix';
  if (/^cmd(\.exe)?$/.test(exe)) return 'cmd';
  if (/^(bash|sh|zsh|wsl)(\.exe)?$/.test(exe)) return 'posix';
  return 'powershell';
}

/**
 * A path quoted so the shell passes it through literally (no $(), backticks, variables).
 * PowerShell: '…' with ' doubled. POSIX: '…' with '\'' for '. cmd has no literal quoting
 * for % and ", so such names are refused there.
 */
function quote(/** @type {unknown} */ p, platform = defaultPlatform, shell = '') {
  const kind = shellKind(platform, shell);
  const str = String(p);
  if (kind === 'powershell') return `'${str.replace(/['‘-‛]/g, '$&$&')}'`;
  if (kind === 'fish') return `'${str.replace(/[\\']/g, '\\$&')}'`;
  if (kind === 'cmd') {
    if (/[%"!^]/.test(str)) throw new Error('The file name contains characters (% " ! ^) that cmd.exe would interpret; use PowerShell or another shell for this command.');
    return `"${str}"`;
  }
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * ffmpeg command lines for frames fa..fb (0-based, inclusive) at fps.
 * The cut points sit half a frame before A and half a frame after B, so the
 * exact cut keeps exactly those frames whatever the container's time rounding.
 * exact: re-encodes (frame-accurate). copy: no re-encode; starts at the keyframe
 * at or before A, so it can begin earlier than A.
 * @returns {{exact: string, copy: string, ss: string, to: string}}
 */
function ffmpegRange(/** @type {string} */ file, /** @type {{ fa: number, fb: number, fps: number }} */ { fa, fb, fps }, platform = defaultPlatform, shell = '') {
  const ss = secs((fa - 0.5) / fps);
  const to = secs((fb + 0.5) / fps);
  const p = (platform === 'win32' ? winPath : posixPath).parse(file); // the file's platform, not this process's
  const tag = `f${String(fa + 1).padStart(6, '0')}-f${String(fb + 1).padStart(6, '0')}`;
  // Output in the current folder, prefixed so a name starting with '-' is not read as an option.
  const here = platform === 'win32' && shellKind(platform, shell) !== 'posix' ? '.\\' : './';
  const outExact = quote(`${here}${p.name}_${tag}.mp4`, platform, shell);
  const outCopy = quote(`${here}${p.name}_${tag}_copy${p.ext || '.mkv'}`, platform, shell);
  const input = `-ss ${ss} -to ${to} -i ${quote(file, platform, shell)}`;
  return {
    ss, to,
    exact: `ffmpeg ${input} -map 0:v:0 -map 0:a:0? -c:v libx264 -crf 16 -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k ${outExact}`,
    copy: `ffmpeg ${input} -map 0 -c copy -avoid_negative_ts make_zero ${outCopy}`,
  };
}

/** Checks a range from the page: null when fine, else a message. */
function rangeProblem(/** @type {{ fa?: unknown, fb?: unknown, fps?: unknown, stride?: unknown } | null | undefined} */ r) {
  if (!r || r.fa === undefined || r.fb === undefined || r.fa === null || r.fb === null) return 'Set an A-B loop first: press A at the first frame and B at the last.';
  // Frame indices name the exported files: whole numbers only, whatever the page sends.
  if (typeof r.fa !== 'number' || typeof r.fb !== 'number' || !Number.isInteger(r.fa) || !Number.isInteger(r.fb) || r.fa < 0) return 'The A-B range is not valid.';
  if (typeof r.fps !== 'number' || !(r.fps > 0)) return 'The frame rate is not known yet; try again in a moment.';
  if (r.fb < r.fa) return 'The A-B range is empty.';
  if (r.stride !== undefined) return strideProblem(r.stride);
  return null;
}
// checkJs: end

module.exports = {
  frameFileName, clipFileName, parseStride, strideProblem, rangeFrameCount, rangeFrames, nextRangeFrame, strideInputOptions,
  ffmpegRange, rangeProblem, quote, shellKind, MAX_FRAMES, CONFIRM_FRAMES,
};
