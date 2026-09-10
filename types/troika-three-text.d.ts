declare module 'troika-three-text' {
  export interface TextRenderInfoParameters {
    text?: string;
    font?: string | Array<{ label?: string; src: string }>;
    sdfGlyphSize?: number;
    unicodeFontsURL?: string;
    gpuAccelerateSDF?: boolean;
    colorRanges?: Record<string, number | string> | null;
    includeCaretPositions?: boolean;
    [key: string]: unknown;
  }
  export interface TextRenderInfo {
    parameters: TextRenderInfoParameters;
    sdfTexture: unknown;
    sdfGlyphSize: number;
    sdfExponent: number;
    glyphBounds: Float32Array;
    glyphAtlasIndices: ArrayLike<number>;
    glyphColors?: Uint8Array;
    caretPositions?: Float32Array;
    chunkedBounds: unknown[];
    blockBounds: number[];
    visibleBounds: number[];
    timings: Record<string, unknown>;
  }
  export function getTextRenderInfo(args: TextRenderInfoParameters, callback: (info: TextRenderInfo) => void): void;
  export function preloadFont(
    options: { font?: string; characters?: string | string[]; sdfGlyphSize?: number },
    callback: () => void,
  ): void;
}
