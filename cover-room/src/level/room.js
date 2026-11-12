// level/room.js: the Cover Room courtyard. Geometry, materials, lights, sky, colliders, markup, spawns, nav.
// Contract: refs/design.md "level/room.js". Owner: A3. All art and layout are original (a ruined coastal fort).
//
// BOOT    main.js calls install(game): builds the room into game.scene / game.world and sets game.level.
//         createRoom() + level.build(game) is the same thing in two steps (tests/level.html uses install too).
// COORDS  metres, Y up. NORTH = -Z, EAST = +X, so the map reads normally from above. Yaw follows Object3D.rotation.y and
//         world.js: local +Z maps to (sin yaw, 0, cos yaw), so yaw 0 faces south (+Z) and the player (facing north) has
//         yaw = PI. The courtyard floor is y = 0; the balcony walkway is LAYOUT.balcony.y.
// TABLES  LAYOUT (every placement), CLIMB (the climbable feature) and LIGHTING sit at the top so the room can be re-tuned
//         in seconds. Values marked [INFERRED] are Claude's calls made before refs/climb-spec.md and refs/player-spec.md
//         existed; replace them with the specs' numbers when they land.
// LOOK    "greybox+": procedural world-space stone (ashlar, dressed, plaster, rubble), flagstone paving and crate wood, all
//         MeshStandardMaterial patched in onBeforeCompile. Chamfered boxes. Baked-feel AO: per-vertex ray-cast AO on
//         every solid (faces are subdivided to <= 0.5 m so contacts resolve) and a top-down contact/dirt mask for the
//         floors. Ivy, grass and banners share one alpha-tested canvas atlas.
// LIGHT   one shadow-casting sun whose shadow camera is fitted to the room's bounds in light space, a hemisphere fill,
//         a weak unshadowed warm bounce, and a sky dome (sky, sun, clouds, distant headland and the sea below the horizon,
//         all directional, no geometry). Radiance budget from core/render.js: environment under ~0.7 (only the sun disc
//         and sea glints may bloom). The renderer, tone mapping and exposure belong to core/render.js.
// BUDGET  static level = 5 draw calls (stone, floor, wood, foliage, sky) + 3 shadow casters; 52k triangles (106k drawn
//         with the shadow pass). Measured on an M1 Pro (tests/level.html bench, min of 5 rounds, MSAA + shadows):
//         ~1.9 ms at 1920x1080, ~3.5 ms at 4.1 MPix (render.js's live cap). Build ~0.25 s (AO bake ~0.15 s).
//         Noise is one 3D-texture fetch per octave (noiseTexture); the sky draws last at the far plane (early-z).
//         Nothing allocates per frame: the only per-frame work is the banner/ivy sway time uniform.
import * as THREE from 'three';
import { ORDER, mulberry32 } from '../core/game.js';
import { buildNav } from './nav.js';

// =====================================================================================================================
// LAYOUT [INFERRED unless noted]. Pieces: c = [x, z] centre on the floor, size = [x, y, z] in the piece's local axes,
// yaw in radians. Cover class comes from height: 0.7-1.25 m low, above 1.25 m high (player-spec cover.lowHeight
// 0.6-1.2, "above 1.2 = High"; climb-spec §2: ND low cover 0.9-1.25).
// =====================================================================================================================
const BALCONY_Y = 6.0;   // walkway floor (m): design.md "~6 m climbable wall"; climb-spec "Proposed data format" T1 at 6.0

export const LAYOUT = {
  room: { x0: -15, x1: 15, z0: -11, z1: 11 },   // inner faces of the courtyard walls (north z0, south z1)
  balcony: {
    y: BALCONY_Y,      // 20 stair rises of 0.3 m. Parapet top = y + parapetH.
    z: -8.0,           // courtyard face of the north rampart = the climb wall plane
    eastX: 12.0,       // courtyard face of the east rampart
    eastZ: -2.5,       // south end of the east rampart, where the stairs arrive
    parapetH: 1.0, parapetT: 0.35,
    backTop: BALCONY_Y + 1.6,   // outer walls behind the walkway (merlons on top)
    merlonH: 1.0, merlonW: 0.9, crenelW: 0.65, outerT: 0.8,
  },
  stairs: { x0: 12.0, x1: 15.0, rise: 0.3, tread: 0.38 },  // rise <= world.moveCapsule stepHeight (0.35)
  gate: { x0: -1.6, x1: 1.6, depth: 1.6, lintelY: 3.3, doorZ: 12.3 },
  wallT: 0.9,                                   // ruined perimeter wall thickness
  fountain: { x: 0, z: 0.8, apothem: 2.6, rimT: 0.4, rimH: 0.95 },   // rim inside low cover 0.9-1.25 (climb-spec §2, ND metric)
  pieces: [
    { id: 'mantle',   kind: 'mantle',  c: [-3.4, 7.6],   size: [2.2, 1.2, 1.3] },               // vault/mantle off the gate
    { id: 'lowS',     kind: 'wall',    c: [3.6, 7.0],    size: [3.6, 1.0, 0.55] },              // first cover, right of gate
    { id: 'cratesSE', kind: 'crates',  c: [9.0, 8.2],    size: [2.0, 2.0, 1.0], yaw: 0.05 },    // east flank start (high)
    { id: 'lowSE',    kind: 'wall',    c: [12.6, 6.6],   size: [2.6, 1.0, 0.55] },              // approach to the stair foot
    { id: 'lowSW',    kind: 'wall',    c: [-9.2, 6.2],   size: [3.4, 1.0, 0.55] },              // west flank start
    { id: 'brokenW',  kind: 'wall',    c: [-5.4, 3.4],   size: [2.8, 2.1, 0.6], broken: true }, // high, mid-west
    { id: 'pierW',    kind: 'pillar',  c: [-10.6, 1.4],  size: [1.1, 2.4, 1.1] },               // high, west lane
    { id: 'lowE',     kind: 'wall',    c: [7.8, 2.6],    size: [3.8, 1.0, 0.55] },              // mid-east
    { id: 'pierE',    kind: 'pillar',  c: [5.4, -1.4],   size: [1.1, 2.4, 1.1] },               // high, centre-east
    { id: 'lowNE',    kind: 'wall',    c: [9.8, -2.2],   size: [3.2, 1.0, 0.55], yaw: Math.PI / 2 }, // N-S run by the stairs
    { id: 'lowN',     kind: 'wall',    c: [0.2, -5.0],   size: [4.2, 1.0, 0.55] },              // enemy line, 15 m from spawn
    { id: 'cratesNE', kind: 'crates',  c: [6.2, -5.6],   size: [2.0, 2.0, 1.0], yaw: -0.04 },   // enemy high cover
    { id: 'cratesN',  kind: 'crates',  c: [-4.6, -6.4],  size: [2.0, 1.0, 1.0], yaw: 0.08 },    // guards the climb (low)
    { id: 'column',   kind: 'column',  c: [-8.95, -3.5], size: [5.0, 1.0, 1.0], yaw: 0.33 },    // fallen column (low)
    { id: 'stump',    kind: 'stump',   c: [-12.0, -2.3], size: [1.15, 2.0, 1.15] },             // its standing base (high)
    { id: 'capital',  kind: 'capital', c: [-6.2, -2.8],  size: [1.0, 0.95, 1.0], yaw: 0.5 },    // fallen capital (low)
  ],
  // Spawns. Player at the south gate facing north. Enemies: the first three are the default set (param ai count = 3).
  spawns: {
    player: { pos: [0, 0, 10.4], yaw: Math.PI },
    enemies: [
      { pos: [0.2, 0, -5.9],   yaw: 0,            role: 'hold' },       // behind lowN, 16 m
      { pos: [3.0, BALCONY_Y, -9.6], yaw: 0,      role: 'overwatch' },  // north balcony, 20 m
      { pos: [6.2, 0, -6.7],   yaw: 0,            role: 'flank' },      // behind cratesNE, 18 m
      { pos: [-9.3, 0, -4.6],  yaw: 0.33,         role: 'hold' },       // behind the fallen column, 17.5 m
      { pos: [13.6, BALCONY_Y, -5.2], yaw: -Math.PI / 2, role: 'overwatch' }, // east balcony, 21 m
    ],
  },
};

// =====================================================================================================================
// CLIMB: the route from refs/climb-spec.md "Proposed data format for the room" (heights [DEV]/[MEASURED] there; x
// placement [INFERRED]). On the north rampart face (z = LAYOUT.balcony.z, normal +Z); y = grip height.
//   L1 2.2 jump-grab ledge (shimmy) -> H1 2.8 -> H2 3.2 (static reaches ~0.6/0.4 m) -> skip the 3.25-4.0 dead zone with a
//   0.9 m reach -> H3 4.1 -> H4 4.7 -> lunge-only 1.3 m gap -> TOP 6.0 (climb up). H1/H1s: side-lunge pair 1.6 m apart.
// Links are computed from `moves`, so moving a hold re-links it; makeClimb() checks the spec's authoring rules.
// =====================================================================================================================
export const CLIMB = {
  wall: { x0: -9.6, x1: -5.4 },   // climbable block of the rampart (tag 'climbable')
  gap: { x0: -9.2, x1: -5.8 },    // parapet gap above it; the 'top' edge spans the gap
  protrude: 0.16,                 // ledges and holds stand this far out of the wall (m)
  ledgeT: 0.14,                   // ledge stone thickness (m)
  holdW: 0.28, holdT: 0.16,       // hold width (climb-spec: holds are short edges ~0.25 m) and thickness (m)
  moves: { reach: 0.9, lunge: 2.0 },     // static reach up to ~0.9 m, lunge (Jump) up to ~2 m (climb-spec summary 2)
  rules: { ambiguous: [0.5, 0.8], deadZone: [3.25, 4.0], jumpGrab: [1.6, 3.5] },   // climb-spec §2 / authoring rules
  edges: [
    { id: 'L1',  kind: 'ledge', x0: -9.3, x1: -6.9, y: 2.2 },   // jump-grab from the ground; shimmy
    { id: 'H1',  kind: 'hold',  x: -7.5, y: 2.8 },               // static reach up from L1
    { id: 'H1s', kind: 'hold',  x: -5.9, y: 2.8 },               // side-lunge partner, 1.6 m right of H1
    { id: 'H2',  kind: 'hold',  x: -7.5, y: 3.2 },               // static reach
    { id: 'H3',  kind: 'hold',  x: -7.5, y: 4.05 },              // 0.85 m reach over the dead zone (B3 retune: straight-up column)
    { id: 'H4',  kind: 'hold',  x: -7.5, y: 4.65 },               // static reach
    { id: 'TOP', kind: 'top',   x0: -9.2, x1: -5.8, y: BALCONY_Y }, // balcony floor edge in the parapet gap: lunge, climb up
  ],
};

// =====================================================================================================================
// LIGHTING [ASSUMED, art]. Colours are sRGB hex (three converts them to linear). Intensities are three.js physical
// units; with tone map E at exposure 1 a sunlit sandstone face lands near 0.4-0.6 linear radiance.
// =====================================================================================================================
export const LIGHTING = {
  sun: { color: '#ffe0b8', intensity: 2.8, elevation: 30, azimuth: 235 },  // azimuth: compass bearing to the sun (0 N, 90 E)
  fill: { sky: '#c3d0e2', ground: '#ad9370', intensity: 1.3 },
  bounce: { color: '#ffcf9c', intensity: 0.35 },   // warm light thrown back by the sunlit north/east walls (no shadow)
  shadowMapSize: 2048,
  sky: {
    zenith: '#88a5cb', mid: '#b3c5db', horizon: '#dcd7ca', glow: '#ffd09c',
    seaDeep: '#24566a', seaHaze: '#93acb6', land: '#7b8890', sunDisc: 2.5,
  },
  aoDirect: 0.35,   // fraction of the baked AO applied to direct light (1 = all; indirect always gets it all)
};

// Surface palettes (sRGB). A = light, B = dark, C = grime/joint.
const PAL = {
  stone: ['#c4ae8c', '#9c8667', '#5d5446'], mortar: '#8e8370', lichen: '#a69a66', plaster: '#d3c19e',
  floor: ['#b6a587', '#8f7e64', '#5a4e3d'], sand: '#cbb790', grass: '#6c7a3a',
  wood: ['#93795a', '#5d4834'],
};

// Camera presets for tests/level.html (and any debug view): position and look-at target.
export const VIEWS = {
  overview: { pos: [19, 24, 25], target: [-1, 0, -1.5], fov: 50 },
  'player-start': { pos: [0.45, 1.65, 12.1], target: [0.45, 1.5, 0], fov: 55 },
  'climb-wall': { pos: [-3.4, 2.1, -0.4], target: [-7.6, 3.7, -8], fov: 58 },
  balcony: { pos: [4.6, BALCONY_Y + 1.65, -9.0], target: [-1.5, 0.8, 4.0], fov: 55 },
};

// Pattern ids in the stone shader (aTint.w).
const PAT = { ashlar: 0, dressed: 1, plaster: 2, rubble: 3 };
const SQRT1_2 = Math.SQRT1_2, INV_SQRT3 = 1 / Math.sqrt(3);

// =====================================================================================================================
// Boot
// =====================================================================================================================
export function install(game) {
  const level = createRoom();
  level.build(game);
  game.level = level;
  return level;
}

export function createRoom() {
  const level = {
    build(game) { buildRoom(game, level); return level; },
    spawns: null, cover: [], climb: null, mantle: [], nav: null, bounds: null,
    boxes: [], colliders: [], meshes: {}, lights: null, sky: null, stats: null,
    dispose() { disposeRoom(level); },
  };
  return level;
}

// =====================================================================================================================
// Geometry builder: an indexed mesh accumulator with a current transform, an AO self-group and per-object attributes.
// =====================================================================================================================
const _p = new THREE.Vector3(), _nn = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1), _mat = new THREE.Matrix4();

function xform(x, y, z, yaw = 0, pitch = 0, roll = 0) {
  _e.set(pitch, yaw, roll, 'YXZ');
  _q.setFromEuler(_e);
  return _mat.compose(_p.set(x, y, z), _q, _one);
}

class Mesher {
  // extras: {attributeName: itemSize}. A value of 'local' for a 3-vector attribute writes the untransformed position.
  constructor(name, extras = {}) {
    this.name = name;
    this.sizes = extras;
    this.pos = []; this.nrm = []; this.idx = []; this.grp = [];
    this.ext = {};
    for (const k in extras) this.ext[k] = [];
    this.cur = {};
    this.m = new THREE.Matrix4();
    this.nmat = new THREE.Matrix3();
    this.group = -1;
    this.n = 0;
    this.ao = null;
  }

  begin(matrix, group = -1, values = {}) {
    this.m.copy(matrix);
    this.nmat.getNormalMatrix(matrix);
    this.group = group;
    this.cur = values;
    return this;
  }

  v(x, y, z, nx, ny, nz) {
    _p.set(x, y, z).applyMatrix4(this.m);
    _nn.set(nx, ny, nz).applyMatrix3(this.nmat).normalize();
    this.pos.push(_p.x, _p.y, _p.z);
    this.nrm.push(_nn.x, _nn.y, _nn.z);
    this.grp.push(this.group);
    for (const k in this.sizes) {
      const val = this.cur[k], arr = this.ext[k], sz = this.sizes[k];
      if (val === 'local') arr.push(x, y, z);
      else if (sz === 1) arr.push(val ?? 1);
      else for (let i = 0; i < sz; i++) arr.push(val ? val[i] : 1);
    }
    return this.n++;
  }

  // Orientation from the first vertex's normal, so callers never think about winding.
  _facing(a, b, c) {
    const P = this.pos, N = this.nrm;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const wx = P[c * 3] - ax, wy = P[c * 3 + 1] - ay, wz = P[c * 3 + 2] - az;
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    return cx * N[a * 3] + cy * N[a * 3 + 1] + cz * N[a * 3 + 2] >= 0;
  }
  tri(a, b, c) { if (this._facing(a, b, c)) this.idx.push(a, b, c); else this.idx.push(a, c, b); }
  quad(a, b, c, d) {
    if (this._facing(a, b, c)) this.idx.push(a, b, c, a, c, d);
    else this.idx.push(a, c, b, a, d, c);
  }

