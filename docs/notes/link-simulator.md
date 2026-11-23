# Link simulator: a slow or flaky SSH link without a remote

`src/link-sim.js` models the connection between the extension host and the player page in both directions, so SSH
playback, Compare tiles competing for one connection and Live transcode's quality ladder can be tested in a local
window and, with a virtual clock, in Node without waiting.

## What it models

| Part | Rule |
|---|---|
| Two pipes | `down` (host to page) and `up` (page to host), each with its own rate (Mb/s) |
| Byte budget | A message takes `bytes / rate` to send; a FIFO queue per direction, so one large batch delays everything behind it, and every player and Compare tile on the simulator shares the same pipes |
| Delay | Half the RTT each way, so a small request and its reply cost one RTT; seeded jitter (`seed`, default 1) varies each message by up to +-`jitter / 2` |
| Blackouts | `blackout=<ms>/<every ms>`: the first opens one period after the start. Nothing is sent or delivered inside one; the backlog drains in order afterwards (nothing dropped or reordered) |
| Size of a message | `estimateMessageBytes`: binary payloads at their length, strings as UTF-8, the rest as JSON |

Presets: `fast-ssh` (25 Mb/s, 15 ms), `typical-ssh` (8 Mb/s, 40 ms), `slow-ssh` (2.5 Mb/s, 80 ms),
`flaky-ssh` (4 Mb/s, 120 ms, a 1.5 s blackout every 8 s). Or `key=val,...`: `mbps` (both ways) or `down` / `up`,
`rtt`, `jitter`, `blackout`, `seed`, `preset` as a base, e.g. `mbps=5,rtt=60,jitter=15,blackout=1500/8000,seed=42`.

## In real VS Code (review mode, layer 3)

Set before VS Code starts:

- `VPE_SIMULATE_LINK=<preset or spec>` (`off` or `none` = no simulation). The extension host creates one simulator,
  logs `[link-sim] active: ...`, and sends the `nd` messages (native decoder and Live transcode data, in both
  directions) of every player and Compare panel through it. Closing a tab drops that tab's messages still in flight.
  A spec that does not parse is logged and ignored.
- `VPE_SIMULATE_REMOTE=<kind>` (`ssh-remote`, `wsl`, `dev-container` ...; `off` = the real window). Without it, an
  active link makes the window act like `ssh-remote`: no raw native frames, no frame server, Live transcode and its
  quality ladder allowed, link-limited read-ahead in the page. `effectiveRemoteName(vscode)` is the one place that
  decides; code that opens remote paths or URIs still uses `vscode.env.remoteName`.

Not simulated: the built-in decoder's `readBlock` replies and other message types (toasts, status). The remote ffmpeg
download offer keeps the real window (it would download a Linux build to the local machine otherwise).

## In Node (layers 1-2)

`createLinkSimulator(config, { clock, seed })` takes a clock `{ now, setTimeout, clearTimeout }`;
`test/lib/virtual-clock.js` is one a test moves by hand (`advance`, `runAll`). `sendDown(msg, deliver)` and
`sendUp(msg, deliver)` call `deliver` when the message would arrive; `wrapChannel(id)` is one user's slice
(its `dispose()` drops what it still has in flight); `stats()` has the byte and message counts and `inBlackout`.
`test/host/link_sim_test.js` shows each rule, and the Live transcode ladder (`src/stream-adapt.js`) stepping down
on `slow-ssh` and `flaky-ssh` while `fast-ssh` keeps full quality.
