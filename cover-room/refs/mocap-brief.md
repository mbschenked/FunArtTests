# Mocap clip brief (for a fresh Claude session on the NVIDIA PC)

Run this in a **new session in a new folder** on the PC (for example `D:\ClaudeCode\cover-room-mocap`). It must not run in, or touch, any Project Known / Redux folder or session.

## Goal
Generate motion clips with a text-to-motion model on the GPU. Cover Room, a browser third-person cover shooter with an original mannequin, will swap them in later in place of its procedural animation (`src/character/clips.js`).

## Steps
1. Pick the best current text-to-motion model with released weights that runs locally on CUDA. Check what is state of the art now; the fallbacks are MoMask, T2M-GPT and MDM. Record each candidate's license in `LICENSE-NOTES.md`. Most are trained on HumanML3D/AMASS, which are non-commercial. The target repo is public and non-commercial; flag anything stricter.
2. Skeleton: the SMPL / HumanML3D 22-joint layout in standard order: pelvis, left_hip, right_hip, spine1, left_knee, right_knee, spine2, left_ankle, right_ankle, spine3, left_foot, right_foot, neck, left_collar, right_collar, head, left_shoulder, right_shoulder, left_elbow, right_elbow, left_wrist, right_wrist. Meters, Y-up, facing +Z at frame 0, root at the origin.
3. Clips, 3 seeds each. The prompts are starting points; improve the wording if the results are poor.

| clip | prompt |
|---|---|
| idle | a person stands idle shifting weight |
| walk (loop) | a person walks forward |
| run (loop) | a person runs forward |
| run_stop | a person running stops quickly |
| walk_back / strafe_left / strafe_right | (write these) |
| turn180 | a person turns around quickly |
| crouch_walk | a person walks forward crouched low |
| cover_slide | a person runs forward then drops into a crouch against a low wall |
| cover_crouch_idle | (write this) |
| popup_aim | a person crouching rises and aims a handgun forward with both hands, then crouches again |
| aim_idle | a person stands aiming a handgun with both hands |
| reload | a person reloads a handgun |
| throw | a person throws a ball overhand with the right hand |
| roll | a person does a forward roll and stands up |
| jump | a person jumps forward |
| jump_grab | a person jumps up and grabs a ledge overhead |
| hang_idle | a person hangs from a ledge with both hands |
| shimmy_left / shimmy_right | (write these) |
| climb_up | a person hanging from a ledge pulls up onto it and stands |
| hit_react | a person is hit in the chest and staggers back |
| death | a person is shot and collapses |

4. Per clip and seed, write `<name>_s<seed>.json`:
   `{name, prompt, model, fps, joints:[22], parents:[22], positions:[frames][22][3]}`.
   Add `.bvh` too if the model's converter works, since local rotations are better. Also make one `contact-sheet.gif` (or `.png`) of stick-figure renders of every clip so Max can pick seeds.
5. Deliver:
   - Clone `https://github.com/mbschenked/FunArtTests` and create branch `cover-room-mocap` from `origin/main`.
   - Put everything under `cover-room/anim/mocap/` with a short README (model, license, how to regenerate).
   - Keep it under ~40 MB, and push the branch. Don't merge and don't open a PR.
6. Report back with: the branch, the model used, the clips that came out badly, and the license note.
