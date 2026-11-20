# Security policy

## Supported versions

Only the latest release on the Visual Studio Marketplace / Open VSX gets security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through GitHub: on the repository's **Security** tab choose
**Report a vulnerability**, or go straight to
<https://github.com/gordon-vidal/video-preview-enhanced/security/advisories/new>.
Include what an attacker can do, the steps or a file that shows it, and the extension, VS Code and
OS versions.

You should get a first answer within a week. Once a fix is released, the advisory is published and
credits you, unless you prefer not to be named.

## Scope

In scope, for example:

- a crafted video, subtitle or playlist file, or a URL, that makes the extension run code, read or
  write files outside what the user opened, or reach the network unexpectedly;
- the local frame server (`127.0.0.1`, used for native ffmpeg frames) accepting requests from
  anything other than the extension's own webview;
- the optional ffmpeg download skipping its checksum, or running a binary the user didn't choose;
- anything that bypasses Restricted Mode (in untrusted workspaces native ffmpeg must never run).

Out of scope: bugs in FFmpeg itself (report those to [FFmpeg](https://ffmpeg.org/security.html);
we update the bundled build when they are fixed), and crashes or hangs of the sandboxed WebAssembly
decoder that only affect the video being opened.
