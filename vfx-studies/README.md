# vfx-studies

Real-time browser studies of two effects from *Uncharted 4: A Thief's End* (Naughty Dog, 2016): the bullet tracer and the muzzle flash, matched against captured gameplay frames. Three.js r160, one HTML file per page, no build step.

Live: **https://mbschenked.github.io/FunArtTests/vfx-studies/u4-range-combined.html**

Visual homage; not affiliated with or endorsed by Naughty Dog or Sony. No game assets are used: every flame, glare and mist texture is drawn by the page when it loads. The gameplay frames the effects were matched against stay private (`refs/frames/` is git-ignored).

## The pages

| Page | What it shows |
|---|---|
| [Combined range](u4-range-combined.html) | Both effects on every shot. Generated from the two study pages by `tools/combine.py`; don't edit it by hand. |
| [Muzzle flash](u4-muzzle-flash.html) | Soft glowing opening flames, a white column that tears into hot pieces, a cream-peach rim and a late glare. Some shots open full size and shrink, the rest open with a small puff and peak later; a slider sets the share. Presets: U4 AK (base), Rifle jet (02), X flash (03), Cinematic. |
| [Bullet tracer](u4-tracer.html) | A contrasty streak with a quick hand-off, a mist trail that fades in place behind the head, and a warm light that travels with each round. Presets: U4 reference, Cinematic. |
| [Range](range.html) | The shared test range the studies are built on: placeholder shooter and rifle, targets, cameras, lighting, bloom and tone mapping, with an empty effect slot. |

Every element of an effect is a control in the side panel, with presets and **Copy settings**.

## Controls

| Key | Action |
|---|---|
| Space, or click the view | fire one shot |
| A | auto-fire |
| number keys | cameras, as numbered on the bottom bar (1–6 on the combined range: shoulder, side, incoming, muzzle, lens pass, hero) |
| Q / W / E | speed 1x / 0.25x / 0.05x |
| P · `.` · Shift + `.` | pause · step 1/60 s · step one 1/240 s substep |
| N | switch the lighting |
| D | show the distortion buffer |
| H | hide the HUD |

To run locally, serve the folder (`python3 -m http.server`) and open a page.

## Test mode

Add `?preflight` and a page draws one exact frame, stops, and sets its title to `PREFLIGHT READY`:

```
u4-range-combined.html?preflight&hud=0&cam=hero&look=day&shot=0&t=0.012
```

`cam` picks the camera, `look` the lighting (`day`, `dusk`, `night`), `shot` the round (or `none`) and `t` the seconds after it. `&set=key:value,...` overrides panel values and `&preset=` picks a preset. `?tm=aces` swaps the custom per-channel tone map for stock ACES.

## Tools and notes

- `tools/combine.py` rebuilds the combined range from the study pages; `--check` exits 1 if it is out of date.
- `tools/shoot.mjs` takes a headless Chrome screenshot of a test-mode URL and reports console errors (`node tools/shoot.mjs <url> <out.png>`; Node 22+ and Google Chrome).
- `refs/tracer-spec.md` and `refs/muzzle-flash-spec.md`: what each effect was matched against, the measurements, the art direction and what is still open.
- `refs/ai-vfx-scouting.md`: a survey of AI-assisted VFX techniques and which ones these builds use.

Work in progress: the tracer's moving light (stage 2) is approved; the muzzle flash's fourth pass is in review.
