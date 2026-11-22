'use strict';
// A-B range helpers for the export commands: the ffmpeg command line equivalent to
// the player's A-B frames, and the PNG names of exported frames. Pure, for tests.
const path = require('path');

const MAX_FRAMES = 2000;
const CONFIRM_FRAMES = 300;

/** `<video>_f000123.png` (frame numbers as the player shows them: 1 = first). */
function frameFileName(base, frame1) {
  return `${base}_f${String(frame1).padStart(6, '0')}.png`;
}

function clipFileName(base, ext, letter) {
  return `${letter ? letter + '_' : ''}${base}_A-B${ext}`;
}

/** Seconds for a command line: up to 4 decimals, no trailing zeros. */
const secs = (t) => String(Math.round(Math.max(0, t) * 1e4) / 1e4);

/**
 * Which shell the command is pasted into: VS Code's default terminal shell (`vscode.env.shell`).
 * Named by the shell's executable on any platform (pwsh on Linux and macOS too; fish anywhere);
 * otherwise Windows defaults to PowerShell and other platforms to POSIX quoting.
 */
function shellKind(platform = process.platform, shell = '') {
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
function quote(p, platform = process.platform, shell = '') {
  const kind = shellKind(platform, shell);
  p = String(p);
  if (kind === 'powershell') return `'${p.replace(/['‘-‛]/g, '$&$&')}'`;
  if (kind === 'fish') return `'${p.replace(/[\\']/g, '\\$&')}'`;
  if (kind === 'cmd') {
    if (/[%"!^]/.test(p)) throw new Error('The file name contains characters (% " ! ^) that cmd.exe would interpret; use PowerShell or another shell for this command.');
    return `"${p}"`;
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * ffmpeg command lines for frames fa..fb (0-based, inclusive) at fps.
 * The cut points sit half a frame before A and half a frame after B, so the
 * exact cut keeps exactly those frames whatever the container's time rounding.
 * exact: re-encodes (frame-accurate). copy: no re-encode; starts at the keyframe
 * at or before A, so it can begin earlier than A.
 * @returns {{exact: string, copy: string, ss: string, to: string}}
 */
function ffmpegRange(file, { fa, fb, fps }, platform = process.platform, shell = '') {
  const ss = secs((fa - 0.5) / fps);
  const to = secs((fb + 0.5) / fps);
  const p = (platform === 'win32' ? path.win32 : path.posix).parse(file); // the file's platform, not this process's
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
function rangeProblem(r) {
  if (!r || r.fa === undefined || r.fb === undefined || r.fa === null || r.fb === null) return 'Set an A-B loop first: press A at the first frame and B at the last.';
  // Frame indices name the exported files: whole numbers only, whatever the page sends.
  if (!Number.isInteger(r.fa) || !Number.isInteger(r.fb) || r.fa < 0) return 'The A-B range is not valid.';
  if (!(r.fps > 0)) return 'The frame rate is not known yet; try again in a moment.';
  if (r.fb < r.fa) return 'The A-B range is empty.';
  return null;
}

module.exports = { frameFileName, clipFileName, ffmpegRange, rangeProblem, quote, shellKind, MAX_FRAMES, CONFIRM_FRAMES };
