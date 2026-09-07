/**
 * Applies deliberate customisations on top of the byte-faithful extraction.
 *
 * `npm run extract` regenerates public/generated/** verbatim from legacy/, so
 * anything hand-edited there would be lost. Every intentional divergence from
 * the original lives here instead, as an explicit anchored replacement that
 * fails loudly if the anchor moves.
 *
 *   node scripts/apply-patches.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HERO = path.join(ROOT, 'public', 'generated', 'home', '04.mjs');

let applied = 0;

/** Replace exactly one occurrence, or throw. */
function replaceOnce(src, anchor, replacement, label) {
  const first = src.indexOf(anchor);
  if (first === -1) throw new Error(`patch "${label}": anchor not found — has the original changed?`);
  if (src.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error(`patch "${label}": anchor is ambiguous (matches more than once)`);
  }
  applied++;
  return src.slice(0, first) + replacement + src.slice(first + anchor.length);
}

/* ------------------------------------------------- hero wordmark: W -> KIASA */

let hero = fs.readFileSync(HERO, 'utf8');

if (hero.includes('/brand/wordmark.js')) {
  console.log('hero wordmark: already patched, skipping');
} else {
  // 1. Pull in the generated outlines (scripts/gen-brand-logo.mjs).
  hero = replaceOnce(
    hero,
    "        import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';",
    "        import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';\n" +
      "        import { buildWordmarkShapes, WORDMARK_SIZE } from '/brand/wordmark.js';",
    'hero: import wordmark'
  );

  // 2. Drop the hand-written W outline. The original traced ten points into a
  //    single Shape; the wordmark supplies one Shape per letter instead.
  hero = replaceOnce(
    hero,
    `            const shape = new THREE.Shape();
            shape.moveTo(-2.4,2.0); shape.lineTo(-1.2,-2.0); shape.lineTo(0.0,1.0);
            shape.lineTo(1.2,-2.0); shape.lineTo(2.4,2.0);   shape.lineTo(1.6,2.0);
            shape.lineTo(0.8,-0.8); shape.lineTo(0.0,1.8);   shape.lineTo(-0.8,-0.8);
            shape.lineTo(-1.6,2.0); shape.closePath();`,
    `            // Wordmark outlines are generated from Syncopate Bold at build time
            // (scripts/gen-brand-logo.mjs) and already centred on the origin.
            const wordmarkShapes = buildWordmarkShapes(THREE);`,
    'hero: replace W outline'
  );

  // 3. One extruded mesh per letter, same material as the W.
  //    NOT .center() per letter — that would stack all five on the origin. The
  //    outlines are pre-centred in X/Y, so only Z needs centring.
  //    Depth and bevel are derived from cap height rather than copied: the W was
  //    4.0 tall with depth 0.4 (10%). Reusing 0.4 on 1.8-tall letters makes them
  //    read as extruded blocks instead of glyphs.
  hero = replaceOnce(
    hero,
    `            logoGroup.add(new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth:0.4, bevelEnabled:true, bevelSize:0.08, bevelThickness:0.08 }).center(), mat));`,
    `            const wmDepth = WORDMARK_SIZE.height * 0.32;
            const wmBevel = WORDMARK_SIZE.height * 0.035;
            for (const s of wordmarkShapes) {
                const geo = new THREE.ExtrudeGeometry(s, { depth:wmDepth, bevelEnabled:true, bevelSize:wmBevel, bevelThickness:wmBevel });
                geo.translate(0, 0, -wmDepth / 2);
                logoGroup.add(new THREE.Mesh(geo, mat));
            }`,
    'hero: extrude each letter'
  );

  // 4. The ring encircled a 4.8-wide glyph at radius 3.8. Track the wordmark's
  //    width or it cuts straight through the letters.
  hero = replaceOnce(
    hero,
    `new THREE.TorusGeometry(3.8, 0.05, 12, 48)`,
    `new THREE.TorusGeometry(Math.max(3.8, WORDMARK_SIZE.width * 0.62), 0.05, 12, 48)`,
    'hero: widen orbit ring'
  );

  // 5. Halve the yaw. +-0.3 rad barely skewed a square glyph, but a wordmark
  //    three times wider foreshortens into an unreadable sliver at that angle.
  hero = replaceOnce(
    hero,
    `            logoGroup.rotation.y  = Math.sin(t*0.5)*0.3 + mouseParallax.x*0.2;`,
    `            logoGroup.rotation.y  = Math.sin(t*0.5)*0.15 + mouseParallax.x*0.1;`,
    'hero: reduce yaw for a wide wordmark'
  );

  // 6. Nudge the resting position right. The W was 4.8 wide and sat centred,
  //    clearing the left-aligned headline. A wordmark this wide would otherwise
  //    put "KIA" behind "WORLD CLASS ...". Scales with width so it stays correct
  //    if the text changes.
  hero = replaceOnce(
    hero,
    `            let lX = 0, lY = Math.sin(t * 0.6) * 0.3;`,
    `            let lX = Math.max(0, (WORDMARK_SIZE.width - 4.8) * 0.22), lY = Math.sin(t * 0.6) * 0.3;`,
    'hero: shift wordmark clear of the headline'
  );

  fs.writeFileSync(HERO, hero);
  console.log(`hero wordmark: ${applied} replacement(s) applied`);
}

