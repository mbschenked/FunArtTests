// Renderer + post pipeline. Contract: refs/design.md "render.js (A5): game.render".
// Ported from vfx-studies/range.html (the approved VFX range) and the muzzle-flash study's one range change (the per-texel
// bloom weight in the HDR alpha). Copied, not linked: this module must work with cover-room/ on its own.
//
// HDR PIPELINE   scene -> 4x MSAA RGBA16F (+ depth texture) -> distortion composite -> [effect passes: addPass()] ->
//   bloom (UnrealBloomPass with a per-texel soft-knee prefilter and a linear strength) -> OutputPass (tone map E, the
//   grade, sRGB). Values are scene-referred linear radiance: 1.0 = diffuse white = the bloom threshold, the soft knee starts
//   at 0.7. Keep the environment under ~0.7 so only emissive values (effects: 2..60) bloom. The HDR alpha is a per-texel
//   BLOOM WEIGHT: everything writes 1, an effect pass may lower it (the muzzle flash does under its defined flame).
//
// TONE MAP E   (Max's pick, 12 Oct 2026) ACES filmic's curve (three r160's RRTAndODTFit) applied to R, G and B separately,
//   without the ACES colour matrices: greys tone exactly as ACES filmic, saturated colours keep their saturation until each
//   channel reaches its own shoulder (amber -> lemon -> white). ?tm=aces brings back stock ACES filmic for A/B checks.
//
// GRADE   setGrade({saturation, vignette, tint, contrast}) runs inside the OutputPass after tone mapping, in display-linear
//   RGB (0..1), before the sRGB transfer: no extra full-screen pass. Neutral = {1, 0, [1,1,1], 1}.
//
// UNITS   metres, radians. Exposure is the tone-mapping exposure (1 = the curve as written). Light intensities are three.js
//   physical units (candela / lux-like), which the level module owns.
//
// BUDGET (measured on the range, Apple silicon): ~3.4 ms per megapixel for the whole pipeline, so the drawing buffer is
//   capped at 4.2 MPix live (8.5 MPix for single-frame captures) on top of the devicePixelRatio cap of 2.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export { Pass, FullScreenQuad };

const QP = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const TONE_MAP = QP.get('tm') === 'aces' ? 'aces' : 'e';
const DPR_MAX = 2;

// --- Tone map E: replace three's CustomToneMapping placeholder once per page --------------------------------------------
{
  const marker = '// Tone map E.';
  const placeholder = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  if (!chunk.includes(marker)) {
    if (!chunk.includes(placeholder)) throw new Error('tone map E: the CustomToneMapping placeholder is not in this three.js build');
    THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(placeholder, /* glsl */`
${marker} color: linear scene-referred radiance (1.0 = diffuse white); toneMappingExposure: the look's exposure.
// Returns linear display RGB in [0, 1]; OutputPass applies the grade and the sRGB transfer afterwards.
vec3 CustomToneMapping( vec3 color ) {
	return saturate( RRTAndODTFit( max( color, vec3( 0.0 ) ) * ( toneMappingExposure / 0.6 ) ) );   // ACES's pre-scale, per channel
}`);
  }
}

// Exposure presets. The level module owns the lights and sky; a look here is only the tone-mapping exposure that the range
// matched to each lighting state (each E exposure matches its backdrop's mean luma under ACES; vfx-studies, 12 Oct 2026).
export const LOOKS = {
  day:   { exposure: 1.002, acesExposure: 1.0 },
  dusk:  { exposure: 1.099, acesExposure: 1.1 },
  night: { exposure: 1.139, acesExposure: 1.15 },
};
const BLOOM = { strength: 0.6, radius: 0.4, threshold: 1.0, knee: 0.3 };   // range defaults

