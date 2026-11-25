# Privacy and security

- **Nothing leaves your machine.** No telemetry, no analytics, no network requests of its own.
- **Two exceptions, both started by you:** the ffmpeg download, only when you run **Set Up Optional ffmpeg** and choose to download (GitHub for BtbN builds, martin-riedl.de for macOS); and a URL you open with **Open Video URL…**, which is fetched from its server (and, for a stream, the segments it lists). The query string of a URL is never logged.
- **Sandboxed decoding.** The built-in decoder is WebAssembly inside the editor's webview, which can only load the extension's own media folder.
- **Restricted Mode:** only the built-in decoder runs. Native ffmpeg never does, and a workspace can't set `ffmpegPath`.
- **Dropped Compare videos** must resolve to files on the current extension host. Drops that point to network shares or a different remote host are ignored.
- **No temporary files.** Videos are decoded in memory and never written anywhere.