  // Append a BufferGeometry (indexed or not) under a transform.
  geo(g, matrix, group = -1, values = {}) {
    this.begin(matrix, group, values);
    const p = g.attributes.position, nr = g.attributes.normal, base = this.n;
    for (let i = 0; i < p.count; i++) this.v(p.getX(i), p.getY(i), p.getZ(i), nr.getX(i), nr.getY(i), nr.getZ(i));
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    for (const k in this.sizes) g.setAttribute(k, new THREE.Float32BufferAttribute(this.ext[k], this.sizes[k]));
    if (this.ao) g.setAttribute('aAO', new THREE.BufferAttribute(this.ao, 1));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Chamfered box centred on the origin (half extents hx, hy, hz), emitted into M under its current transform.
// Faces are gridded to <= seg so per-vertex AO can resolve contacts. skip: {px, nx, py, ny, pz, nz} faces to omit
// (edges and corners stay unless all their faces are skipped).
const FACE_KEYS = [['nx', 'px'], ['ny', 'py'], ['nz', 'pz']];
function chamferBox(M, hx, hy, hz, c = 0.04, seg = 0.5, skip = null) {
  const h = [hx, hy, hz];
  c = Math.max(0, Math.min(c, hx * 0.45, hy * 0.45, hz * 0.45));
  const counts = h.map((v) => Math.max(1, Math.ceil((2 * v - 2 * c) / seg)));
  const P = [0, 0, 0], N = [0, 0, 0];
  const skipped = (k, s) => !!(skip && skip[FACE_KEYS[k][s > 0 ? 1 : 0]]);
  for (let k = 0; k < 3; k++) {
    for (const s of [-1, 1]) {
      if (skipped(k, s)) continue;
      const i = (k + 1) % 3, j = (k + 2) % 3, ni = counts[i], nj = counts[j];
      N[0] = N[1] = N[2] = 0; N[k] = s;
      const ids = [];
      for (let b = 0; b <= nj; b++) {
        for (let a = 0; a <= ni; a++) {
          P[k] = s * h[k];
          P[i] = -h[i] + c + (2 * h[i] - 2 * c) * a / ni;
          P[j] = -h[j] + c + (2 * h[j] - 2 * c) * b / nj;
          ids.push(M.v(P[0], P[1], P[2], N[0], N[1], N[2]));
        }
      }
      for (let b = 0; b < nj; b++) {
        for (let a = 0; a < ni; a++) {
          const r0 = b * (ni + 1), r1 = (b + 1) * (ni + 1);
          M.quad(ids[r0 + a], ids[r0 + a + 1], ids[r1 + a + 1], ids[r1 + a]);
        }
      }
    }
  }
  if (c < 1e-4) return;
  for (const [ka, kb, m] of [[0, 1, 2], [0, 2, 1], [1, 2, 0]]) {
    for (const sa of [-1, 1]) {
      for (const sb of [-1, 1]) {
        if (skipped(ka, sa) && skipped(kb, sb)) continue;
        const nm = counts[m];
        N[0] = N[1] = N[2] = 0; N[ka] = sa * SQRT1_2; N[kb] = sb * SQRT1_2;
        const ra = [], rb = [];
        for (let t = 0; t <= nm; t++) {
          const pm = -h[m] + c + (2 * h[m] - 2 * c) * t / nm;
          P[m] = pm; P[ka] = sa * h[ka]; P[kb] = sb * (h[kb] - c);
          ra.push(M.v(P[0], P[1], P[2], N[0], N[1], N[2]));
          P[m] = pm; P[ka] = sa * (h[ka] - c); P[kb] = sb * h[kb];
          rb.push(M.v(P[0], P[1], P[2], N[0], N[1], N[2]));
        }
        for (let t = 0; t < nm; t++) M.quad(ra[t], ra[t + 1], rb[t + 1], rb[t]);
      }
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        if (skipped(0, sx) && skipped(1, sy) && skipped(2, sz)) continue;
        const nx = sx * INV_SQRT3, ny = sy * INV_SQRT3, nz = sz * INV_SQRT3;
        const a = M.v(sx * hx, sy * (hy - c), sz * (hz - c), nx, ny, nz);
        const b = M.v(sx * (hx - c), sy * hy, sz * (hz - c), nx, ny, nz);
        const d = M.v(sx * (hx - c), sy * (hy - c), sz * hz, nx, ny, nz);
        M.tri(a, b, d);
      }
    }
  }
}

// =====================================================================================================================
// Materials: MeshStandardMaterial + world-space procedural surfaces (onBeforeCompile).
// Noise is sampled in WORLD space (no UVs: nothing stretches, faces of one block share one look). Every octave fades
// before its wavelength reaches ~2 pixels (pixel footprint from fwidth of the world position), so the top octave never
// exceeds what one pixel can resolve. Joints fade out at distance for the same reason.
// =====================================================================================================================
const GLSL_HEAD = /* glsl */`
  varying vec3 vPW;          // world position (m)
  varying vec3 vNW;          // world geometric normal
  uniform float uBump;       // multiplier on the procedural height (1 = heights as written, metres)
  uniform float uAODirect;   // share of the baked AO applied to direct light (0..1); indirect always gets all of it
  float gH = 0.0;            // procedural height (m): source of the bump
  float gRoughMul = 1.0;     // roughness = material.roughness * gRoughMul
  float gAO = 1.0;           // baked AO for this fragment (0..1)

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  // Value noise from uNoise3: a 64^3 RGBA8 texture holding four independent C1 value noises, periodic over 16 lattice
  // units, 4 texels per lattice cell (one trilinear fetch = one smooth octave). p in lattice units. Level 0 only:
  // callers fade octaves out before they alias, so no mip chain is needed and branches may skip the fetch.
  uniform highp sampler3D uNoise3;
  float vnoise(vec3 p) { return textureLod(uNoise3, p * 0.0625, 0.0).r; }
  // one band, about [-1, 1]: p in metres, freq in cycles per metre, px = pixel footprint (m); channel picks r/g/b/a
  float nzc(vec3 p, float freq, float px, vec4 channel) {
    float fade = 1.0 - smoothstep(0.25, 0.5, px * freq);
    if (fade <= 0.0) return 0.0;
    return (dot(textureLod(uNoise3, p * freq * 0.0625, 0.0), channel) - 0.5) * 2.0 * fade;
  }
  float nz(vec3 p, float freq, float px) { return nzc(p, freq, px, vec4(1.0, 0.0, 0.0, 0.0)); }
  // fbm over n octaves (n <= 4), each octave from the next channel
  float fbm(vec3 p, float freq, float px, int n) {
    float s = 0.0, a = 0.5;
    vec4 ch = vec4(1.0, 0.0, 0.0, 0.0);
    for (int i = 0; i < 4; i++) {
      if (i >= n) break;
      s += a * nzc(p, freq, px, ch);
      freq *= 2.03; a *= 0.5; p += vec3(11.7, 5.3, 8.1);
      ch = ch.wxyz;
    }
    return s;
  }
  float fbm4(vec3 p, float freq, float px) { return fbm(p, freq, px, 4); }
  // Running bond: q = (along, up) in metres, H = course height, L = mean block length, jit = 0..0.8 length jitter.
  // Returns (distance to the nearest joint (m), block hash 0..1, block index, course index).
  vec4 bond(vec2 q, float H, float L, float jit) {
    float row = floor(q.y / H);
    float fy = q.y - row * H;
    float x = q.x + hash21(vec2(row, 7.13)) * L;
    float k = floor(x / L);
    float b0 = k * L + (hash21(vec2(k, row)) - 0.5) * jit * L;
    float b1 = (k + 1.0) * L + (hash21(vec2(k + 1.0, row)) - 0.5) * jit * L;
    float id = k, lo = b0, hi = b1;
    if (x < b0) { id = k - 1.0; hi = b0; lo = (k - 1.0) * L + (hash21(vec2(k - 1.0, row)) - 0.5) * jit * L; }
    else if (x > b1) { id = k + 1.0; lo = b1; hi = (k + 2.0) * L + (hash21(vec2(k + 2.0, row)) - 0.5) * jit * L; }
    float d = min(min(x - lo, hi - x), min(fy, H - fy));
    return vec4(d, hash21(vec2(id, row) + 0.37), id, row);
  }
`;

// Stone uniforms: uColA/uColB light/dark stone, uColC grime, uMortar joint colour, uLichen, uPlaster (linear albedo).
const GLSL_STONE = /* glsl */`
  varying vec4 vTint;        // rgb: albedo multiplier per object; a: pattern (0 ashlar, 1 dressed, 2 plaster, 3 rubble)
  varying float vAO;         // baked vertex AO
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;
  uniform vec3 uMortar;
  uniform vec3 uLichen;
  uniform vec3 uPlaster;
`;
const GLSL_STONE_ALBEDO = /* glsl */`
  {
    vec3 P = vPW;
    vec3 N = normalize(vNW);
    vec3 aN = abs(N);
    float px = max(length(fwidth(P)), 1e-4);
    float pat = vTint.a;
    bool top = aN.y > 0.7;
    vec2 q = top ? P.xz : (aN.x > aN.z ? vec2(P.z, P.y) : vec2(P.x, P.y));
    vec4 bk = top ? bond(q, 0.62, 0.95, 0.5) : bond(q, 0.46, 1.05, 0.55);
    float masonry = (pat < 0.5 || (pat > 1.5 && pat < 2.5)) ? 1.0 : 0.0;
    float jointFade = 1.0 - smoothstep(0.012, 0.035, px);
    float lo  = fbm(P, 0.55, px, 2);
    float mid = fbm(P, 3.2, px, 3);
    float hi  = nz(P, 21.0, px);
    float jd  = mix(1.0, bk.x, masonry);
    float bid = mix(hash31(floor(P * 1.3)), bk.y, masonry);

    vec3 stone = mix(uColA, uColB, clamp(0.5 + lo * 1.3 + (bid - 0.5) * 0.32, 0.0, 1.0));
    stone *= 1.0 + mid * 0.14 + hi * 0.07;
    stone *= mix(vec3(1.025, 1.0, 0.97), vec3(0.975, 0.995, 1.025), bid);       // warm/cool per block
    if (pat > 2.5) stone = mix(uColB, uColC, clamp(0.45 + lo * 1.6, 0.0, 1.0)) * (1.0 + mid * 0.35);

    // lichen on sky-facing stone (coastal yellow-ochre blotches)
    float lich = smoothstep(0.66, 0.74, vnoise(P * 2.3 + 3.0) + mid * 0.25) * smoothstep(-0.2, 0.7, N.y)
               * (1.0 - smoothstep(0.1, 0.4, px * 2.3));
    stone = mix(stone, uLichen, lich * 0.3);
    // rain streaks and damp foot of the walls
    float streak = fbm(vec3(P.x * 5.0, P.y * 0.5, P.z * 5.0), 1.0, px * 5.0, 2);
    float damp = smoothstep(0.9, 0.0, P.y) * (1.0 - aN.y);
    float grime = clamp(smoothstep(0.1, 0.55, streak) * 0.32 * (1.0 - aN.y) + damp * 0.35, 0.0, 0.7);
    bool plasterPat = pat > 1.5 && pat < 2.5;
    stone = mix(stone, uColC, grime * (plasterPat ? 0.35 : 1.0));
    // joints: recessed lime mortar, worn block edges
    float jw = 0.009;
    float joint = (1.0 - smoothstep(jw, jw + px * 1.5 + 0.002, jd)) * jointFade * masonry;
    float wear = (1.0 - smoothstep(jw, jw + 0.06, jd)) * masonry;
    stone *= 1.0 - wear * 0.12 * jointFade;
    stone = mix(stone, uMortar * (1.0 + mid * 0.2), joint);
    float h = mid * 0.005 + hi * 0.0018 + smoothstep(jw, jw + 0.035, jd) * 0.005 * masonry - joint * 0.004;
    vec3 albedo = stone;
    float rough = 0.92;
    if (pat > 1.5 && pat < 2.5) {
      // lime plaster over the ashlar, fallen away in patches (never on tops, less near the damp foot)
      float pm = fbm(P + vec3(13.0, 0.0, 5.0), 0.7, px, 3) * 0.85 + nz(P + 3.0, 4.0, px) * 0.08 + 0.2 - damp * 0.4 - (top ? 1.0 : 0.0);
      float plaster = smoothstep(0.0, 0.012, pm);
      vec3 pc = uPlaster * (1.0 + mid * 0.06 + hi * 0.025 + lo * 0.12);
      pc = mix(pc, pc * vec3(0.80, 0.78, 0.76), smoothstep(0.15, 0.6, streak) * 0.55);
      stone *= 0.94 - 0.14 * (1.0 - smoothstep(0.0, 0.08, pm + 0.08)) * (1.0 - plaster);   // shadowed lip where the coat broke
      vec3 under = mix(stone, pc * 0.8, 0.45);   // lime residue left on the bare stone
      albedo = mix(under, pc, plaster);
      h = mix(h, 0.007 + mid * 0.0015, plaster);
      rough = mix(0.92, 0.86, plaster);
    }
    // the promontory darkens and cools toward the sea
    float sea = smoothstep(-1.0, -30.0, P.y);
    albedo *= mix(vec3(1.0), vec3(0.42, 0.47, 0.52), sea);
    diffuseColor.rgb *= albedo * vTint.rgb;
    gH = h * uBump;
    gRoughMul = rough;
    gAO = vAO;
  }
`;

// Floor uniforms: uColA/uColB flagstone light/dark, uColC joint dirt, uSand, uGrass (linear albedo);
// uMask: RGBA mask over the level footprint (r ground AO, g ground dirt, b balcony AO, a balcony dirt);
// uMaskMin (m, world xz of texel 0), uMaskSize (m, world extent); uUpperY: floors above this read the balcony channels.
const GLSL_FLOOR = /* glsl */`
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;
  uniform vec3 uSand;
  uniform vec3 uGrass;
  uniform sampler2D uMask;
  uniform vec2 uMaskMin;
  uniform vec2 uMaskSize;
  uniform float uUpperY;
`;
const GLSL_FLOOR_ALBEDO = /* glsl */`
  {
    vec3 P = vPW;
    float px = max(length(fwidth(P)), 1e-4);
    vec4 mk = texture2D(uMask, (P.xz - uMaskMin) / uMaskSize);
    bool upper = P.y > uUpperY;
    float ao = upper ? mk.b : mk.r;
    float dirt = upper ? mk.a * 0.55 : mk.g;
    float lo  = fbm(P, 0.4, px, 2);
    float mid = fbm(P, 3.0, px, 3);
    float hi  = nz(P, 19.0, px);
    vec4 bk = bond(P.xz, 0.66, 1.1, 0.6);                    // flagstones: courses run east-west
    float jointFade = 1.0 - smoothstep(0.015, 0.04, px);
    vec3 st = mix(uColA, uColB, clamp(0.5 + lo * 1.1 + (bk.y - 0.5) * 0.7, 0.0, 1.0));
    st *= 1.0 + mid * 0.14 + hi * 0.06;
    st *= mix(vec3(1.03, 1.0, 0.96), vec3(0.95, 0.98, 1.03), hash21(bk.zw + 3.1));
    // cracks in some stones
    float cr = abs(vnoise(P * 1.6 + bk.y * 10.0) - 0.5);
    float crack = (1.0 - smoothstep(0.006, 0.006 + px * 1.6, cr * 0.25)) * step(0.7, hash21(bk.zw)) * jointFade;
    float jw = 0.011;
    float joint = (1.0 - smoothstep(jw, jw + px * 1.5 + 0.002, bk.x)) * jointFade;
    float wear = 1.0 - smoothstep(jw, jw + 0.08, bk.x);
    st *= 1.0 - wear * 0.10 * jointFade;
    float gr = smoothstep(0.75, 0.95, vnoise(P * 3.0) + dirt * 0.3) * joint;   // weeds in the joints near walls
    vec3 jc = mix(uColC, uGrass, gr * 0.6);
    vec3 col = mix(st, jc, max(joint, crack * 0.8));
    // wind-blown sand along the walls and in the dry basin
    float sandN = fbm(P + vec3(4.0, 0.0, 9.0), 1.3, px, 3);
    float sand = smoothstep(0.25, 0.75, dirt + sandN * 0.5);
    col = mix(col, uSand * (1.0 + mid * 0.1 + hi * 0.05), sand * 0.85);
    float stoneH = smoothstep(jw, jw + 0.05, bk.x) * 0.006 + (hash21(bk.zw + 7.0) - 0.5) * 0.004 + mid * 0.003 - crack * 0.003;
    gH = mix(stoneH, mid * 0.004 + hi * 0.002, sand) * uBump;
    gRoughMul = mix(0.9, 0.98, sand);
    gAO = ao;
    diffuseColor.rgb *= col;
  }
`;

// Wood uniforms: uColA weathered light wood, uColB dark wood (linear albedo).
// vWL: position in the plank object's local frame (m); vWH: half extents (m) and kind (0 crate, 1 door).
const GLSL_WOOD = /* glsl */`
  varying vec3 vWL;
  varying vec4 vWH;
  varying float vAO;
  uniform vec3 uColA;
  uniform vec3 uColB;
`;
const GLSL_WOOD_ALBEDO = /* glsl */`
  {
    vec3 P = vPW;
    float px = max(length(fwidth(P)), 1e-4);
    vec3 L = vWL, Hh = vWH.xyz;
    bool door = vWH.w > 0.5;
    vec3 r = abs(L) / Hh;
    vec2 uv, ext;
    bool topFace = false;
    if (r.x > r.y && r.x > r.z) { uv = L.zy; ext = Hh.zy; }
    else if (r.y > r.z) { uv = L.xz; ext = Hh.xz; topFace = true; }
    else { uv = L.xy; ext = Hh.xy; }
    float along = door ? uv.y : uv.x;
    float across = door ? uv.x : uv.y;
    float pw = door ? 0.19 : 0.155;
    float fs = fract(across / pw);
    float pidx = floor(across / pw);
    float dSeam = min(fs, 1.0 - fs) * pw;
    float seamFade = 1.0 - smoothstep(0.01, 0.03, px);
    float seam = (1.0 - smoothstep(0.004, 0.004 + px * 1.5, dSeam)) * seamFade;
    // battens: crate frame on every face edge plus a diagonal brace on the sides; door: two cross battens
    float edgeD = min(ext.x - abs(uv.x), ext.y - abs(uv.y));
    float batten = door ? 0.0 : step(edgeD, 0.085);
    if (!door && !topFace) batten = max(batten, step(abs(uv.x * ext.y - uv.y * ext.x) / length(ext), 0.05));
    if (door) batten = step(abs(abs(uv.y) - (ext.y - 0.5)), 0.065);
    float grain = fbm(vec3(along * 0.7, across * 16.0 + pidx * 3.1, vWH.w + batten * 5.0), 1.0, px * 16.0, 3);
    float lo = fbm(P, 0.8, px, 2);
    vec3 wood = mix(uColA, uColB, clamp(0.5 + grain * 1.3 + (hash21(vec2(pidx, vWH.w)) - 0.5) * 0.5, 0.0, 1.0));
    wood = mix(wood, vec3(dot(wood, vec3(0.33))) * 1.08, clamp(0.35 + lo * 0.6, 0.0, 1.0) * 0.6);   // silvered by sun
    wood *= 1.0 - batten * 0.12;
    wood = mix(wood, uColB * 0.35, seam * (1.0 - batten));
    // nail heads / door studs on the battens
    vec2 nq = vec2(along / pw, across / pw);
    float stud = batten * (1.0 - smoothstep(0.012, 0.022, length((fract(nq) - 0.5) * pw))) * seamFade;
    wood = mix(wood, vec3(0.05, 0.045, 0.04), stud);
    diffuseColor.rgb *= wood;
    gH = (batten * 0.015 - seam * 0.004 * (1.0 - batten) + grain * 0.0008 + stud * 0.003) * uBump;
    gRoughMul = mix(0.88, 0.55, stud);
    gAO = vAO;
  }
`;

// Mikkelsen's surface-gradient bump on gH (metres): dH/dpixel over dP/dpixel, so strength is physical at any distance.
const GLSL_BUMP = /* glsl */`
  {
    vec3 sx = dFdx(- vViewPosition);
    vec3 sy = dFdy(- vViewPosition);
    float dHx = dFdx(gH);
    float dHy = dFdy(gH);
    vec3 R1 = cross(sy, normal);
    vec3 R2 = cross(normal, sx);
    float det = dot(sx, R1) * faceDirection;
    vec3 grad = sign(det) * (dHx * R1 + dHy * R2);
    normal = normalize(abs(det) * normal - grad);
  }
`;
const GLSL_AO = /* glsl */`
  reflectedLight.indirectDiffuse *= gAO;
  reflectedLight.indirectSpecular *= gAO;
  reflectedLight.directDiffuse *= mix(1.0, gAO, uAODirect);
`;

function makeSurfaceMaterial(kind, uniforms, { roughness = 1 } = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness, metalness: 0 });
  const head = { stone: GLSL_STONE, floor: GLSL_FLOOR, wood: GLSL_WOOD }[kind];
  const albedo = { stone: GLSL_STONE_ALBEDO, floor: GLSL_FLOOR_ALBEDO, wood: GLSL_WOOD_ALBEDO }[kind];
  let vDecl = 'varying vec3 vPW;\nvarying vec3 vNW;\n';
  let vBody = 'vPW = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvNW = normalize(mat3(modelMatrix) * objectNormal);\n';
  if (kind === 'stone') {
    vDecl += 'attribute vec4 aTint;\nattribute float aAO;\nvarying vec4 vTint;\nvarying float vAO;\n';
    vBody += 'vTint = aTint;\nvAO = aAO;\n';
  } else if (kind === 'wood') {
    vDecl += 'attribute vec3 aWL;\nattribute vec4 aWH;\nattribute float aAO;\nvarying vec3 vWL;\nvarying vec4 vWH;\nvarying float vAO;\n';
    vBody += 'vWL = aWL;\nvWH = aWH;\nvAO = aAO;\n';
  }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + vDecl)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + vBody);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_HEAD + head)
      .replace('#include <map_fragment>', albedo)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(roughness * gRoughMul, 0.04, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + GLSL_BUMP)
      .replace('#include <aomap_fragment>', GLSL_AO);
  };
  m.customProgramCacheKey = () => 'cover-room-level-' + kind;
  m.userData.uniforms = uniforms;
  return m;
}

