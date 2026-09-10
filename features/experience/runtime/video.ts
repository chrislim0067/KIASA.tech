/**
 * Showreel video feed (port of `zt` / `Yt`).
 *
 * The worker cannot decode video on its own, so the main thread draws each presented frame
 * of `/top/showreel_128.mp4` onto a small 2D canvas and transfers the pixels. The loop uses
 * `requestVideoFrameCallback` (one callback per presented frame, none while the tab is
 * hidden) and never queues more than one frame at a time.
 */
import type { EngineApi } from './engine-api';
import { events } from './events';

export const SHOWREEL_URL = '/top/showreel_128.mp4';

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export function startVideoFeed(api: EngineApi): () => void {
  const video = document.createElement('video') as VideoWithFrameCallback;
  video.src = SHOWREEL_URL;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.load();

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let disposed = false;
  let busy = false;
  let frameHandle: number | null = null;
  let rafHandle: number | null = null;

  const sizeCanvas = (): void => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  };

  const pushFrame = async (): Promise<void> => {
    if (busy || disposed || !ctx || !api.alive) return;
    busy = true;
    try {
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (imageData?.data.buffer) await api.processVideoFrame(imageData, [imageData.data.buffer]);
    } finally {
      busy = false;
    }
  };

  const stopLoop = (): void => {
    if (frameHandle !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    frameHandle = null;
    rafHandle = null;
    busy = false;
  };

  const loop = async (): Promise<void> => {
    if (disposed) return;
    await pushFrame();
    if (disposed || video.paused || video.ended) return;
    if (video.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(() => void loop());
    else rafHandle = requestAnimationFrame(() => void loop());
  };

  const startLoop = async (): Promise<void> => {
    stopLoop();
    if (video.videoWidth === 0) {
      await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
    }
    sizeCanvas();
    if (!video.paused && !video.ended) void loop();
  };

  const tryPlay = async (): Promise<boolean> => {
    try {
      const p = video.play();
      if (p !== undefined) await p;
      return true;
    } catch (error) {
      console.log('Autoplay failed:', error);
      return false;
    }
  };

  const onPlay = (): void => {
    void startLoop();
  };
  video.addEventListener('play', onPlay);

  const offPause = events.on('videoPause', () => {
    video.pause();
    video.currentTime = 0;
  });
  const offPlay = events.on('videoPlay', () => {
    void tryPlay();
  });

  let gestureListener: (() => void) | null = null;
  void (async () => {
    if (await tryPlay()) return;
    if (disposed) return;
    console.log('Autoplay blocked - waiting for user interaction');
    gestureListener = () => {
      document.removeEventListener('click', gestureListener!);
      document.removeEventListener('touchstart', gestureListener!);
      gestureListener = null;
      void tryPlay();
    };
    document.addEventListener('click', gestureListener);
    document.addEventListener('touchstart', gestureListener);
  })();

  return () => {
    disposed = true;
    stopLoop();
    video.removeEventListener('play', onPlay);
    offPause();
    offPlay();
    if (gestureListener) {
      document.removeEventListener('click', gestureListener);
      document.removeEventListener('touchstart', gestureListener);
    }
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}
