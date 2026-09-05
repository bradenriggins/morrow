# Morrow launch video preview

This directory contains an editable, local HyperFrames preview for Morrow.

## Preview files

- `index.html` — the full editable 25.2-second composition.
- `STORYBOARD.md` — the timed story and visual direction.
- `BRIEF.md` — audience, limits, and delivery constraints.
- `assets/morrow-orbit.png` — the Morrow orbit mark from this checkout.
- `renders/morrow-launch-preview.mp4` — generated local preview after render.
- `renders/morrow-launch-poster.jpg` — generated poster after render.

## Render locally

Use the pinned HyperFrames browser. Do not use system Chrome.

```bash
cd launch/video
export HYPERFRAMES_BROWSER_PATH="$(npx --yes hyperframes@0.8.28 browser path)"
npm run check -- --samples 15 --at 2.6,6.8,11.9,16.8,20.7,24.0
npm run render -- --quality high --output renders/morrow-launch-preview.mp4
ffmpeg -y -ss 00:00:20.700 -i renders/morrow-launch-preview.mp4 -frames:v 1 -q:v 2 renders/morrow-launch-poster.jpg
```

## Illustrative content

All UI shown in this video is an illustrative product demonstration. The source
statement, cell-lesson correction, quiz answer-key correction, approval action,
and checked-result state are original demo content. It uses the concrete
reviewed wording `Ribosomes assemble proteins.` and contrasts it with the
illustrative lesson error `Ribosomes produce ATP.` and quiz key `Mitochondria`.
The video does not show live Canvas data, learner information, customer proof,
measured product results, or a production verification receipt.

The video is silent. Its message is carried by on-screen text.