const col = (hex) => new THREE.Color(hex);

// 64^3 RGBA8 value-noise texture: four independent smooth (smoothstep-faded) value noises on a 16^3 periodic lattice,
// sampled at texel centres, so trilinear filtering reproduces the C1 noise closely. Built once per page (~40 ms).
let NOISE3 = null;
function noiseTexture() {
  if (NOISE3) return NOISE3;
  const N = 64, L = 16, S = N / L;
  const lat = new Float32Array(L * L * L * 4);
  for (let i = 0; i < lat.length; i++) {
    let h = Math.imul(i + 1, 2654435761) ^ 0x5bd1e995;
    h = Math.imul(h ^ (h >>> 15), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917);
    lat[i] = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  const at = (i, j, k, c) => lat[((((k & 15) * L + (j & 15)) * L + (i & 15)) << 2) + c];
  const sm = (t) => t * t * (3 - 2 * t);
  const data = new Uint8Array(N * N * N * 4);
  let o = 0;
  for (let z = 0; z < N; z++) {
    const qz = (z + 0.5) / S, k = Math.floor(qz), w = sm(qz - k);
    for (let y = 0; y < N; y++) {
      const qy = (y + 0.5) / S, j = Math.floor(qy), v = sm(qy - j);
      for (let x = 0; x < N; x++) {
        const qx = (x + 0.5) / S, i = Math.floor(qx), u = sm(qx - i);
        for (let c = 0; c < 4; c++) {
          const a = at(i, j, k, c) + (at(i + 1, j, k, c) - at(i, j, k, c)) * u;
          const b = at(i, j + 1, k, c) + (at(i + 1, j + 1, k, c) - at(i, j + 1, k, c)) * u;
          const d = at(i, j, k + 1, c) + (at(i + 1, j, k + 1, c) - at(i, j, k + 1, c)) * u;
          const e = at(i, j + 1, k + 1, c) + (at(i + 1, j + 1, k + 1, c) - at(i, j + 1, k + 1, c)) * u;
          const f0 = a + (b - a) * v, f1 = d + (e - d) * v;
          data[o++] = Math.round((f0 + (f1 - f0) * w) * 255);
        }
      }
    }
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  NOISE3 = t;
  return t;
}

// =====================================================================================================================
// Canvas atlas for ivy, grass and banners (1024 x 1024, sRGB). Regions (canvas px, y down):
//   ivy curtain (hangs from a top edge)  0..512 x 0..512      ivy patch (grows up from the ground)  0..512 x 512..1024
//   grass tuft                          512..768 x 0..256     dry grass / weeds                   512..768 x 256..512
//   banner                              768..1024 x 0..1024
// =====================================================================================================================
const ATLAS = {
  ivyHang: [0, 0, 512, 512], ivyPatch: [0, 512, 512, 1024], grass: [512, 0, 768, 256],
  weeds: [512, 256, 768, 512], banner: [768, 0, 1024, 1024],
};
function atlasUV(name) {   // -> [u0, v0, u1, v1] with v up (CanvasTexture flipY)
  const [x0, y0, x1, y1] = ATLAS[name];
  return [x0 / 1024, 1 - y1 / 1024, x1 / 1024, 1 - y0 / 1024];
}

function makeAtlas(seed) {
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const greens = ['#2c4620', '#365424', '#43652b', '#507336', '#3c5d29', '#5f8040', '#2f4f27'];

  function leaf(x, y, s, a, c) {
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.fillStyle = c;
    g.beginPath();
    g.ellipse(0, -s * 0.12, s * 0.40, s * 0.52, 0, 0, Math.PI * 2);
    g.ellipse(-s * 0.36, s * 0.12, s * 0.30, s * 0.34, -0.6, 0, Math.PI * 2);
    g.ellipse(s * 0.36, s * 0.12, s * 0.30, s * 0.34, 0.6, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(210,225,160,0.22)';
    g.lineWidth = Math.max(1, s * 0.06);
    g.beginPath(); g.moveTo(0, s * 0.35); g.lineTo(0, -s * 0.5); g.stroke();
    g.restore();
  }
  function clip(name) {
    const [x0, y0, x1, y1] = ATLAS[name];
    g.save();
    g.beginPath(); g.rect(x0, y0, x1 - x0, y1 - y0); g.clip();
    return [x0, y0, x1 - x0, y1 - y0];
  }

  // ivy curtain: dense mat at the top edge, vines hanging down with thinning leaves
  {
    const [x0, y0, w, h] = clip('ivyHang');
    for (let i = 0; i < 320; i++) leaf(x0 + rnd() * w, y0 + 4 + rnd() * rnd() * 100, 13 + rnd() * 12, rnd() * 6.28, pick(greens));
    for (let v = 0; v < 20; v++) {
      let x = x0 + 16 + rnd() * (w - 32), y = y0 + 8;
      const len = 120 + rnd() * 370, ph = rnd() * 6.28;
      const pts = [];
      g.strokeStyle = '#4b4229'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, y);
      while (y < y0 + 8 + len && y < y0 + h - 8) {
        y += 6; x += Math.sin(ph + y * 0.03) * 1.8 + (rnd() - 0.5) * 1.5;
        pts.push([x, y]); g.lineTo(x, y);
      }
      g.stroke();
      pts.forEach(([px, py], k) => {
        if (k % 2) return;
        const s = (15 + rnd() * 9) * (1 - 0.45 * (py - y0) / h);
        leaf(px + (k % 4 ? 6 : -6), py, s, Math.PI + (rnd() - 0.5) * 1.3, pick(greens));
      });
    }
    g.restore();
  }
  // ivy patch: a mound rising from the bottom edge with a few climbing runners
  {
    const [x0, y0, w, h] = clip('ivyPatch');
    for (let r = 0; r < 7; r++) {
      let x = x0 + 60 + rnd() * (w - 120), y = y0 + h - 4;
      g.strokeStyle = '#4b4229'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, y);
      const top = y0 + 30 + rnd() * 200;
      while (y > top) {
        y -= 7; x += (rnd() - 0.5) * 6; g.lineTo(x, y);
        if (rnd() < 0.6) leaf(x + (rnd() - 0.5) * 14, y, 12 + rnd() * 8, (rnd() - 0.5) * 1.4, pick(greens));
      }
      g.stroke();
    }
    for (let i = 0; i < 1100; i++) {
      const u = (rnd() - 0.5) * 2 * Math.sqrt(rnd());
      const yy = Math.pow(rnd(), 0.75) * (h - 40) * (1 - u * u);
      leaf(x0 + w / 2 + u * (w / 2 - 16), y0 + h - 6 - yy, 13 + rnd() * 10, (rnd() - 0.5) * 2.2, pick(greens));
    }
    g.restore();
  }
  // grass tufts
  function tuft(name, cols, blades, lean) {
    const [x0, y0, w, h] = clip(name);
    g.lineCap = 'round';
    for (let i = 0; i < blades; i++) {
      const bx = x0 + w / 2 + (rnd() - 0.5) * w * 0.32, by = y0 + h - 2;
      const len = (h - 10) * (0.35 + rnd() * 0.65), l = (rnd() - 0.5) * w * lean;
      g.strokeStyle = pick(cols); g.lineWidth = 2 + rnd() * 3;
      g.beginPath(); g.moveTo(bx, by);
      g.quadraticCurveTo(bx + l * 0.15, by - len * 0.6, bx + l, by - len);
      g.stroke();
    }
    g.restore();
  }
  tuft('grass', ['#5f6f2f', '#6f7c38', '#7f8a44', '#4f6128', '#8c8f4f'], 70, 0.9);
  tuft('weeds', ['#9a925c', '#a99f68', '#8a8350', '#b3a874', '#77783f'], 55, 1.1);
  {   // seed heads on the dry weeds
    const [x0, y0, w, h] = clip('weeds');
    for (let i = 0; i < 26; i++) {
      g.fillStyle = pick(['#c8b98a', '#b8a676', '#d6c89b']);
      g.beginPath(); g.ellipse(x0 + w * (0.2 + rnd() * 0.6), y0 + 18 + rnd() * h * 0.45, 3, 7, (rnd() - 0.5), 0, 6.28); g.fill();
    }
    g.restore();
  }
  // banner: faded madder cloth, ochre borders, an original sun-over-waves device, swallowtail bottom, wear
  {
    const [x0, y0, w, h] = clip('banner');
    g.beginPath();
    g.moveTo(x0 + 6, y0); g.lineTo(x0 + w - 6, y0); g.lineTo(x0 + w - 6, y0 + h - 10);
    g.lineTo(x0 + w / 2, y0 + h - 150); g.lineTo(x0 + 6, y0 + h - 10); g.closePath();
    g.clip();
    const grad = g.createLinearGradient(0, y0, 0, y0 + h);
    grad.addColorStop(0, '#6a2219'); grad.addColorStop(0.6, '#7e3324'); grad.addColorStop(1, '#93503a');
    g.fillStyle = grad; g.fillRect(x0, y0, w, h);
    g.strokeStyle = '#c29b54'; g.lineWidth = 9;
    g.strokeRect(x0 + 22, y0 + 26, w - 44, h - 120);
    g.lineWidth = 3; g.strokeRect(x0 + 34, y0 + 38, w - 68, h - 144);
    const cx = x0 + w / 2;
    g.lineWidth = 10; g.beginPath(); g.arc(cx, y0 + 300, 62, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#c29b54'; g.beginPath(); g.arc(cx, y0 + 300, 30, 0, Math.PI * 2); g.fill();
    for (let k = 0; k < 12; k++) {
      const a = k * Math.PI / 6;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * 76, y0 + 300 + Math.sin(a) * 76);
      g.lineTo(cx + Math.cos(a) * 96, y0 + 300 + Math.sin(a) * 96); g.lineWidth = 6; g.stroke();
    }
    g.lineWidth = 8;
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      for (let x = x0 + 46; x <= x0 + w - 46; x += 4) {
        const y = y0 + 450 + k * 44 + Math.sin((x - x0) * 0.075 + k * 1.3) * 10;
        if (x === x0 + 46) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let i = 0; i < 5000; i++) {   // fading, stains, weave noise
      const a = rnd();
      g.fillStyle = a < 0.5 ? `rgba(255,235,200,${0.04 + rnd() * 0.06})` : `rgba(30,10,5,${0.04 + rnd() * 0.08})`;
      g.fillRect(x0 + rnd() * w, y0 + rnd() * h, 2 + rnd() * 6, 2 + rnd() * 10);
    }
    for (let i = 0; i < 18; i++) {     // rain streaks
      g.fillStyle = 'rgba(20,8,4,0.10)';
      g.fillRect(x0 + rnd() * w, y0 + rnd() * 200, 3 + rnd() * 5, 200 + rnd() * 500);
    }
    g.globalCompositeOperation = 'destination-out';   // frayed bottom and moth holes
    for (let x = x0; x < x0 + w; x += 7) {
      const t = (x - x0) / w, yb = y0 + h - 10 - (1 - Math.abs(t - 0.5) * 2) * 140;
      g.beginPath(); g.moveTo(x, yb + 4); g.lineTo(x + 3.5, yb - 6 - rnd() * 22); g.lineTo(x + 7, yb + 4); g.fill();
    }
    for (let i = 0; i < 7; i++) { g.beginPath(); g.arc(x0 + 30 + rnd() * (w - 60), y0 + 200 + rnd() * 650, 2 + rnd() * 6, 0, 6.28); g.fill(); }
    g.globalCompositeOperation = 'source-over';
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// =====================================================================================================================
// Sky dome: sky gradient, sun glow + disc, clouds, a distant headland and the sea below the horizon. Directional only,
// drawn first and translation-free (view rotation only), so it is infinitely far away.
// =====================================================================================================================
function makeSky(L) {
  const u = {
    uSunDir:  { value: new THREE.Vector3(0, 1, 0) },   // world unit vector toward the sun
    uZenith:  { value: col(L.zenith) },                 // radiance straight up (linear)
    uMid:     { value: col(L.mid) },                    // radiance ~30 deg up
    uHorizon: { value: col(L.horizon) },                // radiance at the horizon (also the sea haze line)
    uGlow:    { value: col(L.glow) },                   // radiance added around the sun and on the sea glints
    uSeaDeep: { value: col(L.seaDeep) },                // sea looking down
    uSeaHaze: { value: col(L.seaHaze) },                // sea at grazing angles (sky reflection)
    uLand:    { value: col(L.land) },                   // distant headland silhouette
    uSunDisc: { value: L.sunDisc },                     // sun disc radiance (> 1 blooms; emissive)
    uNoise3:  { value: noiseTexture() },                // shared value-noise volume (see noiseTexture)
  };
  // Drawn after the opaque level at the far plane with the depth test on, so early-z shades only the visible sky.
  const mat = new THREE.ShaderMaterial({
    uniforms: u, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;                                   // unit sphere: local position == world direction
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
        gl_Position.z = p.w * 0.99999;                     // just inside the far plane: passes LessEqual where nothing drew
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir;
      uniform vec3 uZenith;
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uGlow;
      uniform vec3 uSeaDeep;
      uniform vec3 uSeaHaze;
      uniform vec3 uLand;
      uniform float uSunDisc;
      uniform highp sampler3D uNoise3;
      varying vec3 vDir;

      float hash21(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float vn2(vec2 p) { return textureLod(uNoise3, vec3(p * 0.0625, 0.37), 0.0).g; }
      float fbm2(vec2 p) {
        vec4 n0 = textureLod(uNoise3, vec3(p * 0.0625, 0.11), 0.0);
        vec4 n1 = textureLod(uNoise3, vec3(p * 0.129, 0.53), 0.0);
        vec4 n2 = textureLod(uNoise3, vec3(p * 0.267, 0.79), 0.0);
        return n0.r * 0.5 + n1.g * 0.25 + n2.b * 0.125 + n2.a * 0.0625 + 0.03;   // 4 octaves, ~[0, 1]
      }

      void main() {
        vec3 d = normalize(vDir);
        float up = d.y;
        float sd = max(dot(d, uSunDir), 0.0);
        float u = max(up, 0.0);
        vec3 col;
        if (up >= 0.0) {
          col = mix(uHorizon, uMid, smoothstep(0.0, 0.28, u));
          col = mix(col, uZenith, smoothstep(0.22, 0.95, u));
          col += uGlow * (0.20 * pow(sd, 4.0) + 0.25 * pow(sd, 24.0)) * (0.6 + 0.4 * exp(-u * 3.0));
          // fair-weather clouds low in the sky, lit warm on the sun side
          vec2 cp = d.xz / (u + 0.12);
          float c = fbm2(cp * 0.35 + vec2(3.0, 1.0));
          float cm = smoothstep(0.50, 0.76, c) * smoothstep(0.02, 0.16, u) * (1.0 - smoothstep(0.45, 0.85, u));
          vec3 cloud = mix(uHorizon * 1.04, uGlow * 0.78, pow(sd, 3.0));
          col = mix(col, cloud, cm * 0.6);
          // distant headland, south-west to west (bearing 0 = north, -pi/2 = west)
          float az = atan(d.x, -d.z);
          float win = smoothstep(-2.75, -2.35, az) * (1.0 - smoothstep(-1.25, -0.85, az));
          float hl = win * (0.004 + 0.034 * fbm2(vec2(az * 5.0, 2.0)) * fbm2(vec2(az * 1.3, 7.0)) * 2.0);
          float land = 1.0 - smoothstep(hl - 0.0015, hl + 0.0015, u);
          col = mix(col, mix(uLand, uHorizon, 0.35), land * step(0.0005, hl));
        } else {
          float dn = -up;
          float fres = pow(1.0 - dn, 5.0);
          col = mix(uSeaDeep, uSeaHaze, clamp(fres + 0.08, 0.0, 1.0));
          vec3 r = vec3(d.x, -d.y, d.z);
          float rs = max(dot(r, uSunDir), 0.0);
          vec2 sp = d.xz / max(dn, 0.02);
          float spark = smoothstep(0.62, 0.92, vn2(sp * 7.0)) * smoothstep(0.55, 0.9, vn2(sp * 1.7 + 3.0));
          col += uGlow * (pow(rs, 140.0) * (0.2 + spark * 3.0) + pow(rs, 10.0) * 0.07);
          col = mix(col, uHorizon, exp(-dn * 70.0) * 0.85);   // haze line at the horizon
        }
        // soft shoulder: the environment stays under ~0.75 (core/render.js: only emissive values bloom)
        vec3 over = max(col - 0.55, 0.0);
        col = min(col, vec3(0.55)) + 0.2 * (1.0 - exp(-over / 0.2));
        col += vec3(1.0, 0.93, 0.80) * uSunDisc * smoothstep(0.99955, 0.99988, sd) * step(0.0, up);
        col += (hash21(gl_FragCoord.xy) - 0.5) * (0.0006 + 0.008 * dot(col, vec3(0.2126, 0.7152, 0.0722)));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  sky.name = 'level-sky';
  sky.frustumCulled = false;
  sky.renderOrder = 900;   // after the opaque level (three sorts by renderOrder first), before debug overlays
  sky.matrixAutoUpdate = false;
  return sky;
}

// =====================================================================================================================
// The build
// =====================================================================================================================
function buildRoom(game, level) {
  const t0 = performance.now();
  const B = LAYOUT.balcony, R = LAYOUT.room, ST = LAYOUT.stairs, G = LAYOUT.gate, F = LAYOUT.fountain;
  const rnd = mulberry32(20261111);
  const scene = game.scene;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const stone = new Mesher('stone', { aTint: 4 });
  const floor = new Mesher('floor');
  const wood = new Mesher('wood', { aWL: 3, aWH: 4 });
  const leaves = new Mesher('foliage', { uv: 2, aSway: 1 });
  const boxes = level.boxes;   // collider records (see solid())

  // --- solids: one record per collider; also the AO occluders and the nav/cover source ------------------------------
  function solid(id, cx, cy, cz, sx, sy, sz, yaw, tags, material = 'stone', extra = {}) {
    const rec = {
      id, cx, cy, cz, hx: sx / 2, hy: sy / 2, hz: sz / 2, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw),
      top: cy + sy / 2, bottom: cy - sy / 2, tags: new Set(tags), material, index: boxes.length, ...extra,
    };
    rec.group = extra.group ?? rec.index;
    boxes.push(rec);
    return rec;
  }
  // stone box: collider (unless vis.noCollide) + chamfered visual
  function stoneBox(id, cx, cy, cz, sx, sy, sz, yaw, tags, vis = {}) {
    const rec = vis.noCollide ? null : solid(id, cx, cy, cz, sx, sy, sz, yaw, tags, vis.material || 'stone', vis.rec);
    const tint = vis.tint || [1, 1, 1];
    stone.begin(xform(cx, cy, cz, yaw), vis.group ?? (rec ? rec.group : -1),
      { aTint: [tint[0], tint[1], tint[2], vis.pat ?? PAT.ashlar] });
    chamferBox(stone, sx / 2, sy / 2, sz / 2, vis.chamfer ?? 0.04, vis.seg ?? 0.5, vis.skip ?? { ny: true });
    return rec;
  }
  const jitterTint = (k = 0.06) => { const v = 1 + (rnd() - 0.5) * k; return [v * (1 + (rnd() - 0.5) * 0.03), v, v * (1 + (rnd() - 0.5) * 0.03)]; };

  // --- ground ---------------------------------------------------------------------------------------------------------
  solid('ground', 0, -0.25, 0.4, 32.4, 0.5, 25.6, 0, ['floor', 'ground']);
  addFloorQuad(floor, R.x0, R.x1, B.z, G.doorZ + 0.3, 0);

  // --- north and east ramparts (balcony walkway on top) ----------------------------------------------------------------
  const rampZ0 = R.z0, rampZ1 = B.z, rampH = B.y;
  const rc = 0.04;
  // three colliders (the middle one is the climbable block), one seamless visual
  const rampGroup = 2000, rz = (rampZ0 + rampZ1) / 2, rd = rampZ1 - rampZ0;
  solid('rampartW', (R.x0 + CLIMB.wall.x0) / 2, rampH / 2, rz, CLIMB.wall.x0 - R.x0, rampH, rd, 0, ['floor', 'wall'], 'stone', { group: rampGroup });
  solid('rampartClimb', (CLIMB.wall.x0 + CLIMB.wall.x1) / 2, rampH / 2, rz, CLIMB.wall.x1 - CLIMB.wall.x0, rampH, rd, 0,
    ['floor', 'wall', 'climbable'], 'stone', { group: rampGroup });
  solid('rampartE', (CLIMB.wall.x1 + R.x1) / 2, rampH / 2, rz, R.x1 - CLIMB.wall.x1, rampH, rd, 0, ['floor', 'wall'], 'stone', { group: rampGroup });
  stoneBox('rampartN', 0, rampH / 2, rz, R.x1 - R.x0, rampH, rd, 0, [],
    { noCollide: true, group: rampGroup, chamfer: rc, skip: { ny: true, py: true, nz: true, nx: true, px: true } });
  stoneBox('rampartSide', (B.eastX + R.x1) / 2, rampH / 2, (B.z + B.eastZ) / 2, R.x1 - B.eastX, rampH, B.eastZ - B.z, 0,
    ['floor', 'wall'], { chamfer: rc, skip: { ny: true, py: true, px: true, nz: true } });
  addFloorQuad(floor, R.x0, R.x1, rampZ0, rampZ1 - rc, rampH);
  addFloorQuad(floor, B.eastX + rc, R.x1, rampZ1 - 0.5, B.eastZ - rc, rampH);
  // coping strip along the climb top (lighter, worn: reads as the grab edge)
  stoneBox('climbLip', (CLIMB.gap.x0 + CLIMB.gap.x1) / 2, rampH - 0.056, rampZ1 - 0.14, CLIMB.gap.x1 - CLIMB.gap.x0, 0.12, 0.3, 0, [],
    { noCollide: true, pat: PAT.dressed, tint: [1.16, 1.12, 1.04], chamfer: 0.025, skip: { ny: true, nz: true } });

  // parapets (low cover for balcony enemies), with the climb gap
  const pT = B.parapetT, pY = B.y + B.parapetH / 2;
  stoneBox('parapetNW', (R.x0 + CLIMB.gap.x0) / 2, pY, B.z - pT / 2, CLIMB.gap.x0 - R.x0, B.parapetH, pT, 0, ['parapet', 'cover-low'],
    { chamfer: 0.03, tint: [1.02, 1.0, 0.97] });
  stoneBox('parapetN', (CLIMB.gap.x1 + B.eastX + pT) / 2, pY, B.z - pT / 2, B.eastX + pT - CLIMB.gap.x1, B.parapetH, pT, 0,
    ['parapet', 'cover-low'], { chamfer: 0.03, tint: [1.02, 1.0, 0.97] });
  stoneBox('parapetE', B.eastX + pT / 2, pY, (B.z + B.eastZ) / 2, pT, B.parapetH, B.eastZ - B.z, 0, ['parapet', 'cover-low'],
    { chamfer: 0.03, tint: [1.02, 1.0, 0.97] });

  // --- outer walls: battlements behind the walkway, ruined walls elsewhere ------------------------------------------
  const oT = B.outerT, wT = LAYOUT.wallT;
  battlement('wallN', R.x0 - wT, R.x1 + oT, R.z0 - oT, R.z0, 'x', B.backTop);
  battlement('wallE', R.x1, R.x1 + oT, R.z0, 4.5, 'z', B.backTop);
  battlement('wallWN', R.x0 - wT, R.x0, R.z0, -6.0, 'z', B.backTop);
  ruinedWall('wallW', R.x0 - wT, R.x0, -6.0, R.z1 + G.depth, 'z', (s) => 3.6 + 3.2 * Math.max(0, 1 - s / 3.5) + 0.9 * Math.sin(s * 0.55 + 1.0));
  ruinedWall('wallES', R.x1, R.x1 + wT, 4.5, R.z1 + G.depth, 'z', (s) => 6.4 - Math.min(s, 3) * 0.7 + 0.6 * Math.sin(s * 0.9));
  ruinedWall('wallSW', R.x0, G.x0, R.z1, R.z1 + G.depth, 'x', (s, len) => 3.4 + 0.8 * Math.sin(s * 0.45) + 1.6 * Math.max(0, 1 - (len - s) / 2.2));
  ruinedWall('wallSE', G.x1, R.x1, R.z1, R.z1 + G.depth, 'x', (s) => 3.5 + 0.9 * Math.sin(s * 0.5 + 2.0) + 1.6 * Math.max(0, 1 - s / 2.2));
  // gate: jambs, lintel, closed door
  const jambW = 0.55, jambD = 0.25, gateTop = G.lintelY + 0.8;
  stoneBox('jambW', G.x0 - jambW / 2, gateTop / 2, R.z1 - jambD / 2, jambW, gateTop, jambD, 0, ['wall'], { pat: PAT.dressed, tint: [1.05, 1.03, 1.0] });
  stoneBox('jambE', G.x1 + jambW / 2, gateTop / 2, R.z1 - jambD / 2, jambW, gateTop, jambD, 0, ['wall'], { pat: PAT.dressed, tint: [1.05, 1.03, 1.0] });
  stoneBox('lintel', 0, G.lintelY + 0.4, R.z1 + (G.depth - jambD) / 2, G.x1 - G.x0 + 2 * jambW, 0.8, G.depth + jambD, 0, ['wall'],
    { pat: PAT.dressed, tint: [1.06, 1.04, 1.0], skip: {} });
  {
    const dz = G.doorZ + 0.1, dh = G.lintelY;
    solid('door', 0, dh / 2, dz, G.x1 - G.x0, dh, 0.2, 0, ['wall', 'door'], 'wood');
    plankBox(0, dh / 2, dz, G.x1 - G.x0, dh, 0.2, 0, 1, boxes.length - 1);
  }

  // --- stairs on the east: stacked step boxes, top step meets the east rampart --------------------------------------
  const nSteps = Math.round(B.y / ST.rise) - 1;
  for (let k = 1; k <= nSteps; k++) {
    const z0 = B.eastZ + (nSteps - k) * ST.tread, h = k * ST.rise;
    stoneBox(`step${k}`, (ST.x0 + ST.x1) / 2, h / 2, z0 + ST.tread / 2, ST.x1 - ST.x0, h, ST.tread, 0, ['stairs'],
      { chamfer: 0.025, tint: jitterTint(0.05), skip: { ny: true, px: true, nz: k < nSteps } });
  }
  level.stairsFoot = B.eastZ + nSteps * ST.tread;

  // --- cover pieces ----------------------------------------------------------------------------------------------------
  for (const pc of LAYOUT.pieces) buildPiece(pc);

  // --- fountain ----------------------------------------------------------------------------------------------------------
  buildFountain();

  // --- climbable ledges and holds ---------------------------------------------------------------------------------------
  for (const e of CLIMB.edges) {
    if (e.kind === 'top') continue;
    const x0 = e.kind === 'hold' ? e.x - CLIMB.holdW / 2 : e.x0, x1 = e.kind === 'hold' ? e.x + CLIMB.holdW / 2 : e.x1;
    const t = e.kind === 'hold' ? CLIMB.holdT : CLIMB.ledgeT;
    stoneBox(`climb.${e.id}`, (x0 + x1) / 2, e.y - t / 2, B.z + CLIMB.protrude / 2, x1 - x0, t, CLIMB.protrude, 0,
      ['climbable', e.kind], { pat: PAT.dressed, tint: [1.2, 1.15, 1.05], chamfer: 0.02, skip: { nz: true } });
  }
  // the light strip on every grab edge, from the same data the controller reads (climb-spec: ND's white-line rule)
  for (const e of CLIMB.edges) {
    const x0 = e.kind === 'hold' ? e.x - CLIMB.holdW / 2 : e.x0, x1 = e.kind === 'hold' ? e.x + CLIMB.holdW / 2 : e.x1;
    const gz = e.kind === 'top' ? B.z : B.z + CLIMB.protrude;
    stoneBox(`strip.${e.id}`, (x0 + x1) / 2, e.y - 0.02, gz - 0.016, x1 - x0 - 0.02, 0.045, 0.038, 0, [],
      { noCollide: true, pat: PAT.dressed, tint: [1.85, 1.8, 1.68], chamfer: 0.008, skip: { nz: true } });
  }

  // --- the rock the fort stands on (visual only; frames the overview, never reached in play)
  {
    const cliff = cliffGeometry(R, LAYOUT.gate.depth, 5);
    stone.geo(cliff, xform(0, 0, 0), -1, { aTint: [0.9, 0.87, 0.84, PAT.rubble] });
    cliff.dispose();
  }

  // --- life: rubble, ivy, grass, banners -----------------------------------------------------------------------------
  scatterRubble();
  placeFoliage();

  // --- bake: vertex AO for stone and wood, floor mask ------------------------------------------------------------------
  const tBake = performance.now();
  stone.ao = bakeVertexAO(stone, boxes);
  wood.ao = bakeVertexAO(wood, boxes);
  const mask = bakeFloorMask(boxes);
  const bakeMs = performance.now() - tBake;

  // --- materials + meshes ------------------------------------------------------------------------------------------------
  const common = { uBump: { value: 1 }, uAODirect: { value: LIGHTING.aoDirect }, uNoise3: { value: noiseTexture() } };
  const stoneMat = makeSurfaceMaterial('stone', {
    ...common, uColA: { value: col(PAL.stone[0]) }, uColB: { value: col(PAL.stone[1]) }, uColC: { value: col(PAL.stone[2]) },
    uMortar: { value: col(PAL.mortar) }, uLichen: { value: col(PAL.lichen) }, uPlaster: { value: col(PAL.plaster) },
  });
  const floorMat = makeSurfaceMaterial('floor', {
    ...common, uColA: { value: col(PAL.floor[0]) }, uColB: { value: col(PAL.floor[1]) }, uColC: { value: col(PAL.floor[2]) },
    uSand: { value: col(PAL.sand) }, uGrass: { value: col(PAL.grass) },
    uMask: { value: mask.texture }, uMaskMin: { value: mask.min }, uMaskSize: { value: mask.size }, uUpperY: { value: B.y - 1.5 },
  });
  const woodMat = makeSurfaceMaterial('wood', { ...common, uColA: { value: col(PAL.wood[0]) }, uColB: { value: col(PAL.wood[1]) } });
  const atlas = makeAtlas(7);
  const windU = { uTime: { value: 0 }, uWind: { value: reduced ? 0 : 1 } };
  const leafMat = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
  leafMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, windU);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uTime;\nuniform float uWind;\n')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // sway along the card normal; aSway = 0 at the pinned edge, 1 at the free edge. uWind 0 = reduced motion.
          vec4 wp = modelMatrix * vec4(transformed, 1.0);
          float w = sin(uTime * 1.3 + wp.x * 0.6 + wp.z * 0.4) * 0.6 + sin(uTime * 2.9 + wp.y * 1.7) * 0.25;
          transformed += objectNormal * (w * aSway * uWind * 0.07);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\ndiffuseColor.a = 1.0;');   // HDR alpha = bloom weight 1
  };
  leafMat.customProgramCacheKey = () => 'cover-room-level-foliage';

  const meshes = {
    stone: new THREE.Mesh(stone.geometry(), stoneMat),
    floor: new THREE.Mesh(floor.geometry(), floorMat),
    wood: new THREE.Mesh(wood.geometry(), woodMat),
    foliage: new THREE.Mesh(leaves.geometry(), leafMat),
  };
  for (const [name, m] of Object.entries(meshes)) {
    m.name = 'level-' + name;
    m.castShadow = name !== 'floor';
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    scene.add(m);
  }
  level.meshes = meshes;

  // --- lights + sky -----------------------------------------------------------------------------------------------------
  level.bounds = { min: new THREE.Vector3(R.x0 - wT - 0.1, -0.5, R.z0 - oT - 0.1), max: new THREE.Vector3(R.x1 + oT + 0.1, B.backTop + B.merlonH + 1, R.z1 + G.depth + 0.1) };
  const lights = makeLights(game, level, scene);
  level.lights = lights;

  // --- colliders into the world ----------------------------------------------------------------------------------------
  if (game.world && typeof game.world.addBox === 'function') {
    for (const b of boxes) {
      b.collider = game.world.addBox({ center: [b.cx, b.cy, b.cz], size: [b.hx * 2, b.hy * 2, b.hz * 2], yaw: b.yaw },
        { tags: b.tags, material: b.material, owner: 'level' });
      level.colliders.push(b.collider);
    }
  }

  // --- markup, nav, spawns, bounds -------------------------------------------------------------------------------------
  level.cover = makeCover(boxes);
  level.climb = makeClimb(boxes);
  level.mantle = makeMantle(boxes);
  const tNav = performance.now();
  level.nav = buildNav(boxes, level.bounds, { cell: 0.5, radius: 0.35 });
  const navMs = performance.now() - tNav;
  const S = LAYOUT.spawns;
  level.spawns = {
    player: { pos: new THREE.Vector3(...S.player.pos), yaw: S.player.yaw },
    enemies: S.enemies.map((e) => ({ pos: new THREE.Vector3(...e.pos), yaw: e.yaw, role: e.role })),
  };

  // --- per-frame: banner/ivy sway time (allocation-free) -----------------------------------------------------------------
  level.wind = windU;
  if (typeof game.addSystem === 'function' && !reduced) {
    level.system = game.addSystem({ name: 'level', order: ORDER.vfx, frame: (dt) => { windU.uTime.value += Math.min(dt, 0.1); } });
  }

  let tris = 0, verts = 0;
  for (const m of Object.values(meshes)) { tris += m.geometry.index.count / 3; verts += m.geometry.attributes.position.count; }
  level.stats = {
    buildMs: Math.round(performance.now() - t0), bakeMs: Math.round(bakeMs), navMs: Math.round(navMs),
    colliders: boxes.length, triangles: tris, vertices: verts, meshes: Object.keys(meshes).length + 1,
    cover: level.cover.length, climbEdges: level.climb.edges.length, navNodes: level.nav.nodes.length,
  };
  return level;

  // =================================================================================================================
  // local builders (hoisted)
  // =================================================================================================================
  function addFloorQuad(M, x0, x1, z0, z1, y) {
    M.begin(xform(0, 0, 0), -1, {});
    const a = M.v(x0, y, z0, 0, 1, 0), b = M.v(x1, y, z0, 0, 1, 0), c = M.v(x1, y, z1, 0, 1, 0), d = M.v(x0, y, z1, 0, 1, 0);
    M.quad(a, b, c, d);
  }

  // A plank object (crate or door) in the wood mesher. kind 0 crate, 1 door.
  function plankBox(cx, cy, cz, sx, sy, sz, yaw, kind, group) {
    wood.begin(xform(cx, cy, cz, yaw), group, { aWL: 'local', aWH: [sx / 2, sy / 2, sz / 2, kind] });
    chamferBox(wood, sx / 2, sy / 2, sz / 2, 0.018, 0.5, { ny: true });
  }

  // Wall along x or z from (a0..a1) x (b0..b1) footprint, body up to `top` with merlons above.
  function battlement(id, x0, x1, z0, z1, axis, top) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, sx = x1 - x0, sz = z1 - z0;
    stoneBox(id, cx, top / 2, cz, sx, top, sz, 0, ['wall'], { chamfer: 0.05, seg: 0.6, tint: [0.97, 0.96, 0.95] });
    const len = axis === 'x' ? sx : sz, step = B.merlonW + B.crenelW;
    const n = Math.floor((len - B.merlonW) / step);
    const start = (len - (n * step + B.merlonW)) / 2;
    for (let i = 0; i <= n; i++) {
      const s = start + i * step + B.merlonW / 2;
      const mx = axis === 'x' ? x0 + s : cx, mz = axis === 'x' ? cz : z0 + s;
      const msx = axis === 'x' ? B.merlonW : sx, msz = axis === 'x' ? sz : B.merlonW;
      const mh = B.merlonH * (0.82 + rnd() * 0.18);
      stoneBox(`${id}.m${i}`, mx, top + mh / 2, mz, msx, mh, msz, 0, ['wall'], { chamfer: 0.04, tint: jitterTint(0.08) });
    }
  }

  // Ruined wall: a body up to its lowest point, then broken courses of blocks following profile(s, len) (m).
  function ruinedWall(id, x0, x1, z0, z1, axis, profile) {
    const len = axis === 'x' ? x1 - x0 : z1 - z0;
    let minH = Infinity;
    for (let s = 0; s <= len; s += 0.25) minH = Math.min(minH, profile(s, len));
    const base = Math.max(2.4, minH - 0.3);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, sx = x1 - x0, sz = z1 - z0;
    stoneBox(id, cx, base / 2, cz, sx, base, sz, 0, ['wall'], { chamfer: 0.05, seg: 0.55, pat: PAT.plaster });
    let s = 0, i = 0;
    while (s < len - 0.05) {
      const w = Math.min(len - s, 0.5 + rnd() * 1.1);
      const h = Math.max(0.15, profile(s + w / 2, len) + (rnd() - 0.5) * 0.45 - base);
      const thick = (axis === 'x' ? sz : sx) * (0.84 + rnd() * 0.16);
      const mx = axis === 'x' ? x0 + s + w / 2 : cx + (rnd() - 0.5) * 0.06, mz = axis === 'x' ? cz + (rnd() - 0.5) * 0.06 : z0 + s + w / 2;
      stoneBox(`${id}.r${i}`, mx, base + h / 2, mz, axis === 'x' ? w - 0.02 : thick, h, axis === 'x' ? thick : w - 0.02, 0, ['wall'],
        { chamfer: 0.04, seg: 0.55, pat: PAT.plaster, tint: jitterTint(0.06) });
      if (h > 0.5 && rnd() < 0.3) {   // a loose top stone
        const w2 = w * (0.4 + rnd() * 0.3), h2 = 0.2 + rnd() * 0.25;
        stoneBox(`${id}.t${i}`, mx + (axis === 'x' ? (rnd() - 0.5) * (w - w2) : 0), base + h + h2 / 2, mz + (axis === 'z' ? (rnd() - 0.5) * (w - w2) : 0),
          axis === 'x' ? w2 : thick * 0.8, h2, axis === 'x' ? thick * 0.8 : w2, (rnd() - 0.5) * 0.12, ['wall'],
          { chamfer: 0.035, pat: PAT.ashlar, tint: jitterTint(0.1) });
      }
      s += w; i++;
    }
  }

  function buildPiece(pc) {
    const [x, z] = pc.c, [sx, sy, sz] = pc.size, yaw = pc.yaw || 0;
    const coverTag = sy > 1.25 ? 'cover-high' : 'cover-low';
    if (pc.kind === 'wall') {
      const rec = solid(pc.id, x, sy / 2, z, sx, sy, sz, yaw, [coverTag, 'wall']);
      const capH = 0.13, bodyH = pc.broken ? sy - 0.35 : sy - capH;
      stone.begin(xform(x, bodyH / 2, z, yaw), rec.group, { aTint: [...jitterTint(0.05), PAT.ashlar] });
      chamferBox(stone, sx / 2 - 0.02, bodyH / 2, sz / 2 - 0.03, 0.04, 0.5, { ny: true });
      if (pc.broken) {   // jagged top inside the collider: blocks of 0.12..0.35 m
        let s = -sx / 2;
        while (s < sx / 2 - 0.05) {
          const w = Math.min(sx / 2 - s, 0.35 + rnd() * 0.6), h = 0.12 + rnd() * 0.23;
          const lx = s + w / 2, ly = bodyH + h / 2;
          const c = Math.cos(yaw), sn = Math.sin(yaw);
          stone.begin(xform(x + lx * c, ly, z - lx * sn, yaw + (rnd() - 0.5) * 0.06), rec.group, { aTint: [...jitterTint(0.1), PAT.ashlar] });
          chamferBox(stone, w / 2 - 0.015, h / 2, sz / 2 - 0.03 - rnd() * 0.04, 0.035, 0.5, { ny: true });
          s += w;
        }
      } else {
        stone.begin(xform(x, bodyH + capH / 2, z, yaw), rec.group, { aTint: [1.07, 1.05, 1.01, PAT.dressed] });
        chamferBox(stone, sx / 2, capH / 2, sz / 2, 0.03, 0.5, { ny: true });
      }
    } else if (pc.kind === 'pillar') {
      const rec = solid(pc.id, x, sy / 2, z, sx, sy, sz, yaw, [coverTag, 'wall']);
      const capH = 0.24, baseH = 0.3;
      stone.begin(xform(x, baseH / 2, z, yaw), rec.group, { aTint: [1.04, 1.02, 0.99, PAT.dressed] });
      chamferBox(stone, sx / 2, baseH / 2, sz / 2, 0.04, 0.5, { ny: true });
      stone.begin(xform(x, baseH + (sy - baseH - capH) / 2, z, yaw), rec.group, { aTint: [...jitterTint(0.05), PAT.ashlar] });
      chamferBox(stone, sx / 2 - 0.07, (sy - baseH - capH) / 2, sz / 2 - 0.07, 0.03, 0.5, { ny: true });
      stone.begin(xform(x + 0.02, sy - capH / 2, z - 0.015, yaw + 0.04), rec.group, { aTint: [1.06, 1.04, 1.0, PAT.dressed] });
      chamferBox(stone, sx / 2 - 0.02, capH / 2, sz / 2 - 0.02, 0.04, 0.5, { ny: true });
    } else if (pc.kind === 'mantle') {
      const rec = solid(pc.id, x, sy / 2, z, sx, sy, sz, yaw, [coverTag, 'mantle']);
      stone.begin(xform(x, sy / 2, z, yaw), rec.group, { aTint: [1.03, 1.01, 0.98, PAT.dressed] });
      chamferBox(stone, sx / 2, sy / 2, sz / 2, 0.06, 0.5, { ny: true });
    } else if (pc.kind === 'crates') {
      const rec = solid(pc.id, x, sy / 2, z, sx, sy, sz, yaw, [coverTag, 'crate'], 'wood');
      const nx = Math.max(1, Math.round(sx)), ny = Math.max(1, Math.round(sy)), nzc = Math.max(1, Math.round(sz));
      const cw = sx / nx, ch = sy / ny, cd = sz / nzc, c = Math.cos(yaw), sn = Math.sin(yaw);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          for (let k = 0; k < nzc; k++) {
            const lx = -sx / 2 + cw * (i + 0.5) + (j ? (rnd() - 0.5) * 0.04 : 0), lz = -sz / 2 + cd * (k + 0.5) + (j ? (rnd() - 0.5) * 0.04 : 0);
            const w = cw - 0.03, hh = ch - 0.01, d = cd - 0.03;
            plankBox(x + lx * c + lz * sn, ch * j + hh / 2, z - lx * sn + lz * c, w, hh, d, yaw + (j ? (rnd() - 0.5) * 0.05 : 0), 0, rec.group);
          }
        }
      }
    } else if (pc.kind === 'column') {
      const rec = solid(pc.id, x, sy / 2, z, sx, sy, sz, yaw, [coverTag, 'column'], 'stone', { coverEnds: 'open' });
      const r = sy / 2 - 0.02;
      const g = flutedCylinder(r, sx - 0.1, 40, 6, 20, 0.035, 3, true, true);
      g.rotateZ(Math.PI / 2);
      stone.geo(g, xform(x, r, z, yaw), rec.group, { aTint: [1.05, 1.03, 1.0, PAT.dressed] });
      g.dispose();
    } else if (pc.kind === 'stump') {
      const rec = solid(pc.id, x, sy / 2, z, sx, sy, sz, yaw, [coverTag, 'column']);
      const baseH = 0.28;
      stone.begin(xform(x, baseH / 2, z, yaw), rec.group, { aTint: [1.03, 1.01, 0.98, PAT.dressed] });
      chamferBox(stone, sx / 2, baseH / 2, sz / 2, 0.04, 0.5, { ny: true });
      const r = sx / 2 - 0.08, h = sy - baseH - 0.08;
      const g = flutedCylinder(r, h, 40, 4, 20, 0.035, 11, true, false);
      stone.geo(g, xform(x, baseH + h / 2, z, yaw), rec.group, { aTint: [1.05, 1.03, 1.0, PAT.dressed] });
      g.dispose();
    } else if (pc.kind === 'capital') {
      const rec = solid(pc.id, x, sy / 2, z, sx, sy, sz, yaw, [coverTag, 'prop']);
      stone.begin(xform(x, 0.18, z, yaw), rec.group, { aTint: [1.04, 1.02, 0.99, PAT.dressed] });
      chamferBox(stone, sx / 2 - 0.12, 0.18, sz / 2 - 0.12, 0.04, 0.5, { ny: true });
      stone.begin(xform(x, 0.36 + (sy - 0.36) / 2, z, yaw), rec.group, { aTint: [1.06, 1.04, 1.0, PAT.dressed] });
      chamferBox(stone, sx / 2, (sy - 0.36) / 2, sz / 2, 0.05, 0.5, {});
    }
  }

  function buildFountain() {
    const { x, z, apothem: A, rimT, rimH } = F;
    const side = 2 * A * Math.tan(Math.PI / 8);
    const group = boxes.length + 1000;   // one AO self-group for the 8 rim boxes and the ring mesh
    for (let k = 0; k < 8; k++) {
      const th = k * Math.PI / 4, nx = Math.sin(th), nzz = Math.cos(th), rr = A - rimT / 2;
      solid(`fountain.rim${k}`, x + nx * rr, rimH / 2, z + nzz * rr, side, rimH, rimT, th, ['cover-low', 'fountain'], 'stone', { group });
    }
    // ring visual: bevelled octagon ring (extruded), outer faces exactly on the collider faces
    const bev = 0.035, Rc = (a) => a / Math.cos(Math.PI / 8);
    const ring = (a, out) => {
      const pts = [];
      for (let k = 0; k < 8; k++) {
        const ph = k * Math.PI / 4 + Math.PI / 8, rr = Rc(a);
        pts.push(new THREE.Vector2(Math.sin(ph) * rr, -Math.cos(ph) * rr));   // shape y -> world -z after rotateX(-90)
      }
      return out ? new THREE.Shape(pts) : new THREE.Path(pts.reverse());
    };
    const shape = ring(A - bev, true);
    shape.holes.push(ring(A - rimT + bev, false));
    const eg = new THREE.ExtrudeGeometry(shape, { depth: rimH - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 1, steps: 1, curveSegments: 1 });
    eg.rotateX(-Math.PI / 2);
    eg.translate(0, bev, 0);
    stone.geo(eg, xform(x, 0, z), group, { aTint: [1.06, 1.04, 1.0, PAT.dressed] });
    eg.dispose();
    // central plinth: base, octagonal shaft, bowl (collider = one high-cover box)
    const pl = solid('fountain.plinth', x, 1.1, z, 1.0, 2.2, 1.0, 0, ['cover-high', 'fountain']);
    stone.begin(xform(x, 0.22, z, Math.PI / 8), pl.group, { aTint: [1.03, 1.01, 0.98, PAT.dressed] });
    chamferBox(stone, 0.56, 0.22, 0.56, 0.04, 0.5, { ny: true });
    const shaft = new THREE.CylinderGeometry(0.3, 0.38, 1.5, 8, 2);
    stone.geo(shaft, xform(x, 0.44 + 0.75, z, Math.PI / 8), pl.group, { aTint: [1.04, 1.02, 0.99, PAT.dressed] });
    shaft.dispose();
    const bowl = new THREE.LatheGeometry([
      new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.32, 0.02), new THREE.Vector2(0.52, 0.12), new THREE.Vector2(0.6, 0.27),
      new THREE.Vector2(0.56, 0.29), new THREE.Vector2(0.46, 0.18), new THREE.Vector2(0.0, 0.16),
    ], 24);
    stone.geo(bowl, xform(x, 1.92, z), pl.group, { aTint: [1.05, 1.03, 1.0, PAT.dressed] });
    bowl.dispose();
  }

  // Fluted cylinder along Y (length len), optionally with jagged broken ends (top/bottom).
  function flutedCylinder(r, len, radial, rings, flutes, depth, seed, brokenTop, brokenBottom) {
    const g = new THREE.CylinderGeometry(r, r, len, radial, rings, false);
    const p = g.attributes.position;
    const ph = seed * 1.7;
    const jag = (a, s) => 0.09 * Math.sin(3 * a + ph * s) + 0.05 * Math.sin(7 * a + 2.1 * ph * s) + 0.03 * Math.sin(13 * a + s);
    for (let i = 0; i < p.count; i++) {
      let px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
      const rr = Math.hypot(px, pz), a = Math.atan2(pz, px);
      if (rr > 1e-4) {
        const f = 1 - depth * (0.5 + 0.5 * Math.cos(a * flutes));
        px *= f; pz *= f;
      }
      if (brokenTop && py > len / 2 - 1e-4) py += rr > 1e-4 ? jag(a, 1) - 0.06 : -0.02;
      if (brokenBottom && py < -len / 2 + 1e-4) py -= rr > 1e-4 ? jag(a, 2) - 0.06 : -0.02;
      p.setXYZ(i, px, py, pz);
    }
    g.deleteAttribute('normal');
    g.computeVertexNormals();
    return g;
  }

  // Small stones at wall bases, in corners, round the fallen column and in the basin. Visual only (no colliders):
  // all are under 0.3 m and half-sunk, so a capsule stepping over them looks right.
  function scatterRubble() {
    const spots = [];
    const along = (n, fx, fz) => { for (let i = 0; i < n; i++) spots.push(fx(rnd()), fz(rnd())); };
    along(26, (u) => -14.7 + rnd() * 0.5, (u) => -5.5 + u * 16.5);             // west wall foot
    along(24, (u) => -14.6 + u * 13.0, () => 10.55 + rnd() * 0.4);             // south wall foot, west of the gate
    along(18, (u) => 2.2 + u * 12.4, () => 10.55 + rnd() * 0.4);              // south wall foot, east
    along(14, (u) => 14.5 + rnd() * 0.45, (u) => 4.8 + u * 5.6);               // east wall foot
    along(16, (u) => -14.5 + u * 4.4, () => -7.6 + rnd() * 0.5);               // rampart foot, west (clear of the climb)
    along(12, (u) => 9.0 + u * 2.8, () => -7.6 + rnd() * 0.5);                 // rampart foot, east
    along(16, (u) => -11.2 + u * 5.0, (u) => -2.0 + rnd() * 3.0 - u * 1.5);    // round the fallen column
    along(14, () => F.x + (rnd() - 0.5) * 3.2, () => F.z + (rnd() - 0.5) * 3.2); // dry basin
    along(10, (u) => -6.8 + u * 2.8, () => 3.9 + rnd() * 0.5);                 // below the broken wall
    for (let i = 0; i < spots.length; i += 2) {
      const x = spots[i], z = spots[i + 1];
      if (Math.hypot(x - F.x, z - F.z) < 0.75) continue;   // not inside the plinth
      const s = 0.07 + Math.pow(rnd(), 2.2) * 0.22;
      stone.begin(xform(x, s * 0.25, z, rnd() * 6.28, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8), -1,
        { aTint: [...jitterTint(0.15), rnd() < 0.5 ? PAT.rubble : PAT.ashlar] });
      chamferBox(stone, s * (0.7 + rnd() * 0.5), s * (0.45 + rnd() * 0.3), s * (0.6 + rnd() * 0.5), s * 0.18, 1, null);
    }
  }

  // Foliage cards (one draw call with the banners). Normal = right x up (faces away from the wall it hangs on).
  function card(cx, cy, cz, rx, rz, w, h, uvName, swayTop, swayBottom, ux = 0, uy = 1, uz = 0, segX = 1, segY = 1, bulge = 0) {
    const [u0, v0, u1, v1] = atlasUV(uvName);
    // normal = right x up; right also carries u, so the art reads unmirrored from the front
    const rX = rx, rY = 0, rZ = rz;
    let nx = rY * uz - rZ * uy, ny = rZ * ux - rX * uz, nzz = rX * uy - rY * ux;
    const nl = Math.hypot(nx, ny, nzz) || 1; nx /= nl; ny /= nl; nzz /= nl;
    leaves.begin(xform(0, 0, 0), -1, leaves.cur);
    const ids = [];
    for (let j = 0; j <= segY; j++) {
      for (let i = 0; i <= segX; i++) {
        const s = i / segX - 0.5, t = j / segY - 0.5;         // t: -0.5 bottom .. 0.5 top
        const b = bulge * Math.sin((t + 0.5) * Math.PI * 1.3 + s * 2.0) * (0.6 + 0.4 * Math.cos(s * Math.PI));
        leaves.cur = { uv: [u0 + (u1 - u0) * (s + 0.5), v0 + (v1 - v0) * (t + 0.5)], aSway: swayBottom + (swayTop - swayBottom) * (t + 0.5) };
        ids.push(leaves.v(cx + rX * s * w + ux * t * h + nx * b, cy + uy * t * h + ny * b, cz + rZ * s * w + uz * t * h + nzz * b, nx, ny, nzz));
      }
    }
    for (let j = 0; j < segY; j++) for (let i = 0; i < segX; i++) {
      const a = j * (segX + 1) + i;
      leaves.quad(ids[a], ids[a + 1], ids[a + segX + 2], ids[a + segX + 1]);
    }
  }

  function placeFoliage() {
    // ivy on walls: [x, y(top or bottom), z, right x, right z, w, h, type]
    const off = 0.035;
    const hang = (x, yTop, z, rx, rz, w, h) => card(x, yTop - h / 2, z, rx, rz, w, h, 'ivyHang', 0.1, 0.9, 0, 1, 0, 2, 3);
    const patch = (x, yBot, z, rx, rz, w, h) => card(x, yBot + h / 2, z, rx, rz, w, h, 'ivyPatch', 0.5, 0.0, 0, 1, 0, 2, 2);
    // right x up = normal: north rampart face (+Z) right = +X; east rampart (-X) right = +Z;
    // west wall (+X) right = -Z; south wall (-Z) right = -X
    hang(-13.0, B.y + 0.05, B.z + off, 1, 0, 2.6, 3.4);
    hang(10.4, B.y + 0.05, B.z + off, 1, 0, 2.2, 2.9);
    hang(-1.8, B.y + 0.05, B.z + off, 1, 0, 1.6, 2.0);
    hang(B.eastX - off, B.y + 0.05, -6.9, 0, 1, 2.0, 3.1);
    patch(R.x0 + off, 0, 2.6, 0, -1, 2.6, 2.3);
    patch(R.x0 + off, 0, -4.2, 0, -1, 1.8, 1.6);
    patch(8.6, 0, R.z1 - off, -1, 0, 3.0, 2.0);
    hang(-11.2, 3.5, R.z1 - off, -1, 0, 2.2, 2.0);
    // pier and broken wall
    patch(-10.6, 0, 1.4 + 0.55 + off, 1, 0, 1.0, 1.3);
    patch(-5.4 - 0.6, 0, 3.4 + 0.3 + off, 1, 0, 1.4, 1.1);
    // banners hanging from the parapet over the courtyard
    const banner = (x, z, rx, rz, nxz) => card(x + nxz[0] * 0.05, B.y + B.parapetH - 0.12 - 1.45, z + nxz[1] * 0.05, rx, rz, 0.85, 2.9,
      'banner', 0.0, 1.0, 0, 1, 0, 3, 10, 0.05);
    banner(1.6, B.z, 1, 0, [0, 1]);
    banner(8.2, B.z, 1, 0, [0, 1]);
    banner(B.eastX, -4.6, 0, 1, [-1, 0]);
    // grass tufts: crossed cards along wall feet, in the basin and in the paving
    const tuft = (x, z, s, kind) => {
      const a = rnd() * Math.PI;
      for (let k = 0; k < 2; k++) {
        const aa = a + k * Math.PI / 2;
        card(x, s * 0.5 - 0.02, z, Math.cos(aa), Math.sin(aa), s * 1.3, s, kind, 1.0, 0.0);
      }
    };
    const tufts = [];
    for (let i = 0; i < 26; i++) tufts.push([-14.75 + rnd() * 0.35, -6 + rnd() * 16.5]);
    for (let i = 0; i < 22; i++) tufts.push([-14.6 + rnd() * 12.6, 10.65 + rnd() * 0.3]);
    for (let i = 0; i < 18; i++) tufts.push([2.4 + rnd() * 12.3, 10.65 + rnd() * 0.3]);
    for (let i = 0; i < 12; i++) tufts.push([14.6 + rnd() * 0.3, 4.6 + rnd() * 6.2]);
    for (let i = 0; i < 14; i++) tufts.push([-14.6 + rnd() * 4.6, -7.75 + rnd() * 0.35]);
    for (let i = 0; i < 10; i++) tufts.push([7.5 + rnd() * 4.2, -7.75 + rnd() * 0.35]);
    for (let i = 0; i < 16; i++) { const a = rnd() * 6.28, r = 0.8 + rnd() * 1.3; tufts.push([F.x + Math.sin(a) * r, F.z + Math.cos(a) * r]); }
    for (let i = 0; i < 26; i++) tufts.push([-14 + rnd() * 26, -7 + rnd() * 17]);
    for (const [x, z] of tufts) tuft(x, z, 0.22 + rnd() * 0.3, rnd() < 0.55 ? 'grass' : 'weeds');
  }
}

