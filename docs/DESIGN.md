# Design guide

The source of truth for how the player looks. [PRODUCT.md](PRODUCT.md) says what we build; this file says how it
should look so every part of the player feels like one product. `test/host/unified_css_test.js` enforces the card rules
below, so a surface that sets its own background, blur, corners or shadow fails CI.

![Cards in the player: the ⚙ panel and a toast over a comparison](notes/img/design-cards.png)

## Principles

- **Look like VS Code.** Colours come from the VS Code theme (`--vscode-*`), so light, dark and high-contrast themes
  work without extra rules. The player is mostly black and white; colour comes only from VS Code's own tokens.
- **One card look.** Everything that floats over the picture (notices, toasts, menus, panels, popovers, dialogs,
  readouts, tile pills) is the same card. Do not invent a new surface.
- **Reuse before you add.** A new message is a toast or a notice, a new menu uses the menu styles, a new popover is a
  `.vpe-pop`. If none fits, say so in the PR and extend the shared piece instead of adding a look-alike.

## Tokens (`:root` in `media/player.css`)

| Token | Value | Use |
|---|---|---|
| `--vpe-surface-float` (alias `--vpe-panel-bg`) | VS Code menu background at **90%** | The background of every card |
| `--vpe-card-blur` | `blur(2px)` | `backdrop-filter` (and `-webkit-backdrop-filter`) of every card |
| `--vpe-card-radius` | `8px` | Corners of every card and of the small tile buttons; pills use `999px` |
| `--vpe-shadow-low` | `0 4px 16px` widget shadow | Things that lie on the picture: notice, toast, pills, tabs, seek thumbnails |
| `--vpe-shadow-high` | `0 10px 30px` widget shadow | Things that open over it: menus, panels, popovers, dialogs, info cards |
| `--vpe-panel-border` | VS Code menu / widget border | The 1 px border of every card |
| `--vpe-panel-fg` | VS Code menu foreground | Text on cards |

Change a value here, never per surface. The one exception is the overlay Folder Rail's side shadow (it falls to one
side only).

## Type

- **12 px** for messages (notice, toast, Add mode prompt), line height 1.45.
- **13 px** for menus and panels, as VS Code's own menus.
- **11 px** for dense data (pixel readout, stats, Go to, scopes, tile pills).
- Normal weight. Bold only for a label inside a card, never for a whole message.

## Colour

- **Accent blue only from VS Code:** `--vscode-button-background` for the one main action of a notice or dialog,
  `--vscode-focusBorder` for focus rings and "a mode is on" marks (the Add mode dot, the drop frame).
- No hard-coded colours on cards. Exceptions that sit on the picture itself: the drop frame and the shortcut sheet's
  backdrop (dimmers, not cards), the Compare divider and the A–B pins.
- Warnings and errors are said in words; a notice has no accent colour or icon.

## Messages

Which channel to use: [notes/notifications.md](notes/notifications.md) (ownership matrix, priority queue, placement).
In short: a **toast** confirms what the user just did (no buttons, disappears); a **notice** asks for a decision or
reports a lasting state (text on its own line, buttons below: main action filled, then Settings, then the "don't show
again" answer, × in the corner); things outside the player are **VS Code notifications**. Wording and required
buttons: `.claude/skills/ui-notices/SKILL.md`.

## Adding or changing a surface

1. Use the tokens above (the test fails otherwise) and an existing pattern (notice, toast, `.panel`, `.vpe-pop`,
   `#ctxmenu`).
2. Show it in the mockup harness (`tools/mockup/render.js`, a scenario per state) before wiring it to the host.
3. Check dark, light and a narrow editor; keyboard (Tab, Esc) and accessible names.
4. Write it down in `docs/notes/` with a screenshot, and update this file if a rule changes.
