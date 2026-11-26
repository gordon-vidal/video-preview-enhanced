### Videos on another machine

**Remote-SSH, WSL and containers:** the video plays on that machine, so ffmpeg has to be set up there too. The first time a video needs it, a message offers a one-click download (about 80 MB, no admin rights).

**Why a lighter copy (Remote-SSH, containers):** a network connection is much slower than your own disk. So ffmpeg on that machine turns the video into a lighter stream while you watch (**Live transcode**). It starts right away, and the quality goes down and back up with your connection.

**Exact frames still work:** **Copy Frame**, **Save Frame as PNG**, **Pixel Inspector** and **Scopes** always use the original, full-quality picture.

You can change Live transcode for one video in **⚙ › Live transcode**.
