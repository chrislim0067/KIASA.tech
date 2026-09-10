import { Config } from '@remotion/cli/config';

/**
 * Remotion configuration for the promo film.
 *
 * Lives under video/ rather than at the repository root so the video tooling
 * stays in one directory; every npm script passes `--config video/remotion.config.ts`.
 *
 * The public directory is video/public, NOT the Next app's public/ — the film
 * self-hosts its fonts and must not serve, or depend on, the site's assets.
 */
Config.setEntryPoint('./video/index.ts');
Config.setPublicDir('./video/public');

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
Config.setCrf(18);

/**
 * The machine's own Chrome. scripts/verify.mjs drives the same binary, so the
 * install is known-good; setting it here skips Remotion's ~150MB download of
 * a headless shell. Unset it to let Remotion manage its own browser.
 */
Config.setBrowserExecutable('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