// =====================================================================================================================
// The promontory under the fort: a box gridded and pushed out by value-noise fbm, wider toward the sea, flat on top
// (an apron 1.3 m round the outer walls at y = -0.03). Visual only.
// =====================================================================================================================
function valueNoise3(seed) {
  const hash = (i, j, k) => {
    let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1274126177) ^ Math.imul(seed, 144665);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const sm = (t) => t * t * (3 - 2 * t);
  const vn = (x, y, z) => {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    const u = sm(x - i), v = sm(y - j), w = sm(z - k);
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(hash(i, j, k), hash(i + 1, j, k), u), l(hash(i, j + 1, k), hash(i + 1, j + 1, k), u), v),
             l(l(hash(i, j, k + 1), hash(i + 1, j, k + 1), u), l(hash(i, j + 1, k + 1), hash(i + 1, j + 1, k + 1), u), v), w);
  };
  return (x, y, z) => {
    let s = 0, a = 0.5, f = 1;
    for (let o = 0; o < 4; o++) { s += a * vn(x * f + o * 17.1, y * f, z * f - o * 9.3); f *= 2.03; a *= 0.5; }
    return s / 0.9375;
  };
}

function cliffGeometry(R, gateDepth, seed) {
  const fbm = valueNoise3(seed);
  const g = new THREE.BoxGeometry(1, 1, 1, 34, 14, 30);
  const p = g.attributes.position;
  const z0 = R.z0 - 2.2, z1 = R.z1 + gateDepth + 1.3, cz = (z0 + z1) / 2;
  const hx0 = R.x1 + 2.2, hz0 = (z1 - z0) / 2, depth = 38;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i), v = p.getY(i), w = p.getZ(i);
    const t = 0.5 - v;                                  // 0 at the top, 1 at the bottom
    const flare = Math.pow(t, 1.4);
    let x = u * 2 * (hx0 + flare * 10), z = cz + w * 2 * (hz0 + flare * 8);
    const y = -0.03 - t * depth;
    const side = Math.abs(u) > 0.499 || Math.abs(w) > 0.499;
    if (side && t > 0) {
      const rl = Math.hypot(x, z - cz) || 1;
      const d = ((fbm(x * 0.11, y * 0.16, z * 0.11) - 0.5) * 9 + Math.sin(y * 0.7 + fbm(x * 0.05, 0, z * 0.05) * 6) * 0.6)
        * Math.min(1, t * 8);
      x += (x / rl) * d;
      z += ((z - cz) / rl) * d;
    }
    p.setXYZ(i, x, y, z);
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

