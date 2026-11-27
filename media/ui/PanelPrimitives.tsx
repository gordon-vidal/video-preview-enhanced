// Reusable panel primitives (ADR 0004 phase 2). They render the exact DOM media/controls.js builds for its pages
// (same classes, roles and attributes as media/player.css and media/compare.css style), so a page written with them
// looks and behaves like the imperative one. Pure view: state and actions come in as props.
import type { ComponentChildren } from 'preact';

/** The SVG bodies the panels use; same artwork as media/ui-primitives.js ICONS and media/controls.js ICON. */
const ICON_BODIES = {
  back: { body: '<path d="M15 6l-6 6 6 6"></path>', size: 16, sw: 1.8 },
  chev: { body: '<path d="M9 6l6 6-6 6"></path>', size: 16, sw: 1.8 },
  plus: { body: '<path d="M12 5v14M5 12h14"/>', size: 18, sw: 1.6 },
  swap: { body: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>', size: 18, sw: 1.6 },
  leave: { body: '<path d="M10 17l-5-5 5-5M5 12h11a4 4 0 0 1 4 4v3"/>', size: 18, sw: 1.6 },
  close: { body: '<path d="M6 6l12 12M18 6L6 18"/>', size: 12, sw: 2.1 },
} as const;

export type IconName = keyof typeof ICON_BODIES;

/** A decorative 24-unit-grid icon, as the bar and panel rows draw it. */
export function Icon({ name }: { name: IconName }) {
  const i = ICON_BODIES[name];
  return (
    <svg
      width={i.size}
      height={i.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={i.sw}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: i.body }}
    />
  );
}

/** A group title ("Videos"): visual only, the rows below name themselves. */
export function PanelHeading({ children }: { children: ComponentChildren }) {
  return (
    <div class="phead" aria-hidden="true">
      {children}
    </div>
  );
}

export function PanelSep() {
  return <div class="sep" />;
}

export interface PanelRowProps {
  /** The whole class attribute: "row", "row cvid", "row head", "big", "chip", "link". */
  cls: string;
  label?: ComponentChildren | null;
  onClick: () => void;
  icon?: IconName;
  /** Content before everything else (the tile letter). */
  lead?: ComponentChildren;
  value?: ComponentChildren;
  /** Shortcut hint shown on the row (and aria-keyshortcuts). */
  kbd?: string;
  chev?: boolean;
  ariaLabel?: string;
  /** Extra attributes (role, aria-checked, aria-pressed, aria-disabled). */
  attrs?: Record<string, string>;
  children?: ComponentChildren;
}

/** controls.js btn(): a keyboard-navigable button; a click never reaches the page behind the panel. */
export function PanelRow(p: PanelRowProps) {
  const extra: Record<string, string> = { ...(p.attrs || {}) };
  if (p.ariaLabel !== undefined) extra['aria-label'] = p.ariaLabel;
  if (p.kbd) extra['aria-keyshortcuts'] = p.kbd.replace('Ctrl', 'Control');
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    p.onClick();
  };
  return (
    <button type="button" class={p.cls} data-nav="1" {...extra} onClick={onClick}>
      {p.lead}
      {p.icon ? <Icon name={p.icon} /> : null}
      {p.label !== null && p.label !== undefined ? <span class="grow">{p.label}</span> : null}
      {p.value !== undefined ? <span class="val">{p.value}</span> : null}
      {p.kbd ? <kbd aria-hidden="true">{p.kbd}</kbd> : null}
      {p.chev ? <Icon name="chev" /> : null}
      {p.children}
    </button>
  );
}

/** A page's title row: back to the page it came from. */
export function PanelBackHead({ title, onBack }: { title: string; onBack: () => void }) {
  return <PanelRow cls="row head" label={title} onClick={onBack} icon="back" ariaLabel={`Back from ${title}`} />;
}

export interface SwitchRowProps {
  label: string;
  on: boolean;
  onToggle: () => void;
  icon?: IconName;
  kbd?: string;
}

/** A label with an on/off switch: role="switch" with aria-checked. */
export function SwitchRow({ label, on, onToggle, icon, kbd }: SwitchRowProps) {
  return (
    <PanelRow cls="row" label={label} onClick={onToggle} icon={icon} kbd={kbd} attrs={{ role: 'switch', 'aria-checked': String(on) }}>
      <span class={`switch${on ? ' on' : ''}`}>
        <span class="knob" />
      </span>
    </PanelRow>
  );
}

export interface SegmentedRowProps {
  label: string;
  options: ReadonlyArray<readonly [string, string]>;
  current: string;
  onPick: (value: string) => void;
  /** Name of the group for screen readers (defaults to the label). */
  ariaLabel?: string;
}

/** A label and mutually exclusive chips (aria-pressed marks the current one). */
export function SegmentedRow({ label, options, current, onPick, ariaLabel }: SegmentedRowProps) {
  return (
    <div class="row static">
      <span class="grow">{label}</span>
      <div class="seg" role="group" aria-label={ariaLabel ?? label}>
        {options.map(([value, text]) => (
          <PanelRow key={value} cls="chip" label={text} onClick={() => onPick(value)} attrs={{ 'aria-pressed': String(current === value) }} />
        ))}
      </div>
    </div>
  );
}
