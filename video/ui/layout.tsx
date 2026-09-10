import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';

/**
 * Format awareness.
 *
 * Scenes are designed in landscape at 1920×1080 design units. `s` is the
 * factor that maps those units onto the actual composition, so the same scene
 * renders the 16:9 master, the 9:16 vertical and the 1:1 square: landscape
 * scales to width, the others to a 1080-unit width and stack their content.
 */
export function useFormat() {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const square = height === width;
  const landscape = !portrait && !square;
  const s = landscape ? width / 1920 : width / 1080;
  return { width, height, portrait, square, landscape, s };
}

/**
 * A scene's two halves — the UI cluster and the caption — placed for the
 * format. Landscape puts them side by side or stacks caption over/under a
 * wide UI; the vertical and square formats always stack, caption first.
 *
 * `uiSize` is the cluster's design size; it is scaled to fit whatever room the
 * format leaves it, so scenes lay out in fixed design units and never measure.
 */
export function SceneLayout({
  ui,
  caption,
  uiSize,
  captionPos = 'right',
  uiAlign = 'center',
  style,
}: {
  ui: ReactNode;
  caption: ReactNode;
  uiSize: { w: number; h: number };
  /** Where the caption sits in landscape. */
  captionPos?: 'right' | 'left' | 'bottom' | 'top';
  /** Where the UI cluster sits within its region. */
  uiAlign?: 'start' | 'center' | 'end';
  style?: CSSProperties;
}) {
  const { width, height, landscape, s } = useFormat();
  const pad = 80 * s;

  if (!landscape) {
    // Stack: caption in the top band, UI scaled into the remainder.
    const captionH = 0.28 * height;
    const uiW = width - pad * 2;
    const uiH = height - captionH - pad;
    const k = Math.min(uiW / uiSize.w, uiH / uiSize.h);
    return (
      <AbsoluteFill style={style}>
        <div
          style={{
            position: 'absolute',
            left: pad,
            right: pad,
            top: pad * 0.9,
            height: captionH - pad * 0.9,
            display: 'flex',
            alignItems: 'flex-end',
          }}
        >
          {caption}
        </div>
        <div
          style={{
            position: 'absolute',
            left: (width - uiSize.w * k) / 2,
            top: captionH + (uiH - uiSize.h * k) / 2,
            width: uiSize.w,
            height: uiSize.h,
            transform: `scale(${k})`,
            transformOrigin: 'top left',
          }}
        >
          {ui}
        </div>
      </AbsoluteFill>
    );
  }

  const horizontal = captionPos === 'right' || captionPos === 'left';
  const captionW = horizontal ? 0.34 * width : width - pad * 2;
  const captionH = horizontal ? height - pad * 2 : 0.22 * height;
  const uiW = horizontal ? width - captionW - pad * 2.2 : width - pad * 2;
  const uiH = horizontal ? height - pad * 2 : height - captionH - pad * 2;
  // Fill the room the format leaves, up to 1.4× the design size: the clusters
  // are drawn at product-UI density, which is too fine to read on a 1080p
  // frame at 1:1. Beyond 1.4× the type starts to look enlarged rather than
  // designed.
  const k = Math.min(uiW / uiSize.w, uiH / uiSize.h, 1.4 * s);

  const align = uiAlign === 'start' ? 0 : uiAlign === 'end' ? 1 : 0.5;
  const uiLeft = horizontal
    ? captionPos === 'right'
      ? pad + (uiW - uiSize.w * k) * align
      : width - pad - uiW + (uiW - uiSize.w * k) * align
    : pad + (uiW - uiSize.w * k) * 0.5;
  const uiTop = horizontal
    ? pad + (uiH - uiSize.h * k) / 2
    : captionPos === 'top'
      ? captionH + pad + (uiH - uiSize.h * k) / 2
      : pad + (uiH - uiSize.h * k) / 2;

  const captionStyle: CSSProperties = horizontal
    ? {
        position: 'absolute',
        top: pad,
        bottom: pad,
        width: captionW,
        [captionPos === 'right' ? 'right' : 'left']: pad,
        display: 'flex',
        alignItems: 'center',
      }
    : {
        position: 'absolute',
        left: pad,
        right: pad,
        height: captionH,
        [captionPos === 'top' ? 'top' : 'bottom']: pad,
        display: 'flex',
        alignItems: captionPos === 'top' ? 'flex-start' : 'flex-end',
        justifyContent: 'center',
      };

  return (
    <AbsoluteFill style={style}>
      <div style={captionStyle}>{caption}</div>
      <div
        style={{
          position: 'absolute',
          left: uiLeft,
          top: uiTop,
          width: uiSize.w,
          height: uiSize.h,
          transform: `scale(${k})`,
          transformOrigin: 'top left',
        }}
      >
        {ui}
      </div>
    </AbsoluteFill>
  );
}
