// AI tuning: every enemy-AI feel number as a game.params entry under `ai.*`, each with its source from refs/ai-spec.md.
// Tags: [DEV] stated by Naughty Dog, [MEASURED] read off talk slides, [WIKI] guide/community, [INFERRED] the spec's
// recommended default where no source exists, [ASSUMED] my call (geometry / budget), not in the spec.
// Curves are string params "x:y, x:y, ..." (piecewise linear, clamped at the ends) so they stay editable in the panel.
// No 'three' import: node unit tests load this file.

const n = (min, max, step, label) => ({ min, max, step, label });

// [key, default, panel options]   source in the trailing comment
export const AI_PARAMS = [
  ['ai.enabled',               true,  { label: 'AI on' }],                                   // [ASSUMED] debug switch
  ['ai.count',                 3,     n(0, 6, 1, 'enemies')],                                 // design.md "3 enemies (param)"
  ['ai.debug',                 false, { label: 'debug overlay (F2)' }],                       // [ASSUMED]
  // budget (browser): stagger the expensive queries
  ['ai.budget.visionEvery',    2,     n(1, 6, 1, 'vision ray every N steps')],                // [ASSUMED] 30 Hz vision raycast per NPC
  ['ai.budget.postRays',       24,    n(4, 160, 4, 'post rays per step')],                    // [ASSUMED] spec: 160 rays/frame on PS (M p.424)
  ['ai.budget.fields',         1,     n(1, 6, 1, 'path fields per step')],                    // [ASSUMED] Dijkstra fields per step
  ['ai.budget.fireLosEvery',   0.1,   n(0.02, 0.5, 0.02, 'fire-LOS check (s)')],              // [ASSUMED]
  ['ai.budget.vantageRays',    64,    n(8, 256, 8, 'vantage rays per step')],                 // [ASSUMED] browser budget for refs/ai-vantage.md

  // §1.1 vision
  ['ai.vision.K',              300,   n(50, 900, 10, 'cone K (deg·m)')],                      // [INFERRED] halfAngle = K/d (law [DEV] M p.421)
  ['ai.vision.halfMax',        90,    n(10, 180, 1, 'half angle max (deg)')],                 // [INFERRED]
  ['ai.vision.halfMin',        25,    n(5, 90, 1, 'half angle min (deg)')],                   // [INFERRED]
  ['ai.vision.halfV',          40,    n(5, 90, 1, 'vertical half (deg)')],                    // [INFERRED]
  ['ai.vision.combatConeMul',  1.5,   n(1, 3, 0.05, 'combat cone ×')],                        // [INFERRED] value, [DEV] direction (R)
  ['ai.vision.rangeUnaware',   30,    n(5, 80, 1, 'range unaware (m)')],                      // [INFERRED]
  ['ai.vision.rangeCombat',    60,    n(5, 120, 1, 'range combat (m)')],                      // [INFERRED] (R: accuracy 0% at 60 m)
  ['ai.vision.coverRange',     18,    n(2, 60, 1, 'player in cover seen within (m)')],        // [WIKI] P, "seen behind cover up to 18 m"
  ['ai.vision.eye',            1.6,   n(1, 2, 0.01, 'NPC eye height (m)')],                   // [ASSUMED] 1.8 m actor
  ['ai.vision.chest',          1.3,   n(0.5, 1.8, 0.01, 'test point stealth: chest (m)')],    // [DEV] chest centre (M p.423); height [ASSUMED]
  ['ai.vision.headTop',        1.75,  n(0.5, 2, 0.01, 'test point combat: head top (m)')],    // [DEV] top of head (M p.423); height [ASSUMED]
  ['ai.vision.crouchChest',    0.7,   n(0.3, 1.5, 0.01, 'crouched chest (m)')],               // [ASSUMED] crouched behind low cover
  ['ai.vision.crouchHeadTop',  0.95,  n(0.3, 1.8, 0.01, 'crouched head top (m)')],            // [ASSUMED] just under a 1.0 m low wall

  // §1.2 notice meter (0..1 white, 1..2 yellow, 2 = orange)
  ['ai.notice.acqNear',        0.5,   n(0.05, 5, 0.05, 'white fill near (s)')],               // [INFERRED] anchored to M's 1–2 s
  ['ai.notice.acqFar',         3.0,   n(0.1, 10, 0.05, 'white fill at range (s)')],           // [INFERRED]
  ['ai.notice.confirmNear',    0.3,   n(0.05, 5, 0.05, 'yellow fill near (s)')],              // [INFERRED]
  ['ai.notice.confirmFar',     1.5,   n(0.05, 5, 0.05, 'yellow fill at range (s)')],          // [INFERRED]
  ['ai.notice.neverSeenMul',   1.5,   n(1, 4, 0.05, 'never-seen ×')],                         // [INFERRED] value, [DEV] "much higher" (M p.422)
  ['ai.notice.combatReacquire', 0.2,  n(0, 2, 0.05, 'combat re-acquire (s)')],                // [INFERRED] value, [DEV] "much lower" (M p.422)
  ['ai.notice.decay',          1.0,   n(0.05, 5, 0.05, 'decay (units/s)')],                   // [INFERRED] (M: timer simply decrements)
  ['ai.notice.instantRange',   2.5,   n(0, 10, 0.1, 'point-blank range (m)')],                // [INFERRED]
  ['ai.notice.instantTime',    0.3,   n(0.05, 2, 0.05, 'point-blank to orange (s)')],         // [INFERRED]
  ['ai.notice.searchMul',      0.6,   n(0.1, 2, 0.05, 'search re-spot ×')],                   // [INFERRED] (C: aggressive searchers spot better)
  ['ai.notice.difficultyMul',  1.0,   n(0.3, 2, 0.05, 'acquire-time × (difficulty)')],        // [INFERRED] spec §9 Moderate

  // §1.3 hearing
  ['ai.hearing.mul',           1.0,   n(0, 6, 0.1, 'hearing ×')],                             // [DEV] human : Infected = 1 : 6 (B)
  ['ai.hearing.unawareMul',    0.75,  n(0, 1, 0.05, 'unaware hearing ×')],                    // [INFERRED] value, [DEV] "weaker when unaware" (B)
  ['ai.hearing.occlusion',     0.5,   n(0, 1, 0.05, 'occluded radius ×')],                    // [INFERRED] value, [DEV] "partially occluded" (B)
  ['ai.hearing.combatRadius',  15,    n(0, 60, 1, 'gunshot → combat within (m)')],            // [INFERRED] spec §1.3 "inside the combat radius"

  // §2 alert states, investigate, search
  ['ai.search.snuckAway',      8.0,   n(1, 30, 0.5, 'snuck-away distance (m)')],              // [DEV] G-deck p114 snuck-away-distance
  ['ai.search.lkpTimeout',     10,    n(1, 60, 0.5, 'no-sight LKP check (s)')],               // [DEV] (TLOU) M p.423
  ['ai.search.pursueOnTimeout', true, { label: 'allow pursue on timeout' }],                  // [DEV] G-deck p114
  ['ai.search.lkpArrive',      1.5,   n(0.3, 5, 0.1, 'LKP reached within (m)')],              // [ASSUMED]
  ['ai.search.splineCap',      2,     n(1, 6, 1, 'searchers per loop')],                      // [INFERRED] cap exists (G 39:21)
  ['ai.search.loopInset',      3.0,   n(1, 8, 0.5, 'perimeter loop inset (m)')],              // [INFERRED] spec: 2 loops (perimeter + centre)
  ['ai.search.loopStep',       4.0,   n(1, 8, 0.5, 'loop point spacing (m)')],                // [ASSUMED]
  ['ai.investigate.lookAround', 5,    n(1, 15, 0.5, 'look-around (s)')],                      // [INFERRED] 4–6 s
  ['ai.investigate.staggerMin', 0.3,  n(0, 2, 0.05, 'pair stagger min (s)')],                 // [INFERRED] 0.3–0.8 (C: staggered)
  ['ai.investigate.staggerMax', 0.8,  n(0, 3, 0.05, 'pair stagger max (s)')],                 // [INFERRED]
  ['ai.investigate.recruitRange', 12, n(0, 40, 1, 'recruit ally within (m)')],                // [ASSUMED] C: "a nearby ally"
  ['ai.investigate.standOff',  3,     n(0.5, 8, 0.5, 'stop short of stimulus (m)')],          // [INFERRED] investigate selector 2–4 m best

  // §3 posts and selectors
  ['ai.posts.radius',          25,    n(5, 60, 1, 'selection radius from anchor (m)')],       // [DEV] G 14:43
  ['ai.posts.candidates',      20,    n(4, 40, 1, 'candidates per NPC')],                     // [DEV] (TLOU) M p.424
  ['ai.posts.raysPerPost',     4,     n(1, 4, 1, 'rays per candidate')],                      // [DEV] (TLOU) M p.424
  ['ai.posts.rescore',         0.5,   n(0.1, 3, 0.05, 're-score interval (s)')],              // [INFERRED] browser
  ['ai.posts.hysteresis',      1.2,   n(1, 3, 0.05, 'switch if new ≥ × current')],            // [INFERRED]
  ['ai.posts.minDwell',        3,     n(0, 10, 0.5, 'min dwell before moving (s)')],          // [INFERRED]
  ['ai.posts.coverSpacing',    1.0,   n(0.5, 3, 0.1, 'cover post spacing (m)')],              // [INFERRED]
  ['ai.posts.openGrid',        2.0,   n(1, 5, 0.5, 'open post grid (m)')],                    // [INFERRED]
  ['ai.posts.setback',         0.5,   n(0.36, 1.2, 0.01, 'post setback from wall (m)')],      // [ASSUMED] radius 0.35 + clearance
  ['ai.posts.facing',          -0.5,  n(-1, 0.5, 0.05, 'cover faces threat if cos <')],       // [ASSUMED] threat within 60° of the wall's inward normal
  ['ai.posts.behindMargin',    2,     n(0, 10, 0.5, 'behind player margin (m)')],             // [ASSUMED]
  ['ai.posts.pathNearPlayer',  4,     n(0, 10, 0.5, 'path may not pass within (m)')],         // [INFERRED] static-pathfind-not-near-player (M p.425)
  ['ai.posts.allySpacing',     2,     n(0, 6, 0.1, 'ally spacing (m)')],                      // [DEV] (UC2) R: repelled within 2 m
  ['ai.posts.openScore',       0.4,   n(0, 1, 0.05, 'open post score')],                      // [INFERRED] cover 1.0 / open 0.4
  ['ai.posts.visibleScore',    0.2,   n(0, 1, 0.05, 'ambush: visible score')],                // [INFERRED] hidden 1.0 / visible 0.2
  ['ai.posts.popHeight',       1.45,  n(1, 2, 0.01, 'pop-up eye height (m)')],                // [ASSUMED] over a 1.0 m wall
  ['ai.posts.leanOut',         0.45,  n(0.1, 1, 0.05, 'lean past wall end (m)')],             // [ASSUMED]
  ['ai.posts.edgeLean',        0.9,   n(0.2, 2, 0.05, 'lean-capable within (m) of end')],     // [ASSUMED]
  ['ai.posts.curve.path',      '0:1, 5:0.9, 20:0.1', { label: 'path dist curve' }],            // [DEV] G slide (ambush selector)
  ['ai.posts.curve.engage',    '5:0.3, 10:1, 15:1, 25:0.2', { label: 'engage range curve' }],  // [INFERRED] spec §3.2 table
  ['ai.posts.curve.advance',   '4:0.2, 10:1, 15:1, 22:0.3', { label: 'advance range (rifle)' }], // [INFERRED] rifle prefers 10–15 m
  ['ai.posts.curve.flank',     '4:0.3, 8:1, 14:1, 22:0.2', { label: 'flank range curve' }],    // [INFERRED]
  ['ai.posts.curve.panic',     '3:0, 5:1', { label: 'panic dist-to-threat' }],                 // [DEV] (TLOU) M Listing 34.1
  ['ai.posts.curve.investigate', '0:0.3, 2:1, 4:1, 8:0.2', { label: 'investigate dist' }],     // [INFERRED] 2–4 m best
  ['ai.posts.curve.elevation', '-10:0.1, 0:0.2, 5:1', { label: 'elevation curve' }],           // [DEV] G slide (ambush)
  // selector weights = exponents of a weighted geometric mean (spec §3.2 open point [INFERRED]); 0 = term off
  ['ai.sel.engage.range',      1, n(0, 10, 0.5)], ['ai.sel.engage.path', 1, n(0, 10, 0.5)],   // [INFERRED]
  ['ai.sel.engage.cover',      1, n(0, 10, 0.5)], ['ai.sel.engage.space', 1, n(0, 10, 0.5)],   // [INFERRED]
  ['ai.sel.advance.range',     1, n(0, 10, 0.5)], ['ai.sel.advance.path', 1, n(0, 10, 0.5)],   // [INFERRED]
  ['ai.sel.advance.cover',     1, n(0, 10, 0.5)], ['ai.sel.advance.space', 1, n(0, 10, 0.5)],  // [INFERRED]
  ['ai.sel.ambush.high',       10, n(0, 20, 0.5)], ['ai.sel.ambush.path', 1, n(0, 10, 0.5)],   // [DEV] G slide :weight 10 / :weight 1
  ['ai.sel.ambush.hidden',     1, n(0, 10, 0.5)], ['ai.sel.ambush.cover', 1, n(0, 10, 0.5)],   // [INFERRED]
  ['ai.sel.defend.high',       1, n(0, 10, 0.5)], ['ai.sel.defend.cover', 1, n(0, 10, 0.5)],   // [DEV] curve, [INFERRED] weight
  ['ai.sel.flank.range',       1, n(0, 10, 0.5)], ['ai.sel.flank.cover', 1, n(0, 10, 0.5)],    // [INFERRED]
  ['ai.sel.panic.range',       1, n(0, 10, 0.5)], ['ai.sel.panic.path', 1, n(0, 10, 0.5)],     // [DEV] curve (M), [INFERRED] weights
  ['ai.sel.panic.cover',       1, n(0, 10, 0.5)],                                              // [INFERRED]
  ['ai.sel.investigate.range', 1, n(0, 10, 0.5)], ['ai.sel.investigate.path', 1, n(0, 10, 0.5)], // [INFERRED]
  ['ai.sel.engage.vantage',    0.5, n(0, 10, 0.5)], ['ai.sel.advance.vantage', 0.5, n(0, 10, 0.5)], // [ASSUMED] light: the talk dropped vantage as a zone replacement (G-deck p69–72)
  ['ai.sel.defend.vantage',    2, n(0, 10, 0.5)],                                              // [ASSUMED] weight; defenders seek best vantage [DEV G 39:51]
  ['ai.sel.defendSearch.vantage', 3, n(0, 10, 0.5)], ['ai.sel.defendSearch.path', 1, n(0, 10, 0.5)], // [ASSUMED]
  ['ai.sel.defendSearch.cover', 1, n(0, 10, 0.5)], ['ai.sel.defendSearch.high', 0.5, n(0, 10, 0.5)], // [ASSUMED]
  ['ai.sel.perch.range',       1, n(0, 10, 0.5)], ['ai.sel.perch.path', 1, n(0, 10, 0.5)],     // [ASSUMED]
  ['ai.sel.perch.cover',       0.5, n(0, 10, 0.5)],                                            // [ASSUMED] rail 1.0 / ledge perchScore

  // vantage (refs/ai-vantage.md): what the player could reach in ~3 s, and how much of it a post sees
  ['ai.vantage.on',            true,  { label: 'vantage term + defend search' }],            // [ASSUMED] debug switch
  ['ai.vantage.reachTime',     3.0,   n(0.5, 8, 0.25, 'player reach (s)')],                    // [DEV] G 18:52, G-deck p66 "~3 seconds of movement"
  ['ai.vantage.speed',         4.8,   n(1, 8, 0.1, 'player run speed (m/s)')],                 // [INFERRED] player-spec player.run.speed
  ['ai.vantage.sectors',       8,     n(2, 16, 1, 'reach sample sectors')],                    // [ASSUMED] G-deck p67 shows ~a ring of points
  ['ai.vantage.rings',         2,     n(1, 4, 1, 'reach sample rings')],                       // [ASSUMED]
  ['ai.vantage.pointH',        1.0,   n(0.3, 1.8, 0.05, 'reach point height (m)')],            // [ASSUMED] torso of a standing / crouched player
  ['ai.vantage.resample',      2.0,   n(0.25, 8, 0.25, 'rebuild reach when LKP moves (m)')],   // [ASSUMED]
  ['ai.vantage.min',           0.15,  n(0, 1, 0.05, 'no vantage below')],                      // [ASSUMED] ~2 of 17 points
  ['ai.vantage.lostT',         2.0,   n(0, 10, 0.25, 'defender searches after no LOF (s)')],   // [ASSUMED] the talk gives no number
  ['ai.vantage.sweep',         true,  { label: 'background vantage sweep (debug)' }],        // [ASSUMED]
  ['ai.vantage.lookDwell',     1.5,   n(0.25, 6, 0.25, 'defend search look dwell (s)')],      // [ASSUMED] "look outward" (G 19:05) has no timing
  ['ai.posts.curve.vantage',   '0:0.15, 0.3:0.7, 0.6:1', { label: 'vantage curve' }],           // [ASSUMED] G-deck p68 good vs bad vantage, no numbers
  ['ai.posts.curve.perch',     '0:1, 6:1, 15:0.4', { label: 'perch range (2D to player)' }],    // [ASSUMED] right above the climber is the point
  ['ai.posts.perchScore',      0.6,   n(0, 1, 0.05, 'ledge perch cover score')],               // [ASSUMED] between open 0.4 and cover 1.0
  ['ai.posts.designerClear',   0.75,  n(0, 3, 0.05, 'designer post clears generated (m)')],    // [ASSUMED]

  // perches (G 11:03, 44:19; G-deck p46, p146–147): elevated edges, lean out to aim down
  ['ai.perch.on',              true,  { label: 'perch posts' }],                             // [DEV] post type exists (G-deck p46)
  ['ai.perch.rails',           true,  { label: 'rails over drops are perches' }],            // [DEV] G-deck p147 "thin railings"
  ['ai.perch.minDrop',         2.5,   n(0.5, 10, 0.25, 'min drop below edge (m)')],            // [ASSUMED] a storey, not a step
  ['ai.perch.leanPast',        0.25,  n(0, 1, 0.05, 'lean past the edge (m)')],                // [ASSUMED]
  ['ai.perch.railUp',          0.3,   n(0, 1, 0.05, 'eye above the rail (m)')],                // [ASSUMED]
  ['ai.perch.ledgeProbe',      0.8,   n(0.3, 2, 0.05, 'ledge probe distance (m)')],            // [ASSUMED] nav keeps ~0.3 m off a drop
  ['ai.perch.eye',             1.35,  n(0.8, 1.8, 0.05, 'leaning eye height (m)')],            // [ASSUMED] bent over the edge
  ['ai.perch.ledgeSpacing',    1.0,   n(0.5, 4, 0.25, 'ledge perch spacing (m)')],             // [ASSUMED] = cover spacing
  ['ai.perch.below',           2.0,   n(0.5, 10, 0.25, 'perch when player below by (m)')],    // [ASSUMED] climbing below (G-deck p30, p146)
  ['ai.perch.near',            4.0,   n(0.5, 15, 0.25, '… and within (m) of a perch edge')],  // [ASSUMED] "under the edge"
  ['ai.perch.noLof',           1.0,   n(0, 5, 0.25, 'perch after no LOF (s)')],                // [ASSUMED]
  ['ai.perch.retry',           3.0,   n(0, 10, 0.5, 'perch query retry (s)')],                 // [ASSUMED]
  ['ai.perch.lookDown',        88,    n(30, 90, 1, 'perch downward view half (deg)')],         // [ASSUMED] leaning out to look straight down

  // §4 coordination
  ['ai.roles.engagers',        2,     n(0, 6, 1, 'engagers (X)')],                            // [INFERRED] room default (G 33:36: 2–3 typical)
  ['ai.roles.ambushers',       1,     n(0, 6, 1, 'ambushers (Y)')],                           // [INFERRED] room default 0–1 (slide default 2)
  ['ai.roles.ambushDist',      20,    n(5, 40, 1, 'ambush point nav dist (m)')],              // [DEV] G 30:07
  ['ai.roles.ambushPopDist',   12,    n(0, 40, 1, 'ambusher pops out within (m)')],           // [INFERRED] "when the player comes its way"
  ['ai.roles.replaceDelay',    6.0,   n(0, 20, 0.5, 'engager replacement delay (s)')],        // [DEV] G-deck p114
  ['ai.tokens.min',            2,     n(0, 6, 1, 'min shooters')],                            // [DEV] G-deck p114
  ['ai.tokens.max',            3,     n(1, 6, 1, 'max shooters')],                            // [DEV] G-deck p114
  ['ai.tokens.losGrace',       1.0,   n(0, 5, 0.1, 'peek grant LOS grace (s)')],              // [ASSUMED] lets a min-shooter grant pop up
  ['ai.tokens.engagedWindow',  2.0,   n(0, 10, 0.5, '"directly engaged" lasts (s)')],         // [INFERRED] G 37:30 (no number)
  ['ai.tokens.engagedRadius',  1.5,   n(0, 5, 0.1, 'player shot passes within (m)')],         // [ASSUMED]
  ['ai.tokens.engagedPreempts', true, { label: 'engaged NPC preempts a holder' }],           // [INFERRED] "top priority"
  ['ai.advance.wait',          6.0,   n(0.5, 30, 0.5, 'wait-to-advance (s)')],                // [DEV] G-deck p114
  ['ai.advance.reset',         6.0,   n(0.5, 30, 0.5, 'advance reset distance (m)')],         // [DEV] G-deck p114
  ['ai.advance.minGain',       2.0,   n(0, 10, 0.5, 'advance must gain (m)')],                // [ASSUMED]
  ['ai.advance.suppress',      3.0,   n(0, 10, 0.5, 'suppressing fire (s)')],                 // [INFERRED] G 35:44 (no number)
  ['ai.flank.wait',            6.0,   n(0.5, 30, 0.5, 'wait-to-flank (s)')],                  // [DEV] G-deck p114
  ['ai.flank.reset',           4.0,   n(0.5, 30, 0.5, 'flank reset distance (m)')],           // [DEV] G-deck p114
  ['ai.flank.minRating',       0.5,   n(0, 1, 0.05, 'min flank path rating')],                // [DEV] value G-deck p114, [INFERRED] formula
  ['ai.flank.minPressure',     2,     n(0, 6, 1, 'other NPCs pressuring')],                   // [INFERRED] G 55:55
  ['ai.flank.len',             12,    n(2, 30, 0.5, 'combat vector length (m)')],             // [INFERRED] M fig. 34.9 shape
  ['ai.flank.halfWidth',       4,     n(0.5, 10, 0.5, 'combat vector half width (m)')],       // [INFERRED]
  ['ai.flank.costMul',         8,     n(0, 30, 0.5, 'combat vector cost ×')],                 // [INFERRED]
  ['ai.flank.shotWindow',      3,     n(0.5, 10, 0.5, 'shot weighting window (s)')],          // [INFERRED] M p.428 "recently"
  ['ai.flank.offAxis',         60,    n(0, 170, 5, 'flank post off combat vector (deg)')],    // [ASSUMED]
  ['ai.flank.ideal',           11,    n(3, 25, 0.5, 'flank candidates nearest (m) from player')], // [ASSUMED] middle of the flank curve's plateau

  // §5 shooting
  ['ai.acc.class',             'light', { options: ['light', 'medium'], label: 'accuracy class' }], // [DEV] U4 light/medium curves
  ['ai.acc.ttaLight',          '5:3.0, 15:4.5, 30:6.0', { label: 'time to accuracy, light' }], // [DEV] G-deck p145
  ['ai.acc.ttaMedium',         '5:2.5, 15:4.0, 30:5.5', { label: 'time to accuracy, medium' }], // [DEV] G-deck p145
  ['ai.acc.distRifle',         '4:0.9, 8:0.5, 12:0.4, 20:0.4, 30:0.3, 60:0', { label: 'rifle dist curve' }], // [DEV] (UC2) R
  ['ai.acc.distPistol',        '4:0.8, 8:0.45, 12:0.35, 20:0.25, 40:0', { label: 'pistol dist curve' }],    // [INFERRED] shape from R
  ['ai.acc.popOutRamp',        3.5,   n(0, 10, 0.1, 'pop-out ramp (s)')],                     // [DEV] (UC2) R
  ['ai.acc.moveRun',           0.9,   n(0, 1, 0.05, 'target running ×')],                     // [DEV] (UC2) R
  ['ai.acc.moveRoll',          0.5,   n(0, 1, 0.05, 'target rolling ×')],                     // [DEV] (UC2) R
  ['ai.acc.moveStand',         1.0,   n(0, 1, 0.05, 'target standing ×')],                    // [DEV] (UC2) R
  ['ai.acc.runSpeed',          3.0,   n(0.5, 8, 0.1, 'target counts as running above (m/s)')], // [ASSUMED]
  ['ai.acc.mul',               1.0,   n(0, 2, 0.05, 'accuracy × (difficulty)')],              // [INFERRED] Moderate
  ['ai.acc.add',               0.0,   n(-0.5, 0.5, 0.01, 'accuracy + (class)')],              // [DEV] (UC2) Light 0, Medium +0.1
  ['ai.acc.floor',             0.05,  n(0, 0.5, 0.01, 'accuracy floor')],                     // [INFERRED] value, [DEV] floor exists (G 47:06)
  ['ai.acc.respotReset',       2.0,   n(0, 30, 0.5, 'ramp resets after LOS lost (s)')],       // [INFERRED] spec §5
  ['ai.acc.missMin',           0.4,   n(0, 3, 0.05, 'near-miss offset min (m)')],             // [INFERRED]
  ['ai.acc.missMax',           1.2,   n(0, 3, 0.05, 'near-miss offset max (m)')],             // [INFERRED]
  ['ai.shoot.weapon',          'rifle', { options: ['rifle', 'pistol'], label: 'grunt weapon' }], // spec scope: rifle/pistol grunts
  ['ai.shoot.firstMin',        0.3,   n(0, 2, 0.05, 'first shot delay min (s)')],             // [INFERRED]
  ['ai.shoot.firstMax',        0.5,   n(0, 2, 0.05, 'first shot delay max (s)')],             // [INFERRED]
  ['ai.shoot.lkpFireTime',     10,    n(0, 30, 0.5, 'suppress the LKP for up to (s)')],       // [ASSUMED] = LKP timeout; suppress allowed for shooters (G-deck p128)
  ['ai.vision.crouchEye',      1.0,   n(0.5, 1.6, 0.01, 'NPC eye, crouched in cover (m)')],    // [ASSUMED]
  ['ai.burst.singleChance',    0.33,  n(0, 1, 0.01, 'rifle: single-shot burst chance')],      // [DEV] (UC2) R
  ['ai.burst.singleMin',       1,     n(1, 6, 1, 'rifle single shots min')],                  // [DEV] (UC2) R
  ['ai.burst.singleMax',       3,     n(1, 6, 1, 'rifle single shots max')],                  // [DEV] (UC2) R
  ['ai.burst.singleGapMin',    0.16,  n(0.05, 1, 0.01, 'rifle single gap min (s)')],          // [DEV] (UC2) R
  ['ai.burst.singleGapMax',    0.20,  n(0.05, 1, 0.01, 'rifle single gap max (s)')],          // [DEV] (UC2) R
  ['ai.burst.autoMin',         3,     n(1, 10, 1, 'rifle auto rounds min')],                  // [DEV] (UC2) R
  ['ai.burst.autoMax',         5,     n(1, 10, 1, 'rifle auto rounds max')],                  // [DEV] (UC2) R
  ['ai.burst.autoRpm',         600,   n(100, 1200, 10, 'rifle auto rate (rpm)')],             // [INFERRED]
  ['ai.burst.pauseMin',        0.4,   n(0, 3, 0.05, 'rifle pause min (s)')],                  // [DEV] (UC2) R
  ['ai.burst.pauseMax',        0.8,   n(0, 3, 0.05, 'rifle pause max (s)')],                  // [DEV] (UC2) R
  ['ai.burst.pistolMin',       1,     n(1, 6, 1, 'pistol shots min')],                        // [INFERRED]
  ['ai.burst.pistolMax',       3,     n(1, 6, 1, 'pistol shots max')],                        // [INFERRED]
  ['ai.burst.pistolGapMin',    0.3,   n(0.05, 2, 0.01, 'pistol gap min (s)')],                // [INFERRED]
  ['ai.burst.pistolGapMax',    0.45,  n(0.05, 2, 0.01, 'pistol gap max (s)')],                // [INFERRED]
  ['ai.burst.pistolPauseMin',  0.8,   n(0, 3, 0.05, 'pistol pause min (s)')],                 // [INFERRED]
  ['ai.burst.pistolPauseMax',  1.4,   n(0, 3, 0.05, 'pistol pause max (s)')],                 // [INFERRED]
  ['ai.cover.exposeMin',       4.0,   n(0.5, 15, 0.5, 'exposed aim window min (s)')],         // [INFERRED] from [MEASURED] ≥ ~5 s (G-deck p128)
  ['ai.cover.exposeMax',       6.0,   n(0.5, 15, 0.5, 'exposed aim window max (s)')],         // [INFERRED]
  ['ai.cover.hiddenMin',       1.0,   n(0, 10, 0.1, 'hidden between pop-outs min (s)')],      // [INFERRED]
  ['ai.cover.hiddenMax',       2.5,   n(0, 10, 0.1, 'hidden between pop-outs max (s)')],      // [INFERRED]
  ['ai.cover.peekMin',         0.6,   n(0.1, 3, 0.05, 'peek min (s)')],                       // [INFERRED]
  ['ai.cover.peekMax',         1.0,   n(0.1, 3, 0.05, 'peek max (s)')],                       // [INFERRED]
  ['ai.cover.peekGapMin',      1.0,   n(0, 10, 0.1, 'peek re-arm min (s)')],                  // [INFERRED] [MEASURED] ~0–3 s
  ['ai.cover.peekGapMax',      3.0,   n(0, 10, 0.1, 'peek re-arm max (s)')],                  // [INFERRED]
  ['ai.cover.blindfire',       0,     n(0, 1, 0.05, 'blind fire chance per pop-out')],        // [INFERRED] denied in G-deck p128 frame
  ['ai.cover.blindAccMul',     0.3,   n(0, 1, 0.05, 'blind fire accuracy ×')],                // [ASSUMED]
  ['ai.cover.tacticalReload',  0.3,   n(0, 1, 0.05, 'reload when hidden below (mag frac)')],  // [ASSUMED]

  // §6 grenades
  ['ai.grenade.on',            true,  { label: 'AI grenades' }],                              // [DEV] grenade director exists (G 42:03)
  ['ai.grenade.sampleRate',    1.0,   n(0.1, 3, 0.1, 'sample rate (s)')],                     // [DEV] G-deck p142
  ['ai.grenade.timer',         8,     n(1, 60, 0.5, 'dwell before throw (s)')],               // [INFERRED] Moderate (param exists, G 35:50)
  ['ai.grenade.moveReset',     4.0,   n(0.5, 15, 0.5, 'move reset radius (m)')],              // [INFERRED] = flank reset 4.0
  ['ai.grenade.friendCheck',   1.9,   n(0, 8, 0.1, 'friend check radius (m)')],               // [INFERRED] ring ratio [MEASURED] × 4 m
  ['ai.grenade.accuracy',      1.25,  n(0, 5, 0.05, 'landing scatter radius (m)')],           // [INFERRED] ring ratio [MEASURED] × 4 m
  ['ai.grenade.multiChance',   0,     n(0, 1, 0.05, 'multi-grenade chance')],                 // [DEV] G-deck p142 (0%)
  ['ai.grenade.cooldown',      6,     n(0, 30, 0.5, 'cooldown after a throw (s)')],           // [INFERRED]
  ['ai.grenade.maxInFlight',   1,     n(1, 4, 1, 'max enemy grenades live')],                 // [INFERRED]
  ['ai.grenade.prefer',        12,    n(2, 30, 0.5, 'preferred throw dist (m)')],             // [INFERRED] rank −|d − 12|
  ['ai.grenade.minDist',       8,     n(1, 30, 0.5, 'min throw dist (m)')],                   // [INFERRED] 8–18 m
  ['ai.grenade.maxDist',       18,    n(2, 40, 0.5, 'max throw dist (m)')],                   // [INFERRED]
  ['ai.grenade.barkLead',      0.6,   n(0, 3, 0.05, 'bark before release (s)')],              // [INFERRED]
  ['ai.grenade.throwTime',     0.8,   n(0.2, 2, 0.05, 'throw anim (s)')],                     // [ASSUMED]
  ['ai.grenade.releaseAt',     0.45,  n(0, 1, 0.05, 'release at anim fraction')],             // [ASSUMED]
  ['ai.grenade.apex',          2.5,   n(0.5, 8, 0.1, 'arc check apex above (m)')],            // [ASSUMED] high arc for the clear-arc test
  ['ai.grenade.fleeRadius',    5,     n(1, 12, 0.5, 'flee player grenade within (m)')],       // [INFERRED] blast radius + 1
  ['ai.grenade.reactMin',      0.3,   n(0, 2, 0.05, 'react delay min (s)')],                  // [INFERRED]
  ['ai.grenade.reactMax',      0.6,   n(0, 2, 0.05, 'react delay max (s)')],                  // [INFERRED]
  ['ai.grenade.diveFuse',      0.6,   n(0, 2, 0.05, 'dive in place if fuse below (s)')],      // [INFERRED]
  ['ai.grenade.fuse',          2.5,   n(0.5, 6, 0.1, 'stub fuse (s)')],                       // [INFERRED] (stub only; real fuse is weapons')

  // §7 hits, death, health
  ['ai.health',                100,   n(1, 500, 1, 'grunt health')],                          // [DEV] (UC2) R base 100
  ['ai.hit.torso',             0.35,  n(0, 2, 0.05, 'flinch torso (s)')],                     // [INFERRED]
  ['ai.hit.limb',              0.3,   n(0, 2, 0.05, 'flinch limb (s)')],                      // [INFERRED]
  ['ai.hit.head',              0.35,  n(0, 2, 0.05, 'flinch head (s)')],                      // [ASSUMED] = torso
  ['ai.hit.staggerWindow',     1.0,   n(0, 3, 0.05, 'stagger: 2 hits within (s)')],           // [INFERRED]
  ['ai.hit.stagger',           1.0,   n(0, 3, 0.05, 'stagger (s)')],                          // [INFERRED]
  ['ai.hit.panicHp',           0.35,  n(0, 1, 0.05, 'panic fallback below hp')],              // [INFERRED]
  ['ai.hit.deathTime',         1.2,   n(0.2, 5, 0.1, 'death anim (s)')],                      // [ASSUMED]

  // movement (the spec has no locomotion speeds for NPCs)
  ['ai.move.walk',             1.4,   n(0.3, 4, 0.05, 'walk (m/s)')],                         // [ASSUMED] patrol/investigate
  ['ai.move.searchSpeed',      1.8,   n(0.3, 5, 0.05, 'search walk (m/s)')],                  // [ASSUMED]
  ['ai.move.run',              3.8,   n(1, 8, 0.1, 'run (m/s)')],                             // [ASSUMED] under the player's 4.8 (player-spec)
  ['ai.move.sprint',           5.0,   n(1, 9, 0.1, 'sprint (m/s)')],                          // [ASSUMED] grenade flee
  ['ai.move.accel',            12,    n(1, 40, 1, 'accel (m/s²)')],                           // [ASSUMED]
  ['ai.move.turnRate',         6.0,   n(0.5, 20, 0.5, 'turn rate (rad/s)')],                  // [ASSUMED]
  ['ai.move.arrive',           0.3,   n(0.05, 1, 0.05, 'waypoint reached (m)')],              // [ASSUMED]
  ['ai.move.separation',       0.8,   n(0, 2, 0.05, 'ally separation (m)')],                  // [ASSUMED]

  // stub weapon (used only until src/weapons/ exists; the real numbers live in the weapons params)
  ['ai.stub.mag',              30,    n(1, 60, 1, 'stub rifle mag')],                         // [INFERRED] spec §5
  ['ai.stub.reload',           2.0,   n(0.2, 5, 0.1, 'stub rifle reload (s)')],               // [INFERRED] spec §5
  ['ai.stub.damage',           10,    n(0, 50, 1, 'stub rifle damage to player')],            // Max 12 Nov: 10 hits kill (as the rifle)
];

