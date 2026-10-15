# tools

A landing page for the interactive tools in this repo, made to be shared as one link. One HTML file, no JavaScript, no build step.

Live: **https://mbschenked.github.io/FunArtTests/tools/**

It only links to the tools; each one lives in its own folder:

| Tool | Folder |
|---|---|
| Camera Shake Lab | [`camera-shake-lab/`](../camera-shake-lab/) |
| Trajectory Sandbox | [`trajectory-sandbox/`](../trajectory-sandbox/) |
| Muzzle flash and tracer range | [`vfx-studies/u4-range-combined.html`](../vfx-studies/u4-range-combined.html) |

The small graph on each row is inline SVG that draws itself once on load (skipped when the visitor prefers reduced motion). To add a tool, copy a `<li>` row, give its `<h3>` and first `<p>` new ids for `aria-labelledby` / `aria-describedby`, and pick a hue class (`shake`, `flight`, `flame`) or add one.
