# AI for real-time VFX: scouting report

Written on 11 Oct 2026 from the briefs of six research scouts, for Max and the `u4-vfx-build` orchestrator. It covers the Uncharted 4 tracer and muzzle-flash studies in `vfx-studies/`.

**Tags used below**
- **Demonstrated**: the source shows results (tables, figures, images or video). No scout viewed images or video, so quality verdicts come from text, tables and the sources' own descriptions.
- **Claimed**: stated without evidence shown, or only in an abstract, a vendor page or a forum post.
- **Checked**: I re-opened the source on 11 Oct 2026, because scouts disagreed or the claim carries weight here.
- **[inferred]**: our reasoning, not something a source says. **[ASSUMED]**: a guess about our setup that Max should confirm.

---

## 1. Headline: has anyone made or tuned VFX with AI and got good results?

**Partly.** Research systems show measured gains when AI works inside a render, critique and patch loop. Working VFX artists also report good results when they direct and ChatGPT or Claude writes the shader code. But nobody has publicly matched one specific game effect from footage. The one public test of an agent designing 50+ effects on its own was judged generic by working VFX artists, and vision models still miss most fine visual differences. What transfers to us is how the research loops are run, not a tool we can install.

### The best examples

1. **ParticleGen** (Zhejiang University, Aug 2026, [paper](https://arxiv.org/html/2608.00629)). Agents turn a text prompt into an Unreal Niagara effect via a JSON settings file. Each round they render it, have a vision model critique sampled frames, apply small patches and roll back the ones that don't help. The loop returns the best state within 4 rounds. In a blind test, 20 professional technical artists rated 10 effects 4.40/5 for looks (first drafts: 3.19) and 4.42 for matching the prompt (3.26). *Demonstrated, checked.* Limits: it works from text, not a reference clip; it picks from a fixed library of materials and makes no textures; no code has been released.
2. **Artists directing while the model writes shader code** (realtimevfx, 2025-26: [cEssex](https://realtimevfx.com/t/improving-niagara-lighting/28537), [cEssex again](https://realtimevfx.com/t/blocked-stopped/30503/4), [Hovl](https://realtimevfx.com/t/hovl-s-sketchbook/6983/445)). cEssex, who says they aren't a programmer, built and profiled a screen-space light-shaft material for particle sprites with ChatGPT: about 0.3 ms for a 4K screen, shown on video. They later credited Claude and ChatGPT for custom HLSL they couldn't have written before. Hovl built a screen-space shader with ChatGPT's help. *Demonstrated, but three posts by two artists, not a survey.*
3. **Hovl's 50+ agent-built Unity effects** (Sept 2026, [thread](https://realtimevfx.com/t/ai-is-able-to-create-super-complex-effects-now/31737)). This is the honest ceiling for an agent that designs effects with little direction. Other VFX artists rated the results intern-level at best and said they looked like an effect from a cheap asset pack. The agent leaned on Hovl's own textures and shaders without being asked. One effect, prompted with another artist's screenshot, came out so close to that artist's work that Hovl deleted all of them. Someone asked how much cherry-picking went in, and got no answer. *Demonstrated, checked.*
4. **BlenderAlchemy and VLMaterial** (ECCV 2024, [paper](https://arxiv.org/abs/2404.17672); ICLR 2025, [paper](https://arxiv.org/html/2501.18623v2)). In BlenderAlchemy, a vision model edits a procedural Blender material until its render matches a target, with a pairwise judge and the best version always kept. In VLMaterial, a fine-tuned model writes the material and an optimiser then fits its numbers. Both show clear measured gains but loose matches. On the [BlenderGym](https://arxiv.org/abs/2504.01786) benchmark, the best model's error on procedural materials was about 6 times a human's. *Demonstrated, but on materials, not effects.*
5. **AI-tuned procedural smoke** (Brochu, Brochu and de Freitas, 2010, [paper](https://haikufactory.com/files/sca2010.pdf)). The artist picks the best of four animations and a Bayesian model proposes the next four. On a 12-slider smoke system this reached close to expert accuracy in about 5 rounds, while novices tuning the sliders by hand gave up. *Demonstrated, in small studies.*

Two more are real but off our path. Pixar used neural style transfer on fire simulations for *Elemental*, which is offline film work ([talk](https://graphics.pixar.com/library/ElementalNST), claimed). And an open add-on for the LTX 2.5 video model turns flat painted silhouettes into moving fire and smoke ([model card](https://huggingface.co/AInVFX/ainvfx-fluid), demonstrated, checked).

### What nobody has shown
- AI matching one specific game effect from footage, with side-by-side evidence.
- Machine learning that generates fire, smoke or muzzle flashes at runtime in a shipped game.
- An independent quality test of AI-generated flipbooks. All the evidence is vendor demos or paper figures.
- A test of vision models as critics of fire, smoke or glow.
- Any breakdown of how Uncharted 4's muzzle flash or tracer was built. Naughty Dog's SIGGRAPH 2015 talk covers explosions, smoke and fire only ([abstract](https://history.siggraph.org/?p=159912)), so our captured frames stay the ground truth.

### What it means for us
- Our loop already checks its work more thoroughly than any public agent: we render in headless Chrome, measure against captured frames, adjust, and stop for Max. Coplay's Unity agent checks one rendered frame ([blog](https://coplay.dev/blog/ai-vfx)), and Aura's Unreal agent docs describe no check of rendered output at all ([docs](https://www.tryaura.dev/documentation/vfx-agent)).
- The research loops' habits are what to borrow: keep the best state, make small patches, judge with numbers, and let Max pick rather than describe (section 2).
- Design and taste stay with Max. That is exactly where the evidence says agents fall short.

---

## 2. Tactics to adopt now, ranked

| # | Tactic | Effort | Where it fits |
|---|---|---|---|
| 1 | Keep the best state, roll back what fails, cap the rounds | Low | Calibration step, fix rounds |
| 2 | Numbers judge detail, the model judges gestalt, Max judges taste | Low | Critics, calibration gate |
| 3 | Diagnose, look it up, then patch one layer | Low | Build loop, fix rounds |
| 4 | Build the flash from small randomised sprite sets (the studio recipe) | Low to medium (partly in place) | Asset creation, build loop |
| 5 | Give Max a pick-one-of-four board at each stop | Low to medium | Max's review stop |
| 6 | Give the agent known-good code, and gate every edit | Low to medium | Build loop, gate before the critics |
| 7 | Score fire and mist with texture-tolerant measures, at many moments | Medium-low | Calibration step, critics |
| 8 | Let an optimiser fit the numbers once the structure is right | Medium | Calibration step (a new tool) |

### 1. Keep the best state, roll back what fails, cap the rounds
- **What.** In every calibration or fix round, the agent changes the effect with small, named patches to its settings JSON (the Copy-settings format). It doesn't rewrite. After each render it scores the result against the calibration table and logs the settings with their score. A patch that lowers the score is undone. A round ends at a pass threshold or after 4 rounds, and the best-scoring state goes to Max, not the last one.
- **Why it helps here.** Two of our controls are known overshoot traps: the density of the flash and the fade of the mist. ParticleGen hit the same trap: per one scout's reading, a single refinement pass took a snow mist from barely visible to too dense. Its fix was rollback plus returning the best state. Keeping the best also protects the calibrated hero defaults (AK moment 01, tracer moment 02) when a later patch fixes one number and breaks two others.
- **Evidence.** ParticleGen (demonstrated, checked): the full loop raised the artists' looks rating from 3.19 to 4.40. A single refinement pass reached only 3.62, and its automatic looks score slipped from 3.57 to 3.49. BlenderAlchemy (demonstrated): removing the rule that keeps the best version cut its score from 28.2 to 25.8, nearly as much as removing vision altogether (25.7).
- **Effort.** Low: new wording in the build and fix prompts, plus a small helper that logs and restores settings [inferred].
- **Fits.** The calibration step and fix rounds: the build's calibrate instructions and the fix prompt in `u4-vfx-build`.

### 2. Numbers judge detail, the model judges gestalt, Max judges taste
- **What.**
  - The calibration table is the hard gate for anything measurable: clipped-white share, colour bands, clipped area per 1x frame, violet glow size and colour, and mist opacity at fixed ages.
  - The look critic's own eyes answer only coarse questions. Is a layer missing? Is the silhouette or the phase order wrong? Would a UC4 player recognise it?
  - To compare two renders, ask "which is closer to the reference?" twice with the order swapped, and count only answers that agree [inferred from BlenderGym's results on verification].
  - Feed the critic labelled PNGs ("Image 1:", "Image 2:"), images before the question, cropped so the effect spans well over 200 px. Never send GIFs, because only the first frame is read.
  - Keep every PNG an agent reads at 2000 px or less on the long edge. Once a request holds more than 20 images, a stricter size limit applies to every one of them. Images from earlier turns and tool results count, so this hits long agent sessions that read many renders.
- **Why it helps here.** The differences that matter most are fine ones: violet against lavender, the orange of the break-up, how fast the mist fades. Those are exactly what vision models miss.
- **Evidence.**
  - DiffSpot, May 2026 (demonstrated, checked): the best of 13 frontier vision models found only 40.7% of single-property changes in web pages. Every model scored under 23% on the hard tier, and neither the pixel size of a change nor CLIP distance predicted what got noticed.
  - BlenderGym (demonstrated): models agreed with humans on which render was closer 66% of the time, against 79% between humans (chance is 50%). With bigger budgets, results improved by giving verification a larger share of the model calls: 33% below 30 calls, 73% above 100.
  - Anthropic's vision docs (checked): the image limits above, and advice not to use Claude for tasks that need perfect precision without human oversight.
- **Effort.** Low: new wording in the look critic's prompt and the calibration step.
- **Fits.** Critics (the look critic) and the calibration gate.

### 3. Diagnose, look it up, then patch one layer
- **What.** Before each edit, the agent writes three lines: the difference it sees, the slider or shader block it blames, and the change. Each spec gets a symptom-to-cause table that grows with every review. Seed rows from what we already know:
  - The flash reads as one or two smooth, milky blobs → too few pieces. Add licks and flecks between the lobes and more sprite variants per phase, then check density per phase against the frames.
  - The tracer's back reads as a laser → shorten the hand-off from head to tail, and taper the tail to a point.
  - The mist reads as glow → it should be lit, alpha-blended mist, never additive.
  - The mist lingers or vanishes at the wrong time → fix the fade-shape curve first (plainly visible at about 0.25 s, gone by about 0.7 s), then the lifetime.
  - The violet afterglow flickers or drifts → it should be a static, soft sprite with its own lifetime, not flame.

  Work on one layer at a time, with only that layer's sliders and shader block in scope, and keep each editable block short. Mostly run "tweak" rounds that change slider values only, with an occasional "leap" round that changes shader structure.
- **Why it helps here.** Both effects are stacks of layers, and a wrong diagnosis moves the wrong layer and breaks a calibrated one. The three-line log also gives Max a readable record of what changed and why.
- **Evidence.** ParticleGen (demonstrated, but this test was qualitative only): without its symptom-to-cause knowledge base, the refiner blamed the wrong module. BlenderAlchemy (demonstrated): it diagnoses before editing, and dropping its tweak rounds cut its score from 28.2 to 26.6. BlenderGym (demonstrated): failures cluster where the edit doesn't match the diagnosis, the diagnosis is skipped, or the script runs past about 80 lines. Coplay's blog (vendor, demonstrated): per-effect recipes fixed the agent's wrong shader choices and messy structure. 14islands (claimed): asking for a plan before code cut compile errors.
- **Effort.** Low.
- **Fits.** The build loop and fix rounds. The table lives in each spec.

### 4. Build the flash from small randomised sprite sets (the studio recipe)
- **What.**
  - Keep a set of 4-8 sprite variants per phase, picked one per shot, with random roll and size (small, medium, large).
  - Use a round core card, plus directional cards for the lobes and column that fade out when seen edge-on.
  - Let some elements appear on only some shots (side lobes on about half of them).
  - Keep the parts attached to the gun separate from the world-space parts that linger (mist, afterglow).
  - Drive a short-lived point light from the flash's brightness curve.
  - If we bake a short flipbook (8-16 frames), play a random 4-frame window per shot, keeping the start plus the length inside the sheet.
- **Why it helps here.** It answers Max's stage-1 note that the flash had too few pieces. This is how studio artists get density and variety from shot to shot out of a handful of textures. Much of it is already in the spec (onset variants, roll and scale jitter, the muzzle light). The new parts are the per-phase variant sets, the probability controls and the random flipbook window, each as a slider.
- **Evidence.** All claimed, from practitioners, with no images viewed:
  - In a [realtimevfx thread](https://realtimevfx.com/t/wondering-how-good-muzzle-flashes-are-made/13540), one poster recalls Battlefield 1 and Just Cause 4 muzzle flashes as billboard particles only, on screen for 1-2 frames, with separate first- and third-person versions. Another artist there gives the recipe above: sets of 4 or 8 textures, core plus directional cards, the edge-on fade, emitting half the time.
  - A [2025 thread](https://realtimevfx.com/t/flipbook-frame-offset-on-muzzle-flashes-for-greater-variations/28301) describes random flipbook windows for muzzle flashes and calls 16 frames plenty.
  - Epic's 2013 Infiltrator flashes used a cone-shaped element plus a dynamic light ([CG Channel](https://www.cgchannel.com/?p=58401); the cone detail comes from secondary summaries).
- **Effort.** Low to medium, and partly in place.
- **Fits.** Asset creation and the build loop for the muzzle flash. The tracer needs no sprite sets (see section 5).

### 5. Give Max a pick-one-of-four board at each stop
- **What.** Next to the usual comparison board, render four presets of the same build that differ only on the open question, each beside the reference strip. The question might be how much the mist warps, how dense the licks are, or how strong the violet glow is. Max picks one, or says "between B and C", and it becomes the new default. Max can also lock sliders or narrow their ranges, and those limits feed any later optimiser. The four are presets of the one adjustable build, not separate builds.
- **Why it helps here.** Several open questions are taste calls that numbers can't settle. One is Max's warping mist against the gentler bend in the footage; another is how strong the violet afterglow should be. Picking is faster and more reliable than describing.
- **Evidence.**
  - Brochu et al. 2010 (demonstrated, small studies): novices tuning a 12-slider smoke system by hand got so frustrated that the experiment was stopped. A pick-one-of-four gallery plus sliders came close to an expert's accuracy in about 5 rounds. Numeric ratings took about 3 times as many rounds as picking, and people quit after about 20 rounds without visible progress.
  - BlenderAlchemy (demonstrated): a balanced search (4 rounds of 8 candidates, or 8 of 4) beat both one huge round and many single-candidate rounds.
  - [AI Co-Artist](https://arxiv.org/html/2512.08951) (claimed) and the [Parallax](https://github.com/propersloth/parallax-threejs) plugin's contact sheets of slider sweeps (claimed) use the same pattern.
- **Effort.** Low to medium: a board script that renders presets. The range already renders boards.
- **Fits.** Max's review stop at the end of each stage.

### 6. Give the agent known-good code, and gate every edit
- **What.** Before the next build stage, have an agent take apart 2-5 strong implementations of fire, explosions and trails into one pinned snippet file, written for Three.js r160 and WebGL2. It should cover noise and fbm, curl noise, additive HDR colour ramps, velocity-aligned billboards, ribbon trails, alpha erosion and soft particles, plus our own HDR and bloom-safe intensity ranges. Copy code only from MIT or CC0 sources and study the rest. Add a validator that every edit must pass before any critic sees it: the shader compiles, the canvas isn't blank, there are no NaN or Inf values, and the HDR peak is inside the spec's range. Stay on GLSL and WebGL2.
- **Why it helps here.** Models mix up three.js API versions, and there is little GLSL in their training data. A curated file keeps several agents across several stages building the same way, and a validator stops broken candidates from wasting the critics' and Max's time.
- **Evidence.**
  - [LL3M](https://arxiv.org/html/2508.08228v1) (demonstrated): retrieving docs for the right software version took the agent from 1.20 to 5.86 complex operations, with 26% fewer errors.
  - [ShaderMatch](https://conf.researchr.org/details/icse-2025/llm4code-2025-papers/13/Evaluating-Language-Models-for-Computer-Graphics-Code-Completion) (demonstrated): the best open-source models produced GLSL that didn't work 31% of the time. Frontier models weren't tested.
  - SideFX's Houdini 22 assistant (claimed, rigging demo only) serves the model a curated snippet library and validates code before it runs.
  - A [Claude Code shader-art write-up](https://knowledgeworkersguide.substack.com/p/creating-beautiful-shader-art-with) and [ShaderToy-MCP](https://github.com/wilsonchenghy/ShaderToy-MCP) (both claimed) report better shaders after the model studied strong examples.
  - In Hovl's thread, the agent reused whatever textures sat in the project, so a curated folder steers the look.
  - Against moving to TSL/WebGPU: a developer spent [two days with Claude](https://discourse.threejs.org/t/help-wanted-three-fire-glsl-to-tsl/86088) failing to port a volumetric fire shader (claimed, one anecdote).
- **Licence note.** Shadertoy shaders that state no licence default to CC BY-NC-SA 3.0, which is non-commercial and share-alike. Three scouts reported this from secondary sources, but Shadertoy's terms page refused all of us, so it is unverified this run. Study those shaders; don't paste them into the repo.
- **Effort.** Low to medium.
- **Fits.** The build loop (before each stage), plus a gate in front of the critics.

### 7. Score fire and mist with texture-tolerant measures, at many moments
- **What.** Add three scores next to the calibration table:
  - **Shape:** L1 difference on a blurred, low-resolution silhouette (size, lobe placement, column height, trail width).
  - **Colour:** histogram distance per phase (white core, orange break-up, violet glow).
  - **Texture:** LPIPS or DISTS (deep-network image-similarity measures) on the crop.

  Score every 60 fps frame of the flash and several ages of the mist, say 0.05, 0.15, 0.25, 0.4, 0.55 and 0.7 s. Use NVIDIA's FLIP metric the same way as a regression check whenever an agent refactors a shader.
- **Why it helps here.** Our noise will never land on the same pixels as Naughty Dog's, so pixel difference or SSIM rewards a blurry average. These measures ask whether the silhouette, the colours and the kind of texture match.
- **Evidence.**
  - [FIDE](https://arxiv.org/abs/2607.17411), July 2026 (claimed; its plots weren't seen): with pixel MSE as the score, every method failed two of the harder tasks, and LPIPS was generally the better score.
  - VLMaterial (demonstrated): a style loss plus a low-resolution L1 fitted materials with random-looking texture.
  - [renderopt](https://renderopt.github.io/) (demonstrated): FLIP plus many sampled times and viewpoints caught shader edits that matched only some of the time.
  - [DISTS](https://arxiv.org/abs/2004.07728) (claimed, in its abstract) was built to tolerate texture shifting position.
  - [Dobashi 2012](https://ime.ist.hokudai.ac.jp/~doba/projects/inverse_cloud_rendering/inverse_cloud.htm) (claimed, in its abstract) fitted cloud colour parameters to a photo's colour histogram where the shapes couldn't match.
  - Don't use global CLIP scores. [AutoVFX](https://arxiv.org/html/2411.02394v1) found them blind to small local changes, and DiffSpot found that CLIP distance doesn't predict what gets noticed.
- **Effort.** Medium-low: PyTorch for LPIPS or DISTS on the Mac, numpy for the rest [inferred].
- **Fits.** The calibration step and the critics.

### 8. Let an optimiser fit the numbers once the structure is right
- **What.** A Python loop using Nevergrad or Optuna in ask-and-tell mode. It sets one layer's sliders in a headless page that stays open, renders the frames it needs, scores them with tactic 7 and the calibration table, and searches with CMA-ES (an evolution strategy that needs no gradients).
  - Fit one layer at a time, with about 15 sliders or fewer. Bounds are the slider ranges, on a log scale for intensities, with fixed noise seeds.
  - Start with colour, intensity and timing, whose targets are already numbers in the specs.
  - Then fit shape for each flash frame in order, each starting from the previous frame's answer.
  - The agent sets the structure, the optimiser fits the values and Max judges. Run it headless only, never in Max's open tab.
- **Why it helps here.** The calibration targets are numbers that the build agent now chases by hand, one render at a time.
- **Evidence.**
  - VLMaterial (demonstrated): after the model wrote the material, 200 steps of MCMC search (a guided random search) refined the fit (style loss down from 0.019 to 0.015).
  - [Aδ](https://pixl.cs.princeton.edu/pubs/Yang_2022_AAF/) (demonstrated) made fits succeed with three tricks: a coarse-to-fine image pyramid, many random restarts, and starting each keyframe from the previous one's answer. scipy's Nelder-Mead and Powell never succeeded in the same time.
  - FIDE (claimed): CMA-ES on an unmodified renderer needed thousands to tens of thousands of renders at 224 px.
  - The [Nevergrad docs](https://facebookresearch.github.io/nevergrad/optimization.html) confirm the ask-and-tell interface.
- **Effort.** Medium. `tools/shoot.mjs` starts a fresh Chrome for every shot, which takes seconds each, so this needs a page that stays open and a hook to set the settings and render.
- **Fits.** The calibration step, as a new tool in `vfx-studies/tools/`.

---

## 3. Worth trying later

- **AI texture detail for our sprites, if our own bakes look too clean.**
  - [LayerDiffuse](https://arxiv.org/html/2402.17113) makes still images with real transparency. In its user study, 97% preferred it over cutting the background out afterwards. It runs on SDXL and its code is Apache-2.0, so it suits still flame or smoke cards.
  - The [AInVFX add-on for LTX 2.5](https://huggingface.co/AInVFX/ainvfx-fluid) turns flat painted silhouettes into moving fire or smoke that follows them. The card shows six held-out examples, and it was trained on 52 stock clips in under 8 hours on one GPU. We could trace the onset lobes and column from our frames. Its output is RGB video, so there is no alpha channel [inferred].
  - [Wan-Alpha](https://huggingface.co/htdong/wan-alpha-v2.0) (Apache-2.0) makes video with transparency but shows no fire or smoke examples. A cheap hosted test would settle it.
  - Recipes that carry over to any of these:
    - Generate glowing elements on pure black and blend them additively, so nothing needs cutting out ([realtimevfx](https://realtimevfx.com/t/whats-the-difference-between-a-black-and-transparent-background/27398), [Morphic](https://morphic.com/resources/videos/explosion-stock-footage)).
    - Generate a whole sheet in one image so the frames share context ([MythicLemon](https://forums.unrealengine.com/t/mythiclemon-ai-flipbook-generator-niagara-vfx-spritesheets-from-text-prompts/2724414), claimed).
    - For elements that appear from nothing, give the generator three keyframes: empty, peak, empty ([Ludo docs](https://ludo.ai/docs/sprite-generator/vfx-sprite-sheets), vendor).
    - Make tileable smoke textures with Midjourney's tile option, then vary them with image-to-image ([realtimevfx](https://realtimevfx.com/t/how-do-you-approach-creating-noise-pattern-textures/27776), claimed).
  - Costs: all of these need an NVIDIA GPU or the cloud. Output is 8-bit, so the HDR has to come from our shader. [Luma Ray](https://lumalabs.ai/ray) claims 16-bit HDR output, but with no transparency and no fire examples. See section 5 for ownership and disclosure.
- **Preference optimisation that proposes the next four** ([Brochu 2010](https://haikufactory.com/files/sca2010.pdf); Koyama's [Sequential Gallery](https://koyama.xyz/project/sequential_gallery) and BO as Assistant, whose pySequentialLineSearch library is MIT). This automates tactic 5 once the board exists.
- **A motion score for the mist**, from [DyNCA](https://dynca.github.io/)'s motion loss. It compares optical-flow statistics of our trail and the footage across the trail's life, separately from how it looks. Worth adding in stage 2, when drift and warp get tuned. DyNCA's code is non-commercial (CC BY-NC-SA 4.0), so borrow the idea, not the code.
- **Pixar's split for the flame body** (Elemental [talk](https://graphics.pixar.com/library/ElementalNST) and interview; claimed). Calm, low-frequency motion carries the shape. A separately directed layer of sharp detail sits on top, strongest at the silhouette, with its strength animated over time. Our WebGL version needs no network: detail textures carried along by our flow and masked to the edge. A candidate fix for the milky look.
- **Six-way lightmaps** (the standard non-neural format for smoke that reacts to light; see [this paper](https://arxiv.org/abs/2604.03748) for background), if the mist has to pick up the flash's orange light before it turns grey [inferred].
- **Simulated flipbooks** on Max's PC, from EmberGen, Houdini, or Unreal's Niagara Fluids with the Niagara Baker. See section 5.
- **A RenderDoc study of Uncharted 4 on PC** (Legacy of Thieves), to learn privately how many cards, which textures and which blend modes the flash uses. This is untested: the game's licence or anti-tamper may forbid or block it, and nothing captured could ship.

---

## 4. Not worth it, and why

- **Letting an agent design the effects.** Hovl's 50+ effects, made with little direction, were judged generic. Prompting with another artist's screenshot produced a near-copy.
- **Training or fine-tuning a model for two effects.** VLMaterial fine-tuned on about 550,000 material programs, and on real photos plain nearest-match retrieval from a library still beat it.
- **Running neural networks in the page.**
  - Everything shown running in a browser is a looping, uniform texture: [neural cellular automata](https://distill.pub/selforg/2021/textures/) (NCAs, tiny learned rules run as shader passes). Nothing targets a one-off event under a second.
  - [Volumetric NCA smoke](https://arxiv.org/abs/2502.09631) ran at 0.8 s per frame on an RTX 3090 Ti.
  - Neural six-way lightmaps need NVIDIA's TensorRT.
  - [ONNX Runtime Web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)'s WebGL backend is in maintenance mode.
- **ML upscaling** ([tempoGAN](https://github.com/thunil/tempoGAN), Houdini's [ML Volume Upres](https://www.sidefx.com/docs/houdini/ml/overview.html)). It adds fine detail to an existing simulation, but a 4-frame flash lives on silhouette, colour and timing. A [2022 study](https://eprints.cs.univie.ac.at/8230) found low-resolution renders plus neural upscaling didn't match native high-resolution renders. tempoGAN also needs TensorFlow 1.x and CUDA 10.
- **Engine-vendor assistants and VFX agents.**
  - A [hands-on test](https://zenn.dev/althenasoft/articles/4dc9a28480e0a0) found Unity AI of almost no use for VFX Graph.
  - [Epic's UE 5.8 MCP server](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor?lang=en-US) has no Niagara or material-graph tools.
  - SideFX's [Houdini 22 assistant](https://www.jonpeddie.com/news/sidefx-and-nvidia-bring-mcp-powered-ai-agents-to-houdini-22s-rigging-workflow-at-siggraph-2026/) covers rigging only.
  - Aura and Coplay are tied to Unreal and Unity, and check one rendered frame or none.
- **AI video flipbooks for the 4-frame flash, for now.** The output is 8-bit with no HDR, at 8-50 fps, and the frames are small: an 8×8 sheet in 1024 px gives 128 px per frame. There are no independent quality tests, and the paid generators ([Ludo](https://ludo.ai/tools/vfx-sprite-generator), MythicLemon) are pitched for prototyping. Explosion add-ons for video models ([example](https://civarchive.com/models/1295945)) put the effect into a whole scene instead of giving an isolated element.
- **AI background removal to lift fire out of game frames.** Generic matting fails on semi-transparent elements that aren't people ([TransPixar paper](https://arxiv.org/html/2501.03006v1)), and the result couldn't ship anyway (section 5).
- **CLIP-style global scores** as our match metric: they're blind to small local changes.
- **scipy's Nelder-Mead or Powell** for fitting shaders: they never succeeded in Aδ's tests.
- **Moving the studies to TSL/WebGPU.** There are fewer docs and less training data, and one Claude port failed.
- **Example-based fluid methods** ([LazyFluids](https://dcgi.fel.cvut.cz/~sykorad/lazyfluids.html), which is patented; smoke style transfer; [WildSmoke](https://autumnyq.github.io/WildSmoke)). They need a fluid simulation or a 3D grid, and they output frames, not slider values.

---

## 5. Sprites: cut them from the frames, make them, or download them?

Max already decided this, and it is recorded in `muzzle-flash-spec.md`. Nothing cut from the game frames ships, though measuring from them privately is fine. We make our own textures, and we download only what may be redistributed from a public repo. The scouting backs that decision on quality and on licence. I also checked the repo: `refs/frames/` is git-ignored, and nothing under `vfx-studies/` is committed yet.

### Recommendation
1. **Make our own** flame, smoke and glow sprites, baked from the page's own shaders. There is no licence risk, and every parameter stays on the tuning panel.
2. **Measure from the game frames, but never ship them.** Mattes made by subtracting the previous frame, kept in `refs/frames/`, give the silhouettes, colour bands, sizes and timing to fit our sprites to.
3. **Download only CC0 (public-domain) files**, as masks or test inputs: the Kenney Particle Pack and Unity Labs' HDR flipbooks.
4. **Simulated flipbooks are optional.** EmberGen needs Max's PC; Unreal's Niagara Baker runs wherever Unreal is installed.
5. **AI-generated textures**, if ever, only as secondary detail, and disclosed.

### Cutting from the game frames: measure only
- **Quality.** Subtracting the frame before the shot, in linear light, does isolate an additive flash. This is the standard compositing difference key ([Nuke docs](https://learn.foundry.com/nuke/8.0/content/reference_guide/keyer_nodes/difference.html)). But the result is poor as a texture [inferred]:
  - The core is clipped at 8-bit white, so there is no HDR headroom for bloom.
  - YouTube's 4:2:0 colour compression smears exactly the saturated orange edges.
  - Bloom, motion blur and grain are baked in.
  - The light the flash throws on the gun, hands and walls leaks into the difference.
  - Recoil and camera shake throw the two frames out of line.
  - It only works from that one camera angle.

  The grey mist over scenery is a hard matting problem (WildSmoke names it as a core challenge), and generic AI matting fails on fire and smoke (TransPixar paper).
- **Licence.** Uncharted 4's footage and effects are Sony and Naughty Dog's copyright, and nothing grants reuse. GitHub has precedent. In 2024 a Nintendo DMCA notice aimed at the sprite and sound folders of one fan tool led GitHub to disable the whole network of 291 repositories, forks included ([TorrentFreak](https://torrentfreak.com/nintendo-takedown-wipes-rhythm-heaven-remix-tool-and-250-forks-from-github-240619/)). EA's 2018 takedown of the OpenSC2K remake reportedly stood even after the game's assets were replaced with instructions for extracting them (PC Gamer, per one scout; the link wasn't captured).
- **Use.** As a measuring tool, these mattes plug straight into our numpy/Pillow loop: silhouette per frame, colour bands, size relative to the rifle, and timing. Everything they produce stays in `refs/frames/`.

### Making our own (recommended)

| Route | Runs on | Cost and terms | Fit for us |
|---|---|---|---|
| **In-page bake.** Render our procedural shader into an offscreen half-float target laid out as a sheet, with a fixed seed per variant. Save PNGs from headless Chrome, or bake when the page loads. An MIT-licensed [2D fluid sim](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) could grow organic break-up frames the same way. | The Mac, in the current pipeline | Free, and entirely ours | Best. The muzzle flash's second pass (running now) was told to make its own flame textures, either this way or generated when the page loads. |
| **Material Maker** for starburst and lobe masks and noise | The Mac (MIT licence) | Free | Good for masks. It's the workflow Gabriel Aguiar teaches for muzzle flashes ([80.lv](https://80.lv/articles/tutorial-muzzle-flash-vfx-in-godot); evidence unclear, as the write-up has no images). |
| **EmberGen** fire simulation, exported as EXR, PNG or TGA flipbooks | Windows 10 or Linux only. [macOS isn't supported](https://jangafx.com/software/pricing) (checked). Needs an NVIDIA GTX 1060 or better. | Indie licence (under $1M revenue): $300 the first year, then $180 a year, optional. Trial exports may not be used commercially (EULA s2.4). The EULA says nothing about free portfolios, so treat a public portfolio as commercial [inferred]. | The highest ceiling. Practitioners use it for muzzle flashes. |
| **Houdini:** the Simple Muzzle Flash shelf tool (no simulation, so quick to iterate) and the free Labs Flipbook Textures exporter | macOS support not checked | The free [Apprentice](https://www.sidefx.com/faq/question/435/) is non-commercial, capped at 1080p, and watermarks its renders. Indie costs $299 a year. | Closest to how studios work ([tool docs](https://www.sidefx.com/docs/houdini/shelf/pyrosimplemuzzleflash.html)). |
| **Unreal Niagara Fluids** plus the [Niagara Baker](https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-flipbook-baker-quick-start-guide-in-unreal-engine) | Max's UE5 PC | Free. A secondary summary of the Unreal EULA says images made with the engine can be used outside Unreal. Don't bake Epic's sample content into them. | The default sheet is 8×8 frames in 1024 px (128 px each) at 30 fps. For a 4-frame flash, capture at 60 fps into a 2×2 or 4×4 sheet. |

Confirmed by Max on 11 Oct: the PC runs Windows with an NVIDIA GPU, so it can run EmberGen, the Niagara Baker and the CUDA-only AI models in section 3. Our sessions run on the MacBook, though, so any of these means Max, or a separate session, working at the PC. On the Mac, EmberGen isn't supported and those AI models assume an NVIDIA GPU. Unreal does run on macOS, but this Mac has only the Epic launcher; no engine install was found.

The tracer needs no downloaded sprites. Engines draw tracers as camera-facing cards stretched along the bullet's velocity, with a soft gradient a shader can generate ([Unity docs](https://docs.unity.cn/es/2019.4/Manual/PartSysRendererModule.html)). Kenney's CC0 trace sprites are a fallback.

### Downloading: CC0 only, as helpers
- **[Kenney Particle Pack](https://kenney.nl/assets/particle-pack).** CC0, no credit required. 80 sprites at 512×512, including muzzle_01-05, trace_01-07, smoke_01-10, flame_01-06, fire_01-02 and spark_01-07. They are single stills, probably white or grey for tinting (not inspected). Use them as lobe masks, tracer heads and smoke puffs, pushed above 1.0 in the shader so they bloom.
- **[Unity Labs flipbooks](https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks)** (2016). CC0. Explosions, fireballs, flames and wispy smoke made in Houdini, as HDR linear EXR sequences, TGA sequences or ready-made sheets. The links still work (checked by reading headers only, nothing downloaded): FireBall01 is a 5.9 MB zip and Explosion00 is 3.2 MB. They aren't shaped like a muzzle flash, but they make good HDR test inputs and a quality bar.
- **OpenGameArt.** CC0 and CC-BY muzzle-flash sheets exist, but all are stylised: pixel art or toon ([example](https://opengameart.org/content/alotofimpacts-4-quick-hit-impacts-muzzle-flashs-impacts005-008)). CC-BY needs a credit line in the README and on the page. Avoid share-alike licences.
- Keep a `CREDITS.md` that lists each third-party file with its author, licence and source URL as of the download date.

### Keep out of the public repo
- **Unity Asset Store packs.** The [EULA](https://unity.com/legal/as-terms) (section 2.2.1) allows an asset only inside a product with substantial original content whose purpose goes beyond displaying the asset, and never distributed on its own. A page that shows off an effect, with its PNGs in a public repo, fails both tests.
- **Unity's own samples.** Under the [Unity Companion License](https://unity.com/legal/licenses/unity-companion-license) they may only be used with Unity's engine.
- **Free Fab assets under the Standard licence.** They can't be redistributed on their own, and Epic's Unreal-only content can't leave Unreal. This comes from secondary summaries, because the [EULA page](https://www.fab.com/eula) refused us. Fab's CC-BY listings are the exception.
- **Filmed stock** ([ActionVFX](https://www.actionvfx.com), [ProductionCrate](https://www.cgchannel.com/2021/01/download-500-free-stock-fx-elements-from-productioncrate/)). Their licence pages wouldn't load, so assume the raw files can't be redistributed. Use them as private reference at most.
- **CGHEVEN's muzzle-flash packs** ([page](https://cgheven.com/blog/best-free-muzzle-flash-vfx-assets-for-games-films-2025)). They are labelled CC0, but nobody knows where the footage came from. Don't ship them unless the author confirms it in writing.
- **Shadertoy code.** CC BY-NC-SA 3.0 by default, though unverified this run.

### AI-generated sprites
These come later, if at all, as secondary detail (section 3). The terms that decide it:
- In the US, output from prompting alone can't be copyrighted ([Copyright Office report, part 2](https://ipwatchdog.com/2025/01/29/part-two-copyright-office-ai-report-says-creative-prompting-doesnt-constitute-authorship/), via a law-firm summary).
- The LTX licence, which covers the AInVFX add-on, asks you to disclose machine-generated content when you distribute it (one scout's reading).
- Ludo says sprites made with it can be used in commercial games.
- Adobe says Firefly Video was trained only on licensed content ([blog](https://blog.adobe.com/en/publish/2025/02/12/meet-firefly-video-model-ai-powered-creation-with-unparalleled-creative-control)).

Some studio reviewers discount AI textures, and asset sellers now advertise packs as made without generative AI. State any AI use in the write-up.

### Decisions for Max
- Whether to set up simulated flipbooks on the PC, and if so, whether EmberGen's $300 Indie licence is worth it over the free Niagara Baker. Max has the PC, but sessions run on the MacBook (11 Oct). Recommendation: decide at muzzle stage 2 (smoke), after Max has judged our own baked sprites.
- Whether AI-generated texture detail is acceptable in this portfolio piece at all, given the ownership and disclosure terms.

---

## 6. Sources

### Checked for this report
- **ParticleGen.** The scouts disagreed. One saw only the abstract, which has no numbers, and rated it claimed. Two read the full paper. The full paper has the table and the user study quoted above: 20 professional technical artists, a blind test, 10 effects. The critic is GPT-5.4, the loop stops at a score of 0.9 or after 4 rounds, and it returns the best state. The paper is CC BY 4.0, and it says nothing about releasing code or its plugin.
- **Hovl's thread.** One scout couldn't find it, another quoted it, and it is confirmed. I added two details: the agent's inputs included Hovl's own models, textures and shaders, and Hovl said the tool used up credits fast. One scout's line that credits allowed only 1-2 attempts per effect overstates what Hovl said.
- **EmberGen on macOS.** A scout saw conflicting signals. The pricing page lists Windows 10 or Linux and says macOS isn't supported.
- **Unity Labs CC0 flipbooks.** The links still resolve (HTTP 200 on a header check; nothing downloaded).
- **DiffSpot.** The numbers are confirmed from the abstract.
- **AInVFX model card.** The base model, training data, training time and keyframe grid are confirmed. The card doesn't say whether output has alpha or sits on black. One scout said it does sit on black; one sample on the card paints smoke over a real photo.
- **Claude's image limits.** Confirmed in Anthropic's docs.
- **Shadertoy's default licence.** I couldn't check it: the terms page returned 403, the archive was blocked, and the shared web-search budget was used up. Treat it as CC BY-NC-SA 3.0 until someone checks.

### Not found or not checked
- No public case of AI matching one specific game effect from footage. No shipped game using machine learning for runtime fire or smoke. No independent quality test of AI flipbooks. No test of vision models judging fire, smoke or glow. No benchmark of frontier closed models (Claude, GPT, Gemini) on GLSL.
- No scout viewed any image or video.
- Pages that couldn't be read: Reddit (blocked); X and YouTube (search snippets only); Shadertoy's terms (403); ActionVFX's licence (429); ProductionCrate's licence (404); the Fab and Epic EULAs (403); Adobe's help page on Firefly transparency (403).
- The fleet's shared web-search budget ran out. Some follow-ups stayed open: Houdini on macOS, sprite-sheet export in the Effekseer particle editor, and the Shadertoy licence.
- Not read: ParticleGen's supplement (how many frames the critic sees), FIDE's result plots, the Callisto Protocol GDC 2023 muzzle-flash talk (members-only), and the text of the Unreal and Fab EULAs.

### Source table

Angles: **Agents** = LLMs and coding agents writing VFX code. **Textures** = generative AI for sprite and flipbook assets. **Fitting** = fitting effect parameters to references. **ML** = machine learning for fire and smoke. **Practice** = practitioner reports. **Sprites** = sprite sources and licences.

| Title | Link | Date | Evidence | Angle |
|---|---|---|---|---|
| ParticleGen: multi-agent text-to-Niagara with a render critic and rollback | [arxiv.org/html/2608.00629](https://arxiv.org/html/2608.00629) | 2026-08-01 | Demonstrated (checked) | Agents, Practice |
| BlenderAlchemy: vision-model edit loop for Blender materials | [arxiv.org/abs/2404.17672](https://arxiv.org/abs/2404.17672) | 2024-04 (ECCV 2024) | Demonstrated | Agents, Fitting |
| BlenderGym: vision models against human Blender users | [arxiv.org/abs/2504.01786](https://arxiv.org/abs/2504.01786) | 2025-04 (CVPR 2025) | Demonstrated | Agents, Fitting |
| VLMaterial: fine-tuned vision-language model plus parameter search | [arxiv.org/html/2501.18623v2](https://arxiv.org/html/2501.18623v2) | 2025-01 (ICLR 2025) | Demonstrated | Agents |
| LL3M: multi-agent Blender coder with doc retrieval | [arxiv.org/html/2508.08228v1](https://arxiv.org/html/2508.08228v1) | 2025-08 | Demonstrated | Agents |
| ShaderMatch: GLSL code-completion benchmark | [conf.researchr.org](https://conf.researchr.org/details/icse-2025/llm4code-2025-papers/13/Evaluating-Language-Models-for-Computer-Graphics-Code-Completion) | 2025-05-03 | Demonstrated | Agents |
| renderopt: LLM shader optimisation checked with FLIP | [renderopt.github.io](https://renderopt.github.io/) | Undated | Demonstrated | Agents |
| AutoVFX: LLM composes a vetted function library | [arxiv.org/html/2411.02394v1](https://arxiv.org/html/2411.02394v1) | 2024-11-04 | Demonstrated | Agents |
| DiffSpot: vision models miss fine visual differences | [arxiv.org/abs/2605.29615](https://arxiv.org/abs/2605.29615) | 2026-05-28 | Demonstrated (checked) | Agents |
| AI Co-Artist: LLM-evolved shaders, human picks | [arxiv.org/html/2512.08951](https://arxiv.org/html/2512.08951) | 2025-11-27 | Claimed | Agents |
| 14islands: text-to-GLSL tool comparing models | [develop.14islands.com](https://develop.14islands.com/journal/ai-generated-glsl-shaders) | 2025-02-28 | Claimed | Agents, Practice |
| ShaderGPT (14islands) write-up | [abduzeedo.com/node/89091](https://abduzeedo.com/node/89091) | 2026-03-15 | Claimed | Practice |
| Parallax: Claude Code plugin for debugging three.js scenes | [github.com/propersloth/parallax-threejs](https://github.com/propersloth/parallax-threejs) | 2026 | Claimed | Agents |
| ShaderToy-MCP: Shadertoy search for models | [github.com/wilsonchenghy/ShaderToy-MCP](https://github.com/wilsonchenghy/ShaderToy-MCP) | Undated | Claimed | Agents, Practice |
| Shader art with Claude Code: study strong examples first | [knowledgeworkersguide.substack.com](https://knowledgeworkersguide.substack.com/p/creating-beautiful-shader-art-with) | 2026-02-14 | Claimed | Practice |
| three.js forum: fire shader port to TSL fails with Claude | [discourse.threejs.org](https://discourse.threejs.org/t/help-wanted-three-fire-glsl-to-tsl/86088) | 2025-08-11 | Claimed (one anecdote) | Agents |
| Anthropic: Claude vision docs | [platform.claude.com](https://platform.claude.com/docs/en/build-with-claude/vision) | Read 2026-10-11 | Docs (checked) | Agents |
| Aura VFX Agent docs (Unreal, alpha) | [tryaura.dev](https://www.tryaura.dev/documentation/vfx-agent) | Undated | Claimed (vendor) | Agents, Practice |
| Coplay: teaching AI to build VFX in Unity | [coplay.dev/blog/ai-vfx](https://coplay.dev/blog/ai-vfx) | 2026-01-22 | Demonstrated (vendor) | Practice |
| Epic: Unreal MCP in the editor (UE 5.8) | [dev.epicgames.com](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor?lang=en-US) | 2026-06 | Docs | Agents |
| Unity AI hands-on test for VFX Graph (Zenn) | [zenn.dev](https://zenn.dev/althenasoft/articles/4dc9a28480e0a0) | 2025-08-30 | Demonstrated | Agents, Textures |
| SideFX and NVIDIA: Houdini 22 assistant for rigging | [jonpeddie.com](https://www.jonpeddie.com/news/sidefx-and-nvidia-bring-mcp-powered-ai-agents-to-houdini-22s-rigging-workflow-at-siggraph-2026/) | 2026-07-30 | Claimed | Agents |
| Hovl's thread on agent-built effects (realtimevfx) | [realtimevfx.com](https://realtimevfx.com/t/ai-is-able-to-create-super-complex-effects-now/31737) | 2026-09-19 to 09-22 | Demonstrated (checked) | Practice |
| cEssex: light-shaft material written with ChatGPT | [realtimevfx.com](https://realtimevfx.com/t/improving-niagara-lighting/28537) | 2025-09-16 | Demonstrated | Practice |
| cEssex on Claude and ChatGPT for custom HLSL | [realtimevfx.com](https://realtimevfx.com/t/blocked-stopped/30503/4) | 2026-03-25 | Claimed | Practice |
| Hovl's sketchbook: screen-space shader made with ChatGPT | [realtimevfx.com](https://realtimevfx.com/t/hovl-s-sketchbook/6983/445) | 2025-12-14 | Demonstrated | Practice |
| GDC 2023 VFX roundtable notes | [realtimevfx.com](https://realtimevfx.com/t/gdc-2023-vfx-roundtable-discussion-notes/23367) | 2023-06-09 | Claimed | Practice |
| Thread on making noise and smoke textures | [realtimevfx.com](https://realtimevfx.com/t/how-do-you-approach-creating-noise-pattern-textures/27776) | 2024-10-28 | Claimed | Practice |
| Morphic: generating explosion elements on black | [morphic.com](https://morphic.com/resources/videos/explosion-stock-footage) | Undated | Claimed (vendor) | Practice |
| AInVFX fluid add-on for LTX 2.5 | [huggingface.co/AInVFX/ainvfx-fluid](https://huggingface.co/AInVFX/ainvfx-fluid) | About 2026-09 | Demonstrated (card checked) | Textures |
| LayerDiffuse: images with real transparency | [arxiv.org/html/2402.17113](https://arxiv.org/html/2402.17113) | 2024-02 | Demonstrated | Textures |
| TransPixeler (formerly TransPixar): video with transparency | [arxiv.org/html/2501.03006v1](https://arxiv.org/html/2501.03006v1) | 2025-01 (CVPR 2025) | Demonstrated | Textures |
| Wan-Alpha v2: video with transparency (Apache-2.0) | [huggingface.co/htdong/wan-alpha-v2.0](https://huggingface.co/htdong/wan-alpha-v2.0) | 2025-12-16 | Claimed | Textures |
| MythicLemon AI Flipbook Generator (UE5 plugin) | [forums.unrealengine.com](https://forums.unrealengine.com/t/mythiclemon-ai-flipbook-generator-niagara-vfx-spritesheets-from-text-prompts/2724414) | 2026-05-26 | Claimed | Textures, Practice |
| Ludo.ai VFX sprite sheets (docs and product page) | [ludo.ai docs](https://ludo.ai/docs/sprite-generator/vfx-sprite-sheets), [product](https://ludo.ai/tools/vfx-sprite-generator) | 2026-09 | Demonstrated (vendor) | Textures, Practice |
| Adobe Firefly Video model | [blog.adobe.com](https://blog.adobe.com/en/publish/2025/02/12/meet-firefly-video-model-ai-powered-creation-with-unparalleled-creative-control) | 2025-02-12 | Claimed (vendor) | Textures |
| Luma Ray: 16-bit HDR video and EXR export | [lumalabs.ai/ray](https://lumalabs.ai/ray) | Undated | Claimed (vendor) | Textures |
| Black versus transparent backgrounds for effects | [realtimevfx.com](https://realtimevfx.com/t/whats-the-difference-between-a-black-and-transparent-background/27398) | 2024-09 | Claimed (practitioner) | Textures |
| Huge Explosion VFX add-on for Wan2.1 | [civarchive.com/models/1295945](https://civarchive.com/models/1295945) | 2025-03-27 | Demonstrated | Textures |
| US Copyright Office AI report, part 2 (law-firm summary) | [ipwatchdog.com](https://ipwatchdog.com/2025/01/29/part-two-copyright-office-ai-report-says-creative-prompting-doesnt-constitute-authorship/) | 2025-01-29 | Legal summary | Textures |
| Brochu, Brochu and de Freitas: Bayesian gallery for procedural smoke | [haikufactory.com](https://haikufactory.com/files/sca2010.pdf) | 2010 | Demonstrated | Fitting |
| FIDE: black-box inverse rendering with CMA-ES and LPIPS | [arxiv.org/abs/2607.17411](https://arxiv.org/abs/2607.17411) | 2026-07-19 | Claimed (plots not seen) | Fitting |
| Aδ: fitting procedural shaders to images | [pixl.cs.princeton.edu](https://pixl.cs.princeton.edu/pubs/Yang_2022_AAF/) | 2022-07 | Demonstrated | Fitting |
| Koyama: Sequential Gallery and BO as Assistant | [koyama.xyz](https://koyama.xyz/project/sequential_gallery) | 2020, 2022 | Claimed | Fitting |
| DISTS and the Sliced Wasserstein texture loss | [arxiv.org/abs/2004.07728](https://arxiv.org/abs/2004.07728), [arxiv.org/abs/2006.07229](https://arxiv.org/abs/2006.07229) | 2020, 2021 | Claimed (abstracts) | Fitting |
| Dobashi: inverse cloud rendering from colour histograms | [ime.ist.hokudai.ac.jp](https://ime.ist.hokudai.ac.jp/~doba/projects/inverse_cloud_rendering/inverse_cloud.htm) | 2012 | Claimed (abstract) | Fitting |
| MATch: fitting procedural materials to photos | [match.csail.mit.edu](https://match.csail.mit.edu/) | 2020 | Claimed | Fitting |
| Stich and Magnor: Learning Flames | [graphics.tu-bs.de](https://www.graphics.tu-bs.de/upload/people/magnor/publications/vmv05.pdf) | 2005 | Claimed (abstract) | Fitting |
| Nevergrad optimisation docs (ask and tell) | [facebookresearch.github.io](https://facebookresearch.github.io/nevergrad/optimization.html) | Read 2026-10 | Docs | Fitting |
| LazyFluids: appearance transfer for fluids (patented) | [dcgi.fel.cvut.cz](https://dcgi.fel.cvut.cz/~sykorad/lazyfluids.html) | 2015 | Claimed | Fitting |
| DyNCA: real-time dynamic texture synthesis | [dynca.github.io](https://dynca.github.io/) | 2023 (CVPR) | Demonstrated | ML, Fitting |
| Self-Organising Textures (Distill), including the μNCA follow-up | [distill.pub](https://distill.pub/selforg/2021/textures/) | 2021 | Demonstrated (live demo) | ML |
| Pixar Elemental: volumetric neural style transfer | [graphics.pixar.com](https://graphics.pixar.com/library/ElementalNST) | 2023 | Claimed (talk and interview) | ML |
| Random flipbook offsets for muzzle flashes | [realtimevfx.com](https://realtimevfx.com/t/flipbook-frame-offset-on-muzzle-flashes-for-greater-variations/28301) | 2025-01-14 | Claimed (practitioner) | ML, Sprites |
| Houdini ML tools overview (ML Volume Upres) | [sidefx.com](https://www.sidefx.com/docs/houdini/ml/overview.html) | 2025-09 | Claimed (vendor) | ML |
| tempoGAN: smoke super-resolution | [github.com/thunil/tempoGAN](https://github.com/thunil/tempoGAN) | 2018 | Demonstrated | ML |
| Neural upscaling against native renders for fire and smoke | [eprints.cs.univie.ac.at/8230](https://eprints.cs.univie.ac.at/8230) | 2022 | Claimed (abstract) | ML |
| Volumetric NCA smoke stylisation | [arxiv.org/abs/2502.09631](https://arxiv.org/abs/2502.09631) | 2025-02-05 | Demonstrated | ML |
| Real-time neural six-way lightmaps | [arxiv.org/abs/2604.03748](https://arxiv.org/abs/2604.03748) | 2026-04-04 | Demonstrated | ML |
| WildSmoke: 3D smoke from a single video | [autumnyq.github.io/WildSmoke](https://autumnyq.github.io/WildSmoke) | 2025-09-14 | Claimed | ML, Fitting |
| ONNX Runtime Web docs | [onnxruntime.ai](https://onnxruntime.ai/docs/get-started/with-javascript/web.html) | Read 2026-10 | Docs | ML |
| Kenney Particle Pack (CC0) | [kenney.nl](https://kenney.nl/assets/particle-pack) | 2018 | Licence and file list | Sprites |
| Unity Labs free VFX flipbooks (CC0) | [unity.com](https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks) | 2016-11-28 | Demonstrated (links checked) | Textures, Sprites |
| OpenGameArt AlotofImpacts (CC-BY 4.0) | [opengameart.org](https://opengameart.org/content/alotofimpacts-4-quick-hit-impacts-muzzle-flashs-impacts005-008) | 2021 | Claimed | Sprites |
| Unity Asset Store terms | [unity.com/legal/as-terms](https://unity.com/legal/as-terms) | Read 2026-10 | Licence text | Sprites |
| Unity Companion License | [unity.com](https://unity.com/legal/licenses/unity-companion-license) | Read 2026-10 | Licence text | Sprites |
| Fab EULA | [fab.com/eula](https://www.fab.com/eula) | Not readable (403) | Secondary summaries only | Sprites |
| ActionVFX (licence pages returned 429) | [actionvfx.com](https://www.actionvfx.com) | Not readable | Unverified | Sprites |
| ProductionCrate's free FX library (CG Channel) | [cgchannel.com](https://www.cgchannel.com/2021/01/download-500-free-stock-fx-elements-from-productioncrate/) | 2021 | Claimed | Sprites |
| CGHEVEN: free muzzle-flash packs | [cgheven.com](https://cgheven.com/blog/best-free-muzzle-flash-vfx-assets-for-games-films-2025) | 2025 | Claimed | Sprites |
| JangaFX pricing and requirements (EmberGen) | [jangafx.com](https://jangafx.com/software/pricing) | Read 2026-10-11 | Vendor page (checked) | Sprites |
| SideFX: Apprentice limits | [sidefx.com/faq/question/435](https://www.sidefx.com/faq/question/435/) | Read 2026-10 | Licence text | Sprites |
| Houdini Simple Muzzle Flash tool | [sidefx.com](https://www.sidefx.com/docs/houdini/shelf/pyrosimplemuzzleflash.html) | Houdini 22 docs | Docs | Sprites |
| Niagara Flipbook Baker quick start | [dev.epicgames.com](https://dev.epicgames.com/documentation/en-us/unreal-engine/niagara-flipbook-baker-quick-start-guide-in-unreal-engine) | UE 5.8 docs | Docs | Sprites |
| WebGL Fluid Simulation (MIT) | [github.com/PavelDoGreat](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) | Read 2026-10 | Code | Sprites |
| Muzzle flash VFX in Godot (Material Maker workflow) | [80.lv](https://80.lv/articles/tutorial-muzzle-flash-vfx-in-godot) | 2025-06-12 | Unclear (no images) | Sprites |
| Nuke Difference keyer docs | [learn.foundry.com](https://learn.foundry.com/nuke/8.0/content/reference_guide/keyer_nodes/difference.html) | Long-standing | Docs | Sprites |
| Nintendo takedown removes Heaven Studio and its forks | [torrentfreak.com](https://torrentfreak.com/nintendo-takedown-wipes-rhythm-heaven-remix-tool-and-250-forks-from-github-240619/) | 2024-06-19 | Reported fact | Sprites |
| How good muzzle flashes are made (realtimevfx) | [realtimevfx.com](https://realtimevfx.com/t/wondering-how-good-muzzle-flashes-are-made/13540) | 2020-07 (one reply 2025-03) | Claimed (practitioner) | Sprites |
| CG Channel: Infiltrator effects video | [cgchannel.com](https://www.cgchannel.com/?p=58401) | 2013-10-23 | Claimed | Sprites |
| Chasing Film in 5ms: the real-time VFX of Uncharted 4 | [history.siggraph.org](https://history.siggraph.org/?p=159912) | 2015 | Abstract only | Sprites |
| Unity particle renderer (stretched billboards) | [docs.unity.cn](https://docs.unity.cn/es/2019.4/Manual/PartSysRendererModule.html) | Unity 2019.4 docs | Docs | Sprites |
