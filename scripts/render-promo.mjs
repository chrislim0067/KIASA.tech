/**
 * Renders the promo film.
 *
 *   node scripts/render-promo.mjs                 # 16:9 master + 30fps web variant → video/out/
 *   node scripts/render-promo.mjs --install       # …and copy the web variant into public/Assets
 *   node scripts/render-promo.mjs --all           # also the 9:16 and 1:1 compositions
 *   node scripts/render-promo.mjs --preview       # quick: half-scale, 30fps, higher CRF
 *
 * Two files come out of the master: the 60fps render itself, and a 30fps
 * variant re-encoded by ffmpeg for the website hero. The hero is a muted,
 * looping background — 60fps buys it nothing and costs every visitor twice the
 * bytes — so that is the one that ships to public/Assets. The 60fps master is
 * for YouTube and social.
 *
 * Remotion writes the video; ffmpeg only re-times and adds +faststart so the
 * browser can start playing before the whole file has arrived.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/*
 * Every path handed to a child process is RELATIVE to ROOT, and ROOT is the
 * child's cwd. On Windows `npx` is npx.cmd, which Node will only spawn through
 * a shell, and a shell splits an unquoted argument on spaces — this repository
 * lives under "C:\Users\Blue Moon\…", and the first render wrote its output to
 * "C:\Users\Blue". Relative paths carry no spaces; `q()` quotes them anyway.
 */
const OUT = 'video/out';
const CONFIG = 'video/remotion.config.ts';
const ENTRY = 'video/index.ts';
const HERO = path.join(ROOT, 'public', 'Assets', 'KIASA Promo.mp4');

const args = new Set(process.argv.slice(2));
const preview = args.has('--preview');
const install = args.has('--install');
const all = args.has('--all');

fs.mkdirSync(path.join(ROOT, OUT), { recursive: true });

const useShell = process.platform === 'win32';
const q = (arg) => (useShell && /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg);

function run(cmd, cmdArgs, label) {
  console.log(`\n▶ ${label}`);
  // Under a shell Node wants one command line, not an argv it would only
  // concatenate anyway (DEP0190). Without one, argv is passed through as-is.
  const r = useShell
    ? spawnSync([cmd, ...cmdArgs].map(q).join(' '), { cwd: ROOT, stdio: 'inherit', shell: true })
    : spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`✗ ${label} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

function render(id, file, extra = []) {
  run(
    'npx',
    [
      'remotion', 'render', ENTRY, id, file,
      `--config=${CONFIG}`,
      ...(preview ? ['--scale=0.5', '--crf=26', '--every-nth-frame=2'] : []),
      ...extra,
    ],
    `render ${id}${preview ? ' (preview)' : ''}`
  );
}

const master = `${OUT}/${preview ? 'kiasa-promo-preview.mp4' : 'kiasa-promo-16x9-60fps.mp4'}`;
render('KiasaPromo16x9', master);

if (!preview) {
  const web = `${OUT}/kiasa-promo-16x9-30fps.mp4`;
  run(
    'ffmpeg',
    ['-y', '-v', 'error', '-i', master, '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', web],
    'ffmpeg 30fps web variant'
  );
  run('ffmpeg', ['-y', '-v', 'error', '-i', master, '-c', 'copy', '-movflags', '+faststart', `${master}.tmp.mp4`], 'ffmpeg faststart master');
  fs.renameSync(path.join(ROOT, `${master}.tmp.mp4`), path.join(ROOT, master));

  if (install) {
    fs.copyFileSync(path.join(ROOT, web), HERO);
    console.log(`\n✓ installed → ${path.relative(ROOT, HERO)}`);
  }
}

if (all && !preview) {
  render('KiasaPromo9x16', `${OUT}/kiasa-promo-9x16-60fps.mp4`);
  render('KiasaPromo1x1', `${OUT}/kiasa-promo-1x1-60fps.mp4`);
}

console.log(`\n✓ done → ${OUT}`);
