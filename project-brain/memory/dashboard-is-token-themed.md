---
name: dashboard-is-token-themed
description: The dashboard ships dark + light themes driven entirely by CSS tokens; a hardcoded surface colour is a bug, and contrast is asserted at the token level because a render sweep cannot see it
metadata:
  type: project
---

`dashboard/index.html` ships **two themes**. `:root` defines the dark palette, `[data-theme="light"]`
overrides it, the choice persists in `localStorage` under `sv-theme`, and the sidebar "Toggle Theme"
button calls `toggleTheme()` — which **re-renders the active panel instead of reloading**, because
Chart.js bakes its colours in at construction time while the CSS switches on its own.

**Every colour must come from a token.** Four surfaces predated the light theme and kept literal dark
values while their *content* correctly read `var(--text)`: the Leaflet popup wrapper and tip
(`#1e2130`), `.map-loading-overlay`, `.chart-container`, and the JS-built confirm modal (`#161924`).
When `--text` flipped to near-black in light theme, the foreground moved and the background did not —
map popups and the destructive-action dialog rendered at **1.03:1 contrast**. Invisible, not missing.
They now read `--popup-bg` / `--modal-bg` / `--overlay-veil` / `--chart-bg`, whose dark values are
byte-identical to the literals they replaced so the dark theme is provably unchanged.

**Why the test is at the token level:** a rendering sweep structurally cannot catch this. The DOM is
perfect, the text is present and correct, and only the pixels are wrong — and a Leaflet popup does not
exist until someone clicks a pin. So `verify-dashboard.js` asserts the invariant on the tokens
themselves: every surface ≥ 4.5:1 against `--text` and ≥ 3:1 against `--text-muted`, with translucent
films composited over `--bg` first. It runs both themes by default (`--theme=dark|light|both`).
The guard was validated by reintroducing the `#1E2130` popup and confirming it failed at "1.03:1
(needs 4.5:1)" **while the panel sweep still reported 0 errors**.

Related traps in the same file: `var()` is resolved by the CSS engine and never by a canvas, so
`borderColor: 'var(--gold)'` in a Chart.js dataset is silently ignored — charts take literals from
the per-render `C` palette. And `discFullMktBtn` / `discRunBtn` / `themeBtn` no longer exist; if a
grep finds them you are reading `_backup-pre-hardening-2026-08-12/index.html`.

See also [[leaflet-null-latlng-trap]], [[map-pins-need-their-own-price-rule]],
[[analysis-numbers-must-scale-and-admit-unknowns]].
