// The unified viewer's contracts, in one place (docs/notes/player-ui-controller.md, "Contracts"). Declarations
// only: no runtime code, never loaded by a page or the extension host, no build step. The modules name these
// types through JSDoc (`import('./unified-contracts').EngineAdapter`), and `npm run typecheck` checks them across
// files (tsconfig.contracts.json, tools/unified-contracts-check.js).
//
// Who implements what:
//   EngineAdapter        media/player-engine-adapter.js (production), tools/mockup/fake-engine.js (mockup)
//   HostAdapter          media/player-host-adapter.js (production), tools/mockup/fake-host.js (mockup)
//   UnifiedControllerApi media/player-ui.js VpePlayerUi.create()
//   PageToHostMessage    posted by media/player-ui*.js and media/player-unified.js, read by src/unified-session.js
//   HostToPageMessage    posted by src/unified-session.js (and the host that owns it), read by the page

// ---- clips ------------------------------------------------------------------------------------------------------

/** What a page may be told about a clip before its decoder opened it. Only `id` is required. */
export interface ClipSpec {
  id: string;
  name?: string;
  fps?: number;
  frames?: number;
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  codec?: string;
  size?: number;
  [extra: string]: unknown;
}

/** A clip as the engine knows it: every number filled in (a fallback until the decoder learnt the real one). */
export interface ClipMeta {
  id: string;
  name: string;
  fps: number;
  frames: number;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  codec: string;
  size: number;
  /** The mockup's tint for a synthetic clip (tools/mockup/fake-engine.js); no decoder sets it. */
  color?: string;
}

/**
 * A clip as the host describes it to the page (src/unified-session.js clipDescriptor): its id, label and probed
 * facts, never its path or URI. The page reads blocks by `clipId`.
 */
export interface ClipDescriptor {
  clipId: string;
  label: string;
  name: string;
  /** File size in bytes (0: unknown). */
  size: number;
  duration: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
  rotation: number;
  hasAudio: boolean;
  /** Decoded by native ffmpeg on the host ('nd' messages), not in the page. */
  native: boolean;
  codec: string;
  kind: string;
}

/** A tile's offset against the clock: frames (a number) or `{ unit: 'frames' | 'seconds', v }`. */
export type OffsetSpec = number | { unit?: string; v?: number } | null | undefined;

/** A picture's rectangle inside its cell, in CSS pixels. */
export interface PictureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One picture sample under the pointer (the pixel inspector). */
export interface PixelSample {
  r: number;
  g: number;
  b: number;
  a?: number;
  text: string;
  [extra: string]: unknown;
}

export interface ShownFrame {
  /** The clip's own frame for a clock frame, or null outside the clip. */
  frame: number | null;
  outOfRange: boolean;
}

export interface ClipFacts {
  title: string;
  sub: string;
  rows: string[][];
}

export interface DrawOptions {
  width?: number;
  height?: number;
  splitClipRatio?: number | null;
  picMode?: string;
  zoom?: number;
  panX?: number;
  panY?: number;
}

// ---- EngineAdapter ----------------------------------------------------------------------------------------------

/**
 * The decoders behind the controller. The core is what both implementations have and
 * test/host/adapter_contract_test.js holds them to; the optional hooks are inspection and subtitles, where a
 * controller feature simply stays off without them.
 */
