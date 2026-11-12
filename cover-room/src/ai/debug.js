// AI debug overlay, toggled with F2 (param ai.debug). Draws on top of the scene (depthTest off):
//   posts           discs coloured by the best score any NPC's current query gave them (red 0 → green 1),
//                   dark grey = not a candidate, dark red = rejected by a filter; white ring = claimed
//   view cones      the distance-narrowing cone (halfAngle = K/d, clamped) per NPC, widened ×1.5 in combat
//   rings           role colour under each NPC (engager red, ambusher violet, defender blue); gold ring = shooter token
//   paths           each NPC's remaining path; a flank route in cyan
//   LKP             cross at the last known position; grenade-director rings (accuracy / friend check / move reset)
//                   around the dwell anchor; the combat-vector oblong; the ambush point
//   labels          per-NPC text over the head: alert, notice meter, role, token, behaviour / cover phase, health
//   panel           director state: combat, LKP age, advance / flank / grenade timers, confirm-LKP, recent log
// All geometry is preallocated; per frame only buffer attributes and instance colours are written.
import * as THREE from 'three';
import { halfAngleDeg, visionRange } from './perception.js';

const ROLE_COL = { engager: 0xff5a4a, ambusher: 0xb070ff, defender: 0x4aa0ff };
const ALERT_COL = { unaware: '#e8e8e8', suspicious: '#ffd84a', combat: '#ff8a2a', search: '#ffd84a', dead: '#777' };
const CONE_N = 20;          // samples per cone side
const PATH_N = 40;          // max path points drawn per NPC