// =====================================================================================================================
// Bakes
// =====================================================================================================================
// Per-vertex AO: 12 cosine-distributed rays per vertex against every collider box within reach (2 m bins), ignoring the
// vertex's own AO group. occlusion = mean over rays of (1 - t / R) for hits within R; ao = 1 - 0.9 * occlusion.
const AO_RAYS = (() => {
  const n = 12, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n), a = i * 2.399963;
    out[i * 3] = r * Math.cos(a); out[i * 3 + 1] = r * Math.sin(a); out[i * 3 + 2] = Math.sqrt(1 - r * r);
  }
  return out;
})();

function rayBox(b, ox, oy, oz, dx, dy, dz, tmax) {
  const rx = ox - b.cx, rz = oz - b.cz;
  const lox = rx * b.cos - rz * b.sin, loz = rx * b.sin + rz * b.cos, loy = oy - b.cy;
  const ldx = dx * b.cos - dz * b.sin, ldz = dx * b.sin + dz * b.cos, ldy = dy;
  let t0 = 0, t1 = tmax;
  const slab = (o, d, h) => {
    if (Math.abs(d) < 1e-9) return o >= -h && o <= h;
    let ta = (-h - o) / d, tb = (h - o) / d;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    return t0 <= t1;
  };
  if (!slab(lox, ldx, b.hx) || !slab(loy, ldy, b.hy) || !slab(loz, ldz, b.hz)) return -1;
  return t0;
}

