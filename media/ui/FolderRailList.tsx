// The Folder Rail's list rows (ADR 0004 phase 3): the empty / loading note or one `.r-row` per entry, the DOM
// media/folder-rail.js render() used to build (same classes, roles, ids and names). The rail keeps what is not markup:
// filtering, the cursor, hover thumbnails and the host messages; it passes the finished rows and the callbacks.
import { render } from 'preact';

export interface FolderRailRow {
  /** The host's opaque entry id (data-id). */
  id: string;
  /** DOM id, `rail-<id>` (aria-activedescendant points at it). */
  domId: string;
  name: string;
  isUp: boolean;
  active: boolean;
  inCompare: boolean;
  /** A file that is not a video: dimmed. */
  dim: boolean;
  /** The icon's SVG string. */
  iconHtml: string;
  /** The extra column text; null when the column is off or the row is "..". */
  colText: string | null;
  /** The row can start a Compare (shows the .r-cmp button, marks the column .cmp-able). */
  canCompare: boolean;
  /** The Compare button's names (folder: all its videos; video: with the playing one). */
  compareTitle: string;
  compareLabel: string;
  cmpIconHtml: string;
}

export interface FolderRailListProps {
  /** The note shown instead of the rows: an error, "No matching files", "Loading…"; null for none. */
  empty: string | null;
  rows: FolderRailRow[];
  onRow: (id: string) => void;
  onEnter: (id: string) => void;
  onLeave: (id: string) => void;
  onCompare: (id: string) => void;
}

export function FolderRailList(p: FolderRailListProps) {
  return (
    <>
      {p.empty !== null ? <div class="r-empty">{p.empty}</div> : null}
      {p.rows.map((r) => (
        <div
          key={r.id}
          class={`r-row${r.active ? ' active' : ''}${r.inCompare ? ' in-cmp' : ''}${r.dim ? ' dim' : ''}`}
          id={r.domId}
          role="option"
          aria-selected={r.active || r.inCompare}
          title={r.isUp ? 'Parent folder' : r.inCompare ? 'In Compare — click to remove' : undefined}
          data-id={r.id}
          onClick={() => p.onRow(r.id)}
          onMouseEnter={() => p.onEnter(r.id)}
          onMouseLeave={() => p.onLeave(r.id)}
        >
          <span class="r-ico" dangerouslySetInnerHTML={{ __html: r.iconHtml }} />
          <span class="r-name" title={r.isUp ? undefined : r.name}>
            {r.name}
          </span>
          {r.colText !== null ? <span class={`r-col${r.canCompare ? ' cmp-able' : ''}`}>{r.colText}</span> : null}
          {r.canCompare ? (
            <button
              type="button"
              class="r-cmp"
              title={r.compareTitle}
              aria-label={r.compareLabel}
              tabIndex={-1}
              dangerouslySetInnerHTML={{ __html: r.cmpIconHtml }}
              onClick={(e) => {
                e.stopPropagation();
                p.onCompare(r.id);
              }}
            />
          ) : null}
        </div>
      ))}
    </>
  );
}

/**
 * Render the list into `container`, mounted afresh every time. The rail also toggles `.cur` (the cursor) and `.in-cmp`
 * on the row elements itself (cursor moves, Compare changes, without a rebuild), which a diff against the last props
 * would not see, so the cursor class is not part of the props.
 */
export function renderFolderRailList(container: Element, props: FolderRailListProps): void {
  render(null, container);
  container.textContent = '';
  render(<FolderRailList {...props} />, container);
}