export const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Depth linearisation, shared by the distortion composite and every effect shader that reads render.sceneDepth.
// d = raw depth sample 0..1 (1.0 = cleared = far plane), nearFar = (camera.near, camera.far) in metres. Returns metres in
// front of the camera ALONG ITS VIEW AXIS (= -(modelViewMatrix * vec4(position, 1.0)).z in a vertex shader).
export const DEPTH_GLSL = /* glsl */`
  float rangeViewDepth(float d, vec2 nearFar) {
    float z = d * 2.0 - 1.0;
    return 2.0 * nearFar.x * nearFar.y / (nearFar.y + nearFar.x - z * (nearFar.y - nearFar.x));
  }
`;

// Additive signed-offset blending for meshes in render.distortionScene (they write a UV offset into .rg, never depth).
export const DISTORTION_MATERIAL_PARAMS = Object.freeze({
  transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
});

// Scene into its own 4x MSAA RGBA16F target with a DepthTexture (resolved with the colour), so the distortion pass and the
// effects can read FULL-RESOLUTION opaque depth. Composer buffers stay single-sample.
class ScenePass extends Pass {
  constructor(renderer, scene, camera) {
    super();
    this.scene = scene; this.camera = camera;
    this.needsSwap = false;
    this.depthTexture = new THREE.DepthTexture(2, 2);
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      samples: Math.min(4, renderer.capabilities.maxSamples),
      depthTexture: this.depthTexture,
    });
  }
  setSize(w, h) { this.target.setSize(w, h); }
  render(r) {
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
  }
}

