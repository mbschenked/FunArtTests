# camera-shake-lab

An interactive visualizer for Unreal Engine 5.8 camera shakes. One HTML file, no build step.

Live: **https://mbschenked.github.io/FunArtTests/camera-shake-lab/**

The left side copies the Details panel of a camera shake Blueprint's Class Defaults, field for field, with the engine's defaults. Change a value and the views on the right redraw:

- **Camera view** — a target 3 m away at base FOV 90°, with the shake's path drawn as location or rotation
- **Over time** — every axis on a timeline, each scaled to its own peak
- **Peak offsets** — the real sizes of each axis

Wave Oscillator and Perlin Noise patterns are simulated. Presets: engine defaults, gun kick, hit from the left, landing thud, explosion.

Below the views: the gotchas the engine source shows (rotation off by default, random initial offsets, Perlin frequency is not Hz, blend-in eating short shakes) and a 1:1 reference of every field.

Not affiliated with or endorsed by Epic Games.