function bakeVertexAO(M, boxes, R = 1.1, strength = 0.9) {
  const n = M.n, ao = new Float32Array(n).fill(1);
  if (!n) return ao;
  // 2D bins over the level, 2 m cells
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of boxes) {
    const ex = Math.abs(b.cos) * b.hx + Math.abs(b.sin) * b.hz, ez = Math.abs(b.sin) * b.hx + Math.abs(b.cos) * b.hz;
    b._aabb = [b.cx - ex, b.cy - b.hy, b.cz - ez, b.cx + ex, b.cy + b.hy, b.cz + ez];
    x0 = Math.min(x0, b._aabb[0]); z0 = Math.min(z0, b._aabb[2]); x1 = Math.max(x1, b._aabb[3]); z1 = Math.max(z1, b._aabb[5]);
  }
  const C = 2, nx = Math.ceil((x1 - x0) / C) + 1, nz = Math.ceil((z1 - z0) / C) + 1;
  const bins = Array.from({ length: nx * nz }, () => []);
  for (const b of boxes) {
    const i0 = Math.max(0, Math.floor((b._aabb[0] - R - x0) / C)), i1 = Math.min(nx - 1, Math.floor((b._aabb[3] + R - x0) / C));
    const k0 = Math.max(0, Math.floor((b._aabb[2] - R - z0) / C)), k1 = Math.min(nz - 1, Math.floor((b._aabb[5] + R - z0) / C));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) bins[k * nx + i].push(b);
  }
  const P = M.pos, N = M.nrm, Gp = M.grp, nr = AO_RAYS.length / 3;
  for (let v = 0; v < n; v++) {
    const nxv = N[v * 3], nyv = N[v * 3 + 1], nzv = N[v * 3 + 2];
    const ox = P[v * 3] + nxv * 0.02, oy = P[v * 3 + 1] + nyv * 0.02, oz = P[v * 3 + 2] + nzv * 0.02;
    const bi = Math.floor((ox - x0) / C), bk = Math.floor((oz - z0) / C);
    if (bi < 0 || bk < 0 || bi >= nx || bk >= nz) continue;
    const list = bins[bk * nx + bi];
    // tangent frame (Duff et al. 2017)
    const s = nzv >= 0 ? 1 : -1, a = -1 / (s + nzv), bb = nxv * nyv * a;
    const t1x = 1 + s * nxv * nxv * a, t1y = s * bb, t1z = -s * nxv;
    const t2x = bb, t2y = s + nyv * nyv * a, t2z = -nyv;
    let occ = 0;
    for (let r = 0; r < nr; r++) {
      const lx = AO_RAYS[r * 3], ly = AO_RAYS[r * 3 + 1], lz = AO_RAYS[r * 3 + 2];
      const dx = t1x * lx + t2x * ly + nxv * lz, dy = t1y * lx + t2y * ly + nyv * lz, dz = t1z * lx + t2z * ly + nzv * lz;
      let best = R;
      for (const b of list) {
        if (b.group === Gp[v]) continue;
        const A = b._aabb;
        if (ox < A[0] - R || ox > A[3] + R || oy < A[1] - R || oy > A[4] + R || oz < A[2] - R || oz > A[5] + R) continue;
        const t = rayBox(b, ox, oy, oz, dx, dy, dz, best);
        if (t >= 0 && t < best) best = t;
      }
      if (best < R) occ += 1 - best / R;
    }
    ao[v] = Math.max(0.2, 1 - strength * occ / nr);
  }
  return ao;
}

