# Player spec: controls, camera, cover, pistol, grenades, health, HUD

**Status:** research v1, 2026-11-11. This is the build reference for the player, camera, weapon and HUD modules. Every number carries a tag:

- **[DEV]** Naughty Dog said it (GDC talk, interview, developer post).
- **[MEASURED]** Timed from gameplay footage. The clip, the timestamps and the frame method are given.
- **[WIKI]** From a community wiki or strategy guide.
- **[INFERRED]** No source exists. This is my recommended default, and every one of them is a param.

Footage IDs (F1–F6) are listed under Sources. Talk IDs: **G** is Gallant's GDC 2017 combat-AI talk, **Y** is the Yates/Soria GDC 2017 animation bootcamp, and **M** is Mach's GDC 2017 physics-animation talk. Known-repo notes are cited as `Known repo: <path>`. They show how Max's Unreal project did it. They are a view, not a blueprint, and nothing from them is copied here.

**Footage caveat.** YouTube cut downloads off after about 10 MB per session (HTTP 403) and blocked captions (HTTP 429). So the footage is the first 36–46 s of three single-player clips plus four short multiplayer (MP) clips. MP uses the same player animation set but has its own tuning. Every number taken from MP is marked as MP. The protocol at the end lists what is still worth timing by hand.

---

## Summary

1. **Pad layout (PS4):** L2 aim, R2 fire, R1 grenade (hold for the arc, release to throw), Circle cover/roll, X jump (and shoulder swap while aiming), Triangle reload. **PC:** RMB aim, LMB fire, G grenade, Left Shift cover/roll, Space jump/shoulder swap, R reload, Left Ctrl slow walk. [WIKI]
2. **No sprint and no crouch button.** Speed follows how far the stick is pushed. Crouching is automatic, behind low cover and in tall grass. [WIKI] [MEASURED]
3. **Pistol (the standard .45):** 12-round magazine, 60 rounds carried in total, and the HUD number counts all rounds including the magazine. [MEASURED F1] **The fastest fire rate is one shot every 0.200 s (5 shots/s).** [MEASURED F1, 5 identical 12-frame intervals at 60 fps]
4. **Empty magazine:** the reload is automatic. If Drake was popped up from cover, he ducks back down first. Last shot to full magazine takes **0.85 s**. [MEASURED F1]
5. **First shot always lands at the reticle centre** (Naughty Dog removed first-shot deviation after playtests). A pistol can kill at about 50 m. [DEV G]
6. **Aim reticle:** a small white dot sitting **above the screen centre, at 42% of the screen height from the top**. On a hit, a 4-tick "X" hit marker shows for about 0.3 s. [MEASURED F1, F5]
7. **Camera:** in exploration the character fills about 0.4 of the screen height, roughly centred. Aiming is a close over-the-shoulder view, right shoulder by default and swappable. Going from cover to aim takes about **0.14 s**. [MEASURED F1, F5]
8. **Recoil** is a small upward camera kick of about 0.2° per shot that is fully back within about 0.1 s. [MEASURED F1, phase correlation]
9. **Health is "luck":** no bar. Getting hit pulls red streaks in from the screen edge facing the shooter and drains colour from the screen. It recovers about 2–3 s after the last hit. A "damage wobble" camera shake plays on hits. [DEV Cooper, G] [MEASURED F1]
10. **Grenades:** up to 4 carried [WIKI]. Aiming one uses the gun-aim camera and shows a thin white arc line ending in a small landing ring [MEASURED F4]. MP fuses start on impact and last 3 s [WIKI]. The single-player fuse is unmeasured, so the default is [INFERRED].

---

## 1. Control map

Action names are the fixed `game.input` actions from `design.md`.

| Action (`game.input`) | PS4 / pad (standard mapping) | PC KB/M default | Notes | Source |
|---|---|---|---|---|
| `move` | Left stick | W A S D | Analog speed, no run button | [WIKI] gamerguides, progameguides |
| `look` | Right stick | Mouse | PC has separate **Camera** and **Aiming** sensitivity sliders | [WIKI] PCGamingWiki |
| `aim` | L2 (hold) | RMB (hold) | Option: hold or toggle | [WIKI] gamerguides, FGDB |
| `fire` | R2 | LMB | Fire without aim = hip fire, or blind fire in cover | [WIKI] |
| `reload` | Triangle | R | Also automatic when the magazine is empty | [WIKI] [MEASURED F1] |
| `grenade` | R1 (hold = arc, release = throw) | G (hold/release) | Aim it with the camera | [WIKI] gamerguides, twinfinite |
| `cover` | Circle | Left Shift | Same button: enter/leave cover, roll/evade, drop from a ledge | [WIKI] |
| `jump` | X | Space | Also climb. Out of scope here, see climb-spec | [WIKI] |
| `swapShoulder` | X while aiming | Space while aiming | Context: only while `aim` is held | [WIKI] gamerguides, magicgameworld |
| `walk` | Light stick push | Left Ctrl (slow walk, hold) | No sprint exists | [WIKI] magicgameworld |
| crouch | none | none | Automatic only (see §2) | [WIKI] [MEASURED F1 0:30–0:46] |
| melee (out of scope) | Square | F | Note only | [WIKI] |
| mark enemy (out of scope) | L3 | C | Note only | [WIKI] |
| switch weapon (out of scope) | D-pad left/right | 1 / 2 / mouse wheel | Only one gun here | [WIKI] |
| camera reset | R3 | none | R3 also zooms a scope in combat | [WIKI] |

The PC version has **mouse acceleration on by default**. A "raw mouse input" toggle came later (patch 1.2) and is off by default. **Recommendation: raw input on in our build**, because an acceleration curve we can't measure would fight the comparison. [WIKI PCGamingWiki, thefpsreview] The PC version has **no FOV slider**. [WIKI]

---

## 2. Locomotion

### Rules

