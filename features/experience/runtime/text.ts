/**
 * SDF text atlas generation for the 3D headlines (port of the troika-three-text bridge).
 *
 * The worker asks for `getTextRenderInfo` with the text and font parameters; the main thread
 * typesets the string with troika, renders the glyph SDFs and answers with a plain,
 * structured-cloneable render-info object. The original patched troika so that the atlas
 * pixels are always read back from the WebGL canvas (the worker rebuilds a DataTexture from
 * `sdfTexture.source.data`); the same read-back is done here after each generation.
 */
import { getTextRenderInfo, preloadFont } from 'troika-three-text';
import type { EngineApi } from './engine-api';
import { events } from './events';

export const HEADLINE_FONT_URL = '/fonts/PPMori-Medium.woff';
export const HEADLINE_CHARACTERS = 'ENFTCQISWUBDabcdefghiklmnopqrstuvxy, ';

type TextRenderInfo = {
  sdfTexture: {
    image: unknown;
    flipY: boolean;
    isDataTexture?: boolean;
    needsUpdate: boolean;
    source?: { data: unknown };
  };
  parameters: Record<string, unknown>;
};

/** Copies the atlas pixels out of the WebGL canvas into a plain RGBA buffer. */
function readBackAtlas(info: TextRenderInfo): void {
  const image = info.sdfTexture.image;
  if (!(image instanceof HTMLCanvasElement) && !(typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas)) return;
  const canvas = image as HTMLCanvasElement;
  const { width, height } = canvas;
  const gl = canvas.getContext('webgl') as WebGLRenderingContext | null;
  if (!gl) return;
  const data = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  info.sdfTexture.image = { width, height, data };
  info.sdfTexture.flipY = false;
  info.sdfTexture.isDataTexture = true;
}

export function setupTextRendering(api: EngineApi): () => void {
  let disposed = false;

  preloadFont({ font: HEADLINE_FONT_URL, characters: HEADLINE_CHARACTERS }, () => {
    /* atlas warmed */
  });

  const off = events.on<Record<string, unknown>>('getTextRenderInfo', (params) => {
    if (disposed) return;
    try {
      getTextRenderInfo({ ...params, font: HEADLINE_FONT_URL } as Parameters<typeof getTextRenderInfo>[0], (info) => {
        if (disposed || !api.alive) return;
        try {
          readBackAtlas(info as unknown as TextRenderInfo);
          // The frozen object returned by troika is cloned when posted to the worker.
          api.trigger({ name: 'textRenderInfo', fireAtStart: true }, info);
        } catch (error) {
          console.error('[text] failed to send render info', error);
        }
      });
    } catch (error) {
      console.error('[text] getTextRenderInfo failed', error);
    }
  });

  return () => {
    disposed = true;
    off();
  };
}
