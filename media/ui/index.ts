// Entry of the webview UI bundle (ADR 0004). tools/build-ui.js bundles it to media/dist/webview-ui.js as an IIFE
// that sets globalThis.VpeWebviewUi, so the classic page scripts can use Preact, Signals and Floating UI without
// node_modules at runtime. Keep this file a thin typed bridge: components go in sibling modules and are re-exported.
import { h, render } from 'preact';
import { computed, effect, signal } from '@preact/signals';
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom';

export { h, render, signal, computed, effect, computePosition, flip, shift, offset, autoUpdate };

/** Set once the bundle has run: page scripts check it before using the rest. */
export const ready = true;