export function defineAIParams(params) {
  for (const [k, v, o] of AI_PARAMS) params.define(k, v, o);
  return params;
}

// P(key) accessor over a Params instance (core/params.js).
export function makeP(params) { return (k) => params.get(k); }

// ---------------------------------------------------------------------------------------------------- curves
const _curves = new Map();     // key -> {src, xs: Float64Array, ys: Float64Array}

export function parseCurve(src) {
  const pts = [];
  for (const part of String(src).split(',')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const x = Number(part.slice(0, i)), y = Number(part.slice(i + 1));
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  if (!pts.length) pts.push([0, 1]);
  return { src, xs: Float64Array.from(pts, (p) => p[0]), ys: Float64Array.from(pts, (p) => p[1]) };
}

// Piecewise-linear lookup of the curve stored in param `key`, clamped at the end points. Re-parses only on change.
export function curveAt(P, key, x) {
  const src = P(key);
  let c = _curves.get(key);
  if (!c || c.src !== src) { c = parseCurve(src); _curves.set(key, c); }
  const xs = c.xs, ys = c.ys, n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (x <= xs[i]) {
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
      return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
    }
  }
  return ys[n - 1];
}

// ---------------------------------------------------------------------------------------------------- small helpers
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const randRange = (rng, lo, hi) => lo + (hi - lo) * rng();
export const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1 - 1e-9));
export const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const dist3D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const wrapAngle = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
// yaw 0 faces +Z (design.md): forward = (sin yaw, 0, cos yaw)
export const yawTo = (dx, dz) => Math.atan2(dx, dz);

// Emit the measurement feed event (design.md: every state machine emits `state` on every transition).
export function emitState(game, actor, sys, from, to) {
  if (from === to) return;
  game.events.emit('state', { actor, sys, from, to, t: game.time });
}