export function createDebug(game, D, P) {
  const scene = game.scene;
  const group = new THREE.Group();
  group.name = 'ai-debug';
  group.renderOrder = 2000;
  scene.add(group);
  const lineMat = (color, opacity = 0.9) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });

  // ---- posts
  const posts = D.posts;
  const disc = new THREE.CircleGeometry(0.2, 12).rotateX(-Math.PI / 2);
  const postMesh = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false }), Math.max(1, posts.length));
  postMesh.renderOrder = 2001;
  postMesh.frustumCulled = false;
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  posts.forEach((p, i) => { m4.makeScale(p.type === 'cover' ? 1.15 : 0.8, 1, p.type === 'cover' ? 1.15 : 0.8).setPosition(p.x, p.y + 0.04, p.z); postMesh.setMatrixAt(i, m4); postMesh.setColorAt(i, col.set(0x333333)); });
  group.add(postMesh);
  // claimed rings
  const ringGeo = new THREE.RingGeometry(0.26, 0.32, 16).rotateX(-Math.PI / 2);
  const claimMesh = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }), 8);
  claimMesh.renderOrder = 2002; claimMesh.frustumCulled = false;
  group.add(claimMesh);
  // cover post normals (static)
  {
    const pts = [];
    for (const p of posts) if (p.type === 'cover') pts.push(p.x, p.y + 0.05, p.z, p.x - p.nx * 0.35, p.y + 0.05, p.z - p.nz * 0.35);
    if (pts.length) {
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(g, lineMat(0x8fe8ff, 0.5)); l.renderOrder = 2001; l.frustumCulled = false; group.add(l);
    }
  }

  // ---- per NPC: cone, role ring, token ring, path
  const ringBig = new THREE.RingGeometry(0.5, 0.58, 24).rotateX(-Math.PI / 2);
  const ringTok = new THREE.RingGeometry(0.66, 0.76, 24).rotateX(-Math.PI / 2);
  const per = D.npcs.map(() => {
    const coneGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array((CONE_N * 2 + 2) * 3), 3));
    const cone = new THREE.LineLoop(coneGeo, lineMat(0xffffff, 0.55)); cone.frustumCulled = false; cone.renderOrder = 2003;
    const role = new THREE.Mesh(ringBig, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 })); role.renderOrder = 2003;
    const tok = new THREE.Mesh(ringTok, new THREE.MeshBasicMaterial({ color: 0xffc83a, depthTest: false, transparent: true })); tok.renderOrder = 2003;
    const pathGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(PATH_N * 3), 3));
    const path = new THREE.Line(pathGeo, lineMat(0xffffff, 0.7)); path.frustumCulled = false; path.renderOrder = 2003;
    group.add(cone, role, tok, path);
    return { cone, role, tok, path };
  });

  // ---- LKP cross, grenade rings, oblong, ambush point
  const lkpGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5], 3));
  const lkp = new THREE.LineSegments(lkpGeo, lineMat(0xff3355, 1)); lkp.renderOrder = 2004; group.add(lkp);
  const unitCircle = (() => { const a = []; for (let i = 0; i < 48; i++) { const t = i / 48 * Math.PI * 2; a.push(Math.cos(t), 0, Math.sin(t)); } return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(a, 3)); })();
  const gRings = [0xffffff, 0xffb040, 0x5ad1ff].map((c) => { const l = new THREE.LineLoop(unitCircle, lineMat(c, 0.6)); l.renderOrder = 2004; group.add(l); return l; });
  const oblongGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
  const oblong = new THREE.LineLoop(oblongGeo, lineMat(0xff70c0, 0.6)); oblong.frustumCulled = false; oblong.renderOrder = 2004; group.add(oblong);
  const amb = new THREE.Mesh(new THREE.OctahedronGeometry(0.25), new THREE.MeshBasicMaterial({ color: 0xb070ff, depthTest: false })); amb.renderOrder = 2004; group.add(amb);
  // search loops
  const loopLines = D.loops.map((loop) => {
    const a = []; for (const p of loop) a.push(p.x, p.y + 0.06, p.z);
    const l = new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(a, 3)), lineMat(0xffe070, 0.5));
    l.renderOrder = 2001; l.frustumCulled = false; group.add(l);
    return l;
  });

  // ---- DOM: labels + panel
  const host = document.createElement('div');
  host.className = 'ai-debug';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:15;font:11px/1.3 ui-monospace,Menlo,monospace;color:#e8ecf2';
  document.body.appendChild(host);
  const labels = D.npcs.map(() => {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:0;top:0;white-space:pre;padding:2px 4px;background:rgba(8,10,14,.72);border-radius:3px;transform:translate(-50%,-100%)';
    host.appendChild(el);
    return el;
  });
  const panel = document.createElement('div');
  panel.style.cssText = 'position:absolute;right:10px;top:10px;width:330px;white-space:pre;padding:8px 10px;background:rgba(8,10,14,.82);border:1px solid rgba(255,255,255,.12);border-radius:4px';
  host.appendChild(panel);
  const legend = document.createElement('div');
  legend.style.cssText = 'position:absolute;right:10px;bottom:10px;white-space:pre;padding:6px 8px;background:rgba(8,10,14,.75);border-radius:4px;color:#aab4c4';
  legend.innerHTML = 'posts: <span style="color:#ff5040">0</span> → <span style="color:#40ff60">1</span> score · <span style="color:#7a2020">■</span> rejected · ○ claimed\n'
    + 'rings: <span style="color:#ff5a4a">engager</span> <span style="color:#b070ff">ambusher</span> <span style="color:#4aa0ff">defender</span> <span style="color:#ffc83a">token</span>\n'
    + '<span style="color:#ff3355">✕ LKP</span> · grenade rings: accuracy / <span style="color:#ffb040">friend</span> / <span style="color:#5ad1ff">move reset</span> · <span style="color:#ff70c0">combat vector</span>';
  host.appendChild(legend);

  const v3 = new THREE.Vector3();
  const best = new Float32Array(Math.max(1, posts.length));
  let visible = false;
  function setVisible(v) {
    visible = !!v;
    group.visible = visible;
    host.style.display = visible ? '' : 'none';
  }
  setVisible(P('ai.debug'));
  game.params.onChange('ai.debug', (v) => setVisible(v));
  const onKey = (e) => { if (e.code === 'F2') { e.preventDefault(); game.params.set('ai.debug', !P('ai.debug')); } };
  window.addEventListener('keydown', onKey);

  const bar = (t, max, w = 14) => { const k = Math.max(0, Math.min(w, Math.round(t / max * w))); return '█'.repeat(k) + '·'.repeat(w - k); };

  let tick = 0;
  function update() {
    if (!visible) return;
    const textNow = (tick++ % 4) === 0;                       // DOM text at 1/4 rate (labels still track every frame)
    const cam = game.camera;
    // post colours: best score over every NPC's current query
    best.fill(-2);
    for (const n of D.npcs) {
      const q = n.ai.query;
      if (!q || q.phase !== 'done') continue;
      for (let i = 0; i < q.n; i++) { const c = q.cands[i]; const id = c.post.id; best[id] = Math.max(best[id], c.score); }
    }
    let claimed = 0;
    for (let i = 0; i < posts.length; i++) {
      const s = best[i];
      if (s <= -2) col.set(0x3a3d42);
      else if (s < 0) col.set(0x7a2020);
      else col.setRGB(1 - s, 0.25 + 0.75 * s, 0.2);
      postMesh.setColorAt(i, col);
      const p = posts[i];
      if (p.claimedBy && claimed < 8) { m4.makeTranslation(p.x, p.y + 0.05, p.z); claimMesh.setMatrixAt(claimed++, m4); }
    }
    postMesh.instanceColor.needsUpdate = true;
    claimMesh.count = claimed; claimMesh.instanceMatrix.needsUpdate = true;

    D.npcs.forEach((n, k) => {
      const o = per[k], ai = n.ai;
      const alive = n.alive;
      o.cone.visible = alive; o.tok.visible = alive && ai.tok; o.role.visible = alive;
      // cone: left side out, right side back
      const range = Math.min(25, visionRange(ai.alert, P)), mul = ai.alert === 'combat' ? P('ai.vision.combatConeMul') : 1;   // drawn to 25 m
      const arr = o.cone.geometry.attributes.position.array;
      const y = n.pos.y + 0.08;
      let w = 0;
      arr[w++] = n.pos.x; arr[w++] = y; arr[w++] = n.pos.z;
      for (let side = 1; side >= -1; side -= 2) {
        for (let i = 0; i < CONE_N; i++) {
          const t = side > 0 ? i / (CONE_N - 1) : 1 - i / (CONE_N - 1);
          const d = 0.5 + (range - 0.5) * t * t;
          const half = Math.min(180, halfAngleDeg(d, P) * mul) * Math.PI / 180 * side;
          const a = (ai.lookYaw ?? n.yaw) + half;
          arr[w++] = n.pos.x + Math.sin(a) * d; arr[w++] = y; arr[w++] = n.pos.z + Math.cos(a) * d;
        }
      }
      arr[w++] = n.pos.x; arr[w++] = y; arr[w++] = n.pos.z;
      o.cone.geometry.attributes.position.needsUpdate = true;
      o.cone.material.color.set(ALERT_COL[ai.alert] || '#ffffff');
      o.role.position.set(n.pos.x, n.pos.y + 0.06, n.pos.z);
      o.role.material.color.set(ROLE_COL[ai.role] || 0xffffff);
      o.tok.position.set(n.pos.x, n.pos.y + 0.07, n.pos.z);
      // path
      const pa = o.path.geometry.attributes.position.array;
      let c = 0;
      if (alive && ai.moving && ai.path) {
        pa[c++] = n.pos.x; pa[c++] = n.pos.y + 0.1; pa[c++] = n.pos.z;
        for (let i = ai.pathI; i < ai.path.length && c < PATH_N * 3; i++) { const p = ai.path[i]; pa[c++] = p.x; pa[c++] = p.y + 0.1; pa[c++] = p.z; }
      }
      o.path.geometry.setDrawRange(0, c / 3);
      o.path.geometry.attributes.position.needsUpdate = true;
      o.path.material.color.set(ai.flankRoute ? 0x40f0ff : ai.flee ? 0xff4040 : 0xffffff);
      // label
      const el = labels[k];
      if (cam) {
        v3.set(n.pos.x, n.pos.y + 2.25, n.pos.z).project(cam);
        const onScreen = v3.z > -1 && v3.z < 1;
        el.style.display = onScreen ? '' : 'none';
        if (onScreen) {
          el.style.left = ((v3.x * 0.5 + 0.5) * innerWidth).toFixed(0) + 'px';
          el.style.top = ((-v3.y * 0.5 + 0.5) * innerHeight).toFixed(0) + 'px';
        }
      }
      if (!textNow) return;
      const meter = ai.alert === 'combat' ? 'orange' : `${ai.meter.toFixed(2)} ${bar(ai.meter, 2, 8)}`;
      el.style.color = ALERT_COL[ai.alert] || '#fff';
      el.textContent = `${n.id} ${ai.alert}${ai.tok ? ' ★TOKEN' : ''}\n${ai.role}${ai.flanker ? '+flank' : ''}${ai.confirmLKP ? '+checkLKP' : ''} hp ${n.health}\n`
        + `${meter}\n${ai.behavior}${ai.coverPhase !== 'none' ? '/' + ai.coverPhase : ''}${ai.fireLos ? ' LOF' : ''}`;
    });

    // LKP + rings + oblong + ambush
    const L = D.lkp;
    lkp.visible = L.valid; lkp.position.set(L.x, L.y + 0.08, L.z);
    const gr = D.grenade;
    const radii = [P('ai.grenade.accuracy'), P('ai.grenade.friendCheck'), P('ai.grenade.moveReset')];
    gRings.forEach((r, i) => { r.visible = gr.on; r.position.set(gr.x, L.y + 0.07, gr.z); r.scale.setScalar(radii[i]); });
    oblong.visible = D.combat;
    if (D.combat) {
      const len = P('ai.flank.len'), hw = P('ai.flank.halfWidth'), cv = D.cv, a = oblongGeo.attributes.position.array;
      const px = -cv.z, pz = cv.x;
      const pts = [[0, -hw], [len, -hw], [len, hw], [0, hw]];
      pts.forEach(([al, la], i) => { a[i * 3] = L.x + cv.x * al + px * la; a[i * 3 + 1] = L.y + 0.07; a[i * 3 + 2] = L.z + cv.z * al + pz * la; });
      oblongGeo.attributes.position.needsUpdate = true;
    }
    amb.visible = D.ambush.valid && D.combat && D.npcs.some((n) => n.alive && n.ai.role === 'ambusher');
    let searching = false;
    for (const n of D.npcs) if (n.alive && n.ai.alert === 'search') searching = true;
    for (const l of loopLines) l.visible = searching;          // search loops only while searching
    amb.position.set(D.ambush.x, D.ambush.y + 0.5, D.ambush.z);

    // panel
    if (!textNow) return;
    const t = game.time;
    const lines = [];
    lines.push(`AI director   t ${t.toFixed(2)} s   ${D.combat ? 'COMBAT' : D.everCombat ? 'search/calm' : 'calm'}`);
    lines.push(`LKP ${L.valid ? `(${L.x.toFixed(1)}, ${L.z.toFixed(1)}) age ${(t - L.t).toFixed(1)} s   unseen ${(t - D.lastPerceivedT).toFixed(1)} s` : '—'}`);
    lines.push(`advance ${bar(D.advance.t, P('ai.advance.wait'))} ${D.advance.t.toFixed(1)}/${P('ai.advance.wait')}`);
    lines.push(`flank   ${bar(D.flank.t, P('ai.flank.wait'))} ${D.flank.t.toFixed(1)}/${P('ai.flank.wait')}`);
    lines.push(`grenade ${bar(gr.t, P('ai.grenade.timer'))} ${gr.t.toFixed(1)}/${P('ai.grenade.timer')}`);
    lines.push(`tokens  ${D.npcs.filter((n) => n.ai.tok).map((n) => n.id).join(' ') || '—'}  (min ${P('ai.tokens.min')} / max ${P('ai.tokens.max')})`);
    lines.push(`confirm ${D.confirm.active ? (D.confirm.checker ? D.confirm.checker.id : '?') + ' (' + D.confirm.reason + ')' : '—'}`);
    lines.push('—');
    for (const e of D.log.slice(-9)) lines.push(`${e.t.toFixed(2).padStart(6)} ${e.actor ? e.actor + ' ' : ''}${e.what}`);
    panel.textContent = lines.join('\n');
  }

  const sys = { name: 'ai.debug', order: 95, frame: () => update() };
  game.addSystem(sys);
  return { group, update, setVisible, get visible() { return visible; }, dispose() { window.removeEventListener('keydown', onKey); host.remove(); scene.remove(group); game.removeSystem(sys); } };
}
