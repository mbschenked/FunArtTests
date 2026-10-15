# trajectory-sandbox

A sandbox for shaping the flight path of a Death From Above takedown: the leap from a ledge onto an enemy below. One HTML file, no build step.

Live: **https://mbschenked.github.io/FunArtTests/trajectory-sandbox/**

Drag the Control points of the curve and play the jump back. Four reference jumps (near and far, low and high drop) blend into one equation, so the same curve works at any distance and height. **Export CurveVector .csv** saves the curve for an Unreal Engine Curve Vector asset; **All Spans** saves the four references on shared keys.

| Key | Action |
|---|---|
| Space | play / pause |
| click the curve | add a Control point |
| Delete | remove the selected point |
| Option-drag | slide a point's time without moving it |
| Shift-drag | lock a drag to one axis |
| Esc | deselect |
| Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z | undo, redo |

The "Assumed, confirm or change" list on the page names every value that is still a starting guess.

This is a snapshot of a prototype from a private planning repo, copied 2026-10-15.

Not affiliated with or endorsed by Epic Games.
