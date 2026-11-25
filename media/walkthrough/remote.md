### Smooth playback over Remote-SSH, WSL & containers

- **WSL:** Works just like a local window — set up ffmpeg on the previous step for full speed.
- **Remote-SSH / Containers / Tunnels:** **Live transcode** (`Auto`) streams a lightweight version of your video from the remote machine so it plays smoothly without downloading the entire file first.

If your connection slows down, Live transcode automatically lowers the resolution to keep playing, and raises it back up when the link recovers.

**Exact frames still work:** **Copy Frame**, **Save Frame as PNG**, **Pixel Inspector**, and **Scopes** automatically fetch the exact full-resolution frame from the original file on the remote machine.

Adjust **Mode** (`Auto` / `Always` / `Off`), **Max bitrate**, or **Resolution** anytime in **⚙ › Live transcode**.