```
moveState ∈ {Idle, Walk, Run, AimWalk, CoverMove, Roll, Crouch(auto)}
stick = input.axis('move'); m = |stick|            // after deadzone
if aim.down:                     moveState = AimWalk   (strafe, body faces camera yaw)
else if m < deadzone:            Idle
else if m < walkThreshold or walk.down:  Walk
else:                            Run
targetSpeed = lerp by state; speed approaches targetSpeed at accel/decel (below)
facing (not aiming): turn body yaw toward the move direction at turnRate; if the angle is > 135° while running, play a plant-turn (runTurn180Time)
autoCrouch = (inTallGrass or (nearLowCover and not inCombatAlert)) and not aim.down
cover.pressed and no cover in range and m > deadzone → Roll in the stick direction (camera-relative)
cover.pressed and no cover in range and m <= deadzone → Roll forward (body facing)
```

- **Abort frames [DEV Y]:** Naughty Dog puts an "abort frame" in almost every player-controlled animation. From that frame on, stick input cancels the rest of the clip and blends into locomotion. Use this for the roll, the cover entry and the reload: input is ignored until `abortT`, then it blends out.
- **Gameplay movement was made more responsive than The Last of Us** [DEV Y]. Keep input-to-motion inside one sim step (design anti-goal).
- **Known repo** (`.plan/aim-walk/map.md`): aiming forces the walk gait, and the previous gait comes back on release. In U4 aiming is also a slow strafe walk, which agrees.
- **Known repo** (`.plan/plain-jump/map.md`): a directional jump snaps body yaw to the stick instantly. It is a useful rule for the roll too: snap the roll direction to the stick on press.

### Parameters

| name | value | unit | source | confidence |
|---|---|---|---|---|
| player.move.deadzone | 0.15 | stick | typical radial deadzone | [INFERRED] |
| player.move.walkThreshold | 0.55 | stick | U4 speed is analog, threshold unknown | [INFERRED] |
| player.walk.speed | 1.6 | m/s | not measured | [INFERRED] |
| player.run.speed | 4.8 | m/s | not measured. Run looks like a jog, not a sprint. **Measure first (protocol P1)** | [INFERRED] |
| player.aimWalk.speed | 1.4 | m/s | aim = walk (Known repo aim-walk) | [INFERRED] |
| player.crouchWalk.speed | 1.5 | m/s | auto-crouch in grass/near low cover | [INFERRED] |
| player.accel | 18 | m/s² | about 0.27 s to full run, snappy | [INFERRED] |
| player.decel | 22 | m/s² | about 0.22 s to stop | [INFERRED] |
| player.turnRate | 720 | °/s | body yaw toward the move direction | [INFERRED] |
| player.runTurn180Time | 0.30 | s | plant-and-turn when reversing at run | [INFERRED] |
| player.sprint | none | – | no sprint | [WIKI] progameguides |
| player.roll.duration | 0.75 | s | dive start to back up in a crouch. F5 0:14.37→0:15.10 at 30 fps (MP character) | [MEASURED, MP] |
| player.roll.controlBackT (abort) | 0.80 | s | first frame of the run-off after the roll, F5 0:15.17 | [MEASURED, MP] |
| player.roll.distance | 2.2 | m | about 2–2.5 m. F5, position against the wall panels, scaled by crouched height ≈1.3 m (about 104 px/m at 640 px) | [MEASURED, MP, low] |
| player.roll.entryPlant | 0.10 | s | lowering/plant before the dive (F5 frames 9→12) | [MEASURED, MP] |
| player.roll.cooldown | 0.15 | s | after controlBack, so mashing isn't a chain-roll | [INFERRED] |
| player.roll.iframes | 0 | s | no evidence of invulnerability | [INFERRED] |

---

## 3. Camera

### Measured framing (F1, PC, 1280×720, 60 fps)

| mode | character height / screen height | character screen x (0 = left) | notes | frames |
|---|---|---|---|---|
| explore (run) | 0.38–0.50 | 0.46–0.50 | head at about 0.44 of height from top, camera above head looking slightly down | F1 0:19.0, 0:20.0, 0:21.0, 0:22.5 |
| cover (low, crouched) | 0.22 (crouched) | 0.55–0.60 | camera further back and lower, shows over the cover | F1 0:08.0, 0:12.40 |
| aim (right shoulder) | head+shoulder fill the right ~22% (x 0.78–1.0), cut off at the screen edge | 0.82 (head) | reticle at (0.50, **0.42**) | F1 0:12.95 |
| aim, swapped | character on the left edge | ~0.1 | the left-shoulder option exists | F5 0:06.5 (MP) |
| grenade aim | same close over-shoulder view as gun aim | – | arc drawn from the hand | F4 0:01.8–0:03.9 (MP) |

**Zoom when aiming.** A far rock grows about 1.47× and a closer barrel about 1.75× from the cover camera to the aim camera (F1 0:12.40 vs 0:12.95, measured in pixels). The difference is dolly parallax. So the aim view is a dolly-in plus an FOV narrowing of about 1.3–1.4×. [MEASURED, low]

### Rules

```
cameraMode ∈ {Explore, Combat, Cover, Aim, GrenadeAim, Reload?}
pivot = player.pos + (0, pivotHeight, 0)
desired = pivot + rot(yaw, pitch) * (shoulderX * side, 0, -distance)     // side = +1 right shoulder, -1 left
fov, distance, shoulderX, pivotHeight blend toward the mode targets with time constant tau(mode)
Aim/GrenadeAim: the reticle ray starts at the camera and passes through screen point (0.5, 0.42).
   Bullets go from the muzzle toward the point that ray hits (camera ray first, then muzzle→point).
Collision: sphere-sweep from pivot to desired (radius camera.collideRadius). On a hit, pull in at once (no smoothing in)
   and ease back out over camera.collideReturnTau.
Cover: offset so the character sits right of centre and the camera stays on the open side of the cover.
   When the cover edge is on the left, flip side.
Damage wobble [DEV G]: on player damage, add a short decaying shake (pitch/yaw noise) so long-range sniping is harder.
Transition cameras [DEV Y]: blend toward a scripted camera by DISTANCE to the interact point, not over time.
   Not needed for this room, but the rule is recorded.
```

