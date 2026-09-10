import { describe, expect, it } from 'vitest';
import { AUDIO_PATHS, MUSIC_DEFINITIONS, SFX_DEFINITIONS, TRANSITION_DEFINITIONS, audioSources, interactionLoop, interactionStem } from '@/lib/audio/manifest';
import fs from 'node:fs';
import path from 'node:path';

describe('audio manifest', () => {
  it('every sound exists locally in opus and mp3', () => {
    const root = path.resolve(__dirname, '../../public');
    const groups: Array<[typeof SFX_DEFINITIONS, string]> = [
      [SFX_DEFINITIONS, AUDIO_PATHS.sfx],
      [MUSIC_DEFINITIONS, AUDIO_PATHS.music],
      [TRANSITION_DEFINITIONS, AUDIO_PATHS.transitions],
    ];
    for (const [defs, base] of groups) {
      for (const def of defs) {
        const [opus, , mp3] = audioSources(def.path, base);
        expect(fs.existsSync(path.join(root, opus!)), opus).toBe(true);
        expect(fs.existsSync(path.join(root, mp3!)), mp3).toBe(true);
      }
    }
  });

  it('keeps the original interaction stem names', () => {
    expect(interactionStem('section2', true)).toBe('interaction_scene_2_in');
    expect(interactionStem('section4', false)).toBe('interaction_scene_4_out');
    expect(interactionLoop('section2')).toBe('interaction_scene_2_loop');
  });

  it('has 10 sfx, 6 music tracks and 10 transition stems', () => {
    expect(SFX_DEFINITIONS).toHaveLength(10);
    expect(MUSIC_DEFINITIONS).toHaveLength(6);
    expect(TRANSITION_DEFINITIONS).toHaveLength(10);
  });
});