// Top-down floor mask, 5 cm texels: r = ground-level AO, g = ground dirt/sand, b = balcony AO, a = balcony dirt.
// A box darkens a floor level when it stands on it (bottom at or below the floor, top above it): a tight contact blur
// plus a wide, height-weighted blur. Dirt follows the wide blur (sand drifts against walls) plus the dry basin.
function bakeFloorMask(boxes) {
  const res = 0.05, R = LAYOUT.room;
  const minX = R.x0 - 1.5, minZ = R.z0 - 1.5, sizeX = R.x1 - R.x0 + 3, sizeZ = R.z1 - R.z0 + LAYOUT.gate.depth + 3;
  const W = Math.ceil(sizeX / res), H = Math.ceil(sizeZ / res);
  const levels = [0, LAYOUT.balcony.y];
  const out = new Uint8Array(W * H * 4);
  const F = LAYOUT.fountain;
  for (let li = 0; li < 2; li++) {
    const y = levels[li];
    const contact = new Float32Array(W * H), tall = new Float32Array(W * H);
    for (const b of boxes) {
      if (!(b.bottom <= y + 0.05 && b.top > y + 0.1)) continue;
      const ex = Math.abs(b.cos) * b.hx + Math.abs(b.sin) * b.hz, ez = Math.abs(b.sin) * b.hx + Math.abs(b.cos) * b.hz;
      const i0 = Math.max(0, Math.floor((b.cx - ex - minX) / res)), i1 = Math.min(W - 1, Math.ceil((b.cx + ex - minX) / res));
      const k0 = Math.max(0, Math.floor((b.cz - ez - minZ) / res)), k1 = Math.min(H - 1, Math.ceil((b.cz + ez - minZ) / res));
      const wt = Math.min(1, Math.max(0.35, (b.top - y) / 3));
      for (let k = k0; k <= k1; k++) {
        const z = minZ + (k + 0.5) * res;
        for (let i = i0; i <= i1; i++) {
          const x = minX + (i + 0.5) * res, dx = x - b.cx, dz = z - b.cz;
          const lx = dx * b.cos - dz * b.sin, lz = dx * b.sin + dz * b.cos;
          if (Math.abs(lx) <= b.hx && Math.abs(lz) <= b.hz) {
            const j = k * W + i;
            contact[j] = 1;
            if (wt > tall[j]) tall[j] = wt;
          }
        }
      }
    }
    const solidMask = contact.slice();
    blur(contact, W, H, 3); blur(tall, W, H, 12);
    for (let k = 0; k < H; k++) {
      for (let i = 0; i < W; i++) {
        const j = k * W + i;
        const x = minX + (i + 0.5) * res, z = minZ + (k + 0.5) * res;
        let aoV = (1 - 0.62 * contact[j]) * (1 - 0.42 * tall[j]);
        if (solidMask[j]) aoV = 0.5;
        let dirt = Math.min(1, tall[j] * 1.5);
        if (li === 0 && Math.hypot(x - F.x, z - F.z) < F.apothem - F.rimT) dirt = 1;
        out[j * 4 + li * 2] = Math.round(Math.max(0, Math.min(1, aoV)) * 255);
        out[j * 4 + li * 2 + 1] = Math.round(dirt * 255);
      }
    }
  }
  const texture = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, min: new THREE.Vector2(minX, minZ), size: new THREE.Vector2(W * res, H * res) };
}

// Separable box blur, 3 passes (~Gaussian), radius r texels, in place.
function blur(a, W, H, r) {
  const tmp = new Float32Array(Math.max(W, H));
  for (let pass = 0; pass < 3; pass++) {
    for (let k = 0; k < H; k++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += a[k * W + Math.min(W - 1, Math.max(0, i))];
      for (let i = 0; i < W; i++) {
        tmp[i] = s / (2 * r + 1);
        s += a[k * W + Math.min(W - 1, i + r + 1)] - a[k * W + Math.max(0, i - r)];
      }
      for (let i = 0; i < W; i++) a[k * W + i] = tmp[i];
    }
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += a[Math.min(H - 1, Math.max(0, k)) * W + i];
      for (let k = 0; k < H; k++) {
        tmp[k] = s / (2 * r + 1);
        s += a[Math.min(H - 1, k + r + 1) * W + i] - a[Math.max(0, k - r) * W + i];
      }
      for (let k = 0; k < H; k++) a[k * W + i] = tmp[k];
    }
  }
}

// =====================================================================================================================
// Lights and sky. Params (panel folder 'level'): sun intensity / elevation / azimuth, fill, bounce, AO on direct light.
// =====================================================================================================================
function makeLights(game, level, scene) {
  const L = LIGHTING;
  const sun = new THREE.DirectionalLight(L.sun.color, L.sun.intensity);
  sun.name = 'level-sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(L.shadowMapSize, L.shadowMapSize);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.025;
  const hemi = new THREE.HemisphereLight(L.fill.sky, L.fill.ground, L.fill.intensity);
  hemi.name = 'level-fill';
  const bounce = new THREE.DirectionalLight(L.bounce.color, L.bounce.intensity);
  bounce.name = 'level-bounce';
  bounce.position.set(0.6, 0.22, -0.75);   // from the north-east, low: the sunlit walls throwing light back
  const sky = makeSky(L.sky);
  scene.add(sun, sun.target, hemi, bounce, sky);
  level.sky = sky;

  const P = game.params;
  const def = (key, v, o) => (P && typeof P.define === 'function' ? P.define(key, v, o) : v);
  const get = (key, v) => (P && typeof P.has === 'function' && P.has(key) ? P.get(key) : v);
  def('level.sun.intensity', L.sun.intensity, { min: 0, max: 8, step: 0.05, label: 'Sun intensity' });          // [ASSUMED] art
  def('level.sun.elevation', L.sun.elevation, { min: 5, max: 85, step: 0.5, label: 'Sun elevation (deg)' });     // [ASSUMED] art
  def('level.sun.azimuth', L.sun.azimuth, { min: 0, max: 360, step: 1, label: 'Sun bearing (deg, 0 = north)' }); // [ASSUMED] art
  def('level.fill.intensity', L.fill.intensity, { min: 0, max: 4, step: 0.05, label: 'Sky fill' });              // [ASSUMED] art
  def('level.bounce.intensity', L.bounce.intensity, { min: 0, max: 2, step: 0.05, label: 'Wall bounce' });        // [ASSUMED] art
  def('level.ao.direct', L.aoDirect, { min: 0, max: 1, step: 0.05, label: 'AO on direct light' });              // [ASSUMED] art

  const sunDir = new THREE.Vector3();
  const target = new THREE.Vector3(0, 2, 0.5);
  const apply = () => {
    const el = THREE.MathUtils.degToRad(get('level.sun.elevation', L.sun.elevation));
    const az = THREE.MathUtils.degToRad(get('level.sun.azimuth', L.sun.azimuth));
    sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    sun.intensity = get('level.sun.intensity', L.sun.intensity);
    hemi.intensity = get('level.fill.intensity', L.fill.intensity);
    bounce.intensity = get('level.bounce.intensity', L.bounce.intensity);
    const aoD = get('level.ao.direct', L.aoDirect);
    for (const m of Object.values(level.meshes)) if (m.material.userData.uniforms) m.material.userData.uniforms.uAODirect.value = aoD;
    sun.target.position.copy(target);
    sun.position.copy(sunDir).multiplyScalar(60).add(target);
    sky.material.uniforms.uSunDir.value.copy(sunDir);
    fitShadow(sun, level.bounds || { min: new THREE.Vector3(-16.5, -0.5, -12.5), max: new THREE.Vector3(16.5, 8.5, 13.5) });
  };
  apply();
  if (P && typeof P.onChange === 'function') {
    for (const k of ['level.sun.intensity', 'level.sun.elevation', 'level.sun.azimuth', 'level.fill.intensity', 'level.bounce.intensity', 'level.ao.direct']) P.onChange(k, apply);
  }
  return { sun, hemi, bounce, sunDir, apply };
}

// Fit the sun's orthographic shadow camera to the level's bounding box in light space (tight: every texel lands in the room).
const _corner = new THREE.Vector3(), _tgt = new THREE.Vector3();
function fitShadow(sun, bounds) {
  const cam = sun.shadow.camera;
  sun.updateMatrixWorld();
  sun.target.updateMatrixWorld();
  cam.position.setFromMatrixPosition(sun.matrixWorld);
  _tgt.setFromMatrixPosition(sun.target.matrixWorld);
  cam.lookAt(_tgt);
  cam.updateMatrixWorld();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z)
      .applyMatrix4(cam.matrixWorldInverse);
    x0 = Math.min(x0, _corner.x); x1 = Math.max(x1, _corner.x);
    y0 = Math.min(y0, _corner.y); y1 = Math.max(y1, _corner.y);
    z0 = Math.min(z0, _corner.z); z1 = Math.max(z1, _corner.z);
  }
  const pad = 0.5;
  cam.left = x0 - pad; cam.right = x1 + pad; cam.bottom = y0 - pad; cam.top = y1 + pad;
  cam.near = Math.max(0.1, -z1 - pad); cam.far = -z0 + pad;
  cam.updateProjectionMatrix();
  sun.shadow.needsUpdate = true;
}

// =====================================================================================================================
// Markup
// =====================================================================================================================
function insideBox(b, x, y, z, pad = 0) {
  if (y < b.bottom - pad || y > b.top + pad) return false;
  const dx = x - b.cx, dz = z - b.cz;
  const lx = dx * b.cos - dz * b.sin, lz = dx * b.sin + dz * b.cos;
  return Math.abs(lx) <= b.hx + pad && Math.abs(lz) <= b.hz + pad;
}
function insideAny(boxes, x, y, z, except) {
  for (const b of boxes) if (b !== except && b.id !== 'ground' && insideBox(b, x, y, z)) return true;
  return false;
}
function floorAt(boxes, x, z, yMax) {
  let best = -Infinity;
  for (const b of boxes) {
    if (b.top > yMax + 0.05 || !insideBox(b, x, b.top, z)) continue;
    if (b.top > best) best = b.top;
  }
  return best;
}