### Parameters

| name | value | unit | source | confidence |
|---|---|---|---|---|
| camera.explore.vfov | 50 | ° | no source (PC has no FOV slider, so one fixed value exists; protocol P8) | [INFERRED] |
| camera.explore.distance | 4.5 | m (camera to character) | solved from the framing: d = H / (2·frac·tan(vfov/2)) with H 1.8, frac 0.43, vfov 50. **Tune the distance to hit the framing fraction, not the other way round.** | [MEASURED framing, INFERRED fov] |
| camera.explore.pivotHeight | 1.55 | m | puts the head at about 0.44 of height from top | [INFERRED from framing] |
| camera.explore.shoulderX | 0.15 | m | char at x 0.46–0.50, nearly centred | [MEASURED framing] |
| camera.explore.pitchDefault | -12 | ° | looks slightly down (ground fills the lower half) | [MEASURED framing, low] |
| camera.cover.distance | 5.0 | m | crouched char (≈1.1 m) is 0.22 of the screen height; same formula at vfov 50. The cover camera sits as far back as explore, or further | [MEASURED framing, INFERRED fov] |
| camera.cover.shoulderX | 0.5 | m | char at x 0.55–0.60 | [MEASURED framing] |
| camera.aim.vfov | 37 | ° | about 1.35× narrower than explore | [MEASURED ratio, low] |
| camera.aim.distance | 1.1 | m | head+shoulder fill the right ~22% | [MEASURED framing, INFERRED] |
| camera.aim.shoulderX | 0.55 | m | head at x ≈0.82 | [MEASURED framing] |
| camera.aim.reticleY | 0.42 | screen frac from top | F1 0:12.95 dot at (640,300)/720p; F5 rifle ring at (640,303) | [MEASURED] |
| camera.aim.inTime | 0.14 | s | F1 0:12.583 camera starts moving → 0:12.70 aim framing reached (≈8–9 frames @60) | [MEASURED] |
| camera.aim.outTime (to cover) | 0.17 | s | F1 0:13.783→0:13.93 after a 4-frame hold | [MEASURED] |
| camera.aim.outTime (to explore after grenade) | 0.25 | s | F4 release 0:03.93 → explore framing about 0:04.2 (30 fps) | [MEASURED, MP] |
| camera.follow.tau | 0.12 | s | lag. The char runs a little ahead of centre (F1 0:20 char larger) | [INFERRED] |
| camera.collideRadius | 0.25 | m | – | [INFERRED] |
| camera.collideReturnTau | 0.25 | s | – | [INFERRED] |
| camera.pitch.min / max | -60 / +70 | ° | – | [INFERRED] |
| look.pad.yawRate | 200 | °/s at full stick, explore | – | [INFERRED] |
| look.pad.aimYawRate | 110 | °/s at full stick, aim | – | [INFERRED] |
| look.pad.pitchRate | 0.6 × yaw | – | – | [INFERRED] |
| look.pad.accelDelay | 0.25 | s | full deflection held this long before the rate ramps | [INFERRED] |
| look.pad.accelRamp | 0.35 | s | to 1.6× rate | [INFERRED] |
| look.pad.curve | power 2.0 | – | fine control near centre | [INFERRED] |
| look.mouse.camera / aiming | separate scalars | °/count | two sliders, as on PC | [WIKI] |
| look.mouse.raw | true | bool | our default; PC ships with accel on | [WIKI] + choice |
| camera.damageWobble.amp | 0.6 | ° | exists [DEV G], amplitude unknown | [INFERRED] |
| camera.damageWobble.decay | 0.25 | s | – | [INFERRED] |

---

## 4. Cover

### Evidence

- **Low cover:** crouched behind crates or barrels (F1 0:06–0:18). **High cover:** standing with the back to a pillar and the pistol held up, then stepping out at the corner (F2 0:18.6–0:19.6). [MEASURED]
- **Pop-up aim from low cover:** cover camera → aim in 0.14 s, first shot at +0.22 s (F1 0:12.58→0:12.72/0:12.80). [MEASURED]
- **Empty magazine while popped up:** hold the aim for 4 frames, then Drake **drops back into cover by himself** within 0.17 s and reloads there (F1 0:13.717→0:13.93, full magazine at 0:14.567). [MEASURED]
- **Stealth:** Drake crouches next to low walls while enemies search, without being in hard cover (F1 0:30–0:46). That is the auto-crouch near low cover. [MEASURED, qualitative]
- **Entry:** button (Circle / Left Shift). [WIKI] I could not time a player-triggered entry: in F1 the first cover pose comes out of a cutscene.

### State machine

```
Cover.None
  cover.pressed && findCover(within enterRange, in front/stick dir, angle < enterMaxAngle)
     → Cover.Entering: move along a curve to the snap point (on the cover's surface line, facing away from the wall)
        duration = clamp(dist / enterSpeed, enterMin, enterMax); lock input until abortT then → Cover.In
  autoCover (stealth/combat, moving into low cover at speed > walk, contact within autoRange) → Cover.Entering   [INFERRED]
Cover.In {height: Low|High, side: L|R}
  move stick along the wall → slide along cover at coverMoveSpeed (crouched if Low); stop at edges (no fall-off)
  at an edge pushing outward → Cover.Edge (peek pose); pushing on → leave cover around the corner
  aim.down → Cover.PopAim: Low = stand up over the top; High = lean out at the nearest edge (must be at an edge)
       camera → Aim over the shoulder on the open side (auto-flip side at a left edge)
  aim.released → back to Cover.In (camera out 0.17 s)
  fire.pressed && !aim.down → BlindFire: gun over the top / around the edge, body stays hidden, wide spread
  magazine empty while PopAim → hold 4 frames → Cover.In → auto-reload
  grenade.down → Cover.GrenadeAim (pop up/lean, arc shown) → release → throw → Cover.In
  cover.pressed (no stick)        → leave cover (stand/step back)
  cover.pressed + stick away      → Roll away from cover
  stick away from wall for > leaveHoldTime → leave cover
  jump.pressed on Low cover with stick into the wall → vault over (out of scope for v1; climb-spec)
Cover-to-cover: no dedicated swap button in U4. Leave and run (or roll) to the next cover, then press cover.   [INFERRED]
```

