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
  /** `{ nativeLossy?, transcoded?, video?, stream?, display? }`: what the reduced-resolution notice reads. */
  pictureInfo?(clipId: string): any;
}

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
  | { type: 'copyLink'; frame: number; t?: number }
  | { type: 'saveFrame'; frame?: number; data?: any; clipId?: string }
  | { type: 'exportFrame'; id?: number; [field: string]: any }
  | { type: 'exportRange' | 'clipRange' | 'ffmpegRange'; range?: RangePayload; [field: string]: any }
  | { type: 'abQuery'; [field: string]: any }
  | { type: 'openSettings' | 'loadSubs' | 'openUrl' | 'external' | 'fullscreen' }
  | { type: 'focusMode' | 'focusModeExited' }
  | { type: 'action'; id: string; [field: string]: any }
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

/** Host -> page. */
export type HostToPageMessage = PageEnvelope & (
  | { type: 'sessionState'; clips: ClipDescriptor[]; order: string[]; capture: boolean; maxVideos: number }
  | { type: 'open'; clips?: ClipSpec[] }
  | {
    type: 'openVideo'; clipId: string; label?: string; clip?: ClipDescriptor;
    compare?: boolean; replace?: boolean; forceNewTab?: boolean;
  }
  | { type: 'replaceTile'; oldId: string; newId: string; label?: string; clip?: ClipDescriptor }
  | { type: 'removeVideo'; clipId: string }
  | { type: 'toast'; text: string; ms?: number }
  | { type: 'focusMode'; active: boolean }
  | { type: 'setVisible' | 'visible'; visible: boolean; active?: boolean }
  | { type: 'playbackPrefs'; prefs: PlaybackPrefs }
  | { type: 'prefs'; prefs: Record<string, any> }
  | { type: 'goto'; mode?: string; frame?: number; t?: number }
  | { type: 'subs'; tracks: any[]; select?: any }
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
);

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
