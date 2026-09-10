# Founder plates — generation specification

The keynote (0:32–0:44) has three founder slots. This repository cannot
generate them: there is no image-to-video model or API in the build
environment, and a photograph panned across a stage is not footage of a person
presenting. Until each plate exists, `video/brand/keynote/FounderPlate.tsx`
shows the founder's real photo, treated for the stage, as a placeholder — and
labels it as one in Remotion Studio.

## Dropping a plate in

1. Put the file at the path shown below under `video/public/`.
2. In `video/brand/assets.ts`, set that plate's `video` to the path.
3. Render. Nothing else changes — camera, timing and lighting are already cut.

| Slot | File | Used in | Length needed |
|---|---|---|---|
| `wide` | `founder/founder-wide.mp4` | Shot A (0:32–0:35) and Shot D pull-back (0:41–0:44) | ≥ 4.5s |
| `medium` | `founder/founder-medium.mp4` | Shot B (0:35–0:38) | ≥ 4s |
| `vision` | `founder/founder-vision.mp4` | Shot C (0:38–0:41) | ≥ 4s |

All plates: **1920×1080, 24–60fps, H.264 or ProRes, no audio, black or near-black
background** (the set is black; the plate composites over it without a matte).
The subject is framed as described per slot and **lit from front-left with a
cool rim, and violet spill on the subject's right** — that is where the screen
is. The slot crops to the framing below; give the generator a little headroom.

## Identity reference

`video/public/founder/founder-reference.webp` — the founder's actual photo.
Use it as the identity input of an identity-preserving image-to-video model
(e.g. Kling image-to-video with a reference image, Runway Gen-3/Act-One with a
driving performance, Luma or Veo with an image reference). The identity must
be preserved exactly: face shape, eyes, nose, mouth, hair, skin. Cinematic
grading is fine; a different person is not.

Wardrobe: if the tool changes clothing reliably without drifting identity, a
dark fitted jacket over a dark shirt. **If wardrobe change costs identity, keep
the original clothing.** Identity is worth more than the jacket.

## Prompts

Use these as the text conditioning alongside the reference image. Keep the
negative prompt on every plate.

### `founder-wide.mp4` — Shot A

> A young East Asian man, the person in the reference image, standing at a
> dark lectern on a large technology-conference stage, seen from the
> auditorium. Full figure, small in frame, stage right of centre. He is
> presenting calmly: still posture, one small hand gesture toward the screen,
> a slow turn of the head. Dark architectural stage, a single spotlight from
> above, cool rim light from the left, soft violet light on his right side.
> Black background. Cinematic, realistic, 35mm, shallow depth of field, slow
> and steady, no camera movement.

### `founder-medium.mp4` — Shot B

> The same man from the reference image, waist-up, presenting on a dark
> keynote stage. Natural presentation posture, weight slightly on one foot.
> One restrained hand gesture, a small nod, a brief glance to his right
> toward a screen out of frame. Spotlight from above, cool rim light from the
> left, soft violet spill on his right. Black background. Cinematic,
> realistic, 50mm, shallow depth of field, subtle movement only, no camera
> movement.

### `founder-vision.mp4` — Shot C

> The same man from the reference image, chest-up, on a dark keynote stage,
> listening and then speaking with quiet confidence. Small natural head
> movement, breathing, a slight lean forward, eyes toward the audience then
> briefly to his right. Spotlight from above, cool rim light from the left,
> soft violet spill on his right. Black background. Cinematic, realistic,
> 85mm, very shallow depth of field, minimal movement, no camera movement.

### Negative prompt (all plates)

> different face, changed facial structure, different ethnicity, older,
> younger, beautified, celebrity, model, exaggerated gestures, waving,
> walking, pacing, fake smile, laughing, looking into camera like a vlogger,
> visible mouth animation, lip movement, text, logos, watermark, bright
> background, purple stage, neon, holograms, robots, extra people.

## On lip sync

None of the plates should show speaking mouth movement. The narration plays
over wide, medium and side framings and over the screen cutaway, which is why
the sequence is cut this way — it is believable without lip sync. If a
dedicated lip-sync pass is wanted later, it applies to `founder-vision.mp4`
only, against the founder's own recording of the three lines in
`video/brand/timeline.ts`.
