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
if (hero.includes('_wmFitScale')) {
  console.log('hero wordmark fit: already patched, skipping');
} else {
  hero = replaceOnce(
    hero,
    `                const baseScale = _isMobileAnim ? 0.9 : 1.0;`,
    `                // Fit the whole brand — the wordmark and the ring around it —
                // inside the viewport.
                //
                // The hero frames the logo at z -25 from a camera at z 20 through
                // a 35deg vertical FOV, so the visible width there is
                // (2 * tan(fov/2) * 45) * aspect. Narrowing the window shrinks
                // that while the geometry stays ~13 units wide, which is what
                // clipped KIASA off at both ends. The old 0.9 mobile constant
                // could not help: it was a step at 1024px decided once at build
                // time, and this very line overwrites the group's scale every
                // frame, so anything set on resize was lerped straight back out.
                //
                // Measured from a FIXED reference framing rather than the live
                // camera, deliberately. camera.fov is animated by scroll velocity
                // and logoGroup is lerped toward the camera, so reading either
                // here would make the brand breathe during a scroll. Only the
                // aspect ratio actually matters, so this recomputes on resize and
                // nowhere else, and stays at 1 on any normal desktop window.
                // The resting position is pushed right by lX to clear the
                // left-aligned headline, and that offset is NOT scaled with the
                // group — so it has to be counted twice into the width being
                // fitted, or the brand is centred correctly and then shoved off
                // the right edge anyway. At 390x844 that was the difference
                // between a right edge of 7.15 (clipped) and 6.20 (fits) against
                // a 6.56 limit.
                const _wmOffsetX = Math.max(0, (WORDMARK_SIZE.width - 4.8) * 0.22);
                const _wmSpan = Math.max(WORDMARK_SIZE.width, ringMesh ? ringMesh.geometry.parameters.radius * 2 : 0) + _wmOffsetX * 2;
                const _wmVisibleW = (2 * Math.tan(35 * Math.PI / 360) * 45) * camera.aspect;
                const _wmFitScale = Math.min(1, (_wmVisibleW * 0.9) / _wmSpan);
                const baseScale = _wmFitScale;`,
    'hero: scale the wordmark to fit narrow viewports'
  );
  fs.writeFileSync(HERO, hero);
  console.log('hero wordmark fit: applied');
}

console.log('patches done');
