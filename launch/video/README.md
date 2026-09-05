# Morrow launch video preview

This directory contains an editable, local HyperFrames product-film preview for
Morrow course work.

## Preview files

- `index.html` — the full editable 33.1-second composition.
- `STORYBOARD.md` — the timed story and visual direction.
- `BRIEF.md` — audience, limits, and delivery constraints.
- `assets/morrow-wordmark.png` — the original light Morrow wordmark.
- `assets/morrow-wordmark-dark.png` — the original dark Morrow wordmark.
- `renders/morrow-launch-preview.mp4` — generated local preview after render.
- `renders/morrow-launch-poster.jpg` — generated poster after render.

## Render locally

Use the pinned HyperFrames browser. Do not use system Chrome.

```bash
cd launch/video
export HYPERFRAMES_BROWSER_PATH="$(npx --yes hyperframes@0.8.29 browser path)"
npm run check -- --samples 18 --at 0,4.1,5.2,7.65,9.6,11.8,12.2,15.3,16.85,19.5,22.3,24.3,25.2,27.9,29.35,30.05,31.0 --at-transitions --strict
npm run render -- --quality high --output renders/morrow-launch-preview.mp4
ffmpeg -y -ss 00:00:30.500 -i renders/morrow-launch-preview.mp4 -frames:v 1 -q:v 2 renders/morrow-launch-poster.jpg
```

## Illustrative content

All UI shown in this video is an illustrative product demonstration. One
abstract course-work packet stops for review, moves after approval, and aligns
with abstract course-outline, activity-instruction, and knowledge-check rows.
It does not show a live course session, learner information, customer proof,
measured product results, or a production verification receipt.

The film states four product pillars: `Review before you approve`, `Know what
was saved`, `Keep your sign-in private`, and `Choose how you work`. The privacy
statement is specific: course sign-in stays in Chrome, and course content can
be shared with a selected assistant. The film covers the shared Canvas/Moodle
browser bridge. It does not claim Blackboard support, complete feature
parity, that all course work stays local, or that every assistant is supported.

The video is silent. Its message is carried by on-screen text.

## Verification evidence

Final check output, source geometry, keyframes, and actual MP4 contact sheets
are stored locally in `renders/inspection/shared-bridge-final/`.
