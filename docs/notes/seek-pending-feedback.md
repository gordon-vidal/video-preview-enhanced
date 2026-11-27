# Seek-pending feedback

**Problem.** Over a slow Remote-SSH link, or deep into a long GOP, a seek or step can take a second or more to show
its frame. The single-file player dimmed the seek bar after 200 ms; the unified viewer (2026-11-26) kept the CSS but
lost the code, so a slow click showed nothing at all until the picture changed and felt lost.

**Rule.** Everything the UI owns answers at once: the seek bar, frame number, time and play button move on the click
(the state commits before any decoder works). What the decoders still owe is shown, not hidden:

- A tile whose decoder has not shown the frame asked for after **150 ms** gets a small ring spinner centred on its
  picture, and the seek bar breathes (opacity 1 to 0.55, 1.1 s). Both go the moment the frame shows.
- "Owes a frame" (`media/player-unified.js` waitingTiles, every animation frame while a decoder is busy): paused with
  a seek or step in flight; playing but still opening or held by an accurate seek (`media/engine.js` playbackPhase);
  playing with no picture to show because a remote stream is buffering (`waitPic`). A tile outside its clip owes nothing.
- In Compare each tile has its own spinner: the one still loading is the one that shows it.
- A wait under 150 ms (a seek from the page's packets or decoded frames lands in a frame or two) shows nothing: no
  flicker on fast seeks and steps.

**Look.** A 34 px ring (white arc on a 22 % white track) on a 32 % black disc, the frosted monochrome of the bar; it
fades in over 150 ms. No layout shift, no new element in the bar, no focus stop, no colour.

**Accessibility.** The waiting tile gets `aria-busy="true"` (removed when it lands); nothing is announced, so fast
stepping is not read out frame by frame. Under `prefers-reduced-motion` the ring does not spin (static, dimmer arc)
and the bar is held at 0.7 opacity instead of breathing. Keys are unchanged.

**Mock-up.** `node tools/mockup/render.js --scenario grid-2`: the harness foot has a "Seek" latency picker (instant,
0.6 s, 2.5 s); with a latency, a paused seek or step shows the spinner on the tiles until it passes (the harness calls
the controller's `setLoading` like the page does).

**Where.** `media/player-ui.js` setLoading / loadingAfter (controller, Node-tested in `test/host/player_ui_test.js`),
`media/compare.css` `.cell.loading::after`, `media/player.css` `#seekRow.seeking`, `media/player-unified.js`
waitingTiles. Layer 3 `remote-stream-packets` checks the spinner and pulse appear during a 2 s host seek over a 2 Mb/s
link and go when it lands.

**Why not a centred big spinner or a text line.** The picture is what is being inspected frame by frame; a small ring
says "coming" without covering much of it, and text would compete with the frame counter.