// Distortion at full resolution: distortionScene meshes add signed UV offsets into an RGBA16F buffer whose depth attachment IS
// the scene depth (read-only), then a composite samples the scene colour at uv + offset. With nothing to distort this is the
// MSAA resolve copy the chain needs anyway (one fetch per pixel). Guards: silhouette (no displacement next to markedly nearer
// geometry), lookup visibility (a displaced lookup that lands on much nearer geometry falls back: depth ratio < 0.55 rejected,
// > 0.8 accepted), and emissive radiance (luminance > ~1) is never displaced nor pulled.
// Uniforms: tColor HDR scene, tDistortion offsets (.rg, UV units), tDepth scene depth (0..1), uGain global multiplier,
//   uMaxOffset clamp on |offset| (UV units), uNearFar camera near/far (m), uActive 0 = nothing to distort.
class DistortionPass extends Pass {
  constructor(distortionScene, camera, scenePass) {
    super();
    this.distortionScene = distortionScene; this.camera = camera; this.scenePass = scenePass;
    this.needsSwap = true;
    this.dirty = true;
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, depthTexture: scenePass.depthTexture,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tDistortion: { value: null }, tDepth: { value: null },
        uGain: { value: 1 }, uMaxOffset: { value: 0.12 }, uNearFar: { value: new THREE.Vector2(0.05, 400) }, uActive: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */`
        uniform sampler2D tColor;
        uniform sampler2D tDistortion;
        uniform sampler2D tDepth;
        uniform float uGain;
        uniform float uMaxOffset;
        uniform vec2  uNearFar;
        uniform float uActive;
        varying vec2 vUv;
        const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
        float emissive(vec3 c) { return smoothstep(0.8, 1.6, dot(c, LUMA)); }
        ${DEPTH_GLSL}
        float viewDepth(float d) { return rangeViewDepth(d, uNearFar); }
        float depthAt(ivec2 p, ivec2 size) { return viewDepth(texelFetch(tDepth, clamp(p, ivec2(0), size - 1), 0).r); }
        void main() {
          vec4 s0 = texture2D(tColor, vUv);
          vec3 c0 = s0.rgb;
          vec2 d = vec2(0.0);
          if (uActive > 0.5) d = texture2D(tDistortion, vUv).rg * uGain * (1.0 - emissive(c0));
          float l = length(d);
          if (l < 1e-5) { gl_FragColor = vec4(c0, 1.0); return; }
          if (l > uMaxOffset) d *= uMaxOffset / l;
          ivec2 size = textureSize(tDepth, 0);
          ivec2 pc = ivec2(vUv * vec2(size));
          float zHere = depthAt(pc, size);
          float zEdge = min(min(depthAt(pc + ivec2(1, 0), size), depthAt(pc - ivec2(1, 0), size)),
                            min(depthAt(pc + ivec2(0, 1), size), depthAt(pc - ivec2(0, 1), size)));
          d *= smoothstep(0.55, 0.8, zEdge / zHere);
          vec2 uv1 = clamp(vUv + d, 0.0, 1.0);
          ivec2 q = ivec2(floor(uv1 * vec2(size) - 0.5));
          float zLook = min(min(depthAt(q, size), depthAt(q + ivec2(1, 0), size)),
                            min(depthAt(q + ivec2(0, 1), size), depthAt(q + ivec2(1, 1), size)));
          float visible = smoothstep(0.55, 0.8, zLook / zHere);
          vec3 cd = texture2D(tColor, uv1).rgb;
          cd = mix(cd, c0, emissive(cd));
          gl_FragColor = vec4(mix(c0, cd, visible), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this._clearColor = new THREE.Color();
  }
  setSize(w, h) { this.target.setSize(w, h); this.dirty = true; }
  static hasRenderable(o) {
    if (!o.visible) return false;
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) return true;
    for (let i = 0; i < o.children.length; i++) if (DistortionPass.hasRenderable(o.children[i])) return true;
    return false;
  }
  render(r, writeBuffer) {
    const active = DistortionPass.hasRenderable(this.distortionScene);
    if (active || this.dirty) {
      const prevAuto = r.autoClear, prevAlpha = r.getClearAlpha();
      r.getClearColor(this._clearColor);
      r.setRenderTarget(this.target);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);                            // colour only: the depth attachment belongs to the scene pass
      if (active) {
        r.autoClear = false;
        r.render(this.distortionScene, this.camera);
        r.autoClear = prevAuto;
      }
      r.setClearColor(this._clearColor, prevAlpha);
      this.dirty = active;
    }
    const u = this.material.uniforms;
    u.tColor.value = this.scenePass.target.texture;
    u.tDistortion.value = this.target.texture;
    u.tDepth.value = this.scenePass.depthTexture;
    u.uNearFar.value.set(this.camera.near, this.camera.far);
    u.uActive.value = active ? 1 : 0;
    r.setRenderTarget(writeBuffer);
    this.quad.render(r);
  }
}

// Build the renderer and the pipeline; sets game.render, game.scene, game.camera.
// opts: canvas (else one is made and appended to opts.container || document.body), static (single-frame capture: larger
//   pixel budget, preserveDrawingBuffer), look ('day' default: the courtyard is sunlit [ASSUMED]), fov / near / far.
export function createRender(game, opts = {}) {
  const P = game.params;
  const isStatic = !!opts.static;
  const PIXEL_BUDGET = isStatic ? 8.5e6 : 4.2e6;
  let canvas = opts.canvas;
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;position:fixed;inset:0;width:100%;height:100%;';
    (opts.container || document.body).appendChild(canvas);
  }
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: isStatic,
  });
  if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 is required for the HalfFloat render targets.');
  const sizeOf = () => {
    const el = opts.container || null;
    const w = el ? el.clientWidth : window.innerWidth, h = el ? el.clientHeight : window.innerHeight;
    return [Math.max(1, w), Math.max(1, h)];
  };
  const pixelRatioFor = (w, h) => Math.max(0.5, Math.min(window.devicePixelRatio || 1, DPR_MAX, Math.sqrt(PIXEL_BUDGET / (w * h))));
  let [W, H] = sizeOf();
  renderer.setPixelRatio(pixelRatioFor(W, H));
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = TONE_MAP === 'aces' ? THREE.ACESFilmicToneMapping : THREE.CustomToneMapping;   // applied by OutputPass only
  renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x000000, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;                     // one reset per frame in draw(), so calls cover every pass

  const scene = new THREE.Scene();
  const distortionScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(opts.fov ?? 50, W / H, opts.near ?? 0.05, opts.far ?? 400);
  scene.add(camera);                                   // so camera-attached children render

  const composer = new EffectComposer(renderer);
  const scenePass = new ScenePass(renderer, scene, camera);
  const distortionPass = new DistortionPass(distortionScene, camera, scenePass);
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(W, H), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  const outputPass = new OutputPass();

  // Bloom (r160 fixes from the range): (a) a soft knee on the EXCESS above the threshold, applied to every full-resolution
  // texel BEFORE the 4x4 box downsample (thin tracers and sparks bloom in proportion to their own radiance), each texel
  // weighted by its HDR alpha (the bloom weight, muzzle-flash study); (b) blend One/One so strength is linear, not squared.
  bloomPass.highPassUniforms.uKnee = { value: BLOOM.knee };
  bloomPass.materialHighPassFilter.fragmentShader = /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float luminosityThreshold;   // linear luminance where bloom starts (scene-referred, 1.0 = diffuse white)
    uniform float uKnee;                 // width of the soft shoulder below the threshold (same units)
    varying vec2 vUv;
    vec3 prefilter(vec3 c) {
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float soft = clamp(l - luminosityThreshold + uKnee, 0.0, 2.0 * uKnee);
      soft = soft * soft / (4.0 * uKnee + 1e-5);
      return c * (max(soft, l - luminosityThreshold) / max(l, 1e-5));
    }
    void main() {
      // half-resolution target: each texel = the mean of the 4x4 source block centred on it, knee applied per source texel
      ivec2 size = textureSize(tDiffuse, 0);
      ivec2 o = ivec2(floor(vUv * vec2(size) + 0.5)) - 2;
      vec3 sum = vec3(0.0);
      for (int y = 0; y < 4; y++) {
        for (int x = 0; x < 4; x++) {
          vec4 t = texelFetch(tDiffuse, clamp(o + ivec2(x, y), ivec2(0), size - 1), 0);
          sum += prefilter(t.rgb) * clamp(t.a, 0.0, 1.0);   // alpha = per-texel bloom weight (1 unless an effect lowers it)
        }
      }
      gl_FragColor = vec4(sum * (1.0 / 16.0), 1.0);
    }`;
  bloomPass.materialHighPassFilter.needsUpdate = true;
  bloomPass.blendMaterial.blending = THREE.CustomBlending;
  bloomPass.blendMaterial.blendEquation = THREE.AddEquation;
  bloomPass.blendMaterial.blendSrc = THREE.OneFactor;
  bloomPass.blendMaterial.blendDst = THREE.OneFactor;

  // OutputPass: add the CustomToneMapping branch r160 lacks (tone map E) and the grade, after tone mapping and before the
  // sRGB transfer. Grade uniforms (display-linear RGB, 0..1):
  //   uGrade.x saturation (1 unchanged, 0 grey)   uGrade.y vignette strength (0 none, 1 black corners)
  //   uGrade.z contrast (1 unchanged; a power curve pivoting on display-linear 0.18, mid grey)   uGrade.w 1 = grade on
  //   uTint    multiplier per channel (1,1,1 = none)   uAspect = (drawing-buffer width / height, 1), for a round vignette
  Object.assign(outputPass.uniforms, {
    uGrade: { value: new THREE.Vector4(1, 0, 1, 0) },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
    uAspect: { value: new THREE.Vector2(W / H, 1) },
  });
  {
    let fs = outputPass.material.fragmentShader;
    const before = fs;
    fs = fs.replace('#elif defined( AGX_TONE_MAPPING )',
      '#elif defined( CUSTOM_TONE_MAPPING )\n\t\t\t\tgl_FragColor.rgb = CustomToneMapping( gl_FragColor.rgb );\n\t\t\t#elif defined( AGX_TONE_MAPPING )');
    if (fs === before) throw new Error('tone map E: the OutputShader branch to extend was not found');
    const b2 = fs;
    fs = fs.replace('varying vec2 vUv;', /* glsl */`varying vec2 vUv;
		uniform vec4 uGrade;
		uniform vec3 uTint;
		uniform vec2 uAspect;
		vec3 gradeColor( vec3 c ) {
			float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
			c = mix( vec3( l ), c, uGrade.x );
			c *= uTint;
			c = 0.18 * pow( max( c, vec3( 0.0 ) ) / 0.18, vec3( uGrade.z ) );
			vec2 d = ( vUv - 0.5 ) * uAspect;
			float r = length( d ) / length( 0.5 * uAspect );          // 0 centre .. 1 corner
			c *= 1.0 - uGrade.y * smoothstep( 0.3, 1.0, r );
			return clamp( c, 0.0, 1.0 );
		}`);
    fs = fs.replace('// color space', '// grade (render.setGrade)\n\t\t\tif ( uGrade.w > 0.5 ) gl_FragColor.rgb = gradeColor( gl_FragColor.rgb );\n\n\t\t\t// color space');
    if (fs === b2 || !fs.includes('gradeColor( gl_FragColor.rgb )')) throw new Error('render: the OutputShader grade hook was not found');
    outputPass.material.fragmentShader = fs;
    if (TONE_MAP === 'e') {
      // OutputPass rebuilds its defines only when the colour space / tone mapping changes and knows only the built-in
      // operators, so for E the cache fields and defines are set here once (neither renderer setting changes later).
      outputPass._outputColorSpace = renderer.outputColorSpace;
      outputPass._toneMapping = renderer.toneMapping;
      outputPass.material.defines = { CUSTOM_TONE_MAPPING: '' };
      if (THREE.ColorManagement.getTransfer(renderer.outputColorSpace) === THREE.SRGBTransfer) outputPass.material.defines.SRGB_TRANSFER = '';
    }
    outputPass.material.needsUpdate = true;
  }

  composer.addPass(scenePass);
  composer.addPass(distortionPass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  // --- params (panel folder "render") -------------------------------------------------------------------------------------
  const lookNames = Object.keys(LOOKS);
  const startLook = LOOKS[QP.get('look')] ? QP.get('look') : (opts.look && LOOKS[opts.look] ? opts.look : 'day');
  const expOf = (name) => (TONE_MAP === 'aces' ? LOOKS[name].acesExposure : LOOKS[name].exposure);
  P.define('render.look', startLook, { options: lookNames, label: 'Exposure preset' });
  P.define('render.exposure', expOf(P.get('render.look')), { min: 0.1, max: 4, step: 0.001, label: 'Exposure (tone map E)' });   // vfx-studies LOOKS [MEASURED]
  P.define('render.bloom.strength', BLOOM.strength, { min: 0, max: 3, step: 0.01, label: 'Bloom strength' });                 // range [approved]
  P.define('render.bloom.radius', BLOOM.radius, { min: 0, max: 1, step: 0.01, label: 'Bloom radius' });
  P.define('render.bloom.threshold', BLOOM.threshold, { min: 0, max: 4, step: 0.01, label: 'Bloom threshold (radiance)' });
  P.define('render.bloom.knee', BLOOM.knee, { min: 0.01, max: 1, step: 0.01, label: 'Bloom soft knee' });
  P.define('render.distortion.gain', 1, { min: 0, max: 3, step: 0.01, label: 'Distortion gain' });
  const syncParams = () => {
    renderer.toneMappingExposure = P.get('render.exposure');
    bloomPass.strength = P.get('render.bloom.strength');
    bloomPass.radius = P.get('render.bloom.radius');
    bloomPass.threshold = P.get('render.bloom.threshold');
    bloomPass.highPassUniforms.uKnee.value = P.get('render.bloom.knee');
    distortionPass.material.uniforms.uGain.value = P.get('render.distortion.gain');
  };
  for (const k of ['render.exposure', 'render.bloom.strength', 'render.bloom.radius', 'render.bloom.threshold', 'render.bloom.knee', 'render.distortion.gain']) P.onChange(k, syncParams);
  P.onChange('render.look', (name) => { if (LOOKS[name]) P.set('render.exposure', expOf(name)); if (game.events) game.events.emit('render:look', { name }); });
  syncParams();

  const _buf = new THREE.Vector2();
  const render = {
    THREE, renderer, scene, camera, composer, canvas, distortionScene,
    scenePass, distortionPass, bloomPass, outputPass,
    sceneDepth: scenePass.depthTexture,                // full-res opaque depth of this frame: read it from addPass passes only
    sceneDepthGLSL: DEPTH_GLSL,                        // defines float rangeViewDepth(float d, vec2 nearFar)
    distortionMaterialParams: DISTORTION_MATERIAL_PARAMS,
    toneMap: TONE_MAP,
    looks: LOOKS,
    drawCalls: 0, triangles: 0,
    grade: { saturation: 1, vignette: 0, tint: [1, 1, 1], contrast: 1 },

    // Insert an EffectComposer Pass into the HDR chain right before bloom (after the distortion composite and any pass added
    // earlier). Returns a function that removes it again.
    addPass(pass) {
      composer.insertPass(pass, composer.passes.indexOf(bloomPass));
      return () => composer.removePass(pass);
    },

    // Final grade (the HUD's damage look). Any field may be omitted; omitted fields keep their current value.
    //   saturation 0..1+ (1 = unchanged, 0 = grey), vignette 0..1 (darkens toward the corners), tint [r,g,b] or THREE.Color
    //   (multiplier, display-linear), contrast (1 = unchanged). Neutral values switch the grade off.
    setGrade({ saturation, vignette, tint, contrast } = {}) {
      const g = render.grade;
      if (Number.isFinite(saturation)) g.saturation = saturation;
      if (Number.isFinite(vignette)) g.vignette = vignette;
      if (Number.isFinite(contrast)) g.contrast = contrast;
      if (tint) {
        if (tint.isColor) { g.tint[0] = tint.r; g.tint[1] = tint.g; g.tint[2] = tint.b; }
        else if (tint.length === 3) { g.tint[0] = tint[0]; g.tint[1] = tint[1]; g.tint[2] = tint[2]; }
      }
      const u = outputPass.uniforms;
      u.uGrade.value.set(g.saturation, g.vignette, g.contrast,
        g.saturation !== 1 || g.vignette !== 0 || g.contrast !== 1 || g.tint[0] !== 1 || g.tint[1] !== 1 || g.tint[2] !== 1 ? 1 : 0);
      u.uTint.value.set(g.tint[0], g.tint[1], g.tint[2]);
    },

    // Exposure preset by name (day / dusk / night); the level module owns lights and sky and may listen to 'render:look'.
    look(name) { if (LOOKS[name]) P.set('render.look', name); return P.get('render.look'); },

    resize() {
      [W, H] = sizeOf();
      const pr = pixelRatioFor(W, H);
      renderer.setPixelRatio(pr);
      renderer.setSize(W, H, false);
      if (composer._pixelRatio !== pr) composer.setPixelRatio(pr);   // (re)sizes every pass
      composer.setSize(W, H);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      renderer.getDrawingBufferSize(_buf);
      outputPass.uniforms.uAspect.value.set(_buf.x / Math.max(_buf.y, 1), 1);
    },

    // Draw one frame (game.tick calls this after the per-frame systems).
    draw() {
      renderer.info.reset();
      camera.updateMatrixWorld();
      composer.render(0);
      render.drawCalls = renderer.info.render.calls;
      render.triangles = renderer.info.render.triangles;
    },

    bufferSize(out = new THREE.Vector2()) { return renderer.getDrawingBufferSize(out); },
    stats() {
      renderer.getDrawingBufferSize(_buf);
      return { drawCalls: render.drawCalls, triangles: render.triangles, buffer: [_buf.x, _buf.y], pixelRatio: renderer.getPixelRatio(), toneMap: TONE_MAP };
    },
  };
  render.resize();
  if (!isStatic) window.addEventListener('resize', () => render.resize());

  game.render = render;
  game.scene = scene;
  game.camera = camera;
  return render;
}