### Parameters

| name | value | unit | source | confidence |
|---|---|---|---|---|
| cover.enterRange | 2.0 | m | – | [INFERRED] |
| cover.enterMaxAngle | 60 | ° | between the stick/facing and the wall normal | [INFERRED] |
| cover.enterSpeed | 6.0 | m/s | a quick slide-in | [INFERRED] |
| cover.enterMin / enterMax | 0.20 / 0.45 | s | – | [INFERRED] |
| cover.autoRange | 0.6 | m | soft auto-cover when brushing low cover | [INFERRED] |
| cover.lowHeight | 0.6–1.2 | m | crouch-cover band; above 1.2 = High | [INFERRED] |
| cover.moveSpeed | 1.8 | m/s | crouched slide along low cover | [INFERRED] |
| cover.popAim.inTime | 0.14 | s | F1 0:12.583→0:12.70 | [MEASURED] |
| cover.popAim.fireReadyT | 0.13 | s | earliest shot after the aim press; the first observed shot came 0.22 s after the camera moved | [MEASURED upper bound] |
| cover.popAim.outTime | 0.17 | s | F1 0:13.783→0:13.93 | [MEASURED] |
| cover.popAim.emptyHold | 0.067 | s | 4 frames @60 before the auto-duck | [MEASURED] |
| cover.blindFire.spreadDeg | 8 | ° | – | [INFERRED] |
| cover.leaveHoldTime | 0.25 | s | – | [INFERRED] |
| cover.exposedWhenPopped | head+chest | – | AI sees the head-top point in combat (ai-spec) | [DEV via ai-spec] |

---

## 5. Pistol (the standard .45 sidearm)

### Evidence

- **Magazine 12, total carried 60.** In the HUD (F1 0:06–0:18), the tick bar is the magazine and the number is **total rounds including the magazine**. 12 shots took the number from 40 to 28 and emptied the bar. The reload refilled the bar and the number stayed at 28. Picking up ammo took it from 26 to 59, then 60 at the cap (F1 0:21–0:25). [MEASURED] This agrees with Prima's 12-round magazine and the wiki's cap of 60. [WIKI] (The wiki infobox's "mag 7" is the real gun's capacity, not the game value.)
- **Fastest fire rate:** muzzle-flash onsets at F1 0:13.317, 0:13.517, 0:13.717, and the HUD shows the same 12-frame spacing back to 0:12.717. That is five straight intervals of exactly 12 frames at 60 fps = **0.200 s**. The player was clearly mashing, so this is the cap. [MEASURED]
- **Reload:** last shot 0:13.717 → magazine bar full 0:14.567 = **0.85 s**, including the duck back into cover (F1). [MEASURED] I could not see whether a tactical reload (rounds left) is faster.
- **First shot centred:** Naughty Dog had a minimum deviation on the first pistol shot. Playtesters felt guns were sloppy and switched to melee, so ND made the first shot hit the reticle centre every time. That makes long-range "chipping" with a pistol from about 50 m effective. [DEV G 46:27–47:13, Q&A 50:10–50:59]
- **Hit reactions are animations, not physics.** Ragdoll is only used for deaths. [DEV M Q&A 53:15]
- **Shots to kill:** one basic enemy went down after about 4 body hits (F1 0:12.72–0:13.32 hits, falls at about 0:13.45). The difficulty is unknown. [MEASURED, low] The wiki says that in U4 the player's health and damage don't change with difficulty. [WIKI, low] For comparison, the UC2 pistol did 34 to a 100-HP light enemy (3 shots, see ai-spec).
- **Recoil:** phase correlation of a background patch (F1 0:12.85–0:13.80, 512×256 px top-left region). Each shot adds a **+4–5 px (720p) vertical image shift that peaks about 50 ms after the shot and is gone within about 0.1 s**, with no visible net climb. At aim vfov 37° that is about 0.2–0.25° of pitch. [MEASURED]
- **Hit marker:** four diagonal ticks (an "X") around the dot, on for about 0.3 s per hit, shrinking as it fades (F1 0:12.73–0:13.40 at 30 fps samples). [MEASURED]
- **Ammo pickup** happens automatically when Drake runs over a dropped weapon of the same ammo type (F1 about 0:21.5, number 26→59 while running). [MEASURED]

### Rules

```
weaponState ∈ {Ready, Firing(cooldown), Reloading, Holstered}
fire.pressed && Ready && mag > 0 && t - lastShot >= fireInterval:
    dir = aim.down ? reticleRay : hipRay
    spread = aim.down ? (shotsInBurst == 0 ? 0 : min(aimBloomMax, aimBase + bloom)) : hipSpread (+ moving penalty)
    if aim.down and (t - lastShot) > firstShotResetT: spread = 0          // first-shot-centred rule [DEV G]
    ray = cone(dir, spread); hit → damage(part); emit 'shot'
    bloom += bloomPerShot; camera kick (pitch up recoilKick, settle over recoilRecover)
    mag -= 1; if mag == 0 → auto-reload (if in PopAim: hold emptyHold, return to Cover.In first)
bloom decays at bloomDecay per s
reload.pressed && mag < magSize && reserve > 0 → Reloading for reloadTime (abort frame: sprint/roll cancels and the magazine is NOT refilled)
   refill happens at reloadCommitT (the HUD bar fills at that moment)
headshot = instant kill on non-armoured enemies   [INFERRED, series convention]
fire pressed during Reloading/Entering: buffer for inputBuffer s
```

### Parameters