export interface EngineAdapter {
  /** The clips known now (registerClip / unregisterClip change it in place). */
  readonly clips: ReadonlyArray<ClipSpec>;
  getClip(id: string): ClipMeta | null;
  naturalSize(id: string): { width: number; height: number };
  hasAudio(id: string): boolean;
  facts(id: string): ClipFacts;
  shownFrame(clipId: string, clockFrame: number, offset?: OffsetSpec, clockFps?: number): ShownFrame;
  /** shownFrame's inverse for the clock tile: the shared clock frame its decoder's frame stands for (optional). */
  clockFrameFromDecoder?(clipId: string, decoderFrame: number, offset?: OffsetSpec, clockFps?: number): number;
  /** Shows a frame of the clip's decoder; resolves with the frame shown, or null (aborted, unknown clip). */
  showFrame(clipId: string, frame: number, opts?: { signal?: AbortSignal | null }): Promise<number | null>;
  pictureRect(
    clipId: string, cellW: number, cellH: number, picMode?: string, zoom?: number, panX?: number, panY?: number,
  ): PictureRect;
  draw(canvas: any, clipId: string, frame: number, opts?: DrawOptions): void;
  /** `cb`: a function taking `{ clipId, seconds, frame, width, height, picture? }`, or a canvas to draw into. */
  thumbnail(clipId: string, seconds: number, cb: any, scrubbing?: boolean): void;
  thumbnailLeave(immediate?: boolean): void;
  /** A still of the clip: PNG bytes in `{ data }` (or a promise of it), null when there is none. */
  snapshot(clipId: string, frame?: number): any;
  setSoundSource(clipId: string | null): void;
  setVolume(volume: number, muted: boolean): void;
  /** A clip opened after boot (or a known one updated). */
  registerClip(clip: ClipSpec): unknown;
  /** Forget a closed clip; true when it was known. */
  unregisterClip(clipId: string): boolean;
  pixelAt(clipId: string, x: number, y: number): PixelSample | null;

  // Optional inspection and subtitle hooks.
  readPixels?(clipId: string, ...args: any[]): any;
  statsText?(clipId: string): string;
  packetIndex?(clipId: string): any;
  chapters?(clipId: string): any[];
  bufferedRanges?(clipId: string): any[];
  cueAt?(clipId: string, t: number, track: number): any;
  selectSubtitle?(clipId: string, track: number): void;
  /**
   * What the reduced-resolution notice reads, and what tells the notices (setContext) that Live transcode or
   * streaming plays. null: no such clip.
   */
  pictureInfo?(clipId: string): PictureInfo | null;
  /** The Live transcode the clip (else the first transcoded clip) plays through, or null when none does. */
  transcodeInfo?(clipId?: string): TranscodeInfo | null;
  /**
   * The clip's shown picture for an A-B mark: its time from the clip's first picture (`shownRel`), the file's own
   * timestamp of it for an exact clip (`markRel`) and whether that time is only a slot count (`synthetic`: native
   * ffmpeg without picture timestamps, Live transcode). null before a picture shows.
   */
  markOf?(clipId: string): AbMarkInfo | null;
  /**
   * The exact (full-resolution) picture of the clip's shown frame during Live transcode or lossy native playback:
   * `{ img, w, h, png }`, `{ error }`, or null (no player, or the shown picture is exact already).
   */
  exactFrame?(clipId: string): Promise<ExactFrameResult | null>;
}

/** EngineAdapter.pictureInfo: how the shown picture differs from the file. */
export interface PictureInfo {
  clipId?: string;
  /** Native ffmpeg scaled the picture down or reduced it to 8-bit. */
  nativeLossy?: boolean;
  /** Live transcode pixels (the host's spec, or a remote stream). */
  transcoded?: boolean;
  /** A URL / HLS clip, or a remote Live stream. */
  streaming?: boolean;
  video?: any;
  stream?: any;
  display?: any;
  quality?: any;
  [extra: string]: unknown;
}

/** EngineAdapter.markOf. */
export interface AbMarkInfo {
  shownRel: number;
  markRel: number;
  synthetic: boolean;
  fps: number;
}

/** EngineAdapter.transcodeInfo. */
export interface TranscodeInfo {
  clipId: string;
  lossy: boolean;
  transcode: any;
  stream: any;
  quality: any;
}

/** EngineAdapter.exactFrame: the picture, or why there is none. */
export type ExactFrameResult = { img: any; w: number; h: number; png?: any } | { error: string };

// ---- messages ---------------------------------------------------------------------------------------------------

/** The folder-rail protocol's own payload (src/folder-rail.js, media/folder-rail.js); typed there. */
export interface RailPayload {
  op?: string;
  [field: string]: any;
}