/* ------------------------------ hero wordmark: fit the brand to the viewport */

// Guarded separately from the block above: those replacements run once, when the
// W is first swapped for the wordmark, and are skipped forever after. This one
// has to be able to land on a tree where that has already happened.
if (hero.includes('let _wmFit = 1;')) {
  console.log('hero wordmark fit: already patched, skipping');
} else {
  // A module-scoped fit factor. Both the group's scale and its horizontal
  // offset consume it, and those live in different blocks of animate().
  hero = replaceOnce(
    hero,
    `        let logoGroup, ringMesh;`,
    `        let logoGroup, ringMesh;
        // Viewport fit for the 3D brand, recomputed each frame in animate().
        // Module scope because both the scale and the horizontal offset consume
        // it, and they live in different blocks.
        let _wmFit = 1;`,
    'hero: declare the wordmark fit factor'
  );

  hero = replaceOnce(
    hero,
    `                const baseScale = _isMobileAnim ? 0.9 : 1.0;`,
    `                // Fit the whole brand — wordmark plus ring — into the viewport.
                //
                // The logo rides 25 units in front of the camera (lZ below is
                // camera.position.z - 25), so that, NOT the -25 build position,
                // is the distance the framing must be solved at. Visible width
                // there is (2 * tan(fov/2) * 25) * aspect, which on a 390px
                // phone is only 7.28 units against a brand 13.02 across — the
                // clipping the screenshots showed.
                //
                // The brand also sits 1.254 right of centre to clear the
                // headline, and BOTH the size and that offset scale together
                // (see lX below). Shrinking the letters while leaving the offset
                // fixed merely pushes a smaller brand off the same edge; that
                // was measured still-clipped at 390px before this was corrected.
                //
                // Measured from a fixed reference framing rather than the live
                // camera: fov is animated by scroll velocity, so reading it here
                // would make the brand pulse mid-scroll. Only aspect matters, so
                // this recomputes on resize and stays 1 above ~900px wide.
                const _wmOffsetX = Math.max(0, (WORDMARK_SIZE.width - 4.8) * 0.22);
                const _wmSpan = Math.max(WORDMARK_SIZE.width, ringMesh ? ringMesh.geometry.parameters.radius * 2 : 0);
                const _wmVisibleW = (2 * Math.tan(35 * Math.PI / 360) * 25) * camera.aspect;
                _wmFit = Math.min(1, (_wmVisibleW * 0.9) / (_wmSpan + _wmOffsetX * 2));
                const baseScale = _wmFit;`,
    'hero: scale the wordmark to fit narrow viewports'
  );

  // The resting offset and the scroll orbit are positions, not scale, so they
  // are not affected by logoGroup.scale and have to be reduced explicitly.
  hero = replaceOnce(
    hero,
    `            let lX = Math.max(0, (WORDMARK_SIZE.width - 4.8) * 0.22), lY = Math.sin(t * 0.6) * 0.3;`,
    `            let lX = Math.max(0, (WORDMARK_SIZE.width - 4.8) * 0.22) * _wmFit, lY = Math.sin(t * 0.6) * 0.3;`,
    'hero: scale the wordmark resting offset'
  );

  hero = replaceOnce(
    hero,
    `                lX = Math.sin(progress * Math.PI * 5) * 7;`,
    `                lX = Math.sin(progress * Math.PI * 5) * 7 * _wmFit;`,
    'hero: scale the wordmark scroll orbit'
  );

  fs.writeFileSync(HERO, hero);
  console.log('hero wordmark fit: applied');
}

console.log('patches done');