| name | value | unit | source | confidence |
|---|---|---|---|---|
| pistol.magSize | 12 | rounds | F1 HUD 40→28 over 12 shots; Prima | [MEASURED] [WIKI] |
| pistol.maxTotal | 60 | rounds (incl. mag) | F1 HUD cap 60; wiki cap 60 | [MEASURED] [WIKI] |
| pistol.startTotal | 40 | rounds | F1 start of fight (one data point) | [MEASURED, low] |
| pistol.fireInterval | 0.200 | s | F1, 5 × 12 frames @60 | [MEASURED] |
| pistol.reloadTime (empty) | 0.85 | s | F1 last shot → bar full | [MEASURED] |
| pistol.reloadCommitT | 0.80 | s | bar fills near the end | [INFERRED] |
| pistol.reloadTime (tactical) | 0.85 | s | no data; same as empty | [INFERRED] |
| pistol.autoReloadOnEmpty | true | – | F1 | [MEASURED] |
| pistol.damage.body | 28 | HP (enemy 100) | about 4 body shots to kill (F1); UC2 used 34 | [MEASURED low] / [INFERRED] |
| pistol.damage.headMult | ×4 (≥ 100) | – | one-shot headshot | [INFERRED] |
| pistol.damage.limbMult | 0.75 | – | – | [INFERRED] |
| pistol.falloff | none to 50 m | – | ND: pistol kills at ~50 m | [DEV G] |
| pistol.maxRange | 80 | m | – | [INFERRED] |
| pistol.aim.firstShotSpread | 0 | ° | first shot dead centre | [DEV G] |
| pistol.aim.firstShotResetT | 0.35 | s | gap after which the next shot counts as "first" again | [INFERRED] |
| pistol.aim.bloomPerShot | 0.35 | ° | – | [INFERRED] |
| pistol.aim.bloomMax | 1.5 | ° | – | [INFERRED] |
| pistol.aim.bloomDecay | 4 | °/s | – | [INFERRED] |
| pistol.hip.spread | 3.5 | ° (cone half-angle) | hip/blind fire is visibly worse | [INFERRED] |
| pistol.hip.movePenalty | +1.5 | ° when running | – | [INFERRED] |
| pistol.recoil.kickPitch | 0.22 | ° | F1 phase correlation, 4–5 px @720p, vfov 37 | [MEASURED] |
| pistol.recoil.kickPeakT | 0.05 | s | F1 | [MEASURED] |
| pistol.recoil.recoverT | 0.10 | s | F1, back to baseline, no net climb | [MEASURED] |
| pistol.recoil.yawJitter | ±0.05 | ° | none visible | [INFERRED] |
| pistol.inputBuffer | 0.10 | s | – | [INFERRED] |
| aimAssist.strength | 5 (0–10 slider) | – | U4 has a 0–10 aim-assist slider | [WIKI] |
| aimAssist.slowdown | 0.55 × look rate | – | when the reticle is within slowdownAngle of an enemy (pad only) | [INFERRED] |
| aimAssist.slowdownAngle | 3.0 | ° | – | [INFERRED] |
| aimAssist.lockOn | off | bool | accessibility option: aim press snaps to the nearest enemy | [WIKI] FGDB |
| hitReact.enemy.flinch | anim, 0.25 s | s | animated flinch, no physics | [DEV M] / [INFERRED duration] |
| hitMarker.duration | 0.30 | s | F1 | [MEASURED] |

---

## 6. Grenades

### Evidence

- **Capacity 4** in every Uncharted game. A thrown grenade gives off a red glow so you can track it. [WIKI Mk-NDI]
- **Hold R1 to show the trajectory, release to throw.** [WIKI twinfinite, gamerguides]
- **Aim camera:** the same close over-shoulder view as gun aim (F4 0:01.8–0:03.9). **Arc look:** a thin white line coming from above (the apex is off the top of the screen on a long lob) down to a **small ring marker at the landing point** about 8 px across at 720p. The view looks along the throw, so the arc reads almost as a vertical line. The line disappears on the release frame (F4 0:03.93). [MEASURED, MP]
- **Fuse (MP):** grenades can't be cooked; the countdown starts on first contact and lasts 3 s, with beeping that speeds up. [WIKI] Release → kill popup took 2.47 s (F4 0:03.93→0:06.40) and about 3.8 s (F5 about 0:10.0→0:13.8). That's consistent with flight plus a contact fuse. [MEASURED, MP]
- **Enemies flee grenades,** though not all of them, and grenades also flush them out of cover. [WIKI]
- **Known repo** (`docs/design/grenade-arc-tuning.md`): distance follows camera pitch, mapped across a pitch band through an S-curve; launch is yaw-only. The key lesson is that **the preview line and the real throw must come from one launch velocity**. The kit re-solved the velocity and scaled the impulse, so the line lied. Max's project also slowed the camera while the arc is up and smoothed the power value. We take the lessons, not the code.

### Rules

```
grenadeState ∈ {None, Aiming, Throwing, Cooldown}
grenade.pressed && count > 0 && !Reloading → Aiming (camera → Aim mode, side as current shoulder; in cover → pop/lean)
Aiming each step:
    target = camera ray through reticle (0.5, 0.42) → first hit, else point at maxRange; clamp horizontal range to [minRange, maxRange]
    v0 = solveLob(handPos, target, apexRule)           // ONE velocity; the preview and the throw both use it
    preview = integrate(handPos, v0, g, dt=1/30) until hit (sphere sweep r=grenade.radius) or tMax
    draw thin white line + landing ring at the first hit; if the first hit is a wall, the ring sits on the wall
    look sensitivity × grenade.aimLookScale
grenade.released → Throwing: release object at throwReleaseT, velocity v0 (+ player velocity × inheritVel); count -= 1
cover.pressed during Aiming → cancel (no throw)
Projectile: gravity, sphere sweep, bounce: v' = reflect(v)·restitution (normal) and ×friction (tangent); roll when |v_n| < 0.5 m/s
    fuse starts at FIRST contact (fuseStartsOn = 'contact'); beep rate rises; red glow light on the grenade
Explode: damage = maxDamage × falloff(dist / radius); LOS check from the blast centre (raycast to hitbox centre, ignore actors) 
    emit 'grenade:explode' and 'noise'; camera shake by distance
```