/** A page's decode size for its tiles (media/player-ui-lifecycle.js scheduleTileSize). */
export interface TileSizePayload {
  w: number;
  h: number;
  n?: number;
  cols?: number;
  rows?: number;
  layout?: string;
  zoom?: number;
  rate?: number;
  factor?: number;
  aspect?: number;
  actual?: boolean;
  /** Compare: each tile's own cell in device pixels (src/unified-session.js keeps them per clip). */
  tiles?: Array<{ clipId: string; w: number; h: number }>;
}

/** Shared playback preferences (src/settings.js rememberPlaybackPrefs). */
export interface PlaybackPrefs {
  volume?: number;
  rate?: number;
  timeMode?: number | string;
  stepSize?: string | null;
  muted?: boolean;
}

/** An A-B range as the export commands take it. */
export interface RangePayload {
  [field: string]: any;
}

/** Page -> host. `page` / `boot` (the adapter's envelope) ride on every message. */
export type PageToHostMessage = PageEnvelope & (
  | { type: 'ready'; tile?: TileSizePayload; origin?: string; view?: { w: number; h: number } }
  | { type: 'tiles'; tabId?: string; tiles: string[]; current?: string | null; capture?: boolean }
  | { type: 'tileOrder'; order: string[]; current?: string | null }
  | { type: 'tileSize'; tile?: TileSizePayload; clipId?: string; w?: number; h?: number }
  | { type: 'capture'; on: boolean }
  | { type: 'pickVideo'; exclude?: string[]; t?: number }
  | { type: 'comparePick'; t?: number; exclude?: string[] }
  | { type: 'replaceVideo'; oldId?: string; clipId?: string; exclude?: string[] }
  | { type: 'leaveCompare'; keepId?: string; clipId?: string; t?: number }
  | ({ type: 'playbackPrefs'; prefs?: PlaybackPrefs } & PlaybackPrefs)
  | { type: 'copyText'; text: string }
  | { type: 'copyFrame'; clipId?: string; [field: string]: any }
  // A frame link to the clock's frame (1-based `frame`); without `frame` the host links the page's position.
  | { type: 'copyLink'; clipId?: string; key?: string; frame?: number; t?: number; id?: number }
  | { type: 'saveFrame'; frame?: number; data?: any; clipId?: string }
  // One frame of an A-B export (the answer to 'exportGrab'): its PNG, or why there is none.
  | {
    type: 'exportFrame'; clipId?: string; key?: string; id?: number; frame?: number; data?: any; error?: string;
    [field: string]: any;
  }
  | {
    type: 'exportRange' | 'clipRange' | 'ffmpegRange'; clipId?: string; key?: string; range?: RangePayload;
    [field: string]: any;
  }
  | { type: 'abQuery'; [field: string]: any }
  // The exact picture of a shown frame from the host's ffmpeg (answered by 'exactFrame' with the same reqId).
  | { type: 'grabExactFrame'; clipId?: string; key?: string; reqId?: number; t?: number; frame?: number }
  // The clip's position (`t` seconds, `d` its duration), kept for a reload in place.
  | { type: 'pos'; clipId?: string; key?: string; t: number; d?: number }
  | { type: 'loadSubs'; clipId?: string; key?: string }
  | { type: 'openSettings' | 'openUrl' | 'external' | 'fullscreen'; clipId?: string; key?: string }
  | { type: 'focusMode' | 'focusModeExited' }
  | { type: 'action'; id: string; [field: string]: any }
  // The slow-playback notice's choice ('every' frame or 'skip'), saved as the whenSlow setting.
  | { type: 'whenSlow'; value?: string }
  // The Live transcode settings: its mode and the bitrate cap.
  | { type: 'transcodePref'; mode?: string; maxBitrateMbps?: number }
  // A Live transcode resolution for the clip (`height`), and whether it is a pick to remember.
  | { type: 'transcodeResolution'; clipId?: string; key?: string; height?: number; pick?: boolean }
  // Leave Live transcode for the built-in decoder on this tile.
  | { type: 'originalTile'; clipId?: string; key?: string }
  // A URL / HLS clip's quality pick.
  | { type: 'quality'; clipId?: string; key?: string; pick?: any }
  | { type: 'goto'; [field: string]: any }
  | { type: 'railAdopted'; id: number; ok: boolean }
  | ({ type: 'rail' } & RailPayload)
  | { type: 'neighbour'; d: number; auto?: boolean; rail?: any }
  // A decoder's own traffic, tagged with its clip (media/player-unified.js defaultCreatePlayer).
  | { type: 'readBlock'; clipId: string; key?: string; pos: number; len: number }
  | { type: 'thumb'; clipId: string; key?: string; id?: number; cancel?: boolean; [field: string]: any }
  | { type: 'nd'; clipId?: string; key?: string; m: any }
  | { type: 'log'; msg: string; clipId?: string; key?: string }
);

