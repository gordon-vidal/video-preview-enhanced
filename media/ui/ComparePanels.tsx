// The Compare panel ("cmp") and its per-video page ("cmpVid") as Preact components (ADR 0004 phase 2). They replace the
// imperative render functions in media/player-ui.js; the controller computes the data (compare rows, offsets, layout
// state) and passes it with the actions, so the markup is a pure function of the props.
import { render } from 'preact';
import { PanelBackHead, PanelHeading, PanelRow, PanelSep, SegmentedRow, SwitchRow } from './PanelPrimitives';

export interface CompareRowData {
  id: string;
  letter: string;
  name: string;
  /** The value text on the right ("⏱ 🔊 +3f"). */
  value: string;
  ariaLabel: string;
}

export interface ComparePanelProps {
  rows: CompareRowData[];
  /** "2 of 4" next to "Add video…"; null when no more videos fit. */
  addValue: string | null;
  capture: boolean;
  /** Two videos or more: the layout, Swap, Sync and Leave rows. */
  multi: boolean;
  layoutModes: ReadonlyArray<readonly [string, string]>;
  layout: string;
  showSwap: boolean;
  syncMode: boolean;
  keepLetter: string;
  onOpenVideo: (id: string) => void;
  onAdd: () => void;
  onCapture: () => void;
  onLayout: (mode: string) => void;
  onSwap: () => void;
  onSync: () => void;
  onLeave: () => void;
}

export function ComparePanel(p: ComparePanelProps) {
  return (
    <>
      <PanelHeading>Videos</PanelHeading>
      {p.rows.map((r) => (
        <PanelRow
          key={r.id}
          cls="row cvid"
          label={r.name}
          value={r.value}
          chev
          ariaLabel={r.ariaLabel}
          lead={
            <span class="ltr" aria-hidden="true">
              {r.letter}
            </span>
          }
          onClick={() => p.onOpenVideo(r.id)}
        />
      ))}
      {p.addValue !== null ? <PanelRow cls="row" label="Add video…" icon="plus" value={p.addValue} onClick={p.onAdd} /> : null}
      <SwitchRow label="Open new videos here" on={p.capture} onToggle={p.onCapture} icon="plus" kbd="Shift+D" />
      <PanelSep />
      {p.multi ? (
        <>
          <SegmentedRow label="Layout" options={p.layoutModes} current={p.layout} onPick={p.onLayout} />
          {p.showSwap ? <PanelRow cls="row" label="Swap sides" icon="swap" kbd="X" onClick={p.onSwap} /> : null}
          <SwitchRow label="Sync offsets on tiles" on={p.syncMode} onToggle={p.onSync} />
          <PanelSep />
          <PanelRow
            cls="row"
            label="Leave compare"
            icon="leave"
            value={`keep ${p.keepLetter}`}
            ariaLabel={`Leave compare, keep ${p.keepLetter}`}
            onClick={p.onLeave}
          />
        </>
      ) : null}
    </>
  );
}

export type OffsetUnit = 'frames' | 'ms';

export interface CompareVideoPanelProps {
  letter: string;
  name: string;
  /** Short offset ("+3f") and its spoken form. */
  offText: string;
  offLong: string;
  unit: OffsetUnit;
  hasOffset: boolean;
  clock: boolean;
  sound: boolean;
  hasAudio: boolean;
  showSwap: boolean;
  /** "Enlarge tile" or "Back to grid". */
  enlargeLabel: string;
  onBack: () => void;
  onNudge: (dir: -1 | 1) => void;
  onUnit: (unit: OffsetUnit) => void;
  onReset: () => void;
  onClock: () => void;
  onSound: () => void;
  onSwap: () => void;
  onEnlarge: () => void;
  onReplace: () => void;
  onRemove: () => void;
}

const UNITS: ReadonlyArray<readonly [OffsetUnit, string]> = [
  ['frames', 'Frames'],
  ['ms', 'Time ms'],
];

export function CompareVideoPanel(p: CompareVideoPanelProps) {
  return (
    <>
      <PanelBackHead title={`${p.letter} ${p.name}`} onBack={p.onBack} />
      <PanelHeading>Offset</PanelHeading>
      <div class="speedTop">
        <PanelRow cls="big" label={null} onClick={() => p.onNudge(-1)} ariaLabel={`${p.letter} earlier`}>
          −
        </PanelRow>
        <div class="readout off" aria-label={`Offset of ${p.letter}: ${p.offLong}`}>
          {p.offText}
        </div>
        <PanelRow cls="big" label={null} onClick={() => p.onNudge(1)} ariaLabel={`${p.letter} later`}>
          +
        </PanelRow>
      </div>
      <div class="row static">
        <span class="grow">Unit</span>
        <div class="seg" role="group" aria-label={`Offset unit of ${p.letter}`}>
          {UNITS.map(([u, label]) => (
            <PanelRow key={u} cls="chip" label={label} onClick={() => p.onUnit(u)} attrs={{ 'aria-pressed': String(p.unit === u) }} />
          ))}
        </div>
      </div>
      {p.hasOffset ? <PanelRow cls="link" label="Reset offset" onClick={p.onReset} ariaLabel={`Reset the offset of ${p.letter}`} /> : null}
      <PanelSep />
      <SwitchRow label={`${p.letter} sets the clock`} on={p.clock} onToggle={p.onClock} />
      {p.hasAudio ? (
        <SwitchRow label={`Sound from ${p.letter}`} on={p.sound} onToggle={p.onSound} />
      ) : (
        <PanelRow cls="row" label={`No audio track in ${p.letter}`} onClick={() => {}} attrs={{ 'aria-disabled': 'true' }} />
      )}
      <PanelSep />
      {p.showSwap ? <PanelRow cls="row" label="Swap sides" icon="swap" kbd="X" onClick={p.onSwap} /> : null}
      <PanelRow cls="row" label={p.enlargeLabel} onClick={p.onEnlarge} />
      <PanelRow cls="row" label="Replace video…" onClick={p.onReplace} />
      <PanelRow cls="row" label="Remove from compare" icon="close" onClick={p.onRemove} />
    </>
  );
}

/** Mount the Compare page into `container` (replacing what it held). */
export function renderComparePanel(container: Element, props: ComparePanelProps): void {
  render(<ComparePanel {...props} />, container);
}

/** Mount a video's Compare page into `container`. */
export function renderCompareVideoPanel(container: Element, props: CompareVideoPanelProps): void {
  render(<CompareVideoPanel {...props} />, container);
}