### Parameters

| name | value | unit | source | confidence |
|---|---|---|---|---|
| grenade.maxCarry | 4 | – | wiki, all games | [WIKI] |
| grenade.startCount | 2 | – | – | [INFERRED] |
| grenade.fuseStartsOn | contact | – | MP; no cooking | [WIKI, MP] |
| grenade.fuse | 2.0 | s after first contact | MP is 3 s [WIKI]. Single player feels quicker but is unmeasured. **Protocol P4** | [INFERRED] |
| grenade.cookable | false | – | MP | [WIKI] |
| grenade.minRange / maxRange | 3 / 25 | m | – | [INFERRED] |
| grenade.apexRule | apex = 1.5 m + 0.25 × range above the hand | m | high lob; in F4 the arc runs off the top of the frame | [MEASURED shape, INFERRED values] |
| grenade.gravity | 9.81 | m/s² | – | [INFERRED] |
| grenade.radius | 0.06 | m | – | [INFERRED] |
| grenade.restitution | 0.35 | – | – | [INFERRED] |
| grenade.friction | 0.6 | – | tangent keep per bounce | [INFERRED] |
| grenade.throwReleaseT | 0.25 | s after release press | – | [INFERRED] |
| grenade.inheritVel | 0.3 | – | – | [INFERRED] |
| grenade.blast.killRadius | 3.0 | m | full damage | [INFERRED] |
| grenade.blast.radius | 6.0 | m | damage → 0, linear falloff from killRadius | [INFERRED] |
| grenade.blast.maxDamage | 150 | HP | – | [INFERRED] |
| grenade.blast.playerDamageScale | 0.6 | – | self-damage, survivable at the radius edge | [INFERRED] |
| grenade.aimLookScale | 0.6 | – | Known repo used 0.6 (also an assumption there) | [INFERRED] |
| grenade.preview.color | white, 1–2 px line + ring Ø ≈ 0.011 screen h | – | F4 | [MEASURED, MP] |
| grenade.preview.fadeOut | on the release frame | – | F4 0:03.93 | [MEASURED, MP] |
| grenade.fromCover | allowed (pop/lean like aim) | – | not directly seen | [INFERRED] |

---

## 7. Player health ("luck")

### Evidence

- No health bar. The red streaks and colour loss show **luck running out**, not wounds. When the luck is gone, Drake dies. [DEV Jonathan Cooper via Pushsquare; Hennig confirmed]
- F1: the red streaks drip down from the **top edge** while the player trades fire with enemies in front (they first appear at 0:11.0, stay during the pop-ups, fade from about 0:15 and are gone by 0:16.0). The last possible hit is at ≤ 0:13.7, so recovery takes about **2.3 s** from the last hit. Colour is visibly washed out from 0:14.5 to 0:16. [MEASURED, 2 fps samples, low]
- MP F6/F7: at low health the image goes almost fully **greyscale**, and the red splash sits at the edge or corner facing the shooter (top-left in rx_w0spNi00 0:12–0:20). So the edge streak points toward the damage. [MEASURED, MP]
- F2 (PS5, Crushing): heavy desaturation plus darkening near death (0:21–0:24). [MEASURED]
- ND added **camera damage wobble** to discourage long-range sniping. [DEV G]

### Rules