export interface PageEnvelope {
  page?: number;
  boot?: string;
}

/**
 * Host -> page: a video in a tile's place. `reload`: the same file again with another decoder (the page restarts the
 * tile in place). `autoPlay`: Autoplay "Play next in folder" went on at the end of the one before, so the page plays
 * the new video from frame 0; absent (a manual Next), play/pause stays as it was.
 */
export interface ReplaceTileMsg {
  type: 'replaceTile'; oldId: string; newId: string; label?: string; clip?: ClipDescriptor; reload?: boolean;
  autoPlay?: boolean;
}

/** Host -> page. */
export type HostToPageMessage = PageEnvelope & (
  | {
    type: 'sessionState'; clips: ClipDescriptor[]; order: string[]; capture: boolean; maxVideos: number;
    /** What the first clip plays from: 'file', 'url' or 'sequence'. */
    sourceKind?: string;
    /** For the first page only: a frame link, the saved position and the rail carried over a reload. */
    goto?: GotoTarget;
    savedPos?: { t: number; d: number };
    railCarry?: any;
  }
  | { type: 'open'; clips?: ClipSpec[] }
  | {
    type: 'openVideo'; clipId: string; label?: string; clip?: ClipDescriptor;
    compare?: boolean; replace?: boolean; forceNewTab?: boolean;
  }
  | ReplaceTileMsg
  | { type: 'removeVideo'; clipId: string }
  // Capture (Add from the Explorer) changed in the host: a command, Esc in VS Code, an editor switch, Compare full.
  | { type: 'capture'; on: boolean }
  | { type: 'toast'; text: string; ms?: number }
  | { type: 'focusMode'; active: boolean }
  | { type: 'setVisible' | 'visible'; visible: boolean; active?: boolean }
  | { type: 'playbackPrefs'; prefs: PlaybackPrefs }
  | { type: 'prefs'; prefs: Record<string, any> }
  // A frame link opened on this panel: the page seeks there, paused (`clipId`: the tile it names).
  | ({ type: 'goto'; clipId?: string } & GotoTarget)
  // Subtitle files found next to the clip or loaded by the user (`files`: the same list; `select`: turn one on).
  | { type: 'subs'; clipId?: string; key?: string; tracks: any[]; files?: any[]; select?: any; restore?: boolean }
  // Whether native ffmpeg is installed, and whether to offer setting it up (`mb`: its download size).
  | { type: 'ffmpegState'; installed: boolean; offer: boolean; mb?: number }
  | { type: 'abQuery' | 'exportGrab' | 'exportEnd'; [field: string]: any }
  | { type: 'hideReducedResNotice' | 'hideSlowPlaybackNotice' }
  | { type: 'slowPlayback'; variant: string; offerSetup?: boolean; mb?: number }
  | { type: 'railHandoff'; id: number; rail: any; onEnd?: string; fromAutoNext?: boolean }
  | { type: 'railHandoffCancel'; id: number }
  | { type: 'status'; text: string }
  | { type: 'error'; message: string; hint?: string; action?: any }
  | { type: 'pauseForTest' }
  | ({ type: 'rail' } & RailPayload)
  // A decoder's own traffic (media/player-unified.js DECODER_ROUTES), for the clip in clipId / key.
  | { type: 'block'; clipId?: string; key?: string; pos: number; data: Uint8Array; error?: string }
  | { type: 'nd'; clipId?: string; key?: string; m: any }
  | { type: 'ndv' | 'nda' | 'thumb' | 'exactFrame' | 'stream'; clipId?: string; key?: string; [field: string]: any }
  | { type: 'resize'; clipId?: string; key?: string; tiles?: Array<number | string> }
  // The page's own decoder lifecycle (media/player-unified.js LIFECYCLE_TYPES), for the clip in clipId / key:
  // a frame player's meta (MJPEG AVI, image sequences) and its sound when it came whole, one of its pictures, a part
  // of its sound sent ahead, the built-in decoder restarted with the host's meta, and Live transcode giving way to the
  // built-in decoder (`notice`: why).
  | { type: 'frames'; clipId?: string; key?: string; meta: any; wav?: any }
  | { type: 'frame'; clipId?: string; key?: string; index: number; data: any }
  | { type: 'wavPart'; clipId?: string; key?: string; data: any }
  | { type: 'libav'; clipId?: string; key?: string; meta?: any }
  | { type: 'originalTile'; clipId?: string; key?: string; notice?: string }
);

