// Unified overlay engine (ADR 0004 phase 1): one place that promotes floating surfaces (#ctxmenu, #menu, .vpe-pop,
// .panel popovers) into the browser top layer and positions them with Floating UI. The classic page scripts call it
// through globalThis.VpeWebviewUi and keep their own plain-DOM behaviour when it is absent (Node fake-DOM tests).
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';
import type { Placement } from '@floating-ui/dom';

type PopoverElement = HTMLElement & { showPopover?: () => void; hidePopover?: () => void };

/** True while the element is shown in the top layer; false when closed, unsupported or the selector is unknown. */
function isTopLayerOpen(el: HTMLElement): boolean {
  try {
    return el.matches(':popover-open');
  } catch {
    return false;
  }
}

/**
 * Promote `el` to the top layer (`popover="manual"`: no light dismiss, no focus change; the callers keep their own
 * Esc / outside-press handling). A no-op where the Popover API is missing; never throws, also when already open.
 * Call it after un-hiding the element. Returns whether the element is in the top layer afterwards.
 */
export function showTopLayer(el: HTMLElement): boolean {
  const p = el as PopoverElement;
  if (typeof p.showPopover !== 'function') return false;
  try {
    if (!p.hasAttribute('popover')) p.setAttribute('popover', 'manual');
    if (!isTopLayerOpen(p)) p.showPopover();
    return true;
  } catch {
    // Not connected or not a valid popover: back to a plain positioned element, as without the API.
    p.removeAttribute('popover');
    return false;
  }
}

/** Take `el` out of the top layer. Never throws; a no-op when it is not open or the API is missing. */
export function hideTopLayer(el: HTMLElement): void {
  const p = el as PopoverElement;
  if (typeof p.hidePopover !== 'function') return;
  try {
    if (isTopLayerOpen(p)) p.hidePopover();
  } catch {
    // already closed or detached: nothing to undo
  }
}

export interface PointOptions {
  /** Space kept between the surface and the viewport edges (px). Default 4. */
  padding?: number;
}

/** The same clamp as VpeUi.clampToViewport: what a surface gets before Floating UI answers, and in a fake DOM. */
function clampPoint(x: number, y: number, w: number, h: number, vw: number, vh: number, margin: number) {
  return {
    left: Math.max(margin, Math.min(x, vw - w - margin)),
    top: Math.max(margin, Math.min(y, vh - h - margin)),
  };
}

const pointTokens = new WeakMap<HTMLElement, number>();

/**
 * Place a point-anchored menu (right-click, tile menu) with its corner at (x, y), kept inside the viewport.
 * Synchronous: the clamped position is set at once (a measurement right after the call sees it); Floating UI then
 * refines it (flip to the other side of the point, shift) when its answer is still current.
 */
export function positionAtPoint(el: HTMLElement, x: number, y: number, opts: PointOptions = {}): void {
  const padding = opts.padding ?? 4;
  const doc = el.ownerDocument;
  const root = doc.documentElement;
  const vw = (root && root.clientWidth) || doc.defaultView?.innerWidth || 0;
  const vh = (root && root.clientHeight) || doc.defaultView?.innerHeight || 0;
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { width: 0, height: 0 };
  const w = el.offsetWidth || rect.width || 0;
  const h = el.offsetHeight || rect.height || 0;
  const pos = clampPoint(x, y, w, h, vw, vh, padding);
  el.style.left = `${pos.left}px`;
  el.style.top = `${pos.top}px`;

  const token = (pointTokens.get(el) ?? 0) + 1;
  pointTokens.set(el, token);
  // The point itself inside the page: flip() would otherwise put a menu for a point past the bottom edge above that
  // point (still off the page), and shift() moves it only sideways for a bottom placement.
  const px = Math.min(Math.max(x, 0), vw || x);
  const py = Math.min(Math.max(y, 0), vh || y);
  const reference = {
    getBoundingClientRect: () => ({ x: px, y: py, left: px, top: py, right: px, bottom: py, width: 0, height: 0 }),
  };
  computePosition(reference, el, {
    strategy: 'fixed',
    placement: 'bottom-start',
    middleware: [flip({ padding }), shift({ padding })],
  }).then((r) => {
    if (pointTokens.get(el) !== token || el.hidden) return;
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
  }, () => { /* the clamped position stays */ });
}

export interface AnchoredOptions {
  placement?: Placement;
  /** Gap between the anchor and the surface (px). Default 4. */
  offset?: number;
  /** Space kept between the surface and the viewport edges (px). Default 8. */
  padding?: number;
  /** Which coordinate to write: `x` leaves the vertical position to the caller's CSS. Default both. */
  axis?: 'x' | 'y' | 'both';
  /** Re-position on scroll, resize and size changes. Default true. */
  autoUpdate?: boolean;
}

/**
 * Place `el` next to `anchor` (a bar or rail button) with Floating UI. Returns a cleanup that stops following the
 * anchor and drops a late answer: call it when the surface closes or moves to another anchor.
 */
export function positionAnchored(anchor: Element, el: HTMLElement, opts: AnchoredOptions = {}): () => void {
  const axis = opts.axis ?? 'both';
  const padding = opts.padding ?? 8;
  let live = true;
  const update = () => {
    computePosition(anchor, el, {
      strategy: 'fixed',
      placement: opts.placement ?? 'bottom',
      middleware: [offset(opts.offset ?? 4), flip({ padding }), shift({ padding })],
    }).then((r) => {
      if (!live || el.hidden) return;
      if (axis !== 'y') el.style.left = `${r.x}px`;
      if (axis !== 'x') el.style.top = `${r.y}px`;
    }, () => { /* keep the caller's position */ });
  };
  let stop: () => void = () => {};
  if (opts.autoUpdate === false) {
    update();
  } else {
    try {
      stop = autoUpdate(anchor, el, update);
    } catch {
      // No observers in this runtime: one placement is still better than none.
      update();
    }
  }
  return () => {
    live = false;
    stop();
  };
}