```
hp ∈ [0, maxHp]; lastHitT
onDamage(a, dir): hp -= a × difficultyTakenMult; lastHitT = t; wobble(); edgeStreak(dir → screen edge, intensity ∝ a)
if t - lastHitT > regenDelay: hp += regenRate × dt
luck = hp / maxHp
post: saturation = lerp(minSat, 1, smoothstep(0, satKnee, luck)); vignette = (1 - luck) × vignetteMax
streaks: spawn on hit at the edge facing the source (top = in front), drip in streakIn, hold while luck < streakHoldLuck, fade over streakFade
hp <= 0 → Death: play death clip (or ragdoll fallback, [DEV M] ragdoll only for deaths) → fade to black deathFade → respawn at the encounter checkpoint
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| player.maxHp | 100 | HP | – | [INFERRED] |
| enemy pistol hit on player | 10 | HP | about 10 hits from full (enemy accuracy is ramped by the AI) | [INFERRED] |
| enemy rifle hit on player | 7 | HP / bullet | – | [INFERRED] |
| player.regenDelay | 1.5 | s | F1 recovery ≈2.3 s after the last hit, total | [MEASURED low → split INFERRED] |
| player.regenRate | 120 | HP/s (full in ~0.8 s) | as above | [INFERRED] |
| fx.damage.minSat | 0.05 | – | near-greyscale at low luck (F6/F7) | [MEASURED, MP] |
| fx.damage.satKnee | 0.7 | luck | colour loss starts below this | [INFERRED] |
| fx.damage.vignetteMax | 0.45 | – | F2 darkening | [MEASURED qualitative] |
| fx.damage.streakIn | 0.15 | s | – | [INFERRED] |
| fx.damage.streakFade | 1.0 | s | F1 streaks fade from about 0:15→0:16 | [MEASURED low] |
| fx.damage.streakColor | dark red, dripping, ragged | – | F1, F3, F6 | [MEASURED] |
| player.deathFade | 1.5 | s | – | [INFERRED] |
| difficulty | Moderate (default of 5: Explorer, Light, Moderate, Hard, Crushing) | – | U4 difficulties | [WIKI] |

---

## 8. HUD

### Evidence (F1, single player, PC)

- **Weapon panel, bottom-left:** weapon silhouette icon (x 0.10–0.17, y 0.81–0.88 of a 720p screen), then a row of **bullet ticks, one per round in the magazine** (x 0.15–0.21, y 0.87), then the **total rounds number** (x 0.23). Fired rounds go dim instead of disappearing (F1 0:09–0:13: dim ticks remain). [MEASURED]
- In MP a grenade icon (orange circle) with a count sits to the right of the ammo number (F4, F5). F1 (single player) shows no grenade icon. My guess is that it appears only while you carry grenades. [MEASURED, MP] / [INFERRED]
- **The HUD fades in when combat starts:** 0.2–0.3 s at the cutscene→gameplay cut (F1 0:06.1–0:06.4). It stays up through the fight and the stealth section that follows. [MEASURED]
- **Reticle:** a dot only while aiming (pistol). The rifle reticle is a ring of 4 arc ticks (F5). With no aim, there is no reticle (F1 explore frames). PS5 has a "persistent dot reticle" accessibility option. [MEASURED] [WIKI FGDB]
- **Hit marker:** a 4-tick X, see §5. **Damage direction:** the edge streaks in §7. U4 has no separate damage-direction arrow. [MEASURED]
- **Pickup prompt:** a small icon over dropped weapons/ammo (F1 0:21). [MEASURED]

### Rules and parameters

```
hud.visible = inCombatEncounter || aim.down || reloading || ammoChangedRecently(hud.pickupShowT)
fade in hud.fadeIn; when no longer visible, wait hud.hideDelay then fade out hud.fadeOut
reticle shown only while aim.down (or grenade aim → arc instead of the dot) unless the persistentDot option is on
```

| name | value | unit | source | confidence |
|---|---|---|---|---|
| hud.fadeIn | 0.25 | s | F1 0:06.1–0:06.4 | [MEASURED] |
| hud.hideDelay | 4.0 | s after combat ends | not observed | [INFERRED] |
| hud.fadeOut | 0.5 | s | – | [INFERRED] |
| hud.pickupShowT | 3.0 | s | – | [INFERRED] |
| hud.panel.anchor | bottom-left, x 0.10, y 0.85 | screen frac | F1 | [MEASURED] |
| hud.ammo.tickPerRound | true; spent = 25% alpha | – | F1 | [MEASURED] |
| hud.ammo.number | total rounds incl. magazine | – | F1 | [MEASURED] |
| hud.reticle.pistol | dot Ø ≈ 6 px @720p, white with dark outline | – | F1 zoom | [MEASURED] |
| hud.reticle.y | 0.42 | screen frac from top | F1, F5 | [MEASURED] |
| hud.hitMarker | 4 diagonal ticks, ~22 px span @720p, 0.30 s | – | F1 | [MEASURED] |
| hud.reticle.bloomVisual | the ring expands with bloom (pistol: none visible) | – | – | [INFERRED] |
| hud.persistentDot | false (option) | – | PS5 accessibility | [WIKI] |

The HUD art must be our own: shapes and layout only, no game icons.

---

## Open questions

1. **Run and walk speed (biggest gap).** Not measurable from the clips I got, and not published anywhere. It shapes the feel of everything.
2. **Single-player grenade fuse, throw speed, blast radius.** Only MP numbers exist (3 s fuse on contact). The radius and damage falloff are pure inference.
3. **Cover entry snap time and range.** No player-triggered entry is in the footage. Whether U4 auto-enters soft cover without the button is also unconfirmed.
4. **Roll in single player.** The roll was timed on an MP character (0.75 s, about 2.2 m). The single-player Drake roll probably matches, but that's unverified.
5. **Absolute FOV.** Only framing fractions and the explore/aim ratio were measured. PC has no FOV slider, so one 16:9 value exists. It could be measured from a known-geometry scene (a door of known width at known distance).
6. **Player damage per enemy hit** and **enemy shots to kill** on Moderate. F1's difficulty is unknown. The wiki claims U4 health doesn't scale with difficulty (low trust).
7. **Tactical vs empty reload time**, and whether a sprint/roll cancels a reload.
8. **Hip fire.** Its spread and its reticle (none?) were not observed.
9. **Look rates and acceleration on pad.** No source. Only measurable with a stick-input overlay video.
10. **HUD hide timing** after combat.
11. Both talks were not captioned this session: "Authored vs. Systemic" came from the Known repo transcript. The 2012 Lemarchand playtesting talk turned out to be about attention, not controls, so it was skipped.

## Measurement protocol (for Max to capture by hand)

Capture at **60 fps** (Legacy of Thieves on PS5/PC), ideally your own play with the HUD on and **Moderate** difficulty. Step through in a frame-accurate player (or `ffmpeg -vf "select=..."` into tiles). Use a standing character ≈ 1.8 m tall for scale.

| # | What | Where (suggested) | How to time | Gives |
|---|---|---|---|---|
| P1 | Run/walk speed | any flat courtyard with floor tiles or a repeating wall panel; run straight away from the camera, then across | count frames to cross N panels; panel width from the character's standing height in px at the same depth | player.run.speed, walk.speed, accel (frames from stick push to steady speed) |
| P2 | Cover entry | press Circle from 1, 2 and 3 m away, square-on and at 45° | press frame (use a controller overlay or a known sound cue) → pose settled | cover.enterRange, enterSpeed, min/max |
| P3 | Roll (single player) | open floor, roll forward and sideways | first dive frame → stand/run frame; distance against floor tiles | roll.duration, distance, controlBackT |
| P4 | Grenade | throw at flat ground at 5, 10 and 20 m (range from known geometry) | release frame → first bounce → explosion flash | fuse (from first contact), flight time → launch speed and apex |
| P5 | Blast radius | grenade next to 2–3 enemies at different distances (or MP private match with a friend) | who dies or flinches vs distance | killRadius, radius |
| P6 | Tactical reload | reload with 6 rounds left, then with 0 | press → bar refill frame | reloadTime (tactical vs empty) |
| P7 | Hip fire | fire without aiming at a wall from 10 m, 10 shots | spread of bullet decals in px → degrees | hip.spread |
| P8 | FOV | stand a known distance from a known-width door (measure by character width) in explore and aim | angular width = 2·atan(w/2d) vs its px share of the screen | camera.explore.vfov, aim.vfov |
| P9 | Damage taken | stand in the open against one rifle enemy on Moderate | count hits (each hit plays a flinch + streak) until death | enemy hit damage vs maxHp |
| P10 | Regen | take 2–3 hits, then hide | last hit → colour fully back | regenDelay + regenRate |

Already measured (from YouTube clips, not needed again unless re-checking): pistol fire interval, magazine/total ammo, empty reload, aim-in/out camera times, reticle position, recoil kick, hit marker.

## Sources

**Naughty Dog talks / statements**
- **G**: Matthew Gallant, "Authored vs. Systemic: Finding a Balance for Combat AI in Uncharted 4", GDC 2017. https://www.youtube.com/watch?v=G8W7EQKBgcg. Transcript read from Known repo: `docs/reference/uncharted4-combat-ai/transcript.md` (46:27–47:13 pistol at 50 m, damage wobble, accuracy floor; Q&A 49:59–50:59 first shot centred; 43:54 accuracy ramp).
- **Y**: Jeremy Yates and Almudena Soria, "Animation Bootcamp: Animating Uncharted 4: Workflow and Prototyping", GDC 2017. Reupload https://www.youtube.com/watch?v=fQnUTmOu3lc (auto-captions: abort frames ~20:00–21:20; transition cameras blended by distance ~18:08–19:20; responsiveness vs TLOU ~39:20; entry system ~39:00–42:30).
- **M**: Michal Mach, "Physics Animation in Uncharted 4: A Thief's End", GDC 2017. https://www.youtube.com/watch?v=7S-_vuoKgR4 (Q&A 53:15: ragdoll for deaths only, hit reactions animated).
- Naughty Dog GDC 2017 talk list: https://naughtydog.com/blog/naughty_dog_gdc_2017
- Jonathan Cooper on luck vs health: https://pushsquare.com/news/2018/07/nathan_drakes_regenerative_health_was_actually_his_luck_running_out

**Controls / settings**
- PS4 map: https://www.gamerguides.com/uncharted-4-a-thiefs-end/guide/introduction/gameplay/controls
- PC KB/M defaults: https://www.magicgameworld.com/?p=127939
- No run button: https://progameguides.com/uncharted/how-to-run-in-uncharted-4
- Accessibility (lock-on, hold/toggle, persistent dot): https://www.familygamingdatabase.com/accessibility/Uncharted+4+A+Thiefs+End
- PC settings (raw input patch, camera/aiming sensitivity, no FOV slider): PCGamingWiki "Uncharted: Legacy of Thieves Collection" (via MediaWiki API); https://www.thefpsreview.com/2022/10/21/uncharted-legacy-of-thieves-collection-players-complain-of-forced-mouse-acceleration-lack-of-fov-slider-cpu-compatibility-issues-and-more-on-pc/
- Grenade hold-R1 trajectory: https://twinfinite.net/guides/uncharted-4-how-to-use-grenades-and-dynamite/ (search snippet)

**Wikis**
- Para .45 (standard pistol, cap 60): https://uncharted.fandom.com/wiki/Para_.45
- Mk-NDI grenade (cap 4, red glow, MP fuse 3 s on contact, no cooking): https://uncharted.fandom.com/wiki/Mk-NDI
- Difficulty (5 levels; health and damage the same across U4 difficulties): https://uncharted.fandom.com/wiki/Difficulty
- A Thief's End multiplayer weapon table: https://uncharted.fandom.com/wiki/A_Thief%27s_End_multiplayer
- Prima eGuide weapons (12-round pistol magazine; seen via a search snippet only): https://primagames.com/eguides/uncharted-4-a-thiefs-end-eguide/basics/weapons

**Footage** (downloads and frames in `refs/frames/research-player/`, git-ignored)
- **F1** "Uncharted 4: A Thief's End - COMBAT Gameplay (Ch. 8) | PC Legacy of Thieves Collection", 720p60, first 46 s (0:00–0:46): https://www.youtube.com/watch?v=He9W0zR0jCQ
- **F2** "Uncharted 4 Ballroom NO HUD CRUSHING Legacy of Thieves PS5", 720p60, first 36 s: https://www.youtube.com/watch?v=C1BWciOtQfk
- **F3** "Uncharted 4: Shooting The Enemy", 720p30, first 39 s (one-handed aim while hanging): https://www.youtube.com/watch?v=pbDVjVZc4e8
- **F4** "Uncharted 4 - The art of estimating a grenade arc" (MP), 720p30, 15 s: https://www.youtube.com/watch?v=MbWU47P1y3U
- **F5** "Uncharted 4 Grenade Throw" (MP), 720p30, 20 s (rifle reticle, left-shoulder aim, roll 0:14.0–0:15.4): https://www.youtube.com/watch?v=aEfFs-k13Jo
- **F6** "Uncharted 4: How to toss a grenade" (MP), 27 s (greyscale at low health): https://www.youtube.com/watch?v=1RxmH6zO6DQ
- **F7** "Uncharted 4: A Thief's End amazing grenade throw" (MP), 23 s (directional red edge): https://www.youtube.com/watch?v=rx_w0spNi00

**Frame methods.** Frames come from ffmpeg at native fps (`-ss`, `tile`), and the timestamps are clip-relative. Fire interval: muzzle-flash onset frames at 60 fps, cross-checked against per-frame changes in the HUD ammo bar. Recoil: phase correlation (numpy FFT) of a 512×256 background patch, per frame. Framing: pixel extents of the character in 1280×720 frames. Roll distance: displacement against wall panels, scaled by the character's crouched pixel height.

**Known repo** (private, paraphrased): `docs/design/grenade-arc-tuning.md`, `.plan/grenade-arc/map.md`, `.plan/grenade-single/map.md`, `.plan/aim-walk/map.md`, `.plan/plain-jump/map.md`, `.plan/roll-air-pop/map.md`, `.plan/player-death/map.md`, `docs/reference/uncharted4-combat-ai/transcript.md`.
