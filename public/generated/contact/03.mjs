
        import * as THREE from 'three';
        (async function () {
            const canvas = document.getElementById('bg3d');
            if (!canvas) return;
            const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            // ── ?cwarp — cursor vortex, ON by default ───────────────────────────────────────────
            //   absent / =shader  the homepage's ripple as a post-process pass — the live default
            //   ?cwarp=0          off, the pre-August behaviour. The rollback.
            //   ?cwarp=particles  a world-space black hole that moves the dust itself — the
            //                     alternative that was compared against, kept for reference
            //
            // Chosen by eye against the particle variant. Worth recording why it was not obvious:
            //
            //   1. This canvas is alpha:true — a transparent layer BEHIND the HTML, where the
            //      homepage renders an opaque full scene. The post-process warps only the dust and
            //      the wireframe; the text above it is never touched.
            //   2. The scene is sparse — ~1100 points and two wireframes on mostly empty space, and
            //      a UV ripple distorts PIXELS. The prediction was that it would be near-invisible
            //      with so few lit pixels to bend. That prediction was wrong: it reads well, because
            //      the wireframe shell gives the ripple a continuous edge to distort.
            const CWARP = new URLSearchParams(location.search).get('cwarp');
            const CWARP_PARTICLES = CWARP === 'particles';
            const CWARP_SHADER = !CWARP_PARTICLES && CWARP !== '0';
            try {
                const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
                renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
                renderer.setSize(window.innerWidth, window.innerHeight);

                const scene = new THREE.Scene();
                scene.fog = new THREE.FogExp2(0x05010c, 0.03);
                const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
                camera.position.set(0, 0, 15);

                // Drifting dust
                const COUNT = window.innerWidth < 700 ? 600 : 1100;
                const pos = new Float32Array(COUNT * 3);
                for (let i = 0; i < COUNT; i++) {
                    pos[i * 3]     = (Math.random() - 0.5) * 46;
                    pos[i * 3 + 1] = (Math.random() - 0.5) * 30;
                    pos[i * 3 + 2] = (Math.random() - 0.5) * 32;
                }

                // ── Round point sprites ─────────────────────────────────────────────────────────────────────
                // A PointsMaterial with no `map` draws every particle as a hard SQUARE quad. Against a near-black
                // background at small sizes that reads as literal stray pixels rather than motes of light, which
                // is exactly what it looked like.
                //
                // Fixed in the shader rather than with the usual radial-gradient texture: a texture would mean an
                // upload, a sampler and texture memory on pages that already manage a budget, to encode something
                // computable in two lines. `discard` clips the quad to a disc; the smoothstep feathers the edge so
                // it is a soft mote, not a stamped dot.
                //
                // smoothstep with edge0 > edge1 is UNDEFINED per the GLSL/GLSL-ES spec. Every real driver
    // computes clamp((x-e0)/(e1-e0)) and gives the intended falloff, which is why the reversed
    // form worked, but it was spec-undefined in three verbatim copies. 1.0 - smoothstep(lo, hi)
    // is the portable spelling and compiles to the same thing.
    // The string being replaced is emitted verbatim by three's points fragment shader. If three ever
                // changes it the replace silently does nothing and the squares come back with no error anywhere —
                // so it is asserted, and the result recorded on the material for the verification harness.
                window.__WT_POINTS_MATS = window.__WT_POINTS_MATS || [];
                function _roundPoints(mat) {
                  var TARGET = 'vec4 diffuseColor = vec4( diffuse, opacity );';
                  mat.onBeforeCompile = function (shader) {
                    var before = shader.fragmentShader;
                    shader.fragmentShader = before.replace(
                      TARGET,
                      'float _pd = length( gl_PointCoord - vec2( 0.5 ) );\n\tif ( _pd > 0.5 ) discard;\n\t'
                      + 'vec4 diffuseColor = vec4( diffuse, opacity * ( 1.0 - smoothstep( 0.18, 0.5, _pd ) ) );'
                    );
                    var ok = shader.fragmentShader !== before;
                    mat.userData.roundMaskApplied = ok;
                    if (!ok) console.warn('[wt] point round-mask failed to inject — sprites will render square');
                  };
                  window.__WT_POINTS_MATS.push(mat);
                  return mat;
                }

                const pgeo = new THREE.BufferGeometry();
                pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
                const points = new THREE.Points(pgeo, _roundPoints(new THREE.PointsMaterial({
                    // Size scaled INVERSELY by pixel ratio so a mote covers the same number of DEVICE
                    // pixels on every screen. gl_PointSize = size * pixelRatio * (height/2) / dist, so a
                    // fixed world size shrinks in device px as DPR falls: at the 1.8 cap this field sat
                    // near 3.2 device px (where the disc mask shapes it properly), but at DPR 1 it fell to
                    // ~1.8 px — and below ~3 px the mask cannot shape anything. At exactly 2 px all four
                    // fragment centres sit at _pd = 0.354, so none is discarded and all four get the same
                    // alpha: a flat 2x2 SQUARE, mask perfectly intact. Normalising by DPR leaves the
                    // high-DPR view byte-identical and fixes the DPR-1 case.
                    color: 0xc9a8ff, size: 0.06 * (1.8 / renderer.getPixelRatio()),
                    transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false
                })));
                scene.add(points);

                // Simple wireframe "connecting lines" — two nested icosahedrons, slowly rotating.
                const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(4.6, 1),
                    new THREE.MeshBasicMaterial({ color: 0x8b5cf6, wireframe: true, transparent: true, opacity: 0.28 }));
                const core  = new THREE.Mesh(new THREE.IcosahedronGeometry(2.8, 1),
                    new THREE.MeshBasicMaterial({ color: 0xd8b4fe, wireframe: true, transparent: true, opacity: 0.16 }));
                scene.add(shell, core);

                let mx = 0, my = 0;
                window.addEventListener('pointermove', (e) => {
                    mx = (e.clientX / window.innerWidth) - 0.5;
                    my = (e.clientY / window.innerHeight) - 0.5;
                }, { passive: true });

                // ── ?cwarp=shader — post-process ripple ─────────────────────────────────────────
                // The homepage's ripple term, and only that term: its scroll-velocity barrel warp and
                // chromatic split are driven by a scrolling 3D scene this page does not have.
                //
                // The critical difference from the homepage version is the last line. The homepage
                // writes vec4(colour, 1.0) because it renders an opaque scene. Doing that here would
                // make this transparent background canvas fully OPAQUE and paint black over the
                // page's own backdrop. Alpha is sampled and passed through instead.
                let composer = null;
                if (CWARP_SHADER) try {
                    const base = 'https://unpkg.com/three@0.160.0/examples/jsm/postprocessing/';
                    // Its OWN try/catch, not the outer one. These are three extra CDN modules, and
                    // now that the effect is on by default a hiccup fetching any of them would
                    // otherwise reject into the outer catch and take the ENTIRE 3D background down —
                    // losing the plain scene that worked perfectly well before this existed. A
                    // failure here must cost the ripple and nothing else.
                    const [{ EffectComposer }, { RenderPass }, { ShaderPass }] = await Promise.all([
                        import(base + 'EffectComposer.js'),
                        import(base + 'RenderPass.js'),
                        import(base + 'ShaderPass.js'),
                    ]);
                    renderer.setClearAlpha(0);
                    composer = new EffectComposer(renderer);
                    composer.setPixelRatio(1);   // the composer target already holds device pixels
                    composer.setSize(window.innerWidth, window.innerHeight);
                    composer.addPass(new RenderPass(scene, camera));
                    const ripple = new ShaderPass({
                        uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uMouse: { value: new THREE.Vector2(0.5, 0.5) } },
                        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
                        fragmentShader: [
                            'uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uMouse; varying vec2 vUv;',
                            'void main(){',
                            '  vec2 uv = vUv;',
                            '  float d = distance(uv, uMouse);',
                            '  float ripple = sin(d * 30.0 - uTime * 4.0) * exp(-d * 6.0) * 0.04;',
                            '  uv += normalize(uv - uMouse + 1e-6) * ripple;',
                            '  vec4 c = texture2D(tDiffuse, uv);',
                            '  gl_FragColor = c;',   // alpha preserved — see the note above
                            '}'
                        ].join('\n')
                    });
                    ripple.renderToScreen = true;
                    composer.addPass(ripple);
                    window.__cwarpRipple = ripple;
                } catch (err) {
                    // Ripple unavailable — fall back to the plain scene rather than losing it.
                    composer = null;
                }

                // ── ?cwarp=particles — world-space black hole ───────────────────────────────────
                // Moves the dust itself rather than the pixels: each mote is pulled toward the cursor
                // and swirled around it, with a gaussian falloff so the disturbance is local. Reads
                // clearly on a sparse scene, where a UV ripple has almost nothing to bend.
                const basePos = CWARP_PARTICLES ? Float32Array.from(pos) : null;
                const cursorWorld = new THREE.Vector3();
                const HOLE_R = 7.0;    // radius of influence, world units
                const HOLE_PULL = 0.42; // how far a mote is dragged toward the centre at full strength
                const HOLE_SWIRL = 0.5; // tangential component — what makes it a vortex, not a magnet
                function updateHole() {
                    // Cursor -> the z = 0 plane the dust is centred on.
                    cursorWorld.set(mx * 2, -my * 2, 0.5).unproject(camera).sub(camera.position).normalize();
                    const tz = camera.position.z !== 0 ? -camera.position.z / cursorWorld.z : 0;
                    cursorWorld.multiplyScalar(tz).add(camera.position);

                    const arr = points.geometry.attributes.position.array;
                    for (let i = 0; i < COUNT; i++) {
                        const i3 = i * 3;
                        const dx = basePos[i3] - cursorWorld.x, dy = basePos[i3 + 1] - cursorWorld.y;
                        const f = Math.exp(-(dx * dx + dy * dy) / (HOLE_R * HOLE_R));
                        arr[i3]     = basePos[i3]     - dx * HOLE_PULL * f - dy * HOLE_SWIRL * f;
                        arr[i3 + 1] = basePos[i3 + 1] - dy * HOLE_PULL * f + dx * HOLE_SWIRL * f;
                    }
                    points.geometry.attributes.position.needsUpdate = true;
                }
                // Read-only diagnostic, flag-gated so it costs nothing normally. A vortex that
                // silently moves nothing looks identical to one that is merely subtle, and only a
                // count can tell those apart. Same idea as __wtQuality on the two WebGL pages.
                if (CWARP_PARTICLES) window.__cwarpProbe = function () {
                    const a = points.geometry.attributes.position.array;
                    let moved = 0, maxD = 0;
                    for (let i = 0; i < COUNT; i++) {
                        const i3 = i * 3;
                        const d = Math.hypot(a[i3] - basePos[i3], a[i3 + 1] - basePos[i3 + 1]);
                        if (d > 0.01) moved++;
                        if (d > maxD) maxD = d;
                    }
                    return moved + '/' + COUNT + ' motes moved, max ' + maxD.toFixed(2) + 'u';
                };
                window.addEventListener('resize', () => {
                    camera.aspect = window.innerWidth / window.innerHeight;
                    camera.updateProjectionMatrix();
                    renderer.setSize(window.innerWidth, window.innerHeight);
                    if (composer) composer.setSize(window.innerWidth, window.innerHeight);
                });

                renderer.setAnimationLoop((t) => {
                    const e = t * 0.001;
                    shell.rotation.y = e * 0.12; shell.rotation.x = e * 0.05;
                    core.rotation.y = -e * 0.18; core.rotation.z = e * 0.08;
                    points.rotation.y = e * 0.02;
                    if (!reduce) {
                        camera.position.x += (mx * 3 - camera.position.x) * 0.04;
                        camera.position.y += (-my * 2 - camera.position.y) * 0.04;
                    }
                    camera.lookAt(0, 0, 0);
                    // Both variants respect prefers-reduced-motion: a cursor-chasing distortion is
                    // exactly the kind of motion that setting exists to suppress.
                    if (CWARP_PARTICLES && !reduce) updateHole();
                    if (composer) {
                        window.__cwarpRipple.uniforms.uTime.value = e;
                        // Screen UV origin is bottom-left; my is measured from the top.
                        window.__cwarpRipple.uniforms.uMouse.value.set(mx + 0.5, 0.5 - my);
                        composer.render();
                    } else {
                        renderer.render(scene, camera);
                    }
                });

                // Release the GL context on navigate-away so repeated visits don't exhaust the browser's limit.
                window.addEventListener('pagehide', () => {
                    try { renderer.setAnimationLoop(null); renderer.forceContextLoss(); renderer.dispose(); } catch (e) {}
                }, { once: true });
            } catch (e) { /* 3D is purely decorative — page works without it */ }
        })();
    