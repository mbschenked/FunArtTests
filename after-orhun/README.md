# after-orhun

Three browser studies inspired by [orhun](https://github.com/orhun)'s terminal-native dynamic art.

Live: **https://mbschenked.github.io/FunArtTests/after-orhun/**

Visual homage; unaffiliated. Each piece is written from scratch in plain HTML/CSS/JS — no Rust, no WASM, no vendored upstream code.

## The three pieces

| # | Piece | Source thread | Web primitive |
|---|---|---|---|
| A | [Phosphor Cell Field](a-phosphor.html) | [`theattyr`](https://github.com/orhun/theattyr) — VT100 cell-mutation loop | DOM `<pre>` grid + `requestAnimationFrame` |
| B | [Warped Console](b-warped.html) | [`ratty`](https://github.com/orhun/ratty) — Möbius surface warp of a terminal buffer | WebGL via Three.js, custom vertex + fragment shaders |
| C | [Boot Scatter](c-scatter.html) | [`ratatui-splash-screen`](https://github.com/orhun/ratatui-splash-screen) — progressive scatter-point image reveal | HTML5 Canvas 2D + offscreen mask buffer |

Web-bridge precedent: [`ratatui/ratzilla`](https://github.com/ratatui/ratzilla) (Rust → WASM, DOM/Canvas/WebGL2 backends).

## Source palette catalog

Near-black backgrounds with sparse cool accents. The full catalog these pieces draw from — individual pieces use subsets, not all of it:

- `#000000` background
- `#7fd0ff` ratty cyan
- `#3c8cba` ratzilla slate
- `#e6ac73` Black Waves amber
- `#5F8787` Black Waves teal
- `#a7da1e` Black Waves lime
- `#b657ff` Black Waves purple

## Run locally

No build, no dependencies. Piece A works from `file://`; pieces B and C use ES-module imports (Three.js / strict CORS), so they need a local server:

```sh
python3 -m http.server 8000
# → http://localhost:8000/after-orhun/
```

## Credits

- **Orhun Parmaksız** — original style and the source repos linked above. `orhun.dev`
- **Three.js** — used by piece B, loaded from jsdelivr CDN
- **Fira Code** — font, loaded from Google Fonts

Honors the project's `prefers-reduced-motion` setting on all three pieces (renders a single static frame instead of looping).