/** Where a frame link points: a frame (0-based) or a time in seconds; `mode` how it was written. */
export interface GotoTarget {
  mode?: string;
  frame?: number;
  t?: number;
}

export type PageToHostType = PageToHostMessage['type'];
export type HostToPageType = HostToPageMessage['type'];

// ---- HostAdapter ------------------------------------------------------------------------------------------------

/** The webview's saved state (survives a reload). */
export interface HostStorage {
  getState(): any;
  setState(state: any): void;
}

/**
 * The extension host behind the controller. `post` takes the controller's messages; a production adapter may
 * translate them for an older host, so it accepts any `{ type }` object and never throws.
 */
export interface HostAdapter {
  post(msg: PageToHostMessage | { type: string; [field: string]: any }): void;
  /** The host's messages go to `onHostMessage` from now on. */
  connect(onHostMessage: (msg: HostToPageMessage) => void): void;
  dispose(): void;
  storage?: HostStorage;
}

// ---- controller -------------------------------------------------------------------------------------------------

/** What the user did to the transport, as the controller reports it when a decoder owns the clock (`tickMs: 0`). */
export type TransportCommand =
  | { type: 'play'; frame?: number; playing?: boolean }
  | { type: 'pause'; frame?: number; playing?: boolean }
  | { type: 'seek'; frame: number; playing?: boolean }
  | { type: 'rate'; rate: number }
  | { type: 'loop'; loop: boolean };

/** What VpePlayerUi.create() returns. */
export interface UnifiedControllerApi {
  render(): void;
  onHostMessage(msg: HostToPageMessage | { type: string; [field: string]: any }): void;
  /**
   * A decoder clock presented this clock frame: the UI follows without telling onTransport. The page also names the
   * clock's clip; the controller knows its clock tile and does not need it.
   */
  onDecoderFrame(frame: number, clipId?: string): void;
  /** A decoder clock reached its end: A-B wrap, Loop, or pause and Autoplay next. */
  onDecoderEnded(info?: { natural?: boolean }): void;
  /** The clock video's decoder learnt its real fps / length. */
  syncClockMeta(): void;
  /** Run one action by name (the table the keys, bar and menus use); throws for an unknown name. */
  dispatch(name: string, ...args: any[]): any;
  actions(): string[];
  /** The workspace state of media/player-state.js. */
  getState(): any;
  setState(next: any): void;
  getPrefs(): Record<string, any>;
  dispose(): void;
  /** The tile, input, tools and lifecycle controllers (null without their widget modules). */
  parts: Record<string, any>;
}