// Cover edges: one per vertical face of every cover-tagged box that has floor and room in front of it.
//   {id, a, b, normal, height: 'low'|'high', top, floorY, length, ends: {a, b}, links: {a, b}, owner, tags}
//   a, b: Vector3 on the floor at the wall face; a is on the user's LEFT as they face the wall (along -normal).
//   normal: out of the wall, toward where the user stands.
//   ends: 'corner' = a convex corner you can peek/aim round (links name the cover round it, if any);
//         'wall' = the face runs into another solid; 'open' = it just stops (the fallen column's round ends).
//   links: {id, end} of the cover edge you reach round that end (the adjacent face, or the far face of a thin wall).
function makeCover(boxes) {
  const out = [];
  const LOW = 0.7, HIGH = 1.25, MIN_LEN = 0.8, STEP = 0.25, FRONT = 0.45;
  const dirName = (nx, nz) => ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'][((Math.round(Math.atan2(nx, nz) / (Math.PI / 4)) % 8) + 8) % 8];
  for (const b of boxes) {
    if (!(b.tags.has('cover-low') || b.tags.has('cover-high'))) continue;
    // 4 faces: local +x, -x, +z, -z
    const faces = [[1, 0, b.hx, b.hz], [-1, 0, b.hx, b.hz], [0, 1, b.hz, b.hx], [0, -1, b.hz, b.hx]];
    for (const [fx, fz, hn, ht] of faces) {
      // local normal (fx, fz) -> world: local +X = (cos, -sin), local +Z = (sin, cos)
      const nx = fx * b.cos + fz * b.sin, nz = -fx * b.sin + fz * b.cos;
      const rx = nz, rz = -nx;   // the user's right as they face the wall (along -normal) = up x normal = (nz, 0, -nx)
      const fcx = b.cx + nx * hn, fcz = b.cz + nz * hn;
      const floorY = b.bottom;
      const h = b.top - floorY;
      if (h < LOW || 2 * ht < MIN_LEN) continue;
      // sample the face, keep the longest run with floor and room in front
      const nS = Math.max(2, Math.round((2 * ht) / STEP));
      const ok = [];
      for (let i = 0; i <= nS; i++) {
        const s = -ht + 0.08 + (2 * ht - 0.16) * i / nS;
        const px = fcx + rx * s + nx * FRONT, pz = fcz + rz * s + nz * FRONT;
        const fl = floorAt(boxes, px, pz, floorY + 0.2);
        ok.push(Math.abs(fl - floorY) < 0.15 && !insideAny(boxes, px, floorY + 0.3, pz, null) && !insideAny(boxes, px, floorY + 1.0, pz, null)
          && !insideAny(boxes, fcx + rx * s + nx * 0.12, floorY + 0.3, fcz + rz * s + nz * 0.12, b));
      }
      let best = null, cur = -1;
      for (let i = 0; i <= nS + 1; i++) {
        if (i <= nS && ok[i]) { if (cur < 0) cur = i; }
        else if (cur >= 0) { if (!best || i - cur > best[1] - best[0]) best = [cur, i - 1]; cur = -1; }
      }
      if (!best) continue;
      const sAt = (i) => -ht + 0.08 + (2 * ht - 0.16) * i / nS;
      const trimA = best[0] > 0, trimB = best[1] < nS;
      const sa = trimA ? sAt(best[0]) - STEP / 2 : -ht, sb = trimB ? sAt(best[1]) + STEP / 2 : ht;
      if (sb - sa < MIN_LEN) continue;
      const endType = (s, dir, trimmed) => {
        if (trimmed) return 'wall';
        if (b.coverEnds) return b.coverEnds;
        const px = fcx + rx * (s + dir * 0.2) + nx * 0.2, pz = fcz + rz * (s + dir * 0.2) + nz * 0.2;
        return insideAny(boxes, px, floorY + 0.5, pz, b) ? 'wall' : 'corner';
      };
      out.push({
        id: `${b.id}:${dirName(nx, nz)}`, owner: b.id, tags: b.tags,
        a: new THREE.Vector3(fcx + rx * sa, floorY, fcz + rz * sa), b: new THREE.Vector3(fcx + rx * sb, floorY, fcz + rz * sb),
        normal: new THREE.Vector3(nx, 0, nz), height: h >= HIGH ? 'high' : 'low', top: b.top, floorY, length: sb - sa,
        ends: { a: endType(sa, -1, trimA), b: endType(sb, 1, trimB) }, links: { a: null, b: null },
        _thin: 2 * hn,
      });
    }
  }
  // links round corners: the nearest other edge end within 0.75 m with a different normal; thin walls wrap to their far face
  for (const e of out) {
    for (const end of ['a', 'b']) {
      if (e.ends[end] !== 'corner') continue;
      const p = e[end];
      let best = null, bd = 0.75;
      for (const f of out) {
        if (f === e || Math.abs(f.floorY - e.floorY) > 0.2 || f.normal.dot(e.normal) > 0.95) continue;
        for (const fe of ['a', 'b']) {
          const d = Math.hypot(f[fe].x - p.x, f[fe].z - p.z);
          if (d < bd) { bd = d; best = { id: f.id, end: fe }; }
        }
      }
      if (!best && e._thin <= 0.8) {
        const far = out.find((f) => f.owner === e.owner && f.normal.dot(e.normal) < -0.95);
        if (far) best = { id: far.id, end: end === 'a' ? 'b' : 'a' };
      }
      e.links[end] = best;
    }
  }
  for (const e of out) delete e._thin;
  return out;
}

// Climb markup from the CLIMB table, in the shape player/climb-data.js normalises (refs/climb-spec.md).
//   edges: [{id, kind: 'ledge'|'hold'|'top', a, b, normal, y, size: 'large'|'small', feet, top, links}]
//     a/b: grip line ends (Vector3), a on the climber's LEFT facing the wall, so +s (a -> b) is the climber's right.
//     The grip line is the outer top corner of the stone (for 'top': the top of the wall face; climb up onto the floor).
//     links: [{to, dir, move: 'reach'|'lunge', dist}] between edges, closest points; dir is the stick direction:
//     'up' | 'down' | 'left' | 'right' | 'upLeft' | 'upRight' | 'downLeft' | 'downRight'.
//   holds: the 'hold' edges (same objects); byId; wall: {a, b, normal, top, base}; moves; warnings (authoring rules).
function makeClimb(boxes) {
  const z = LAYOUT.balcony.z, normal = new THREE.Vector3(0, 0, 1);
  const edges = CLIMB.edges.map((e) => {
    const x0 = e.kind === 'hold' ? e.x - CLIMB.holdW / 2 : e.x0, x1 = e.kind === 'hold' ? e.x + CLIMB.holdW / 2 : e.x1;
    const gz = e.kind === 'top' ? z : z + CLIMB.protrude;
    return {
      id: e.id, kind: e.kind, a: new THREE.Vector3(x0, e.y, gz), b: new THREE.Vector3(x1, e.y, gz), normal: normal.clone(), y: e.y,
      size: e.kind === 'hold' ? 'small' : 'large', feet: true, top: e.kind === 'top', links: [],
    };
  });
  const mv = CLIMB.moves;
  for (const e of edges) {
    for (const f of edges) {
      if (e === f) continue;
      const dy = f.y - e.y;
      const gap = f.a.x > e.b.x ? f.a.x - e.b.x : e.a.x > f.b.x ? -(e.a.x - f.b.x) : 0;   // signed horizontal gap
      const dist = Math.hypot(dy, gap);
      if (dist > mv.lunge || (Math.abs(dy) < 0.3 && Math.abs(gap) < 0.01)) continue;
      const v = dy > 0.3 ? 'up' : dy < -0.3 ? 'down' : '';
      const hz = gap > 0.25 ? 'Right' : gap < -0.25 ? 'Left' : '';
      const dir = v ? v + hz : hz.toLowerCase();
      if (!dir) continue;
      e.links.push({ to: f.id, dir, move: dist <= mv.reach ? 'reach' : 'lunge', dist: +dist.toFixed(3) });
    }
  }
  // authoring rules (climb-spec §2): no grab edge 0.5-0.8 m or 3.25-4.0 m above a floor the player can stand on in
  // front of it, and the lowest edge must be a jump-grab (1.6-3.5 m)
  const warnings = [], R = CLIMB.rules;
  for (const e of edges) {
    if (e.kind === 'top') continue;
    const fl = floorAt(boxes, (e.a.x + e.b.x) / 2, e.a.z + 0.5, e.y - 0.3);
    const h = e.y - fl;
    if (h >= R.ambiguous[0] && h <= R.ambiguous[1]) warnings.push(`${e.id}: ${h.toFixed(2)} m above the floor is in the mantle ambiguity band`);
    if (h >= R.deadZone[0] && h <= R.deadZone[1]) warnings.push(`${e.id}: ${h.toFixed(2)} m above the floor is in the jump-grab dead zone`);
  }
  const lowest = edges.reduce((m, e) => (e.y < m.y ? e : m), edges[0]);
  if (lowest.y < R.jumpGrab[0] || lowest.y > R.jumpGrab[1]) warnings.push(`${lowest.id}: lowest edge ${lowest.y} m is outside the jump-grab band`);
  for (const w of warnings) console.warn('[level] climb rule:', w);
  const byId = Object.fromEntries(edges.map((e) => [e.id, e]));
  return {
    edges, holds: edges.filter((e) => e.kind === 'hold'), byId, moves: { ...mv }, warnings,
    wall: { a: new THREE.Vector3(CLIMB.wall.x0, 0, z), b: new THREE.Vector3(CLIMB.wall.x1, 0, z), normal: normal.clone(), top: LAYOUT.balcony.y, base: 0 },
  };
}

// Mantle edges: the top edges of 'mantle'-tagged boxes. {id, a, b, normal, y (top), floorY}
function makeMantle(boxes) {
  const out = [];
  for (const b of boxes) {
    if (!b.tags.has('mantle')) continue;
    for (const [fx, fz, hn, ht] of [[1, 0, b.hx, b.hz], [-1, 0, b.hx, b.hz], [0, 1, b.hz, b.hx], [0, -1, b.hz, b.hx]]) {
      const nx = fx * b.cos + fz * b.sin, nz = -fx * b.sin + fz * b.cos, rx = nz, rz = -nx;   // right = up x normal
      const cx = b.cx + nx * hn, cz = b.cz + nz * hn;
      out.push({ id: `${b.id}:${fx}${fz}`, a: new THREE.Vector3(cx - rx * ht, b.top, cz - rz * ht), b: new THREE.Vector3(cx + rx * ht, b.top, cz + rz * ht),
        normal: new THREE.Vector3(nx, 0, nz), y: b.top, floorY: b.bottom });
    }
  }
  return out;
}

// Debug drawing for tests/level.html and debug/overlay.js: cover (cyan), climb (yellow), nav (faint), path (magenta).
// opts: {cover, climb, nav, path: Vector3[]}; returns a THREE.Group (depthTest off, drawn last).
export function buildMarkup(level, opts = { cover: true, climb: true, nav: true, path: null }) {
  const group = new THREE.Group();
  group.name = 'level-markup';
  const lineMat = (color, opacity) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
  const addLines = (pts, mat) => {
    if (!pts.length) return;
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, mat);
    l.renderOrder = 1000;
    l.frustumCulled = false;
    group.add(l);
  };
  if (opts.nav && level.nav) {
    const N = level.nav.nodes, L = level.nav.links, pts = [], lift = 0.04;
    for (let i = 0; i < L.length; i += 2) {
      const a = N[L[i]], b = N[L[i + 1]];
      pts.push(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z);
    }
    addLines(pts, lineMat(0x9fb4d0, 0.13));
    const pp = new Float32Array(N.length * 3);
    N.forEach((n, i) => pp.set([n.x, n.y + lift, n.z], i * 3));
    const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pp, 3));
    const pm = new THREE.PointsMaterial({ color: 0xc8d6ea, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.35, depthTest: false });
    const points = new THREE.Points(pg, pm);
    points.renderOrder = 1000;
    group.add(points);
  }
  if (opts.cover) {
    const lo = [], hi = [], ticks = [];
    for (const e of level.cover) {
      const arr = e.height === 'high' ? hi : lo, y0 = e.floorY + 0.03, y1 = e.top + 0.02;
      arr.push(e.a.x, y0, e.a.z, e.b.x, y0, e.b.z, e.a.x, y1, e.a.z, e.b.x, y1, e.b.z);
      const mx = (e.a.x + e.b.x) / 2, mz = (e.a.z + e.b.z) / 2;
      ticks.push(mx, y0, mz, mx + e.normal.x * 0.45, y0, mz + e.normal.z * 0.45);
      for (const end of ['a', 'b']) {
        const p = e[end], t = e.ends[end];
        if (t === 'corner') ticks.push(p.x, y0, p.z, p.x, y1, p.z);
        else if (t === 'wall') ticks.push(p.x + e.normal.x * 0.3, y0 + 0.3, p.z + e.normal.z * 0.3, p.x, y0 + 0.3, p.z);
      }
    }
    addLines(lo, lineMat(0x34f0ff, 0.95));
    addLines(hi, lineMat(0x2aa8ff, 0.95));
    addLines(ticks, lineMat(0x34f0ff, 0.7));
  }
  if (opts.climb && level.climb) {
    const pts = [], links = [];
    for (const e of level.climb.edges) {
      pts.push(e.a.x, e.a.y, e.a.z + 0.01, e.b.x, e.b.y, e.b.z + 0.01);
      for (const k of [e.a, e.b]) pts.push(k.x, k.y - 0.08, k.z + 0.01, k.x, k.y + 0.08, k.z + 0.01);
      const ca = new THREE.Vector3().addVectors(e.a, e.b).multiplyScalar(0.5);
      for (const l of e.links) {
        if (l.to < e.id) continue;   // each pair once
        const f = level.climb.byId[l.to];
        const cb = new THREE.Vector3().addVectors(f.a, f.b).multiplyScalar(0.5);
        links.push(ca.x, ca.y, ca.z + 0.05, cb.x, cb.y, cb.z + 0.05);
      }
    }
    for (const m of level.mantle) pts.push(m.a.x, m.y + 0.02, m.a.z, m.b.x, m.y + 0.02, m.b.z);
    addLines(pts, lineMat(0xffe14a, 1.0));
    addLines(links, lineMat(0xffe14a, 0.45));
  }
  if (opts.path && opts.path.length > 1) {
    const curve = new THREE.CurvePath();
    for (let i = 0; i < opts.path.length - 1; i++) {
      curve.add(new THREE.LineCurve3(opts.path[i].clone().setY(opts.path[i].y + 0.08), opts.path[i + 1].clone().setY(opts.path[i + 1].y + 0.08)));
    }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, opts.path.length * 24, 0.05, 6, false),
      new THREE.MeshBasicMaterial({ color: 0xff3fd2, depthTest: false, transparent: true, opacity: 0.95 }));
    tube.renderOrder = 1001;
    group.add(tube);
    for (const p of opts.path) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 6), tube.material);
      s.position.copy(p).setY(p.y + 0.08);
      s.renderOrder = 1001;
      group.add(s);
    }
  }
  return group;
}

function disposeRoom(level) {
  for (const m of Object.values(level.meshes || {})) {
    m.geometry.dispose();
    if (m.material.map) m.material.map.dispose();
    if (m.material.userData.uniforms?.uMask) m.material.userData.uniforms.uMask.value.dispose();
    m.material.dispose();
    m.removeFromParent();
  }
  if (level.sky) { level.sky.geometry.dispose(); level.sky.material.dispose(); level.sky.removeFromParent(); }
  if (level.lights) for (const l of [level.lights.sun, level.lights.hemi, level.lights.bounce]) { l.dispose?.(); l.removeFromParent(); }
}
