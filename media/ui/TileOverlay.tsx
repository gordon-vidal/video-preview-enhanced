// A Compare tile's overlay (ADR 0004 phase 3): the top-right Enlarge / Remove buttons, the bottom pill (letter, name,
// frame, details, sound) and the offset nudge. It renders the markup media/player-ui.js overlayHtml() used to build
// (same classes, data-* hooks and names), so the controller's one delegated click handler on the stage keeps working
// and the stylesheets do not change. Pure view: the controller passes the facts, the icons are its SVG strings.
import { render } from 'preact';

export interface TileOverlayIcons {
  close: string;
  expand: string;
  collapse: string;
  info: string;
  sound: string;
  muted: string;
  noAudio: string;
}

export interface TileOverlayProps {
  /** The tile's numeric video id (data-i). */
  vid: number;
  letter: string;
  name: string;
  /** How many tiles Compare shows; the Remove confirmation only exists above two. */
  tileCount: number;
  /** Split Wipe's two sides: 'L' / 'R' (no top buttons, no details button); '' for a normal tile. */
  side: '' | 'L' | 'R';
  isHero: boolean;
  confirming: boolean;
  statsOn: boolean;
  hasAudio: boolean;
  /** The sound comes from this tile and is not muted. */
  heard: boolean;
  isClock: boolean;
  /** The offset as the pill shows it ("+3f") and as its name reads ("+3 frames"). */
  offsetShort: string;
  offsetLong: string;
  icons: TileOverlayIcons;
}

export function TileOverlay(p: TileOverlayProps) {
  const v = String(p.vid);
  const k = p.letter;
  const split = p.side !== '';
  const enl = p.isHero ? 'Back to grid' : 'Enlarge tile';
  const confirm = p.tileCount > 2 && p.confirming;
  return (
    <>
      {split ? null : (
        <div class="tile-top-acts">
          <button
            type="button"
            class="tbtn"
            data-act="enlarge"
            data-enlarge=""
            data-i={v}
            title={enl}
            aria-label={`${enl} ${k}`}
            dangerouslySetInnerHTML={{ __html: p.isHero ? p.icons.collapse : p.icons.expand }}
          />
          {confirm ? (
            <button
              type="button"
              class="tbtn rm confirm"
              data-act="remove"
              data-rm=""
              data-i={v}
              aria-label={`Confirm remove ${p.name} from Compare`}
              title="Click again to remove"
            >
              Remove?
            </button>
          ) : (
            <button
              type="button"
              class="tbtn rm"
              data-act="remove"
              data-rm=""
              data-i={v}
              aria-label={`Remove ${k} from compare`}
              title={p.tileCount > 2 ? 'Remove from compare' : 'Remove from compare (back to one video)'}
              dangerouslySetInnerHTML={{ __html: p.icons.close }}
            />
          )}
        </div>
      )}
      <div class={`tile-bottom-pill pill ${p.side === 'R' ? 'right' : 'left'}${p.isClock ? ' clock' : ''}`} data-zoom-drag="1">
        <span class="zoom-grip" title="Drag here to reposition while zoomed" aria-hidden="true">
          ⋮⋮
        </span>
        <button
          class="pill-open"
          type="button"
          data-act="openVid"
          data-i={v}
          title={`${p.name}: offset, clock, sound, replace, remove`}
          aria-label={`${k}: ${p.name}${p.isClock ? ', sets the clock' : ''}. Offset, clock and sound`}
        >
          <span class="ltr">{k}</span>
          <span class="nm">{p.name}</span>
          <span class="fr mono" />
        </button>
        {split ? null : (
          <button
            class={`mute-mini${p.statsOn ? ' info-on' : ''}`}
            type="button"
            data-act="info"
            data-i={v}
            aria-label={`Toggle details for ${k}`}
            aria-pressed={p.statsOn}
            title="Toggle clip details (mismatch highlighted)"
            dangerouslySetInnerHTML={{ __html: p.icons.info }}
          />
        )}
        {!p.hasAudio ? (
          <button
            class="mute-mini no-audio"
            type="button"
            data-act="sound"
            data-i={v}
            aria-label={`No audio track in ${k}`}
            aria-disabled="true"
            title="No audio track"
            dangerouslySetInnerHTML={{ __html: p.icons.noAudio }}
          />
        ) : (
          <button
            class={`mute-mini${p.heard ? ' on' : ''}`}
            type="button"
            data-act="sound"
            data-i={v}
            aria-label={p.heard ? `Mute ${k}` : `Sound from ${k}`}
            aria-pressed={p.heard}
            title={p.heard ? 'Mute' : `Sound from ${k}`}
            dangerouslySetInnerHTML={{ __html: p.heard ? p.icons.sound : p.icons.muted }}
          />
        )}
      </div>
      <div
        class={`sync-pill nudge${p.side === 'R' ? ' right below' : p.side === 'L' ? ' left below' : ''}`}
        role="group"
        aria-label={`Offset of ${k}`}
      >
        <button type="button" data-act="nudge" data-i={v} data-d="-1" aria-label={`${k} earlier`} title="Earlier (−)">
          −
        </button>
        <button
          class="offv mono"
          type="button"
          data-act="openVid"
          data-i={v}
          title={`Offset of ${k}`}
          aria-label={`Offset of ${k}: ${p.offsetLong}`}
        >
          {p.offsetShort}
        </button>
        <button type="button" data-act="nudge" data-i={v} data-d="1" aria-label={`${k} later`} title="Later (+)">
          +
        </button>
      </div>
    </>
  );
}

/** Render (or update) the overlay into `container`, the tile's `.ov` element. */
export function renderTileOverlay(container: Element, props: TileOverlayProps): void {
  render(<TileOverlay {...props} />, container);
}
