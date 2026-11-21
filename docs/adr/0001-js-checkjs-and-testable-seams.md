# 0001: Pragmatic JS + scoped `checkJs` and testable seams

- **Status:** Signed off by maintainer (2026-11-21)

## Decision
- Keep production in plain JavaScript with no build step and no new runtime dependencies, and add a scoped, dev-only JSDoc `checkJs`/`noEmit` check at host/page/worker boundaries.
- Treat this as a pragmatic initial stage focused on making the project in its current form easier to develop, test, and cheaply mock at real seams — starting with a small pilot on the single-player `readBlock` exchange and page-load identity.

## Why
- Makes development more efficient and reduces regressions by making boundary contracts explicit and moving fast, reliable tests below Layer 3 VS Code.
- Keeps the current VSIX layout, debugging workflow, and LGPL WASM boundary intact without stalling feature work.

## Discussed & rejected
- **Full TypeScript migration (now)** — adds build/sourcemap/packaging overhead without solving lifetime/cancellation bugs; revisit for a bounded controller only if JSDoc becomes painful.
- **Standalone player package / rewrite** — deferred until a concrete second host/use case exists; clean host↔player boundaries keep future extraction cheap.
- **Arbitrary file splitting** — extract along lifetime/contract seams only where it improves testability and cheap mocking.
