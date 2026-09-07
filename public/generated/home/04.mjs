
        import * as THREE from 'three';
        import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
        import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
        import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
        import { ShaderPass }      from 'three/addons/postprocessing/ShaderPass.js';
        import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
        import { buildWordmarkShapes, WORDMARK_SIZE } from '/brand/wordmark.js';

        // ==========================================
        // DATA MODELS
        // ==========================================
        const modalData = {
            services: [
                { title:"Web Design & Development", category:"Service 01", desc:"High-performance websites built for speed, conversion, and scale. From custom front-end builds to full-stack platforms, we engineer digital experiences that drive measurable business results." },
                { title:"Marketing & Strategy", category:"Service 02", desc:"Data-driven marketing campaigns designed to amplify your reach. From SEO to full-scale paid acquisition, we position your brand exactly where your audience lives." },
                { title:"AI Automations",       category:"Service 03", desc:"AI-powered automation that cuts manual work and scales your operations — smart workflows, intelligent chatbots, lead-routing agents, and automated marketing that runs while you sleep." },
                { title:"UI & UX Design",       category:"Service 04", desc:"We craft intuitive, user-centric interfaces that not only look breathtaking but are meticulously engineered to guide user behavior and increase conversion rates seamlessly." }
            ],
            projects: [
                {
                    title:"Multi-Million Dollar Impact", category:"Revenue & Growth",
                    desc:"We design and execute growth systems that drive scalable revenue across multiple industries. A system built for scale, not short-term results.",
                    img:"/Assets/Multi-Million%20Dirham%20Impact.jpg", video:null,
                    results:["Multi-million dollar revenue generated across clients","Built full digital ecosystems (web, branding, marketing)","Created conversion-focused user journeys","Consistent growth across fashion, tech & events sectors","Long-term scalable systems, not one-time wins"]
                },
                {
                    title:"Scaling Fashion Brands", category:"Fashion & E-Commerce",
                    desc:"From concept to market leaders — we elevate fashion brands through strategy, design, and execution. Where creativity meets commercial success.",
                    img:"/Assets/Scaling%20Fashion%20Brands.jpg", video:null,
                    results:["30+ fashion brands successfully launched and scaled","Developed full brand identities and positioning","Designed and built e-commerce platforms","Strong brand presence across Singapore & APAC","Consistent revenue growth through digital channels"]
                },
                {
                    title:"High-Performance Campaigns", category:"Marketing & Performance",
                    desc:"We build campaigns engineered for performance — not just visibility. Performance is engineered, not guessed.",
                    img:"/Assets/High-Performance%20Campaigns.jpg", video:null,
                    results:["Designed multi-platform marketing campaigns","Created high-converting creatives and funnels","Strong engagement and conversion rates","Scalable campaign structures","Reliable, repeatable growth systems"]
                },
                {
                    title:"Elite Events & Experiences", category:"Events & Activations",
                    desc:"We create high-end events that connect brands with influential audiences. Experiences that position brands at the highest level.",
                    img:"/Assets/Elite%20Events%20%26%20Experiences.jpg", video:null,
                    results:["Events attended by VIPs, ministers, and key decision-makers","Designed and executed premium event experiences","Managed brand presence and storytelling","Strong brand visibility and positioning","International reach across multiple locations"]
                },
                {
                    title:"Strategic Tech Partnerships", category:"Technology & Innovation",
                    desc:"We collaborate with advanced technology providers to deliver innovative solutions. Innovation through strategic collaboration.",
                    img:"/Assets/Strategic%20Tech%20Partnerships.jpg", video:null,
                    results:["Partnered with leading tech and innovation companies","Delivered immersive and digital-first experiences","Exposure to high-level and strategic networks","Implementation of advanced tech solutions","Expansion across Singapore, Qatar, and Oman"]
                },
                {
                    title:"100+ Websites Delivered", category:"Web Development",
                    desc:"We design and develop websites built for performance, scalability, and conversion. Built to perform. Designed to scale.",
                    img:"/Assets/100%2B%20Websites%20Delivered.jpg", video:null,
                    results:["Built 100+ websites across multiple industries","Focused on UX, speed, and mobile optimization","Strong user engagement and conversion rates","Reliable and scalable digital platforms","Websites that support long-term growth"]
                },
                {
                    title:"Full Creative Ecosystem", category:"Creative & Content",
                    desc:"We deliver end-to-end creative solutions across branding, content, and marketing. Creative execution at scale.",
                    img:"/Assets/Full%20Creative%20Ecosystem.jpg", video:null,
                    results:["Produced 1000+ social media designs","Created 100+ video assets","Developed full branding and campaign systems","Consistent brand presence across platforms","Integrated creative strategies across all channels"]
                }
            ]
        };

        // Asset manifest for Three.js tunnel
        // Video projects use a static poster image for the 3D tunnel cards
        // to avoid double-decoding (the HTML project cards already decode on hover).
        // This frees the GPU video decoder for the HTML videos to play smoothly.
        const projectAssets = [
            { type:'image', src:'/Assets/Multi-Million%20Dirham%20Impact.jpg' },
            { type:'image', src:'/Assets/Scaling%20Fashion%20Brands.jpg' },
            { type:'image', src:'/Assets/High-Performance%20Campaigns.jpg' },
            { type:'image', src:'/Assets/Elite%20Events%20%26%20Experiences.jpg' },
            { type:'image', src:'/Assets/Strategic%20Tech%20Partnerships.jpg' },
            { type:'image', src:'/Assets/100%2B%20Websites%20Delivered.jpg' },
            { type:'image', src:'/Assets/Full%20Creative%20Ecosystem.jpg' },
        ];

        let isModalOpen = false;
        window.setHoveredProject = (i) => { window.hoveredProjectIndex = i; };

        window.openModal = (type, index) => {
            if (!modalData[type] || !modalData[type][index]) return;
            const data = modalData[type][index];

            // Services still use old modal
            if (type === 'services') {
                isModalOpen = true;
                // Same lock as openDrawer — modal-open alone only sets body overflow, and this page
                // scrolls on <html> with Lenis driving it.
                document.documentElement.style.overflowY = 'hidden';
                if (window.__lenis) window.__lenis.stop();
                document.body.classList.add('modal-open');
                const modalImg = document.getElementById('modal-img');
                const modalVid = document.getElementById('modal-video');
                const mediaCont  = document.querySelector('.modal-media');
                const contentEl  = document.querySelector('.modal-content');
                document.getElementById('modal-kicker').innerText = data.category;
                document.getElementById('modal-title').innerText  = data.title;
                document.getElementById('modal-desc').innerText   = data.desc;
                let resultsEl = document.getElementById('modal-results');
                if (!resultsEl) {
                    resultsEl = document.createElement('ul');
                    resultsEl.id = 'modal-results';
                    resultsEl.className = 'modal-results';
                    document.getElementById('modal-desc').after(resultsEl);
                }
                resultsEl.innerHTML = '';
                resultsEl.style.display = 'none';
                modalImg.style.display = 'none';
                modalVid.style.display = 'none';
                modalVid.pause(); modalVid.src = '';
                mediaCont.style.display = 'none';
                contentEl.style.gridTemplateColumns = '1fr';
                document.getElementById('detail-modal').classList.add('active');
                document.getElementById('navbar').classList.add('hidden');
                return;
            }

            // Projects use the drawer
            const mediaEl = document.getElementById('drawer-media');
            mediaEl.innerHTML = '';
            if (data.video) {
                const v = document.createElement('video');
                v.muted = true; v.loop = true; v.playsInline = true;
                v.setAttribute('disablepictureinpicture', '');
                v.setAttribute('controlslist', 'nodownload nofullscreen noremoteplayback');
                v.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
                mediaEl.appendChild(v);
                v.src = data.video;
                v.load();
                v.play().catch(()=>{});
            } else if (data.img) {
                const img = document.createElement('img');
                img.src = data.img; img.alt = data.title; img.loading = 'lazy';
                mediaEl.appendChild(img);
            }

            document.getElementById('drawer-kicker').innerText = data.category;
            document.getElementById('drawer-title').innerText  = data.title;
            document.getElementById('drawer-desc').innerText   = data.desc;
            const resultsEl = document.getElementById('drawer-results');
            resultsEl.innerHTML = (data.results || []).map(r => `<li>${r}</li>`).join('');
            document.getElementById('drawer-tag').innerText = `${data.category} · KIASA`;
            document.getElementById('drawer-num').innerText = String(index + 1).padStart(2, '0');

            document.getElementById('case-drawer').classList.add('open');
            document.getElementById('drawer-backdrop').classList.add('open');
            // body.modal-open sets `overflow:hidden` on BODY, but this page scrolls on <html>, so it
            // locked nothing — and Lenis kept running its own rAF regardless. The page scrolled
            // freely behind an open modal on desktop. Lock the real container and stop Lenis, the
            // same way the mobile menu already does.
            document.documentElement.style.overflowY = 'hidden';
            if (window.__lenis) window.__lenis.stop();
            document.body.classList.add('modal-open');
            isModalOpen = true;
        };

        window.closeDrawer = () => {
            document.getElementById('case-drawer').classList.remove('open');
            document.getElementById('drawer-backdrop').classList.remove('open');
            document.documentElement.style.overflowY = '';
            if (window.__lenis) window.__lenis.start();
            document.body.classList.remove('modal-open');
            isModalOpen = false;
            // Stop any video inside drawer
            const v = document.querySelector('#drawer-media video');
            if (v) { v.pause(); v.src = ''; }
        };

        window.closeModal = () => {
            isModalOpen = false;
            document.documentElement.style.overflowY = '';
            if (window.__lenis) window.__lenis.start();
            document.body.classList.remove('modal-open');
            document.getElementById('detail-modal').classList.remove('active');
            document.getElementById('navbar').classList.remove('hidden');
            const v = document.getElementById('modal-video');
            v.pause();
            setTimeout(() => { v.src = ''; }, 500);
        };

        // Cyber Text Decoder
        const chars = "01X><-/\\*+~_#";
        window.decodeText = function(el) {
            if (el.dataset.decoded === "true") return;
            el.dataset.decoded = "true";
            const orig = el.dataset.text;
            if (!orig) return;
            // Honour prefers-reduced-motion. The CSS block neutralises every other animation on the
            // page, but this one is written frame-by-frame in JS and was exempt — so a visitor who
            // has asked the OS to reduce motion still watched every heading scramble through random
            // glyphs. Show the final text immediately instead.
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                el.textContent = orig;
                return;
            }
            // textContent, not innerText, in every write below. The values here are single-line
            // strings so the resulting DOM is identical, but the innerText setter is specified to
            // handle line breaks and so does markedly more work — and this runs on a 30ms interval
            // per heading, alongside the stats count-up which wrote once per animation frame.
            let it = 0;
            const iv = setInterval(() => {
                el.textContent = orig.split("").map((c, i) => {
                    if (c === " ") return " ";
                    if (i < it) return orig[i];
                    return chars[Math.floor(Math.random() * chars.length)];
                }).join("");
                if (it >= orig.length) clearInterval(iv);
                it += 1/3;
            }, 30);
        };

        // ==========================================
        // GLSL SHADERS
        // ==========================================
        const liquidShader = {
            // uWarp scales the ripple only. It is 1.0 on desktop and never written there, so the
            // desktop image is unchanged bit for bit; the mobile touch-follow uses it to duck the
            // effect where it would sit on a large heading.
            uniforms: { tDiffuse:{value:null}, uTime:{value:0}, uScrollVelocity:{value:0}, uMouse:{value:new THREE.Vector2(0.5,0.5)}, uWarp:{value:1} },
            vertexShader:   `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
            fragmentShader: `
                uniform sampler2D tDiffuse; uniform float uTime; uniform float uScrollVelocity; uniform vec2 uMouse; uniform float uWarp; varying vec2 vUv;
                void main() {
                    vec2 uv = vUv;
                    float d = distance(uv, uMouse);
                    float ripple = sin(d * 30.0 - uTime * 4.0) * exp(-d * 6.0) * 0.04 * uWarp;
                    uv += normalize(uv - uMouse) * ripple;
                    vec2 dd = uv - 0.5; float r = dot(dd, dd);
                    uv += dd * r * (uScrollVelocity * 0.003);
                    float shift = abs(uScrollVelocity) * 0.0005;
                    // Three fetches only while the chromatic split is wide enough to show. This is the
                    // last pass in the chain, so it runs once per output pixel (3.0M on a DPR-3 phone)
                    // and it took three samples on every frame of the page's life, including the usual
                    // case of nobody scrolling. The branch is on a UNIFORM, so it is dynamically
                    // uniform — one path per draw, no divergence cost. Same trick as the uHover guard
                    // on the gallery's scan filament. (No backticks in here: this GLSL sits inside a
                    // JS template literal and one would end the string.)
                    // uScrollVelocity decays 10%/frame toward 0 and never reaches it, so a threshold
                    // is required. At 5e-5 the widest split it can hide is 0.14px at 2880px wide.
                    if (shift > 0.00005) {
                        float cr = texture2D(tDiffuse, uv + vec2(shift, 0.0)).r;
                        float cg = texture2D(tDiffuse, uv).g;
                        float cb = texture2D(tDiffuse, uv - vec2(shift, 0.0)).b;
                        gl_FragColor = vec4(cr, cg, cb, 1.0);
                    } else {
                        gl_FragColor = vec4(texture2D(tDiffuse, uv).rgb, 1.0);
                    }
                }
            `
        };

        const imageShader = {
            uniforms: { tDiffuse:{value:null}, uHover:{value:0.0}, uTime:{value:0.0}, uOpacity:{value:1.0} },
            vertexShader:   `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
            fragmentShader: `
                uniform sampler2D tDiffuse; uniform float uHover; uniform float uTime; uniform float uOpacity; varying vec2 vUv;
                void main() {
                    // uHover is 0 for every card but the one under the pointer, and 0 for all of them
                    // on mobile (animate() skips the hover branch there). At 0 the wave is exactly 0,
                    // so the three fetches sampled the identical texel and the red and blue reads were
                    // waste — on six of seven cards on desktop, all seven on every phone. Branching on
                    // the uniform is free (one path per draw); same pattern as the gallery hover scan.
                    if (uHover > 0.001) {
                        float wave = sin(vUv.y * 10.0 + uTime * 3.0) * 0.03 * uHover;
                        float r = texture2D(tDiffuse, vUv + vec2(wave, 0.0)).r;
                        float g = texture2D(tDiffuse, vUv).g;
                        float b = texture2D(tDiffuse, vUv - vec2(wave, 0.0)).b;
                        gl_FragColor = vec4(r, g, b, uOpacity);
                    } else {
                        gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, uOpacity);
                    }
                }
            `
        };

        const trailShader = {
            vertexShader: `
                attribute float aLife; varying float vLife;
                void main() {
                    vLife = aLife;
                    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                    gl_Position  = projectionMatrix * mvPos;
                    gl_PointSize = (40.0 / -mvPos.z) * aLife;
                }
            `,
            fragmentShader: `
                varying float vLife;
                void main() {
                    float d = distance(gl_PointCoord, vec2(0.5));
                    if (d > 0.5) discard;
                    vec3 col = mix(vec3(0.85, 0.7, 1.0), vec3(1.0, 1.0, 1.0), vLife);
                    gl_FragColor = vec4(col, vLife * 0.8);
                }
            `
        };

        // ==========================================
        // THREE.JS CORE ENGINE
        // ==========================================
        let scene, camera, renderer, composer, masterPass, bloomPass;
        let logoGroup, ringMesh;
        let particles, bokehParticles, glassOrbs = [], projectCards = [], uniformsMap = [];
        let _buildEnvMap = null;   // re-bakes the PMREM environment; needed again after a context restore
        // Keep the composer's targets exactly the size of the drawing buffer, and bloom at half the
        // CSS size. Using setPixelRatio(renderer.getPixelRatio()) instead looks natural but feeds
        // FRACTIONAL sizes to the targets as soon as the adaptive governor picks a tier (2 * 0.85),
        // because EffectComposer multiplies without rounding and WebGL then truncates — the
        // composer's idea of the buffer and the renderer's drift apart by a pixel. Pinning the ratio
        // at 1 and passing the already-integer drawing-buffer size keeps them exact.
        // Bloom stays in CSS units deliberately: its blur kernel is measured in texels, so tying its
        // resolution to DPR would change the apparent width of the glow from device to device.
        const _dbSize = new THREE.Vector2();   // scratch: _syncComposerSize runs on every governor tier change

        // ── Quality-tier STATE lives here, above _syncComposerSize ────────────────────────────────
        // That function reads _qLevel and _qSamples, and it is called from init() during composer
        // construction. Declaring the state further down with the governor left it in the temporal
        // dead zone; `typeof` on an uninitialised const THROWS rather than returning 'undefined', so
        // the guard that used to be here would not have caught it. Only call ordering was keeping it
        // safe, which is not worth depending on.
        const _qTiers   = [1.0, 0.85, 0.7, 0.55, 0.42];
        const _qBloom   = [0.50, 0.50, 0.45, 0.40, 0.35];
        const _qSamples = [4,    4,    4,    2,    2   ];
        let _qLevel = 0, _qGood = 0, _fpsT0 = 0, _fpsFrames = 0;
        let _bloomScale = _qBloom[0];
        function _syncComposerSize() {
            if (!composer || !renderer) return;
            const s = renderer.getDrawingBufferSize(_dbSize);
            // Sample count first, so the reallocation composer.setSize() is about to do anyway also
            // picks up the new count instead of costing a second one. WebGLRenderTarget.setSize()
            // disposes itself when the dimensions change, which is what makes the new `samples` take
            // effect; when the dimensions happen to be unchanged we dispose explicitly.
            const wantSamples = _qSamples[_qLevel];
            const rt1 = composer.renderTarget1, rt2 = composer.renderTarget2;
            if (rt1 && rt1.samples !== wantSamples) {
                const sameSize = (rt1.width === s.width && rt1.height === s.height);
                rt1.samples = wantSamples; if (rt2) rt2.samples = wantSamples;
                if (sameSize) { rt1.dispose(); if (rt2) rt2.dispose(); }
            }
            composer.setPixelRatio(1);
            composer.setSize(s.width, s.height);
            // Bloom stays measured in CSS pixels, NOT device pixels — deliberate, because its blur
            // kernel is counted in texels, so tying it to DPR would change the apparent width of the
            // glow from device to device.
            //
            // But it must still shrink with the quality tier, and it did not. That is why descending
            // stopped helping: the scene shrank while the five-level bloom ladder stayed the same size
            // and got blurred twice per level per frame regardless. At 1080p the ladder is a fixed
            // 480x270 plus four mips at every tier — about a quarter of the scene's fragment work at
            // tier 0, and a *larger* share than the scene itself by tier 4. So the governor kept
            // trading away sharpness for a saving that was capped at roughly half the frame.
            if (typeof bloomPass !== 'undefined' && bloomPass) {
                bloomPass.setSize(window.innerWidth * _bloomScale, window.innerHeight * _bloomScale);
            }
        }

        // ── Device pixel ratio: a ceiling AND a total-pixel budget ────────────────────────────────
        // The ceilings (3 on phones, 2 elsewhere) are unchanged and deliberate. What they do not
        // bound is the absolute pixel count, and this page pays for every pixel five times over: two
        // full-resolution HalfFloat ping-pong targets, a third that three.js allocates for the
        // transmission pass and mip-generates every frame (40 materials here have transmission > 0),
        // and a 4x MSAA colour+depth renderbuffer pair behind each composer target.
        //
        // A phone is fine — 393x852 at DPR 3 is 3.0M pixels. A 16" MacBook is 1728x1117 at DPR 2 =
        // 7.7M, and a 5K iMac 2560x1440 at DPR 2 = 14.7M, which cannot hold 60fps here. The adaptive
        // governor did rescue those machines eventually, but only after seconds of stutter and at a
        // far coarser tier (down to 0.42) than this. Bounding up front is faster AND sharper.
        //
        // 6.0M is a no-op on every common device: phones, tablets, 13"/14" retina laptops and any
        // DPR-1 monitor up to 3440x1440 keep their full ceiling. Only the outliers scale down.
        const _MAX_DRAWING_PIXELS = 6.0e6;
        function _targetDpr() {
            const ceiling = window.innerWidth < 1024 ? 3 : 2;
            const dpr = Math.min(window.devicePixelRatio || 1, ceiling);
            const px = window.innerWidth * window.innerHeight * dpr * dpr;
            if (px <= _MAX_DRAWING_PIXELS) return dpr;
            // Never fall below 1: a sub-1 buffer is a visible softening, and the governor owns that
            // decision from real frame timings rather than from a static guess.
            return Math.max(1, Math.min(dpr, Math.sqrt(_MAX_DRAWING_PIXELS / (window.innerWidth * window.innerHeight))));
        }
        let trailGeo, trailPos, trailVel, trailLife, trailIndex = 0, trailPoints;
        const MAX_TRAIL = window.innerWidth < 1024 ? 40 : 150;
        let constellationLines = null;
        let glassShards = [];
        let helixStrand = null;
        let orbitLights = [];
        let wireSphere = null;
        let portalRings = [];
        let particleVelocities = null; let particleBasePositions = null;
        let clickChromaDecay = 0;
        let mirrorFloor = null;
        let dustMotes = null;
        let wPulseTimer = 0;
        let audioConnected = false;
        let sceneColorProgress = 0;
        let cameraShakeX = 0, cameraShakeY = 0;
        const globalProgressBar = document.getElementById('global-progress');

        let currentScrollY = 0, scrollVelocity = 0, lastScrollY = 0;
        const workWrapper = document.getElementById('work-wrapper');
        const workTrack   = document.getElementById('work-track');
        let _trackMaxX = 0, _workTx = 0, _workTicking = false;
        function _cacheTrackWidth() { _trackMaxX = workTrack.scrollWidth - window.innerWidth; }
        window.addEventListener('load', _cacheTrackWidth, { once: true });
        window.addEventListener('resize', _cacheTrackWidth, { passive: true });

        let mouse = new THREE.Vector2(0.5, 0.5), mouseParallax = new THREE.Vector2(0, 0);
        let mouseVelocity = 0, lastMouseX = 0, lastMouseY = 0;
        window.hoveredProjectIndex = -1;
        const TUNNEL_DEPTH = 600;

        function init() {
            const progressEl = document.getElementById('loader-progress');
            const barEl      = document.getElementById('loader-bar');

            // Real asset loading tracker.
            // The reel video is NOT counted here any more. It used to be (`+ 1`), so the preloader —
            // and with it the whole hero reveal — waited on a 2MB mp4 belonging to a section five
            // screens down. And `preload` does not reliably reach readyState 2, so `canplay` often
            // never fired and only the 8-second fallback timer finished the count: measured cold, the
            // counter sat pinned near 95% and the preloader held the page for ~14s. The 3D scene needs
            // these seven textures and nothing else.
            const totalAssets = projectAssets.length;
            let assetsLoaded = 0;
            let displayPct = 0;
            let loadingDone = false;

            function onAssetLoad() {
                assetsLoaded++;
                if (assetsLoaded >= totalAssets && !loadingDone) {
                    loadingDone = true;
                }
            }

            // Smooth counter animation — chases the real percentage
            const loadInterval = setInterval(() => {
                const realPct = Math.round((assetsLoaded / totalAssets) * 100);
                const target = loadingDone ? 100 : Math.min(realPct, 95);
                if (displayPct < target) {
                    displayPct += Math.max(1, Math.floor((target - displayPct) * 0.15));
                    if (displayPct > target) displayPct = target;
                }
                progressEl.textContent = displayPct + '%';
                barEl.style.width = displayPct + '%';
                if (displayPct >= 100) {
                    clearInterval(loadInterval);
                    window._heroReady = true;   // module loaded + hero ready → CDN safety net stands down
                    document.getElementById('preloader').style.opacity = '0';
                    setTimeout(() => {
                        document.getElementById('preloader').style.visibility = 'hidden';
                        document.getElementById('hero').querySelectorAll('.fade-up, .decode-text, .hero-center-label').forEach(el => {
                            el.classList.add('in-view');
                            if (el.classList.contains('decode-text')) decodeText(el);
                        });
                        // The hero has had its entrance; everything below may now reveal on approach,
                        // and the reel may start buffering now that the critical path is clear.
                        // This is also where the adaptive governor starts paying attention — see
                        // _adaptiveArm. Before this point every frame is boot cost (texture uploads,
                        // PMREM, twenty-two shader links, first target allocation) and judging the
                        // device on those is what used to slam it to the bottom tier.
                        _adaptiveArm(performance.now());
                        _revealsArmed = true;
                        if (_revealPending) _revealPending = _revealPending.filter(el => !el.classList.contains('in-view'));
                        if (_armReelWarm) _armReelWarm();
                    }, 500);
                }
            }, 40);

            // Load tunnel card textures with tracking.
            // crossOrigin = null is load-bearing, not tidying. THREE.Loader defaults it to
            // 'anonymous', which makes ImageLoader issue a CORS-mode request — and a CORS-mode request
            // has a DIFFERENT HTTP cache key from the plain request the CSS background-image on these
            // same seven .h-project cards already made. Measured over the wire, every one of these
            // files was downloaded twice (393ms as CSS, 591ms again as TextureLoader, neither cached):
            // 592KB of pure duplication. They are same-origin, so CORS buys nothing here — a
            // same-origin texture is never tainted — and dropping it reuses the CSS fetch.
            const texLoader = new THREE.TextureLoader();
            texLoader.crossOrigin = null;
            projectAssets.forEach((asset, i) => {
                texLoader.load(asset.src, (tex) => {
                    if (uniformsMap[i]) uniformsMap[i].tDiffuse.value = tex;
                    onAssetLoad();
                }, undefined, () => onAssetLoad()); // count errors too so loader doesn't stall
            });

            // Safety net for the counter itself: if a texture request neither completes nor errors
            // (a proxy that hangs the socket rather than failing it), finish the bar anyway rather
            // than leaving the preloader up forever. The CDN net in <head> covers a failed module
            // import; this covers a stalled image.
            setTimeout(() => { if (!loadingDone) { assetsLoaded = totalAssets; onAssetLoad(); } }, 8000);

            const isMobile = window.innerWidth < 1024;

            scene = new THREE.Scene();
            scene.fog = new THREE.FogExp2('#020204', 0.012);
            camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 1000);
            camera.position.z = 20;
            renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('webgl-canvas'), antialias: false, powerPreference:"high-performance" });
            renderer.setSize(window.innerWidth, window.innerHeight);
            // DPR: 3 on phones, 2 on desktop — matched to Gallery.html. A flagship phone renders this
            // natively rather than upscaling a DPR-2 buffer, which is what read as soft.
            // Both ceilings now live in _targetDpr(), together with the total-pixel budget that keeps
            // a 5K desktop from allocating three 14.7-megapixel HalfFloat targets. This call and
            // _baseDpr below MUST come from the same function — CLAUDE.md flags them drifting apart
            // as a live hazard, because _baseDpr is what the governor's tiers multiply.
            // Goes through _applyQuality(), not setPixelRatio(_targetDpr()) directly. At the default
            // tier 0 the two are identical — _effectiveDpr() is max(1, _baseDpr * 1.0) — but ?qtier=N
            // is parsed during module evaluation, which happens BEFORE this function runs and before
            // `renderer` exists, so the forced tier can only be applied from here. Measured: without
            // this, ?qtier=3 set _qLevel to 3 and left the canvas at tier 0's 2866px.
            // _syncComposerSize() inside it no-ops while the composer is still null, and composer
            // construction below calls it again anyway.
            _applyQuality();   // tier 0 unless ?qtier= forced one; _applyQuality() owns the ratio from here
            // Colour management. This page had NONE of it, which is the single biggest reason it read
            // flat next to the gallery: with the default NoToneMapping, every value above 1.0 clips
            // straight to white, so bright emissive and specular highlights land as dead flat patches
            // and lose their colour on the way. ACES rolls those highlights off instead of severing
            // them, which is what gives the gallery its depth.
            //
            // CORRECTION, from a later audit: on this page these three lines are INERT, and so are
            // the equivalent lines in Gallery.html. three.js applies toneMapping and the sRGB encode
            // only when a material renders directly to the canvas; every material here renders into
            // the EffectComposer's target, where r160 forces NoToneMapping, and the final ShaderPass
            // blits that buffer out with a hand-written shader that includes no conversion. Making
            // them live would need an OutputPass appended to the chain.
            //
            // They are kept, unchanged, deliberately. The look that was measured and shipped — mean
            // luminance held, saturation up, clipped pixels down — is the UN-tone-mapped one, and it
            // came from the lighting and material work below, not from here. Adding an OutputPass now
            // would re-grade a page that was tuned in this space and is known to look right. Left as
            // the declared intent for whenever the chain does gain an OutputPass; do not "fix" this
            // in isolation, because it will visibly re-grade the whole page the moment it takes.
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            renderer.toneMapping = THREE.ACESFilmicToneMapping;
            renderer.toneMappingExposure = 0.95;
            // Stand the CDN safety net down HERE, the moment the module has run and a WebGL context
            // exists. It used to be set only once the preloader counter reached 100%, which requires
            // every project texture to have finished loading — so the net could not tell "the three.js
            // import failed" (what it is for) from "one image is slow on a bad connection". On a weak
            // connection the second case hit the 10s timeout and the page threw away a perfectly
            // working 3D hero for the flat lite layout, permanently, with no way back.
            window._heroReady = true;
            // Environment map for glass reflections on all devices
            // Dispose the generator and the throwaway RoomEnvironment once the cubemap is baked —
            // the texture survives disposal, but the generator's ping-pong render targets, blur
            // materials and compiled programs do not need to sit resident for the whole session.
            // Gallery.html already disposes its equivalent; this one was leaking. Kept in a named
            // variable so a context restore can rebuild it (see webglcontextrestored below).
            _buildEnvMap = () => {
                // Release the previous cubemap first. This function is called again after a context
                // restore, and without the dispose the old texture's CPU-side record was orphaned on
                // every restore — a small leak, but one that accumulates on exactly the low-memory
                // mobile devices where context loss happens in the first place.
                const prev = scene.environment;
                const pmrem = new THREE.PMREMGenerator(renderer);
                const roomEnv = new RoomEnvironment();
                scene.environment = pmrem.fromScene(roomEnv, 0.04).texture;
                pmrem.dispose();
                roomEnv.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
                if (prev && prev !== scene.environment) prev.dispose();
            };
            _buildEnvMap();

            // Portrait screens: slight FOV widen to fit scene in narrower viewport
            if (isMobile) {
                camera.fov = 36;
                camera.updateProjectionMatrix();
            }

            // EffectComposer's DEFAULT render target is samples:0, so with post-processing in the
            // path NOTHING on this page was antialiased — the renderer's own antialias flag is
            // discarded the moment the composer owns the frame. Every edge of the 3D logo and the
            // glass geometry was rendering jagged. An explicit MSAA target fixes it; HalfFloat also
            // stops the bloom chain banding in the dark gradients. 4 samples on BOTH now — mobile
            // used to take 2, and the extruded logo's bevels are exactly the thin high-contrast
            // edges that 2x MSAA still leaves crawling. composer.setSize() preserves both.
            const _cSize = renderer.getDrawingBufferSize(new THREE.Vector2());
            composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(_cSize.width, _cSize.height, {
                type: THREE.HalfFloatType, samples: 4
            }));
            composer.addPass(new RenderPass(scene, camera));
            // Bloom runs at HALF resolution. Bloom is a low-frequency glow, so half-res looks identical
            // but cuts the bloom blur-chain fragment work to ~25% (a big scroll-smoothness win at 1440p+).
            // Re-applied on resize / context-restore below, since composer.setSize() resets it to full.
            bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth * 0.5, window.innerHeight * 0.5), 0.5, 0.8, 0.95);
            composer.addPass(bloomPass);
            masterPass = new ShaderPass(liquidShader);
            composer.addPass(masterPass);
            // ...except it did NOT run at half resolution, on any frame, until the first resize.
            //
            // EffectComposer's two-argument constructor reads `_width`/`_height` straight off the
            // render target we hand it — which is in DEVICE pixels, from getDrawingBufferSize() —
            // while separately caching `_pixelRatio`. addPass() then sizes each pass to
            // `_width * _pixelRatio`, multiplying by the DPR a second time and throwing away the
            // half-resolution Vector2 above. Measured on a DPR-2 viewport, the bloom ladder came out
            // 2832x1602 -> 1416x801 -> 708x401 -> 354x201 -> 177x101, against a designed ladder
            // starting at 354x200: 64x the pixels, ~180MB of RGBA16F targets, and five
            // full-resolution separable blur passes every frame. On a DPR-3 phone it is 324x, which
            // is enough on its own to explain a context loss.
            // setPixelRatio + setSize restate the composer in CSS pixels, matching what onResize()
            // and the adaptive governor already pass, so the correct sizing is the boot state.
            _syncComposerSize();

            // A bright white AmbientLight is the most reliable way to make a scene look washed out:
            // it lifts every surface by the same flat amount regardless of which way the surface
            // faces, so nothing is modelled and the logo reads as grey cardboard rather than glass.
            // Cut to a dim violet fill — enough that unlit faces don't crush to black, tinted so the
            // lift carries the brand colour instead of neutral grey — and the loss is put back as
            // directional light, which actually shapes the geometry.
            scene.add(new THREE.AmbientLight(0xb794f6, 0.16));
            const sLight = new THREE.SpotLight(0xffffff, 5.2);
            sLight.position.set(-10, 10, 20); scene.add(sLight);
            const pLight = new THREE.PointLight(0xd8b4fe, 2.4, 100);
            pLight.position.set(5, -5, 10); scene.add(pLight);
            // Rim light from behind-right. Nothing here separated the logo from the black backdrop
            // except the ring passing in front of it; a cool rim catches the bevelled edges and gives
            // the silhouette an edge to read against.
            // Parented to the logo, not to the world. r160 uses physical light falloff by default
            // (useLegacyLights is gone), so intensity is in candela and irradiance falls off with the
            // square of distance: this light pinned at world z=-34 sat ~33 units from a logo whose
            // own position is camera-relative and re-lerped every frame, delivering on the order of
            // 0.002 — nothing at all, against an ambient fill of 0.16. Attaching it to logoGroup
            // keeps the offset constant so the rim actually lands on the bevels, and lets the
            // intensity be a sane value for the ~6-unit distance it now works over.
            const rimLight = new THREE.PointLight(0x9f7aea, 14, 26);
            rimLight.position.set(5.5, 2.5, -4.5);

            buildWLogo();
            logoGroup.add(rimLight);   // must come after buildWLogo — that is where logoGroup is created
            buildProjectCards();
            buildLiquidGlassOrbs();
            buildParticles();
            buildCursorTrail();
            buildGlassShards();
            buildHelixStrand();
            buildOrbitLights();
            buildWireSphere();
            buildPortalRings();
            buildMirrorFloor();
            buildDustMotes();

            // Scroll sources only ever set a flag now; the frame loop drains it exactly once per
            // frame and runs the single batched pass (see triggerReveals). This listener plus the
            // Lenis one below used to call the whole pass directly, which on desktop meant it ran
            // twice per frame.
            window.addEventListener('scroll',    () => {
                currentScrollY = window.scrollY;
                _scrollDirty = true;
                // Only a scroll that has actually left the top arms reveals — a spurious scroll event
                // at offset 0 during loading must not pre-play the hero's entrance behind the preloader.
                if (currentScrollY > 0) _revealsArmed = true;
            }, { passive:true });
            window.addEventListener('resize',    onResize, { passive: true });
            window.addEventListener('orientationchange', onResize, { passive: true });
            window.addEventListener('mousemove', onMouseMove, { passive: true });

            setupDOMInteractions();
            setupSoundToggle();
            setupCrossPageWipe();
            setupBentoStagger();
            setupManifestoReveal();
            setupReelVideoAutoplay();
            setupTextSplitKickers();
            setupLazyBackgrounds();
            setupCardEntrance();
            setupSingaporeClock();
            setupStatsRecount();
            setupCinematicEntry();
            setupRetroFooter();
            setupTypedText();

            if (!isMobile) {
                // The custom cursor exists from here on, so the CSS may hide the system one.
                document.documentElement.classList.add('wt-cursor-ready');
                // Desktop-only: cursor effects, parallax, magnetic buttons, heading gravity
                setupParallax();
                setupCursorLabel();
                setupMagneticButtons();
                setupCardTilt();
                setupHeadingGravity();
                setupCursorMorphing();
                setupUISounds();
                setupCursorTrailGlow();
            }

            // Touch-only
            if (isMobile) {
                setupTouchSwipe();
                setupHapticFeedback();
            }

            // ---- Lenis smooth scroll ----
            // Runs on desktop AND touch now. It is driven from this page's single rAF loop (see
            // _frame), so enabling it on mobile adds no second loop — the old "heavy on mobile"
            // reasoning applied to a version that ran its own.
            //
            // THE WORK TRACK NEEDS NO EXCLUSION, and adding one would be a bug. It looks like a
            // horizontally-swipeable strip, and a stale comment on setupTouchSwipe() still claims it
            // "uses native horizontal scroll-snap" — it does not. #work-wrapper is a 500vh-tall
            // section and the strip is moved by `workTrack.style.transform = translate3d(-x,0,0)`
            // driven by VERTICAL scroll progress. Measured: scrollWidth <= clientWidth and
            // scroll-snap-type: none, i.e. nothing scrolls sideways natively at all.
            //
            // Excluding it from Lenis would therefore protect nothing while making the smoother
            // ignore touch across 500vh of page — an unsmoothed dead zone in the middle of the
            // scroll. Letting Lenis drive it instead smooths the horizontal motion too, because that
            // motion is a function of the vertical position Lenis is easing.
            //
            // data-lenis-prevent is still honoured so a genuinely independently-scrolling element
            // can opt out later without editing this.
            if (typeof Lenis !== 'undefined') {
                const _preventNative = (node) => !!(node && node.closest && node.closest('[data-lenis-prevent]'));
                const lenis = isMobile
                    // Touch profile. syncTouch keeps the page glued to the thumb while dragging and
                    // then eases out, which is what makes it read as cinematic rather than as the
                    // browser's abrupt native momentum. touchInertiaMultiplier is the "don't fly past
                    // half the page on one flick" dial — Lenis defaults to 35, which on a page this
                    // tall throws far too far; the gallery landed on 9 for the same reason.
                    ? new Lenis({
                          syncTouch: true,
                          syncTouchLerp: 0.11,
                          touchInertiaMultiplier: 10,
                          touchMultiplier: 1.0,
                          smoothWheel: false,        // a touch device has no wheel to smooth
                          prevent: _preventNative,
                      })
                    // Wheel/trackpad profile. lerp 0.08 -> 0.065 and wheelMultiplier 0.9 -> 0.75:
                    // a longer glide and slightly less travel per notch, for a more deliberate,
                    // dramatic feel. Deliberately NOT the gallery's 0.26 — that is a corridor walk;
                    // this page has copy to read, and slowing it that far would fight the reading.
                    : new Lenis({ lerp: 0.065, smoothWheel: true, wheelMultiplier: 0.75, prevent: _preventNative });
                window.__lenis = lenis;   // exposed so the mobile menu can pause smooth-scroll while open
                // Only flag; the frame loop runs the batched pass once. This callback fires on EVERY
                // animation frame while a glide is in flight, and it used to call the whole scroll
                // pass directly — on top of the native scroll event Lenis's own scrollTo triggers.
                lenis.on('scroll', ({ scroll }) => {
                    currentScrollY = scroll;
                    _scrollDirty = true;
                    if (scroll > 0) _revealsArmed = true;
                });
                // Lenis's raf() is driven from _frame() below instead of a second rAF loop of its own.
                // Patch anchor links to use lenis scroll
                document.querySelectorAll('a[href^="#"]').forEach(a => {
                    a.addEventListener('click', e => {
                        const target = document.querySelector(a.getAttribute('href'));
                        if (target) { e.preventDefault(); lenis.scrollTo(target, { duration: 1.4 }); }
                    });
                });
            }

            if (__WT_PERF) _perfInit();   // ?perf=1 — on-device diagnostic overlay
            _startLoop();

            // WebGL context loss recovery for mobile
            const cvs = document.getElementById('webgl-canvas');
            // preventDefault asks the browser for a restore; also stop RENDERING, because every frame
            // rendered against a dead context is wasted work that can itself delay the restore. The
            // frame loop itself keeps running — Lenis and the scroll/pointer passes hang off it, and
            // freezing those would leave the page's smooth scroll and reveals dead until the GPU came
            // back rather than just its 3D layer.
            cvs.addEventListener('webglcontextlost', (e) => { e.preventDefault(); _renderEnabled = false; }, false);
            cvs.addEventListener('webglcontextrestored', () => {
                renderer.setSize(window.innerWidth, window.innerHeight);
                _baseDpr = _targetDpr();
                _applyQuality();   // clamped so a restore can never come back below native
                // The environment cubemap lives in GPU memory and does NOT survive context loss.
                // Without this every glass surface — the logo, the orbs, the shards — comes back
                // with no reflections at all, which is the most visible thing on the page.
                if (_buildEnvMap) { try { _buildEnvMap(); } catch (e) {} }
                _renderEnabled = true;
            }, false);

            // ---- Tab visibility ----
            // rAF is already throttled hard in a background tab, but "throttled" is not "stopped":
            // Safari and Firefox keep servicing it at a low rate, and on a laptop that means the
            // whole post-processing chain — two full-resolution HalfFloat targets, a five-level bloom
            // ladder and a transmission pass — keeps being rendered for a tab nobody is looking at.
            // Park the loop outright and restart it on return; also stop the reel's video decoder,
            // which browsers do NOT pause for a hidden tab.
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    _stopLoop();
                    if (_reelVid && !_reelVid.paused) _reelVid.pause();
                } else {
                    // Re-measure and re-read on the way back in: the window may have been resized
                    // or the page scrolled by the browser while we were away.
                    _scrollDirty = true; _hgAt = NaN;
                    if (_reelVid && _reelWantsPlay) _reelVid.play().catch(() => {});
                    // Re-arm the governor. Without this the first tick back computes fps over the
                    // ENTIRE time the tab was hidden — a 10s switch gives (a few frames)/10s ≈ 0.3fps,
                    // which trips `fps < 44` and knocks the quality down on a device that was sitting
                    // idle and fast. Two tab switches used to reach the floor. Parking the loop (which
                    // this handler does, and which is the right thing for battery) made it certain
                    // rather than merely likely, because the frame counter stops advancing entirely.
                    _adaptiveArm(performance.now());
                    // Recorded so ?perf=1 can say the numbers on screen were taken on a page that has
                    // been backgrounded — cold GPU caches and a re-armed governor, so the first few
                    // seconds are not representative. Without the flag that reads as a regression.
                    _qWasRestored = true;
                    // The loop was PARKED, so the next frame's delta spans the whole absence. Zeroing
                    // this makes the panel skip that one delta instead of reporting it as a 119-second
                    // frame, which is what it did.
                    if (_pf) _pf.last = 0;
                    _startLoop();
                }
            });

            // ---- Audio reactive (simulated via sine waves — no Web Audio API needed) ----
            // The audio element plays independently; visuals animate with smooth sine oscillations
            audioConnected = true; // flag used by animate() to enable reactive block

            // ---- Constellation lines ----
            if (window.innerWidth >= 1024) {
                const maxLines = 80;
                const lineGeo  = new THREE.BufferGeometry();
                const linePos  = new Float32Array(maxLines * 2 * 3);
                lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
                lineGeo.setDrawRange(0, 0);
                constellationLines = new THREE.LineSegments(lineGeo,
                    new THREE.LineBasicMaterial({ color: 0xd8b4fe, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false })
                );
                scene.add(constellationLines);
            }

            // ---- Global scroll progress ---- now written by the batched scroll pass, which reuses
            // the cached _maxScroll instead of reading documentElement.scrollHeight (a forced layout)
            // on every scroll event.

            // ---- Section re-scramble on re-entry ----
            const rescrambleIO = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting && entry.target.dataset.decoded === 'true') {
                        entry.target.dataset.decoded = 'false';
                        entry.target.classList.remove('in-view');
                        setTimeout(() => {
                            entry.target.classList.add('in-view');
                            decodeText(entry.target);
                        }, 100);
                    }
                });
            }, { threshold: 0.5 });
            document.querySelectorAll('h2.decode-text').forEach(el => rescrambleIO.observe(el));
        }

        function buildWLogo() {
            logoGroup = new THREE.Group();
            // Wordmark outlines are generated from Syncopate Bold at build time
            // (scripts/gen-brand-logo.mjs) and already centred on the origin.
            const wordmarkShapes = buildWordmarkShapes(THREE);
            const isMobileW = window.innerWidth < 1024;
            // Logo material. Three things here were flattening it:
            //   transmission 0.5 — half the surface response was "show the background through me",
            //     and the background is near-black, so it averaged down to a dead mid grey. 0.3 keeps
            //     the glass read (you can still see the work behind it) without draining the shading.
            //   emissive 0x222222 — a flat neutral grey added to every pixel, i.e. literally a wash.
            //     Same trick as the ambient above: keep a lift, make it violet so it tints instead.
            //   envMapIntensity — left at 1, so the RoomEnvironment PMREM barely registered. This is
            //     what turns the bevels into bright specular edges and is most of the "expensive
            //     glass" look; it costs nothing, the env map was already being generated.
            //   color 0xffffff — a pure white base has NO headroom: the body of the letter already
            //     sits at the top of the range, so every specular peak clips into it and the whole
            //     form goes to one flat white. Dropping the base to a light violet-grey leaves room
            //     for highlights to actually be brighter than the surface they sit on, which is what
            //     separation looks like. It does not read as grey — the highlights carry the white.
            const mat = new THREE.MeshPhysicalMaterial({ color:0xe2dcee, transmission:0.3, metalness:0.1,
                roughness:0.06, ior:1.5, emissive:0x140c26, clearcoat:1.0, clearcoatRoughness:0.04,
                envMapIntensity:1.4, specularIntensity:1.0 });
            const wmDepth = WORDMARK_SIZE.height * 0.32;
            const wmBevel = WORDMARK_SIZE.height * 0.035;
            for (const s of wordmarkShapes) {
                const geo = new THREE.ExtrudeGeometry(s, { depth:wmDepth, bevelEnabled:true, bevelSize:wmBevel, bevelThickness:wmBevel });
                geo.translate(0, 0, -wmDepth / 2);
                logoGroup.add(new THREE.Mesh(geo, mat));
            }
            ringMesh = new THREE.Mesh(new THREE.TorusGeometry(Math.max(3.8, WORDMARK_SIZE.width * 0.62), 0.05, 12, 48), new THREE.MeshStandardMaterial({ color:0xffffff, emissive:0xd8b4fe, emissiveIntensity:2.0 }));
            ringMesh.rotation.x = Math.PI/2; ringMesh.rotation.y = Math.PI/8;
            logoGroup.add(ringMesh);
            // Scale logo group for mobile portrait viewport fit
            if (isMobileW) {
                logoGroup.scale.setScalar(0.9);
            }
            logoGroup.position.set(0, 0, -25);
            scene.add(logoGroup);
        }

        function buildProjectCards() {
            const startZ = -100, zSpacing = -50;
            const dummyCanvas = document.createElement('canvas');
            dummyCanvas.width = 2; dummyCanvas.height = 2;
            const dummyTex = new THREE.CanvasTexture(dummyCanvas);

            projectAssets.forEach((asset, i) => {
                const group    = new THREE.Group();
                const frameMat = new THREE.MeshPhysicalMaterial({ color:0x111111, transmission:0.9, transparent:true, metalness:0.5, roughness:0.3, ior:1.5 });
                const frame    = new THREE.Mesh(new THREE.BoxGeometry(6.2, 3.8, 0.1), frameMat);

                const uniforms = { tDiffuse:{value:dummyTex}, uHover:{value:0.0}, uTime:{value:0.0}, uOpacity:{value:1.0} };
                uniformsMap.push(uniforms);
                // Texture is loaded asynchronously by the poster/image loader in init()

                const imgMat  = new THREE.ShaderMaterial({ vertexShader:imageShader.vertexShader, fragmentShader:imageShader.fragmentShader, uniforms, transparent:true });
                const imgMesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.6), imgMat);
                imgMesh.position.z = 0.06;
                group.add(frame, imgMesh);

                const xPos = (i % 2 === 0) ? -6 : 6;
                const zPos = startZ + (i * zSpacing);
                group.position.set(xPos, (Math.random()-0.5)*4, zPos);
                group.userData = { baseX:xPos, baseY:group.position.y, baseZ:zPos, baseRotY:(Math.random()-0.5)*0.4 };
                group.rotation.y = group.userData.baseRotY;
                scene.add(group); projectCards.push(group);
            });
        }

        function buildLiquidGlassOrbs() {
            const geo = new THREE.IcosahedronGeometry(2, 2);
            const mat = new THREE.MeshPhysicalMaterial({ color:0x555555, transmission:1.0, metalness:0.1, roughness:0.2, ior:1.5, thickness:2.0 });
            const count = 20;
            for (let i = 0; i < count; i++) {
                const m = new THREE.Mesh(geo, mat);
                m.position.set((Math.random()-0.5)*60, (Math.random()-0.5)*40, -50-Math.random()*TUNNEL_DEPTH);
                m.scale.setScalar(Math.random()*2.0+0.5);
                scene.add(m); glassOrbs.push(m);
            }
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

        function buildParticles() {
            const count = 2000;
            const geo = new THREE.BufferGeometry();
            const pos = new Float32Array(count*3), col = new Float32Array(count*3);
            const cP = new THREE.Color(0xd8b4fe), cW = new THREE.Color(0xFFFFFF);
            for (let i = 0; i < count; i++) {
                pos[i*3]=(Math.random()-0.5)*80; pos[i*3+1]=(Math.random()-0.5)*80; pos[i*3+2]=20-Math.random()*(TUNNEL_DEPTH+100);
                const c = Math.random()>0.7 ? cP : cW;
                col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b;
            }
            geo.setAttribute('position', new THREE.BufferAttribute(pos,3));

            geo.setAttribute('color',    new THREE.BufferAttribute(col,3));
            particles = new THREE.Points(geo, _roundPoints(new THREE.PointsMaterial({ size:0.08, vertexColors:true, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, sizeAttenuation:true })));
            scene.add(particles);
            particleBasePositions = pos.slice(); // copy
            particleVelocities = new Float32Array(count * 3);

            const bGeo = new THREE.BufferGeometry();
            const bPos = new Float32Array(100*3);
            for (let i=0;i<100;i++){bPos[i*3]=(Math.random()-0.5)*40;bPos[i*3+1]=(Math.random()-0.5)*40;bPos[i*3+2]=20-Math.random()*TUNNEL_DEPTH;}
            bGeo.setAttribute('position', new THREE.BufferAttribute(bPos,3));
            bokehParticles = new THREE.Points(bGeo, new THREE.ShaderMaterial({
                vertexShader:  `void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_PointSize=(200.0/-(modelViewMatrix*vec4(position,1.0)).z);}`,
                fragmentShader:`void main(){float d=distance(gl_PointCoord,vec2(0.5));float a=smoothstep(0.5,0.2,d)*0.15;if(a<0.01)discard;gl_FragColor=vec4(1.0,1.0,1.0,a);}`,
                transparent:true, depthWrite:false, blending:THREE.AdditiveBlending
            }));
            scene.add(bokehParticles);
        }

        function buildCursorTrail() {
            trailGeo = new THREE.BufferGeometry();
            trailPos = new Float32Array(MAX_TRAIL*3); trailVel = new Float32Array(MAX_TRAIL*3); trailLife = new Float32Array(MAX_TRAIL);
            trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos,3));
            trailGeo.setAttribute('aLife',    new THREE.BufferAttribute(trailLife,1));
            trailPoints = new THREE.Points(trailGeo, new THREE.ShaderMaterial({ vertexShader:trailShader.vertexShader, fragmentShader:trailShader.fragmentShader, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false }));
            scene.add(trailPoints);
        }

        function buildGlassShards() {
            const count = 12;
            const shardGeo = new THREE.PlaneGeometry(1, 2.5);
            // forceSinglePass is the load-bearing addition here, not tidying.
            // In r160, WebGLRenderer.renderObject() gives every `transparent && side === DoubleSide`
            // material the two-pass treatment: it renders back faces then front faces, and to do that
            // it mutates the material between the two —
            //     material.side = BackSide;  material.needsUpdate = true;   ...render...
            //     material.side = FrontSide; material.needsUpdate = true;   ...render...
            // `needsUpdate = true` invalidates the program cache key, so for twelve of these, every
            // frame, three.js re-derives material parameters and re-resolves the program twice per
            // shard. That is 24 draw calls and 24 material re-derivations per frame for twelve flat
            // planes at 0.15 opacity — and it is CPU/driver cost, the kind that resolution reduction
            // cannot touch, which is exactly why the governor descending never fixed the jank.
            // These are single flat quads, so a two-pass back-then-front render is buying nothing that
            // is visible at 15% opacity; one pass draws both facings in the same call.
            const shardMat = new THREE.MeshPhysicalMaterial({
                color: 0xffffff, transmission: 0.92, transparent: true,
                metalness: 0.1, roughness: 0.05, ior: 1.5, thickness: 0.2,
                opacity: 0.15, side: THREE.DoubleSide, forceSinglePass: true
            });
            for (let i = 0; i < count; i++) {
                const shard = new THREE.Mesh(shardGeo, shardMat.clone());
                shard.position.set(
                    (Math.random() - 0.5) * 50,
                    (Math.random() - 0.5) * 30,
                    -20 - Math.random() * 200
                );
                shard.rotation.set(
                    Math.random() * Math.PI,
                    Math.random() * Math.PI,
                    Math.random() * Math.PI
                );
                shard.scale.setScalar(0.5 + Math.random() * 2.5);
                shard.userData.rotSpeed = { x: (Math.random()-0.5)*0.004, y: (Math.random()-0.5)*0.006, z: (Math.random()-0.5)*0.003 };
                shard.userData.floatSpeed = 0.3 + Math.random() * 0.7;
                shard.userData.floatOffset = Math.random() * Math.PI * 2;
                scene.add(shard);
                glassShards.push(shard);
            }
        }

        function buildHelixStrand() {
            const count = 120;
            const helixGeo = new THREE.BufferGeometry();
            const helixPos = new Float32Array(count * 2 * 3); // 2 strands
            const helixCol = new Float32Array(count * 2 * 3);
            const c1 = new THREE.Color(0xd8b4fe);
            const c2 = new THREE.Color(0xffffff);
            for (let i = 0; i < count; i++) {
                const t2 = (i / count) * Math.PI * 8;
                const y  = (i / count) * 60 - 30;
                const r  = 4;
                // Strand A
                helixPos[i*6+0] = Math.cos(t2) * r;
                helixPos[i*6+1] = y;
                helixPos[i*6+2] = -80 + Math.sin(t2) * r * 0.5;
                helixCol[i*6+0] = c1.r; helixCol[i*6+1] = c1.g; helixCol[i*6+2] = c1.b;
                // Strand B (offset by PI)
                helixPos[i*6+3] = Math.cos(t2 + Math.PI) * r;
                helixPos[i*6+4] = y;
                helixPos[i*6+5] = -80 + Math.sin(t2 + Math.PI) * r * 0.5;
                helixCol[i*6+3] = c2.r; helixCol[i*6+4] = c2.g; helixCol[i*6+5] = c2.b;
            }
            helixGeo.setAttribute('position', new THREE.BufferAttribute(helixPos, 3));
            helixGeo.setAttribute('color',    new THREE.BufferAttribute(helixCol, 3));
            helixStrand = new THREE.Points(helixGeo, _roundPoints(new THREE.PointsMaterial({
                size: 0.2, vertexColors: true, transparent: true,
                opacity: 0.5, blending: THREE.AdditiveBlending, sizeAttenuation: true
            })));
            helixStrand.position.set(8, 0, 0);
            scene.add(helixStrand);
        }

        function buildOrbitLights() {
            const colors = [0xd8b4fe, 0x818cf8, 0xf0abfc];
            const radii  = [6, 8, 5];
            const speeds = [0.4, -0.25, 0.6];
            colors.forEach((col, i) => {
                const light = new THREE.PointLight(col, 3, 40);
                light.userData = { radius: radii[i], speed: speeds[i], offset: (i / colors.length) * Math.PI * 2, baseY: (i - 1) * 3 };
                scene.add(light);
                orbitLights.push(light);
            });
        }

        function buildWireSphere() {
            const isMobile = window.innerWidth < 1024;
            const geo = new THREE.IcosahedronGeometry(isMobile ? 3.8 : 5.5, 1);
            const mat = new THREE.MeshBasicMaterial({ color: 0xd8b4fe, wireframe: true, transparent: true, opacity: 0.08 });
            wireSphere = new THREE.Mesh(geo, mat);
            wireSphere.position.copy(logoGroup.position);
            scene.add(wireSphere);
        }

        function buildPortalRings() {
            const positions = [-60, -130, -200, -300, -420];
            positions.forEach((z, i) => {
                const geo = new THREE.TorusGeometry(8 + i * 2, 0.04, 10, 40);
                const mat = new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? 0xd8b4fe : 0x818cf8, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending });
                const ring = new THREE.Mesh(geo, mat);
                ring.position.set((Math.random()-0.5)*4, (Math.random()-0.5)*4, z);
                ring.rotation.x = Math.PI / 2 + (Math.random()-0.5)*0.3;
                ring.userData.rotSpeed = (Math.random()-0.5) * 0.008;
                ring.userData.pulseOffset = i * 0.8;
                scene.add(ring);
                portalRings.push(ring);
            });
        }

        function buildMirrorFloor() {
            const geo = new THREE.PlaneGeometry(200, 600);
            const mat = new THREE.MeshStandardMaterial({
                color: 0x050508, metalness: 0.9, roughness: 0.1,
                transparent: true, opacity: 0.6, envMapIntensity: 2.0
            });
            mirrorFloor = new THREE.Mesh(geo, mat);
            mirrorFloor.rotation.x = -Math.PI / 2;
            mirrorFloor.position.set(0, -12, -TUNNEL_DEPTH / 2);
            scene.add(mirrorFloor);
        }

        function buildDustMotes() {
            const count = 180;
            const geo = new THREE.BufferGeometry();
            const pos = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                pos[i*3]   = (Math.random() - 0.5) * 28;
                pos[i*3+1] = (Math.random() - 0.5) * 18;
                pos[i*3+2] = (Math.random() - 0.5) * 6; // very close Z range (relative)
            }
            geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            dustMotes = new THREE.Points(geo, _roundPoints(new THREE.PointsMaterial({
                size: 0.035, color: 0xffffff, transparent: true, opacity: 0.35,
                blending: THREE.AdditiveBlending, sizeAttenuation: true, depthWrite: false
            })));
            scene.add(dustMotes);
        }

        function spawnTrailParticle(x, y, z) {
            if (!trailPos) return;
            const i3 = trailIndex*3;
            trailPos[i3]=x; trailPos[i3+1]=y; trailPos[i3+2]=z;
            trailVel[i3]=(Math.random()-0.5)*0.4; trailVel[i3+1]=(Math.random()-0.5)*0.4; trailVel[i3+2]=(Math.random()-0.5)*0.4;
            trailLife[trailIndex] = 1.0;
            trailIndex = (trailIndex+1) % MAX_TRAIL;
        }

        // ESC to close modals
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closeDrawer(); if (document.getElementById('mobile-menu') && document.getElementById('mobile-menu').classList.contains('open')) closeMobileMenu(); } });

        // ---- Cursor View Label (section-aware) ----
        // Same four section tests as before, but they now consume the rects the batched scroll pass
        // has already measured instead of taking four more of its own on every scroll event. The
        // per-move position write moved into the pointer pass (see _pointerPass) so it no longer
        // needs a mousemove listener of its own either.
        function setupCursorLabel() {
            const label = document.getElementById('cursor-view-label');
            let onCard = false;
            let lastCls = '', lastText = '', lastShow = null;

            _cursorLabelUpdate = (heroBottom, mid, reelStraddles, workTop, workBottom, contactTop, contactBottom) => {
                if (onCard) return;
                let text = '', cls = '', show = false;
                if      (heroBottom > mid)                          { text = 'SCROLL ↓';  cls = '';             show = true;  }
                else if (reelStraddles)                             { text = '';          cls = '';             show = false; }
                else if (workTop    < mid && workBottom    > 0)     { text = '→';         cls = 'cursor-arrow'; show = true;  }
                else if (contactTop < mid && contactBottom > 0)     { text = '✦ CONNECT'; cls = 'cursor-hand';  show = true;  }
                if (cls !== lastCls) {
                    label.classList.remove('cursor-play', 'cursor-arrow', 'cursor-hand');
                    if (cls) label.classList.add(cls);
                    lastCls = cls;
                }
                if (text && text !== lastText) { label.textContent = text; lastText = text; }
                if (show !== lastShow) { label.classList.toggle('visible', show); lastShow = show; }
            };
            _cursorLabelEl = label;

            document.querySelectorAll('.h-project').forEach(card => {
                card.addEventListener('mouseenter', () => {
                    onCard = true;
                    label.textContent = 'VIEW →';
                    lastText = 'VIEW →';
                    label.classList.add('visible');
                    lastShow = true;
                });
                card.addEventListener('mouseleave', () => {
                    onCard = false;
                    label.classList.remove('visible');
                    lastShow = false;
                    // Let the next scroll pass re-evaluate now the cursor has left.
                    _scrollDirty = true;
                });
            });
        }

        // ---- Work Counter ----      folded into the batched scroll pass (triggerReveals).
        // ---- Scroll Velocity Line ---- folded into the batched scroll pass (triggerReveals).
        // Both measured #work-wrapper independently, on top of the pass that already measures it.

        // ---- Bento Stagger ----
        function setupBentoStagger() {
            const items = document.querySelectorAll('.bento-item');
            const io = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('in-view');
                        io.unobserve(entry.target);
                    }
                });
            }, { threshold: 0.1 });
            items.forEach(item => io.observe(item));
        }

        // Shared with the visibility handler further down, which pauses the decoder when the tab is
        // backgrounded and resumes only if the reel is still the section in view.
        let _reelIO = null, _reelWantsPlay = false, _reelVid = null, _armReelWarm = null;

        function setupReelVideoAutoplay() {
            const reelVid = document.querySelector('#reel .reel-video');
            if (!reelVid) return;
            window._reelVideoEl = reelVid;
            _reelVid = reelVid;

            const reelSection = document.getElementById('reel');

            // Buffer AHEAD of the section, decode only inside it — two observers, on purpose.
            //
            // The preloader no longer waits on this 2MB file (see the asset tracker in init), so
            // nothing forces it to buffer any more; left alone, play() below would be the first thing
            // to ask for the bytes and the reel could start on a black frame. This observer raises
            // preload to 'auto' while the section is still most of a screen away, so the data is in
            // flight in good time — while the narrow observer below keeps the original rule that the
            // video decoder only runs when the reel is actually on screen.
            //
            // Two details worth not undoing:
            //  * It is armed from the preloader hand-off, not at boot. The reel sits about two and a
            //    half screens down, which at a 900px viewport is inside even a 150% rootMargin — so an
            //    observer created at boot fires IMMEDIATELY and puts the 2MB straight back on the
            //    hero's critical path, which is the exact thing this change exists to prevent.
            //  * load() is only called when nothing has been fetched yet. load() re-runs the resource
            //    selection algorithm, which DISCARDS whatever is already buffered and starts over:
            //    measured against a server without Range support it downloaded the whole 2MB twice.
            _armReelWarm = () => {
                const warmIO = new IntersectionObserver((entries) => {
                    if (!entries.some(e => e.isIntersecting)) return;
                    if (reelVid.preload !== 'auto') {
                        reelVid.preload = 'auto';
                        if (reelVid.readyState === 0) reelVid.load();
                    }
                    warmIO.disconnect();
                }, { threshold: 0, rootMargin: '75% 0px' });
                warmIO.observe(reelSection);
                _armReelWarm = null;
            };

            // Only play when section is visible — saves GPU decoder bandwidth
            _reelIO = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    _reelWantsPlay = entry.isIntersecting;
                    if (entry.isIntersecting) {
                        if (!document.hidden) reelVid.play().catch(() => {});
                    } else if (!reelVid.paused) {
                        reelVid.pause();
                    }
                });
            }, { threshold: 0.2 });
            _reelIO.observe(reelSection);
        }

        // ---- Mobile Menu ----
        window.closeMobileMenu = () => {
            document.getElementById('mobile-menu').classList.remove('open');
            document.getElementById('hamburger').classList.remove('open');
            document.documentElement.style.overflowY = '';
            if (window.__lenis) window.__lenis.start();
            document.body.classList.remove('modal-open');
        };
        document.getElementById('hamburger').addEventListener('click', () => {
            const menu = document.getElementById('mobile-menu');
            const ham  = document.getElementById('hamburger');
            const isOpen = menu.classList.contains('open');
            if (isOpen) { closeMobileMenu(); }
            else {
                menu.classList.add('open'); ham.classList.add('open'); document.body.classList.add('modal-open');
                // Lock the real scroll container + pause Lenis so wheel/touch can't scroll the page behind the menu.
                document.documentElement.style.overflowY = 'hidden';
                if (window.__lenis) window.__lenis.stop();
            }
        });

        // ---- Testimonial Slider ----
        let currentSlide = 0;
        const slides = document.querySelectorAll('.testimonial-slide');
        const dots   = document.querySelectorAll('.t-dot');
        let slideTimer = null;
        // Only advance while the section is on screen and the tab is in front. The autoplay used to
        // run from page load to unload, so a visitor still reading the hero had already been advanced
        // through the testimonials several times before ever seeing them — each rotation touching two
        // classes on absolutely-positioned siblings, i.e. real style and paint work for content
        // nobody was looking at.
        let _testiVisible = false;
        function resetSlideTimer() {
            clearInterval(slideTimer);
            slideTimer = (_testiVisible && !document.hidden)
                ? setInterval(() => { goToSlide((currentSlide + 1) % slides.length); }, 7000)
                : null;
        }
        window.goToSlide = (n) => {
            slides[currentSlide].classList.remove('active');
            dots[currentSlide].classList.remove('active');
            currentSlide = n;
            slides[currentSlide].classList.add('active');
            dots[currentSlide].classList.add('active');
            resetSlideTimer();
        };
        window.nextSlide = () => { goToSlide((currentSlide + 1) % slides.length); };
        window.prevSlide = () => { goToSlide((currentSlide - 1 + slides.length) % slides.length); };
        {
            const tSection = document.getElementById('testimonials');
            if (tSection) {
                new IntersectionObserver(e => { _testiVisible = e[0].isIntersecting; resetSlideTimer(); },
                    { threshold: 0.15 }).observe(tSection);
                document.addEventListener('visibilitychange', resetSlideTimer);
            } else { _testiVisible = true; resetSlideTimer(); }
        }

        // ---- FAQ Accordion ----
        window.toggleFaq = (btn) => {
            const item   = btn.closest('.faq-item');
            const isOpen = item.classList.contains('open');
            document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
            if (!isOpen) item.classList.add('open');
        };

        // ---- Cookie Banner ----
        window.acceptCookie = () => {
            document.getElementById('cookie-banner').classList.remove('show');
            localStorage.setItem('wt_cookie', 'accepted');
        };
        window.declineCookie = () => {
            document.getElementById('cookie-banner').classList.remove('show');
            localStorage.setItem('wt_cookie', 'declined');
        };
        if (!localStorage.getItem('wt_cookie')) {
            setTimeout(() => document.getElementById('cookie-banner').classList.add('show'), 2500);
        }

        // ---- Scroll-to-Top with progress ring ----
        // Folded into the batched scroll pass. This one was the worst offender of the group: it read
        // documentElement.scrollHeight on every single scroll event (a forced synchronous layout of
        // the entire 14,400px document) purely to compute a stroke offset, and it also re-resolved
        // #scroll-top-btn by id each time.

        function setupSoundToggle() {
            const btn   = document.getElementById('sound-toggle');
            const audio = document.getElementById('ambient-audio');
            audio.volume = 0.3;
            let unlocked = false;

            // Restore state from previous page in this session
            const savedTime  = parseFloat(sessionStorage.getItem('wt-audio-time') || '0');
            const wasPlaying = sessionStorage.getItem('wt-audio-playing') === '1';
            if (savedTime > 0 && isFinite(savedTime)) {
                try { audio.currentTime = savedTime; } catch(e) {}
            }

            function tryPlay() {
                if (unlocked) return;
                audio.play().then(() => {
                    unlocked = true;
                    btn.classList.remove('muted');
                    sessionStorage.setItem('wt-audio-playing', '1');
                }).catch(() => {});
            }

            // Try immediate autoplay only if user previously had audio on, or first visit
            if (wasPlaying || sessionStorage.getItem('wt-audio-playing') === null) tryPlay();
            else btn.classList.add('muted');

            // Hook every possible early user signal (only if user wants audio)
            const EVENTS = ['click','mousedown','mousemove','scroll','touchstart','keydown','pointerdown'];
            function onUserGesture() {
                if (sessionStorage.getItem('wt-audio-playing') !== '0') tryPlay();
                if (unlocked) EVENTS.forEach(ev => document.removeEventListener(ev, onUserGesture));
            }
            EVENTS.forEach(ev => document.addEventListener(ev, onUserGesture, { passive: true }));

            // Manual toggle
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (audio.paused) {
                    audio.play().then(() => { btn.classList.remove('muted'); unlocked = true; sessionStorage.setItem('wt-audio-playing', '1'); }).catch(()=>{});
                } else {
                    audio.pause();
                    btn.classList.add('muted');
                    sessionStorage.setItem('wt-audio-playing', '0');
                }
            });

            // Save currentTime continuously so navigation resumes seamlessly.
            // Driven by the element's own play/pause events rather than a permanent 500ms interval.
            // Ambient audio is opt-in and starts muted for most visitors, so that interval spent the
            // whole session waking twice a second only to find `audio.paused` and return — and when
            // audio WAS playing it wrote to sessionStorage twice a second, which is a synchronous
            // main-thread store. Same 500ms cadence while playing, nothing at all while not.
            let saveTimer = null;
            const startSaving = () => { if (!saveTimer) saveTimer = setInterval(() => { sessionStorage.setItem('wt-audio-time', audio.currentTime.toString()); }, 500); };
            const stopSaving  = () => { if (saveTimer) { clearInterval(saveTimer); saveTimer = null; } };
            audio.addEventListener('playing', startSaving);
            audio.addEventListener('pause',   stopSaving);
            audio.addEventListener('ended',   stopSaving);
            if (!audio.paused) startSaving();
            window.addEventListener('pagehide', () => {
                sessionStorage.setItem('wt-audio-time', audio.currentTime.toString());
                sessionStorage.setItem('wt-audio-playing', audio.paused ? '0' : '1');
            });
        }

        function setupCrossPageWipe() {
            const wipe = document.getElementById('wt-page-wipe');
            if (!wipe) return;
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            const parkWipe = () => {
                // Snap to the parked (off-screen) base state, clearing classes AND the inline
                // transform — otherwise the inline transform permanently outranks .cover and the
                // exit wipe never plays (dead 650ms delay).
                wipe.style.transition = 'none';
                wipe.classList.remove('cover', 'uncover');
                wipe.style.transform = '';
                requestAnimationFrame(() => { wipe.style.transition = ''; });
            };
            requestAnimationFrame(() => {
                wipe.classList.add('uncover');
                setTimeout(parkWipe, 750);
            });
            // Intercept internal cross-page links (extensionless clean URLs + legacy .html/.php).
            document.addEventListener('click', (e) => {
                const link = e.target.closest('a[href]');
                if (!link) return;
                const raw = link.getAttribute('href');
                if (!raw || raw.charAt(0) === '#') return;
                // Let the browser have modifier-clicks and non-primary buttons. Without this a
                // ctrl/cmd-click (open in new tab), shift-click (new window) or middle-click on ANY
                // internal link was swallowed by the preventDefault() below and turned into an
                // ordinary same-tab navigation — the visitor asked for a new tab and lost their
                // place instead. Same guard exists in Gallery.html and site.js.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button && e.button !== 0)) return;
                if (e.defaultPrevented) return;
                if (link.target === '_blank' || link.hasAttribute('download')) return;
                if (link.protocol === 'mailto:' || link.protocol === 'tel:') return;
                if (link.hostname !== location.hostname) return;
                if (link.pathname === location.pathname && link.hash) return;
                if (/\.[a-z0-9]+$/i.test(link.pathname) && !/\.(html?|php)$/i.test(link.pathname)) return;
                e.preventDefault();
                wipe.classList.add('cover');
                setTimeout(() => { window.location.href = raw; }, 650);
            });
            // bfcache restore keeps .cover applied (black overlay) → clear it; also release the menu.
            window.addEventListener('pageshow', (ev) => {
                if (!ev.persisted) return;
                parkWipe();
                if (typeof window.closeMobileMenu === 'function') window.closeMobileMenu();
            });
        }

        function setupParallax() {
            // The .parallax-el layers were removed from the markup long ago (see the comment where
            // they used to be), so this bound a scroll listener that iterated an empty NodeList on
            // every event for the rest of the session. Nothing to do.
        }

        // setupStatsCounter() was an exact duplicate of setupStatsRecount(): two IntersectionObservers
        // on the same .stat-num elements, both starting a requestAnimationFrame count-up with the same
        // target, the same duration and the same cubic ease, within a frame of each other — so every
        // stat ran two competing rAF loops writing the same text to the same node. Recount also
        // re-counts on re-entry, which is the behaviour the page ships, so Counter was pure overhead
        // and is gone. init() no longer calls it.

        // ---- Work Progress Bar ---- folded into the batched scroll pass (triggerReveals).

        const _coarsePtr = window.matchMedia('(pointer: coarse)').matches;
        let _rzW = window.innerWidth, _rzH = window.innerHeight;
        let _rzQueued = false;
        // Coalesce to at most one reallocation per animation frame. A desktop window drag fires
        // `resize` faster than the compositor paints, and each one of those used to run
        // renderer.setSize + _syncComposerSize, i.e. tear down and rebuild two full-resolution
        // HalfFloat ping-pong targets, their 4x MSAA colour+depth renderbuffers, the transmission
        // target and the five-level bloom mip chain. Dozens of times per second, that is the
        // "resizing the window makes it stutter" you can feel. rAF is the right granularity: the
        // canvas cannot show a new size before the next paint anyway, so nothing is deferred that
        // the visitor could have seen.
        function onResize() {
            if (_rzQueued) return;
            _rzQueued = true;
            requestAnimationFrame(_applyResize);
        }
        function _applyResize() {
            _rzQueued = false;
            if (!camera || !renderer) return;
            const w = window.innerWidth, h = window.innerHeight;
            // Mobile URL-bar show/hide fires height-only resizes mid-scroll; rebuilding the
            // backbuffer + bloom mip chain there is a visible hitch. Rotation/split-screen
            // changes width, and the keyboard jumps height >=150px — both still resize fully.
            if (_coarsePtr && w === _rzW && Math.abs(h - _rzH) < 150) { _scrollDirty = true; return; }
            _rzW = w; _rzH = h;
            camera.aspect = w / h; camera.updateProjectionMatrix();
            renderer.setSize(w, h);
            // Re-evaluate the pixel budget: it is a function of the viewport, so a rotation, a
            // window drag or entering split-screen can move a device across the threshold. Feed the
            // governor's current tier back in so a resize does not silently undo a downgrade.
            _baseDpr = _targetDpr();
            _applyQuality();       // reads the drawing buffer after setSize/setPixelRatio; clamped >= native
            // NB: never park logoGroup here — its position is camera-relative and lerped
            // every frame in animate(); a hard reset teleports it (the old mobile
            // first-scroll "logo respawns" bug) and the lerp converges without it.
            _scrollDirty = true;
            _revealsArmed = true;   // matches the original, which revealed from onResize as well
            _hgAt = NaN;   // heading-gravity centres are cached per scroll position; a resize moves them
        }

        // Cached list of everything still waiting to reveal. This used to run a document-wide
        // querySelectorAll with two :not() selectors on EVERY scroll event, then interleave a
        // getBoundingClientRect (a layout read) with a classList.add (a layout-invalidating write)
        // per match — the classic thrash pattern, where each write forces the next read to
        // re-layout the whole document. Collecting the elements once and splicing them out as they
        // reveal makes the common case a short walk over a shrinking array, and once everything has
        // revealed the loop costs nothing at all.
        // ── Reveals ───────────────────────────────────────────────────────────────────────────────
        // The trigger is `rect.top < innerHeight - 100`. An IntersectionObserver with the root's
        // bottom edge pulled in by 100px expresses exactly that, and it does the measuring inside the
        // browser's own layout pass — so the reveal check now costs ZERO forced layouts instead of one
        // getBoundingClientRect per still-hidden element per frame (about 30 of them on first descent).
        //
        // `_revealsArmed` reproduces the original trigger set precisely, and it matters: before, the
        // reveal check only ran on a scroll or resize event, so at rest during loading it did not run
        // at all and the hero's entrance was owned solely by the preloader hand-off. Now that the pass
        // is frame-driven, an unarmed first frame would reveal and decode the hero headline WHILE the
        // preloader still covered it — the fade-up and the character scramble would both be over by
        // the time the overlay lifted. Armed by: the preloader hand-off, a real scroll, or a resize.
        let _revealPending = null, _revealIO = null, _revealsArmed = false;
        function _revealEl(el) {
            if (el.classList.contains('in-view')) return;
            el.classList.add('in-view');
            if (el.classList.contains('decode-text')) decodeText(el);
        }
        function _collectReveals() {
            _revealPending = Array.prototype.slice.call(
                document.querySelectorAll('.fade-up:not(.in-view), .decode-text:not(.in-view)'));
            if (!_revealIO) {
                _revealIO = new IntersectionObserver((entries) => {
                    if (!_revealsArmed) return;
                    for (const e of entries) {
                        // isIntersecting is the ordinary downward reveal. The rect test covers an
                        // element that is already entirely ABOVE the viewport when observation starts
                        // — a bfcache restore, a reload part-way down the page, a #hash landing —
                        // which never intersects and would otherwise sit at opacity 0 forever. The
                        // two together are exactly the original `top < innerHeight - 100` predicate,
                        // and e.boundingClientRect is handed to us already measured.
                        if (e.isIntersecting || e.boundingClientRect.top < window.innerHeight - 100) {
                            _revealEl(e.target);
                            _revealIO.unobserve(e.target);
                        }
                    }
                }, { rootMargin: '0px 0px -100px 0px', threshold: 0 });
            }
            for (const el of _revealPending) if (!el.classList.contains('in-view')) _revealIO.observe(el);
        }
        window._wtRecollectReveals = _collectReveals;

        // ══════════════════════════════════════════════════════════════════════════════════════════
        //  ONE SCROLL PASS PER FRAME
        // ══════════════════════════════════════════════════════════════════════════════════════════
        // Replaces eight independent `scroll` listeners. Measured, a single scroll event cost 51.6
        // getBoundingClientRect calls, 20.6 getElementById lookups and 4.9 reads of
        // documentElement.scrollHeight (each a forced synchronous layout) — and it all ran twice per
        // frame on desktop, since Lenis emits its own 'scroll' every animation frame on top of the
        // native one.
        //
        // Worse than the count was the ordering. Handlers ran in registration order, so one that
        // wrote a class or a width (navbar, work progress bar, in-work-section) was followed by one
        // that read a rect — forcing a full re-layout before it could answer. That read/write ladder
        // is why frame pacing suffered on scroll even with GPU headroom.
        //
        // Now scroll sources only set a flag; the loop drains it once per frame, all reads then all
        // writes. Same effects, same thresholds — the seven sections it needs are measured once each.
        // KEEP THE PHASES SEPARATE: anything that reads geometry must stay above the write phase.
        let _scrollDirty = true;
        let _sect = null;                       // cached section elements, in read order
        let _dom = null;                         // cached DOM refs for the write phase
        let _lastSectionId = '';                 // for the UI-section tone (desktop)
        let _uiSoundTone = null;                 // set by setupUISounds when it is active
        let _cursorLabelUpdate = null;           // set by setupCursorLabel when it is active
        let _velLastY = 0;
        const _RING_CIRC = 138.23;

        function _cacheScrollDom() {
            _sect = [
                document.getElementById('hero'),
                document.getElementById('about-1'),
                document.getElementById('reel'),
                document.getElementById('capabilities'),
                workWrapper,
                document.getElementById('testimonials'),
                document.getElementById('contact'),
            ];
            _dom = {
                navbar:    document.getElementById('navbar'),
                workBar:   document.getElementById('work-progress-bar'),
                workCount: document.getElementById('work-counter-current'),
                scrollBtn: document.getElementById('scroll-top-btn'),
                scrollRing:document.getElementById('scroll-ring'),
                velLine:   document.getElementById('scroll-vel-line'),
            };
            _dom.workTotal = document.querySelectorAll('.h-project').length || 7;
        }

        // Last-written values, so the pass only touches the DOM when something actually changed.
        // Assigning an identical style string still costs a style invalidation, and several of these
        // (the navbar's backdrop-filter, body.in-work-section) invalidate a large subtree.
        const _w = { nav: null, work: null, tx: -1, bar: '', count: '', prog: '', btn: null, ring: '', vel: '', velOp: '' };

        function triggerReveals() {
            if (_sect === null) _cacheScrollDom();
            const vh = window.innerHeight;

            // ─── READ PHASE — every layout read happens here, before any write ───────────────────
            if (_revealPending === null) _collectReveals();
            // Backstop sweep, twice a second at 60fps. The IntersectionObserver above is the primary
            // trigger and handles every case we know of; this is insurance for the ones we do not,
            // because the failure mode — a section of the page permanently stuck at opacity 0 — is
            // far worse than 30 rect reads every 32nd frame. Both paths are idempotent.
            const hit = [];
            let stale = false;
            if (_revealsArmed && _revealPending.length && (_frameNo & 31) === 0) {
                const limit = vh - 100;
                for (let i = 0; i < _revealPending.length; i++) {
                    const el = _revealPending[i];
                    // Several other paths add .in-view directly (the preloader hand-off, two
                    // IntersectionObservers, the lite fallback). Drop those here rather than
                    // re-measuring them forever.
                    if (el.classList.contains('in-view')) { stale = true; continue; }
                    if (el.getBoundingClientRect().top < limit) hit.push(el);
                }
            }
            // Heading-gravity centres, if the desktop pointer effects are active. Refreshed here in
            // the read phase rather than from the pointer pass, which runs after the write phase and
            // would therefore force an extra layout per frame during scroll-plus-move.
            // Only while the pointer is actually in use, though: scrolling with a still mouse is the
            // common case and does not need twelve heading rects per frame for an effect nothing is
            // driving. When the pointer wakes up at a new scroll offset the fallback in _pointerPass
            // catches it with a single refresh.
            if (_hgEls && _hgAt !== currentScrollY && (_frameNo - _lastMoveFrame) < 120) _refreshHeadingRects();

            // Seven section rects, once each. Every consumer below reads from this array.
            const mid = vh / 2;
            let sectionInMiddle = '';
            let heroBottom = 0, reelStraddles = false, workTop = 0, workBottom = 0, workHeight = 0, contactTop = 0, contactBottom = 0;
            for (let i = 0; i < _sect.length; i++) {
                const el = _sect[i];
                if (!el) continue;
                const r = el.getBoundingClientRect();
                if (!sectionInMiddle && r.top < mid && r.bottom > mid) sectionInMiddle = el.id;
                if (i === 0) heroBottom = r.bottom;
                else if (i === 2) reelStraddles = r.top < mid && r.bottom > mid;
                else if (i === 4) { workTop = r.top; workBottom = r.bottom; workHeight = r.height; }
                else if (i === 6) { contactTop = r.top; contactBottom = r.bottom; }
            }
            const inWork = workTop <= 0 && workBottom >= vh;
            const workProgress = inWork && workHeight > vh ? Math.abs(workTop) / (workHeight - vh) : 0;
            // _maxScroll is the cached scrollHeight-derived value maintained by animate(); reading
            // documentElement.scrollHeight here is what used to force ~5 extra layouts per event.
            const pageProgress = _maxScroll > 0 ? Math.max(0, Math.min(currentScrollY / _maxScroll, 1)) : 0;

            // ─── WRITE PHASE — nothing below reads geometry ──────────────────────────────────────
            if (hit.length || stale) {
                for (const el of hit) { _revealEl(el); if (_revealIO) _revealIO.unobserve(el); }
                _revealPending = _revealPending.filter(el => !el.classList.contains('in-view'));
            }

            const wantNav = currentScrollY > 50 && !isModalOpen;
            if (wantNav !== _w.nav) { _dom.navbar.classList.toggle('scrolled', wantNav); _w.nav = wantNav; }

            // Scroll-driven horizontal animation (all devices)
            if (inWork) {
                _workTx = Math.max(0, Math.min(workProgress * _trackMaxX, _trackMaxX));
                if (_workTx !== _w.tx) { workTrack.style.transform = `translate3d(-${_workTx}px, 0, 0)`; _w.tx = _workTx; }
            }

            // Work progress bar + counter
            if (inWork !== _w.work) { document.body.classList.toggle('in-work-section', inWork); _w.work = inWork; }
            if (inWork) {
                const bw = (workProgress * 100) + '%';
                if (bw !== _w.bar) { _dom.workBar.style.width = bw; _w.bar = bw; }
                const idx = Math.min(Math.floor(workProgress * _dom.workTotal), _dom.workTotal - 1);
                const cnt = String(idx + 1).padStart(2, '0');
                if (cnt !== _w.count) { _dom.workCount.textContent = cnt; _w.count = cnt; }
            }

            // Global scroll progress bar
            if (globalProgressBar) {
                const pw = (pageProgress * 100) + '%';
                if (pw !== _w.prog) { globalProgressBar.style.width = pw; _w.prog = pw; }
            }

            // Scroll-to-top button + its progress ring
            const showBtn = currentScrollY > vh * 0.3;
            if (showBtn !== _w.btn) { _dom.scrollBtn.classList.toggle('visible', showBtn); _w.btn = showBtn; }
            if (_dom.scrollRing) {
                const off = (_RING_CIRC - pageProgress * _RING_CIRC).toFixed(2);
                if (off !== _w.ring) { _dom.scrollRing.style.strokeDashoffset = off; _w.ring = off; }
            }

            // Scroll velocity line (desktop only — the element is created for every device but the
            // original only bound this on desktop, and #scroll-vel-line is invisible at 0 height).
            if (!_isMobileAnim && _dom.velLine) {
                const vel = Math.abs(currentScrollY - _velLastY);
                _velLastY = currentScrollY;
                const hpx = Math.min(vel * 8, vh * 0.5).toFixed(0) + 'px';
                const op = vel * 8 > 5 ? '1' : '0';
                if (hpx !== _w.vel) { _dom.velLine.style.height = hpx; _w.vel = hpx; }
                if (op !== _w.velOp) { _dom.velLine.style.opacity = op; _w.velOp = op; }
            }

            // Section-aware cursor label (desktop) — fed the rects this pass already took.
            if (_cursorLabelUpdate) _cursorLabelUpdate(heroBottom, mid, reelStraddles, workTop, workBottom, contactTop, contactBottom);

            // Section transition tone (desktop)
            if (_uiSoundTone && sectionInMiddle && sectionInMiddle !== _lastSectionId) {
                _lastSectionId = sectionInMiddle;
                _uiSoundTone();
            }

            // Letterbox cinematic bars on fast scroll.
            // Skipped entirely where the bars are hidden by CSS anyway — `.letterbox` is
            // `display: none !important` under (max-width: 1024px) and under reduced motion. The only
            // thing `body.fast-scroll` selects is those bars' height, so on every phone this was
            // adding and removing a class on <body> — which invalidates style for the whole document —
            // and churning a 380ms timer, for something with no rule that could match. The media
            // query is written out rather than reusing _isMobileAnim so it tracks the CSS exactly
            // (_isMobileAnim is `< 1024`, the rule is `<= 1024`).
            if (!_lbOff.matches && Math.abs(currentScrollY - lastScrollY) > 14) {
                document.body.classList.add('fast-scroll');
                clearTimeout(window._lbTimeout);
                window._lbTimeout = setTimeout(() => document.body.classList.remove('fast-scroll'), 380);
            }
        }
        const _lbOff = window.matchMedia('(max-width: 1024px), (prefers-reduced-motion: reduce)');

        // ══════════════════════════════════════════════════════════════════════════════════════════
        //  ONE POINTER PASS PER FRAME
        // ══════════════════════════════════════════════════════════════════════════════════════════
        // A single mouse move used to run five document-level handlers costing, measured, 13
        // getBoundingClientRect calls, 2.7 forced layouts, 4.5 style recalculations and 2.5 fresh
        // setTimeout timers — on a 120Hz panel roughly 1,500 layout reads and 300 timers per second,
        // to move four small overlays and nudge some headings.
        //
        // onMouseMove is now a recorder: pure arithmetic, no DOM, no layout. Everything visual happens
        // once per frame in _pointerPass, which is as fast as those overlays could appear anyway.
        //
        // mouseVelocity and the travel angle stay per-EVENT deliberately: derived from per-frame
        // deltas they would roughly double on a high-polling-rate mouse and over-stretch the ring.
        let _ptrX = 0, _ptrY = 0, _ptrAngle = 0, _ptrStretch = 1;
        let _ptrDirty = false, _ptrSeen = false, _lastMoveT = 0, _glowActive = false, _lastMoveFrame = -1e9;
        let _cursorDotEl = null, _cursorRingEl = null, _cursorGlowEl = null, _cursorLabelEl = null;
        // Ring history: the ring deliberately trails the pointer by 40ms. That used to be one
        // setTimeout per mouse event; it is now a tiny ring buffer that the pass samples 40ms back,
        // which is the same thing expressed without allocating a timer per input event.
        const _RING_LAG = 40, _RH = 12;
        const _ringHist = new Float64Array(_RH * 5);   // t, x, y, angle, stretch
        let _ringHead = 0, _ringCount = 0;

        function onMouseMove(e) {
            if (_isMobileAnim) return; // skip all mouse tracking on mobile
            const x = e.clientX, y = e.clientY;
            mouseVelocity = Math.sqrt((x-lastMouseX)**2 + (y-lastMouseY)**2);
            const angle  = Math.atan2(y-lastMouseY, x-lastMouseX);
            lastMouseX = x; lastMouseY = y;
            mouse.x = x/window.innerWidth; mouse.y = 1.0-(y/window.innerHeight);
            mouseParallax.x = (x/window.innerWidth)*2-1; mouseParallax.y = -(y/window.innerHeight)*2+1;
            _ptrX = x; _ptrY = y; _ptrAngle = angle;
            _ptrStretch = Math.min(1+mouseVelocity*0.02, 2.0);
            _ptrDirty = true; _ptrSeen = true;
            _lastMoveT = e.timeStamp; _lastMoveFrame = _frameNo;
            if (mouseVelocity > 3) _glowWanted = true;
            const b = (_ringHead % _RH) * 5;
            _ringHist[b] = e.timeStamp; _ringHist[b+1] = x; _ringHist[b+2] = y;
            _ringHist[b+3] = angle; _ringHist[b+4] = _ptrStretch;
            _ringHead++; if (_ringCount < _RH) _ringCount++;
        }

        // Scratch vectors for the trail spawn. The originals were `new THREE.Vector3(...)` plus a
        // `.clone()` on every fast mouse event — two allocations per event, i.e. a steady drip of
        // garbage at pointer frequency, which is exactly the kind of churn that produces a minor GC
        // pause mid-scroll.
        const _spawnVec = new THREE.Vector3(), _spawnDir = new THREE.Vector3(), _spawnPos = new THREE.Vector3();
        let _glowWanted = false;
        let _ringLastTx = '';

        // Heading gravity: cached centres.
        // The rects are re-measured only when the scroll position changes or the viewport resizes,
        // because that is the only time a heading can move. In the common case — pointer moving over
        // a stationary page — this costs zero layout reads, against twelve per event before.
        // Measuring once per scroll position also breaks a feedback loop the original had: it read
        // the rect of an element it had itself translated on the previous event, so the "centre" it
        // pulled toward drifted with the pull. The centre is now stable, which is what the effect
        // was always meant to be.
        // ── Mobile warp follow ─────────────────────────────────────────────────────────────────────
        // On desktop the ripple centre (`mouse`) tracks the pointer, which is what makes the warp read
        // as intentional. onMouseMove returns early when _isMobileAnim, so on a phone `mouse` never
        // moved from its initial (0.5, 0.5) — the warp sat dead centre for the entire session.
        //
        // This drives the same uniform from touch instead. Desktop is untouched: every branch here is
        // behind _isMobileAnim, no desktop listener is added, and uWarp stays 1.0 there.
        //
        // Listeners are PASSIVE without exception. A non-passive touch listener on this page would
        // force every touchmove through the main thread before the compositor may scroll — the exact
        // mechanism that was measured holding the gallery at 28fps. A decorative effect must never
        // buy itself that.
        // Touch-follow is simply on for touch-sized viewports now; the ?mwarp=center comparison mode
        // was removed once the behaviour was approved.
        //
        // NB the mobile test is inlined rather than reading _isMobileAnim. That `const` is declared
        // several hundred lines BELOW this point, and reading it from here executes in its temporal
        // dead zone — a ReferenceError at boot that would drop the whole 3D hero to the flat wt-lite
        // layout. No syntax check can see that; this file has shipped the same mistake before.
        const _MWARP_FOLLOW = window.innerWidth < 1024;
        const _MW_LIFT = 88;         // px above the finger, so the effect is not hidden under the thumb
        const _MW_COAST_MS = 550;    // hold near the release point while native momentum carries on
        let _mwId = null;            // identifier of the touch being followed
        let _mwTx = 0.5, _mwTy = 0.5;   // target, UV (y up, matching `mouse`)
        let _mwCx = 0.5, _mwCy = 0.5;   // current, UV — smoothed toward the target
        let _mwPhase = 'rest';          // 'touch' | 'coast' | 'rest'
        let _mwCoastUntil = 0, _mwLastT = 0;
        let _mwInt = 1;                 // ripple scale, eased
        let _mwSnap = true;             // next update jumps rather than slides
        const _mwLogoV = new THREE.Vector3();

        function _mwSetTargetFromTouch(t) {
            _mwTx = t.clientX / window.innerWidth;
            _mwTy = 1 - ((t.clientY - _MW_LIFT) / window.innerHeight);
        }
        if (_MWARP_FOLLOW) {
            // Follow ONE touch, by identifier. Tracking touches[0] instead would jump across the
            // screen the moment a first finger lifts while a second is still down.
            addEventListener('touchstart', (e) => {
                if (_mwId !== null) return;                  // already following a finger
                const t = e.changedTouches[0]; if (!t) return;
                _mwId = t.identifier;
                _mwSetTargetFromTouch(t);
                _mwPhase = 'touch';
            }, { passive: true });
            addEventListener('touchmove', (e) => {
                if (_mwId === null) return;
                for (let i = 0; i < e.touches.length; i++) {
                    if (e.touches[i].identifier === _mwId) { _mwSetTargetFromTouch(e.touches[i]); _mwPhase = 'touch'; return; }
                }
            }, { passive: true });
            const _mwEnd = (e) => {
                if (_mwId === null) return;
                for (let i = 0; i < e.touches.length; i++) if (e.touches[i].identifier === _mwId) return;  // still down
                _mwId = null;
                _mwPhase = 'coast';
                _mwCoastUntil = performance.now() + _MW_COAST_MS;
            };
            addEventListener('touchend', _mwEnd, { passive: true });
            addEventListener('touchcancel', _mwEnd, { passive: true });
            // Rotating the device changes what every normalised coordinate means, and resize fires for
            // the mobile URL bar too. Snapping on the next update stops the warp sliding across the
            // new layout instead of simply being where it should be.
            addEventListener('orientationchange', () => { _mwSnap = true; }, { passive: true });
            addEventListener('resize', () => { _mwSnap = true; }, { passive: true });
        }

        // Where the warp settles when nobody is touching. On the hero that is the 3D logo rather than
        // the geometric centre of the viewport; past the hero it is the middle of the screen, which is
        // where it always used to sit. logoGroup's position is camera-relative and re-lerped every
        // frame, so this is projected fresh rather than cached.
        function _mwRestTarget() {
            if (logoGroup && currentScrollY < window.innerHeight * 0.9) {
                _mwLogoV.setFromMatrixPosition(logoGroup.matrixWorld).project(camera);
                if (Math.abs(_mwLogoV.x) < 2 && Math.abs(_mwLogoV.y) < 2) {
                    _mwTx = _mwLogoV.x * 0.5 + 0.5;
                    _mwTy = _mwLogoV.y * 0.5 + 0.5;
                    return;
                }
            }
            _mwTx = 0.5; _mwTy = 0.5;
        }

        // Takes no time argument on purpose. animate()'s local `t` is SECONDS (time * 0.001) while the
        // coast deadline is set from performance.now() in MILLISECONDS; an earlier version accepted the
        // caller's value and mixed the two, which made the smoothing run 1000x too slow and left the
        // coast timer permanently unexpired. Reading the clock here means the units cannot disagree.
        function _mwStep() {
            if (!_MWARP_FOLLOW) return;
            const nowMs = performance.now();
            const dt = _mwLastT ? Math.min(0.05, (nowMs - _mwLastT) / 1000) : 1 / 60;
            _mwLastT = nowMs;
            if (_mwPhase === 'coast' && nowMs > _mwCoastUntil) _mwPhase = 'rest';
            if (_mwPhase === 'rest') _mwRestTarget();

            // Responsive under the finger, slower while coasting, slowest on the way home — so the
            // return reads as the effect settling rather than chasing. Frame-rate independent.
            const k = _mwPhase === 'touch' ? 11 : (_mwPhase === 'coast' ? 5 : 2.2);
            if (_mwSnap) { _mwCx = _mwTx; _mwCy = _mwTy; _mwSnap = false; }
            else {
                const a = 1 - Math.exp(-dt * k);
                _mwCx += (_mwTx - _mwCx) * a;
                _mwCy += (_mwTy - _mwCy) * a;
            }
            mouse.x = _mwCx; mouse.y = _mwCy;

            // Duck the ripple where it would sit on a large heading. Reuses the h1/h2 rect cache the
            // desktop heading-gravity already maintains, refreshed only once per ~60px of scroll — a
            // per-frame refresh would be a layout read on every frame of every scroll.
            if (!_hgEls || Math.abs(_hgAt - currentScrollY) > 60) _refreshHeadingRects();
            const vh = window.innerHeight;
            const px = _mwCx * window.innerWidth, py = (1 - _mwCy) * vh;
            let over = false;
            for (let i = 0; _hgEls && i < _hgEls.length && !over; i++) {
                if (_hgTop[i] > vh || _hgBot[i] < 0) continue;
                if (py > _hgTop[i] - 24 && py < _hgBot[i] + 24 && Math.abs(px - _hgCx[i]) < 340) over = true;
            }
            _mwInt += ((over ? 0.32 : 1) - _mwInt) * (1 - Math.exp(-dt * 4));
        }
        // Read-only state, for verification and support. Four numbers and a string; no way to drive
        // anything from here.
        window.__wtWarp = () => ({
            mode: _MWARP_FOLLOW ? 'follow' : 'center',
            x: +mouse.x.toFixed(4), y: +mouse.y.toFixed(4),
            intensity: +_mwInt.toFixed(3), phase: _mwPhase,
        });

        let _hgEls = null, _hgCx = null, _hgCy = null, _hgTop = null, _hgBot = null, _hgAt = NaN;
        let _hgState = null;   // 0 = parked, 1 = pulled; avoids rewriting identical transforms
        function _refreshHeadingRects() {
            if (!_hgEls) {
                _hgEls = Array.prototype.slice.call(document.querySelectorAll('h1, h2'));
                _hgCx = new Float64Array(_hgEls.length); _hgCy = new Float64Array(_hgEls.length);
                _hgTop = new Float64Array(_hgEls.length); _hgBot = new Float64Array(_hgEls.length);
                _hgState = new Int8Array(_hgEls.length).fill(-1);
            }
            for (let i = 0; i < _hgEls.length; i++) {
                const r = _hgEls[i].getBoundingClientRect();
                _hgCx[i] = r.left + r.width / 2; _hgCy[i] = r.top + r.height / 2;
                _hgTop[i] = r.top; _hgBot[i] = r.bottom;
            }
            _hgAt = currentScrollY;
        }
        window._wtInvalidateHeadingRects = () => { _hgAt = NaN; };

        function _pointerPass(nowMs) {
            if (!_ptrSeen) return;
            if (!_cursorDotEl) {
                _cursorDotEl  = document.getElementById('cursor-dot');
                _cursorRingEl = document.getElementById('cursor-ring');
                _cursorGlowEl = document.getElementById('cursor-trail-glow');
            }
            const xpx = _ptrX + 'px', ypx = _ptrY + 'px';

            if (_ptrDirty) {
                _ptrDirty = false;
                _cursorDotEl.style.left = xpx; _cursorDotEl.style.top = ypx;
                if (_cursorLabelEl) { _cursorLabelEl.style.left = xpx; _cursorLabelEl.style.top = ypx; }
                if (_cursorGlowEl)  { _cursorGlowEl.style.left  = xpx; _cursorGlowEl.style.top  = ypx; }

                // Heading gravity — same distances, same forces, same easings. The rect refresh
                // normally happens in the scroll pass's read phase; this is the belt-and-braces case
                // where the pointer moved on a frame that ran no scroll pass at a new scroll offset.
                if (_hgEls && _hgAt !== currentScrollY) _refreshHeadingRects();
                const vh = window.innerHeight, maxDist = 260;
                for (let i = 0; _hgEls && i < _hgEls.length; i++) {
                    if (_hgTop[i] > vh || _hgBot[i] < 0) continue;
                    const dx = _ptrX - _hgCx[i], dy = _ptrY - _hgCy[i];
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const h = _hgEls[i];
                    if (dist < maxDist) {
                        const force = (maxDist - dist) / maxDist;
                        h.style.transform  = `translate(${dx * force * 0.07}px, ${dy * force * 0.045}px)`;
                        if (_hgState[i] !== 1) { h.style.transition = 'transform 0.35s cubic-bezier(0.16,1,0.3,1)'; _hgState[i] = 1; }
                    } else if (_hgState[i] !== 0) {
                        h.style.transform  = 'translate(0px,0px)';
                        h.style.transition = 'transform 0.8s cubic-bezier(0.16,1,0.3,1)';
                        _hgState[i] = 0;
                    }
                }
            }

            // Ring: the sample from ~40ms ago.
            if (_ringCount) {
                const want = nowMs - _RING_LAG;
                let bi = -1;
                for (let k = 1; k <= _ringCount; k++) {
                    const idx = ((_ringHead - k) % _RH + _RH) % _RH;
                    if (_ringHist[idx * 5] <= want) { bi = idx * 5; break; }
                }
                if (bi < 0) bi = (((_ringHead - _ringCount) % _RH + _RH) % _RH) * 5;
                const tx = `translate(-50%,-50%) translate(${_ringHist[bi+1]}px,${_ringHist[bi+2]}px) rotate(${_ringHist[bi+3]}rad) scaleX(${_ringHist[bi+4]})`;
                if (tx !== _ringLastTx) { _cursorRingEl.style.transform = tx; _ringLastTx = tx; }
            }

            // Trail glow: fades out 200ms after the pointer stops. Was a clearTimeout + setTimeout on
            // every single mouse event; it is now a timestamp comparison.
            if (_cursorGlowEl) {
                const want = _glowWanted && (nowMs - _lastMoveT) < 200;
                if (want !== _glowActive) { _cursorGlowEl.classList.toggle('active', want); _glowActive = want; }
                if (!want) _glowWanted = false;
            }
        }

        // 3D cursor trail particles — spawned once per frame rather than per input event, so the
        // spawn rate no longer depends on the pointer's polling rate (at 120Hz it used to emit twice
        // as many as the 150-slot buffer could hold, overwriting live particles).
        function _spawnTrailForFrame() {
            if (_isMobileAnim || isModalOpen || !camera || mouseVelocity <= 2.0) return;
            _spawnVec.set(mouseParallax.x, mouseParallax.y, 0.5).unproject(camera);
            _spawnDir.copy(_spawnVec).sub(camera.position).normalize();
            _spawnPos.copy(camera.position).addScaledVector(_spawnDir, 15);
            for (let i = 0; i < 3; i++) spawnTrailParticle(_spawnPos.x, _spawnPos.y, _spawnPos.z);
        }

        function setupDOMInteractions() {
            // body.hovering only drives #cursor-ring and #cursor-dot, and both are display:none at
            // <=1024px — so on a phone these two listeners on each of ~70 elements (140 registrations)
            // existed to toggle a class with no rule that could apply. Tapping a button on a touch
            // device does fire a synthetic mouseenter, so they were even running. Desktop unchanged.
            if (!_isMobileAnim) {
                const ringEl = document.getElementById('cursor-ring');
                document.querySelectorAll('.interactable, input, textarea, button, a').forEach(el => {
                    el.addEventListener('mouseenter', () => document.body.classList.add('hovering'));
                    el.addEventListener('mouseleave', () => {
                        document.body.classList.remove('hovering');
                        ringEl.style.transform = ringEl.style.transform.replace(/scaleX\([^)]*\)/, 'scaleX(1)');
                        _ringLastTx = ringEl.style.transform;
                    });
                });
            }
            // Magnetic nav links
            document.querySelectorAll('.nav-link').forEach(link => {
                link.addEventListener('mousemove', (e) => {
                    const rect = link.getBoundingClientRect();
                    const dx = (e.clientX - rect.left - rect.width/2) * 0.25;
                    const dy = (e.clientY - rect.top  - rect.height/2) * 0.25;
                    link.style.transform = `translate(${dx}px, ${dy}px)`;
                });
                link.addEventListener('mouseleave', () => { link.style.transform = 'translate(0px, 0px)'; });
            });
            // Nav link wipe transition
            document.querySelectorAll('.nav-link').forEach(link => {
                link.addEventListener('click', (e) => {
                    const href = link.getAttribute('href');
                    if (!href || !href.startsWith('#')) return;
                    e.preventDefault();
                    const wipe = document.getElementById('page-wipe');
                    wipe.classList.add('page-wipe-active');
                    setTimeout(() => {
                        const target = document.querySelector(href);
                        if (target) target.scrollIntoView({ behavior: 'instant' });
                        wipe.classList.remove('page-wipe-active');
                    }, 350);
                });
            });
            // The `.magnetic` block that used to sit here was a duplicate of setupMagneticButtons(),
            // which init() calls a few lines later. Both bound a mousemove to the same wrappers and
            // both wrote the inner button's transform; because this one was registered first, its
            // 0.4-scaled value was overwritten by the other's 0.15 on every single event. Removing it
            // changes nothing visually and halves the handler count on those elements.
        }

        // Pre-allocated fog color palette (avoids per-frame Color allocations)
        const _fogPalette = [
            { color: new THREE.Color('#020204'), density: 0.012 },
            { color: new THREE.Color('#030109'), density: 0.010 },
            { color: new THREE.Color('#020208'), density: 0.011 },
            { color: new THREE.Color('#040203'), density: 0.013 },
        ];

        const _isMobileAnim = window.innerWidth < 1024;

        // ── Perf: per-frame caches (avoid layout reads / DOM lookups every frame) ──
        let _frameNo = 0, _maxScroll = 0, _elsCached = false, _vigEl = null, _grEl = null;
        let _lastVigOp = '', _lastGrOp = '';
        // ── Adaptive quality — OPT-IN via ?adaptive=1. Dynamic resolution to hold framerate on weak devices.
        //    Capable devices never change. EASY TO REMOVE: delete this block + the _adaptive* calls in animate(). ──
        const __WT_QS = new URLSearchParams(location.search);
        // ?adaptive=1 shows the badge. The governor itself runs for every visitor either way.
        const __WT_ADAPTIVE_BADGE = __WT_QS.get('adaptive') === '1';
        // ?noadaptive=1 pins the tier and stops the governor acting; ?qtier=N forces a tier. The
        // gallery has had both for a while and this page had neither, which meant the governor's own
        // cost could not be separated from the scene's here, and "did the image change?" could not be
        // answered at all — a comparison is only valid with the tier held still on both sides.
        const __WT_ADAPTIVE = __WT_QS.get('noadaptive') !== '1';
        {
            const forced = parseInt(__WT_QS.get('qtier') || '', 10);
            if (Number.isFinite(forced) && forced >= 0 && forced <= _qTiers.length - 1) {
                _qLevel = forced;
                // _applyQuality is hoisted but it dereferences `renderer`, which is assigned inside
                // init(). Guarded rather than assumed, because whether this block evaluates before or
                // after init() is exactly the kind of ordering this file has been bitten by; the
                // ?qtier= verification below confirms the tier really does take effect.
                if (renderer) _applyQuality();
            }
        }
        // Tier state (_qTiers / _qBloom / _qSamples / _qLevel / _qGood / _fpsT0 / _fpsFrames) is
        // declared above _syncComposerSize — see the note there. The extra bottom tier exists because
        // these multiply _baseDpr, so raising the desktop cap also raised the floor.
        let _qBadge = null;
        // Ceilings match Gallery.html and must stay equal to the setPixelRatio() call in init() —
        // this value is what the tiers below multiply, so if the two drift apart the governor
        // silently rescales the page the first time it acts.
        // Both read the single _targetDpr() helper so they cannot drift; it is re-evaluated on a
        // real resize (rotation, window drag, split screen) because the pixel budget depends on the
        // viewport, not just on devicePixelRatio.
        let _baseDpr = _targetDpr();

        // ══════════════════════════════════════════════════════════════════════════════════════════
        //  NEVER RENDER BELOW NATIVE RESOLUTION.  This is the pixelation fix.
        // ══════════════════════════════════════════════════════════════════════════════════════════
        // The tiers above are a SUPERSAMPLING dial, not a resolution dial. Giving back supersampling
        // (DPR 2 -> 1.4) costs a little sharpness. Going below 1.0 is categorically different: the
        // scene is then rendered at fewer pixels than the display has and stretched back up, which
        // does not read as "slightly soft", it reads as broken.
        //
        // Multiplied raw, the old tiers did exactly that:
        //     DPR 1 monitor : 1.00  0.85  0.70  0.55  0.42   <- 42% of native on a 1080p desktop
        //     DPR 2 laptop  : 2.00  1.70  1.40  1.10  0.84
        //     DPR 3 phone   : 3.00  2.55  2.10  1.65  1.26
        // A DPR-1 display is the WORST case, not the exempt one the old comment claimed, because it
        // has no supersampling to surrender — every tier below the first is straight downsampling.
        // Measured on this machine (RTX 3050, real D3D11, not SwiftShader) the governor walked a
        // 1512x982 DPR-2 viewport down to an effective 0.84 within a second of load and stayed there.
        //
        // Clamping at 1.0 means a DPR-1 display now has no resolution lever at all — correct, since
        // there was never anything there to give. If such a device still cannot hold framerate the
        // answer has to be less GPU work, not fewer pixels than the screen.
        function _effectiveDpr() {
            return Math.max(1, _baseDpr * _qTiers[_qLevel]);
        }

        // ── The tiers reduce WORK, not only pixels ─────────────────────────────────────────────────
        // Resolution was the governor's only lever, and on a DPR-1 display it has no lever at all once
        // clamped at native. Two further axes (declared with the tier state above) let a tier drop
        // still buy framerate there.
        //
        //  _qBloom  — bloom ladder scale in CSS pixels. Bloom is a low-frequency glow; at 0.35 the
        //             first mip is 35% of CSS width instead of 50%, which is half the fragment work
        //             through the whole five-level chain. It is genuinely hard to see on a glow whose
        //             own radius is 0.8 — and it only ever applies on a device that is already failing.
        //  _qSamples — MSAA sample count. A 4x multisampled RGBA16F colour buffer is 32 bytes per
        //             pixel plus a 4x depth-stencil at 16, PER composer target, and there are two of
        //             them — so this is mostly a memory-bandwidth lever, which is exactly the lever a
        //             laptop iGPU (sharing ~50-70GB/s with the CPU) and a phone need. At the deep tiers
        //             the buffer is being upscaled anyway, so a 4-sample resolve inside it is smeared
        //             back out by the upscale.
        //             It stops at 2, never 0. Dropping to 0 removes edge antialiasing outright, and
        //             CLAUDE.md is explicit that the extruded logo's bevels are the thin high-contrast
        //             edges that even 2x leaves crawling — going to none would be a visible regression,
        //             which is not a trade worth making on a device that is already struggling.

        function _applyQuality() {
            if (!renderer) return;
            _bloomScale = _qBloom[_qLevel];
            renderer.setPixelRatio(_effectiveDpr());
            // The composer caches its OWN pixel ratio at construction and multiplies every setSize()
            // by it. Without re-stating it here the render targets stay at the original resolution, so
            // a tier drop shrinks the canvas and softens the image without reducing any of the work —
            // paying the visual cost of a downgrade for none of the framerate.
            _syncComposerSize();
        }
        function _adaptiveInit() {
            _qBadge = document.createElement('div');
            _qBadge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99990;font:600 11px/1.4 ui-monospace,monospace;letter-spacing:0.06em;color:#d8b4fe;background:rgba(2,2,4,0.72);border:1px solid rgba(216,180,254,0.35);border-radius:8px;padding:5px 9px;pointer-events:none;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);';
            _qBadge.textContent = 'ADAPTIVE 100%';
            document.body.appendChild(_qBadge);
        }
        // The governor must not judge the scene until the scene has settled.
        // Boot costs real time that has nothing to do with steady-state capability: seven texture
        // uploads, PMREM environment generation, twenty-two shader programs linked, the first
        // allocation of two full-resolution MSAA targets plus the transmission target, and the
        // cinematic fly-in. Measured on real hardware those produce individual frames of hundreds of
        // milliseconds, so the first one-second windows report single-digit fps.
        //
        // Fed to the old logic that meant `fps < 30` -> drop TWO tiers, twice in a row, so a machine
        // that was never struggling was on the bottom tier about a second after load — and then
        // needed three consecutive windows above 58fps to climb one step back, on a display that is
        // vsync-locked near 60 where a single hitch resets the counter. In practice it never climbed.
        // That, not the steady-state cost, is why a capable machine looked soft.
        let _warmUntil = 0;          // set when the preloader hands off
        let _qFrames = 0;            // frames seen since warm-up ended
        let _qChanges = 0, _qLastFps = 0, _qWasRestored = false;

        // ── The same three suspensions the gallery got, plus graduated recovery ──────────────────
        // The counters above were added to find out whether this governor thrashed too. It did, and
        // worse: measured on an Iris Xe laptop at 1638x944 dpr 1.75 it reported
        //
        //     gov tier 4/4  base 1.75  AT FLOOR  changes 4  win 49fps  good 0
        //     canvas 1638x944  effDPR 1.00 << BELOW NATIVE
        //
        // i.e. it had ratcheted to the bottom tier and could not get back out, because 49fps sits in
        // the 44-52 dead band where neither counter accumulates. Two causes, identical to the gallery:
        //
        //  1. THE GOVERNOR WAS ITS OWN TRIGGER. A tier change disposes and rebuilds two HalfFloat MSAA
        //     colour+depth pairs, the five-level bloom ladder and the transmission target. That stall
        //     lands inside the very next 1-second window, which reads below 44 and descends again.
        //  2. A TRANSIENT WAS TREATED AS A VERDICT. A scroll burst legitimately costs frames and is
        //     over in well under a second; judging inside it descends for a condition that has ended.
        //
        // And a third, specific to being stuck: with a single ascent rule at >= 52fps, a machine that
        // steadies at 45-51 can never climb, so one bad moment is permanent for the session.
        // _COOL_MS is 500, not the gallery's 2000, because the stall was MEASURED rather than guessed.
        // Frame intervals immediately after each tier change, on the Iris Xe at 1638x944@1.75:
        //
        //   0->1  [8.4, 58.2, 41.8, ...]   worst 58ms
        //   1->2  [8.4, 100,  8.3,  ...]   worst 100ms
        //   2->3  [8.3, 66.5, 8.4,  ...]   worst 67ms
        //   4->3  [16.8, 25,  16.8, ...]   worst 25ms
        //
        // One frame, 25-100ms, and the frame after it is already normal. 500ms is a 5x margin on the
        // worst of those. The first version of this used 2000 and it cost real quality: a genuinely
        // weak laptop took 19.2s to reach its sustainable tier instead of 9.9s, i.e. ten extra seconds
        // at ~25fps on first load, which is a regression in the exact case the governor exists for.
        const _COOL_MS      = 500;
        const _HOLD_TAIL_MS = 600;    // after the last moving frame: lets the scroll settle
        const _HOLD_MAX_MS  = 4000;   // a hold this long is no longer a transient — see _adaptiveHold
        // Two ascent paths. The fast one is the original rule and means "clear headroom". The slow one
        // is what lets a 45-51fps machine recover at all: same direction, much more evidence required.
        const _ASC_CLEAR = 52, _ASC_CLEAR_N = 3;
        const _ASC_SLOW  = 48, _ASC_SLOW_N  = 8;
        // A climb undone within this long was not recovery, it was a mis-prediction.
        const _PROBE_JUDGE_MS = 15000;
        let _coolUntil = 0, _holdUntil = 0, _holdSince = 0, _qBad = 0, _qLastChangeAt = 0;
        let _qClimbedFrom = -1, _qClimbedAt = 0;
        const _qNoClimb = _qTiers.map(() => false);   // tiers proven unsustainable this session

        // ── What a tier actually costs, so recovery cannot become oscillation ────────────────────
        // The first version of this used probe-with-backoff and MEASURED BADLY: it oscillated 3->2->3
        // twice, because holding tier 3 forgave the tier-2 failure and immediately re-authorised it.
        // Backoff was the wrong shape — the question is not "how long since it failed" but "can this
        // framerate afford the next tier at all".
        //
        // That is computable. Returns the factor by which frame time grows going from `from` to `to`
        // (`to` being higher quality, i.e. the lower index), so fps/ratio is the framerate the higher
        // tier would land at. Both terms matter and both are already in the tier tables:
        //
        //   pixels — the DPR is clamped at 1.0, so on some displays two tiers are IDENTICAL in
        //            resolution. At base 1.75 (a common laptop) tiers 3 and 4 both clamp to 1.0, which
        //            makes 4 -> 3 free in pixel terms; the clamp has to be applied here or the cost is
        //            overstated and a free climb gets vetoed.
        //   MSAA   — multiplies the bandwidth of the composer's colour+depth pair, a large share of
        //            this page's frame but not all of it. Counted at quarter weight rather than
        //            pretending it is linear; that is an estimate and is deliberately conservative.
        function _tierCostRatio(from, to) {
            const dFrom = Math.max(1, _baseDpr * _qTiers[from]);
            const dTo   = Math.max(1, _baseDpr * _qTiers[to]);
            const px = (dTo * dTo) / (dFrom * dFrom);
            const aa = 1 + 0.25 * (_qSamples[to] / _qSamples[from] - 1);
            return px * aa;
        }

        function _adaptiveArm(nowMs) {
            _warmUntil = nowMs + 2500; _fpsT0 = 0; _fpsFrames = 0; _qFrames = 0;
            // Evidence gathered before a stall says nothing about what follows it. Warm-up, tab
            // restore and context restore all come through here, so all three discard the sample.
            _qGood = 0; _qBad = 0; _coolUntil = 0; _holdUntil = 0; _holdSince = 0;
            // A pending probe verdict is also void — the restore, not the tier, would be judging it.
            _qClimbedFrom = -1;
            // And a tier written off earlier deserves a fresh opinion: a tab restore or a context
            // restore means the situation has changed, which is precisely when an old verdict is wrong.
            for (let i = 0; i < _qNoClimb.length; i++) _qNoClimb[i] = false;
        }

        // Called from animate() while the visitor is moving. Not an unconditional "suspend while
        // scrolling": this page is scroll-driven, so that would mean a device which only struggles
        // while scrolling is never protected. The hold expires after _HOLD_MAX_MS of CONTINUOUS
        // interaction — long past any burst, well before a weak device suffers.
        function _adaptiveHold(nowMs) {
            if (!_holdSince) _holdSince = nowMs;
            if (nowMs - _holdSince < _HOLD_MAX_MS) _holdUntil = nowMs + _HOLD_TAIL_MS;
        }
        // Read-only diagnostic, matching the gallery's. No behaviour depends on it.
        window.__wtQuality = () => ({
            tier: _qLevel, tiers: _qTiers.length - 1, dpr: +_effectiveDpr().toFixed(3), baseDpr: +_baseDpr.toFixed(3),
            bloom: _bloomScale, msaa: _qSamples[_qLevel], changes: _qChanges,
            sinceChangeMs: _qLastChangeAt ? Math.round(performance.now() - _qLastChangeAt) : null,
            lastFps: +_qLastFps.toFixed(1), good: _qGood, bad: _qBad,
            // Which tiers have been proven unsustainable, and the cost of the next climb — so a page
            // sitting below native DPR can say WHY it is not climbing rather than just that it isn't.
            noClimb: _qNoClimb.map((v, i) => v ? i : -1).filter(i => i >= 0),
            nextCost: _qLevel > 0 ? +_tierCostRatio(_qLevel, _qLevel - 1).toFixed(2) : null,
            holdMs: _holdSince ? Math.round(performance.now() - _holdSince) : 0,
            state: !__WT_ADAPTIVE ? 'pinned'
                 : performance.now() < _warmUntil ? 'warming'
                 : performance.now() < _coolUntil ? 'cooling'
                 : performance.now() < _holdUntil ? 'held' : 'judging',
            restored: _qWasRestored,
        });

        function _adaptiveTick(nowMs) {
            if (!__WT_ADAPTIVE) return;   // ?noadaptive=1 — tier pinned, governor inert
            // Four reasons not to judge — hand-off, warm-up, the cooldown after a change, and an
            // interaction in progress — and every one of them also DISCARDS the partial sample.
            // Carrying frames across a suspension is what let a window that was half scroll-burst and
            // half idle be judged as one steady framerate.
            if (_warmUntil === 0 || nowMs < _warmUntil || nowMs < _coolUntil || nowMs < _holdUntil) {
                _fpsT0 = 0; _fpsFrames = 0; return;
            }
            _fpsFrames++; _qFrames++;
            if (_fpsT0 === 0) { _fpsT0 = nowMs; return; }
            if (nowMs - _fpsT0 < 1000) return;
            const fps = _fpsFrames * 1000 / (nowMs - _fpsT0);
            _fpsT0 = nowMs; _fpsFrames = 0;
            _qLastFps = fps;

            // Descend one tier at a time. The old two-tier jump below 30fps existed to react quickly,
            // but combined with the boot windows above it was what slammed capable machines to the
            // floor.
            let changed = false;
            if (fps < 44) {
                // Confirmed descent in the marginal band. A single bad window used to be enough, and
                // since a tier change stalls the NEXT window, the first descent caused the second.
                // A good window resets the count, so only sustained trouble moves the tier.
                //
                // The exception is a window under 30fps taken while the visitor is genuinely IDLE:
                // there is nothing happening to blame it on, and the hold has already excluded every
                // moving frame, so act at once. Requiring _holdSince === 0 is what keeps that safe —
                // during a long scroll, where the 4s cap has let judgement resume mid-movement, the
                // reading could be the movement itself, so that path still needs two windows.
                _qGood = 0;
                const urgent = fps < 30 && _holdSince === 0;
                if ((urgent || ++_qBad >= 2) && _qLevel < _qTiers.length - 1) {
                    // If this undoes a climb made moments ago, the affordability estimate was wrong
                    // for that tier on this hardware. Do not attempt it again this session: one failed
                    // probe is a tolerable cost, a repeating one IS the oscillation. Cleared by
                    // _adaptiveArm, so a tab restore or context restore gets a fresh opinion.
                    if (_qClimbedFrom >= 0 && _qLevel + 1 === _qClimbedFrom && nowMs - _qClimbedAt < _PROBE_JUDGE_MS) {
                        _qNoClimb[_qLevel] = true;
                    }
                    _qClimbedFrom = -1;
                    _qLevel++; _qBad = 0; changed = true;
                }
            } else if (fps >= _ASC_SLOW) {
                // Recovery. Climb threshold is 52 for the fast path, not 58: a 1-second sample of a
                // vsync-locked 60Hz display routinely measures 57-59, so 58 made recovery depend on
                // luck. The 48 path exists because a machine that steadies at 45-51 could never climb
                // at all under a single 52 rule — which is exactly how this page ended up pinned at
                // tier 4/4 with effDPR 1.00 and no way back.
                _qBad = 0;
                _qGood++;
                const target = _qLevel - 1;
                const clear = fps >= _ASC_CLEAR;
                // Do not attempt a tier this framerate cannot afford — that is not recovery, it is a
                // guaranteed descent one window later. Skipped on the CLEAR path because above ~52fps
                // on a 60Hz display the sample is vsync-limited and carries no headroom information at
                // all, so there is nothing to predict from; that path stays the original rule.
                const affordable = clear || (target >= 0 && fps / _tierCostRatio(_qLevel, target) >= 44);
                // A tier that has already failed needs clear headroom AND three times the evidence.
                const need = clear ? (target >= 0 && _qNoClimb[target] ? _ASC_CLEAR_N * 3 : _ASC_CLEAR_N)
                                   : _ASC_SLOW_N;
                const allowed = target >= 0 && affordable && (clear || !_qNoClimb[target]);
                if (_qGood >= need && allowed) {
                    _qClimbedFrom = _qLevel; _qClimbedAt = nowMs;
                    _qLevel--; _qGood = 0; changed = true;
                }
                // A climb that has held past the probe window stops being a pending verdict.
                if (_qClimbedFrom >= 0 && nowMs - _qClimbedAt >= _PROBE_JUDGE_MS) _qClimbedFrom = -1;
            } else {
                // The 44-48 dead band decides nothing. Decay both counters rather than resetting, so
                // one isolated hitch does not erase accumulated evidence in either direction.
                if (_qGood > 0) _qGood--;
                if (_qBad  > 0) _qBad--;
            }
            if (changed) {
                _applyQuality(); _qChanges++; _qLastChangeAt = nowMs;
                _coolUntil = nowMs + _COOL_MS;
                _fpsT0 = 0; _fpsFrames = 0;   // the rebuild is not part of the next measurement
            }
            if (_qBadge) {
                const eff = _effectiveDpr();
                _qBadge.textContent = 'ADAPTIVE tier ' + _qLevel + '/' + (_qTiers.length - 1)
                    + ' · dpr ' + eff.toFixed(2) + (eff >= _baseDpr ? ' (native)' : '')
                    + ' · ' + Math.round(fps) + 'fps'
                    + ' · ' + _qChanges + ' chg';
            }
        }

        // ══════════════════════════════════════════════════════════════════════════════════════════
        //  ON-DEVICE DIAGNOSTIC  —  add ?perf=1 to the URL
        // ══════════════════════════════════════════════════════════════════════════════════════════
        // Turns "it feels buggy" into numbers taken on the device that actually feels buggy, which is
        // the only place the answer lives. Everything here is behind the flag; with the flag absent the
        // whole block costs one URLSearchParams read at boot and one `if` per frame.
        //
        // It deliberately reports frame PACING, not just average fps — a page that averages 58fps but
        // drops a 120ms frame every second feels far worse than a steady 45, and average fps hides
        // exactly that. It also prints the effective DPR next to the CSS viewport and the canvas
        // buffer, so "is it rendering below my screen's resolution" is answerable at a glance.
        //
        // Availability, honestly: EXT_disjoint_timer_query_webgl2 gives true GPU time per frame on
        // Chrome/Edge/Android but is NOT implemented in Safari, so on an iPhone the GPU row reads n/a
        // and the CPU-vs-GPU split has to be inferred from jsMs against frameMs instead. Safari 17+
        // also masks WEBGL_debug_renderer_info down to a generic string. Both still leave enough.
        const __WT_PERF = new URLSearchParams(location.search).get('perf') === '1';
        let _pf = null;
        function _perfInit() {
            const el = document.createElement('div');
            el.id = 'wt-perf';
            el.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;font:600 10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;'
                + 'color:#dff;background:rgba(0,0,0,0.82);padding:6px 8px;margin:6px;border:1px solid rgba(140,220,255,0.45);border-radius:6px;'
                + 'white-space:pre;pointer-events:auto;max-width:calc(100vw - 24px);overflow:auto;-webkit-user-select:all;user-select:all;'
                + 'text-align:left;letter-spacing:0;text-transform:none;';
            el.title = 'Tap/click to copy';
            el.addEventListener('click', () => {
                const t = el.textContent;
                if (navigator.clipboard) navigator.clipboard.writeText(t).then(
                    () => { el.style.borderColor = '#7f7'; }, () => {});
            });
            document.body.appendChild(el);
            let gl = null, ext = null, renderer_ = '?', vendor_ = '?';
            try {
                gl = renderer && renderer.getContext ? renderer.getContext() : null;
                if (gl) {
                    const d = gl.getExtension('WEBGL_debug_renderer_info');
                    renderer_ = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
                    vendor_ = d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
                    ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') || gl.getExtension('EXT_disjoint_timer_query');
                }
            } catch (e) {}
            // renderer.info is per-RENDER-CALL and auto-resets at the start of each one. Under
            // EffectComposer the last render call of a frame is the final full-screen ShaderPass, so
            // reading it afterwards reports `calls: 1, triangles: 2` — not slightly wrong, wrong by two
            // orders of magnitude. Turning autoReset off makes it accumulate across every pass in the
            // frame; we then reset it ourselves once per frame, in _perfFrameStart.
            if (renderer) renderer.info.autoReset = false;
            _pf = {
                el, gl, ext, renderer_: String(renderer_).slice(0, 74), vendor_: String(vendor_).slice(0, 34),
                dt: [], js: [], gpu: [], last: 0, lastPaint: 0, q: [], worstEver: 0, startedAt: performance.now(),
                calls: 0, tris: 0,
            };
        }
        // Render targets, enumerated and measured rather than inferred. renderer.info reports texture
        // and geometry counts but says nothing about render targets, which on this page are the
        // largest single allocation and the thing a tier change rebuilds — so their count and
        // dimensions are the row that makes a governor change visible on a real device.
        function _perfTargets() {
            const out = [];
            const add = (name, rt) => { if (rt && rt.width) out.push(name + ' ' + rt.width + 'x' + rt.height + (rt.samples ? '@' + rt.samples + 'x' : '')); };
            if (composer) { add('cmp1', composer.renderTarget1); add('cmp2', composer.renderTarget2); }
            if (bloomPass) {
                add('bloomB', bloomPass.renderTargetBright);
                (bloomPass.renderTargetsHorizontal || []).forEach((rt, i) => add('bH' + i, rt));
                (bloomPass.renderTargetsVertical || []).forEach((rt, i) => add('bV' + i, rt));
            }
            return out;
        }
        function _perfFrameStart(nowMs) {
            if (!_pf) return;
            // Capture the PREVIOUS frame's accumulated totals, then reset for this one. With
            // autoReset off these have summed every pass of the frame just finished, which is the
            // number that means something.
            if (renderer) { _pf.calls = renderer.info.render.calls; _pf.tris = renderer.info.render.triangles; renderer.info.reset(); }
            if (_pf.last) {
                const d = nowMs - _pf.last;
                // A gap this long is not a frame. Backgrounding the tab parks the loop entirely, so
                // the first delta on return spans the whole absence — this panel reported
                // `worst 119374ms`, i.e. two minutes, presented as the worst frame of the session.
                // The handlers that park the loop also zero _pf.last, which covers the normal case;
                // this is the backstop for any other discontinuity (context loss, a long alert).
                if (d < 5000) {
                    _pf.dt.push(d);
                    if (d > _pf.worstEver) _pf.worstEver = d;
                    if (_pf.dt.length > 240) _pf.dt.shift();
                }
            }
            _pf.last = nowMs;
            // Open a GPU timer for this frame where the extension exists. One in flight at a time —
            // querying every frame is itself a cost, and a disjoint result must be discarded anyway.
            if (_pf.ext && _pf.q.length === 0 && (_frameNo & 7) === 0) {
                try {
                    const g = _pf.gl, e = _pf.ext;
                    const qy = g.createQuery ? g.createQuery() : e.createQueryEXT();
                    if (g.beginQuery) g.beginQuery(e.TIME_ELAPSED_EXT, qy); else e.beginQueryEXT(e.TIME_ELAPSED_EXT, qy);
                    _pf.q.push(qy); _pf.open = true;
                } catch (err) { _pf.ext = null; }
            }
        }
        function _perfFrameEnd(jsMs) {
            if (!_pf) return;
            _pf.js.push(jsMs);
            if (_pf.js.length > 240) _pf.js.shift();
            if (_pf.ext && _pf.open) {
                try {
                    const g = _pf.gl, e = _pf.ext;
                    if (g.endQuery) g.endQuery(e.TIME_ELAPSED_EXT); else e.endQueryEXT(e.TIME_ELAPSED_EXT);
                    _pf.open = false;
                } catch (err) { _pf.ext = null; _pf.open = false; }
            }
            // Harvest any finished GPU query.
            if (_pf.ext && _pf.q.length && !_pf.open) {
                try {
                    const g = _pf.gl, e = _pf.ext, qy = _pf.q[0];
                    const avail = g.getQueryParameter ? g.getQueryParameter(qy, g.QUERY_RESULT_AVAILABLE)
                                                      : e.getQueryObjectEXT(qy, e.QUERY_RESULT_AVAILABLE_EXT);
                    const disjoint = g.getParameter(e.GPU_DISJOINT_EXT);
                    if (avail) {
                        if (!disjoint) {
                            const ns = g.getQueryParameter ? g.getQueryParameter(qy, g.QUERY_RESULT)
                                                           : e.getQueryObjectEXT(qy, e.QUERY_RESULT_EXT);
                            _pf.gpu.push(ns / 1e6);
                            if (_pf.gpu.length > 60) _pf.gpu.shift();
                        }
                        if (g.deleteQuery) g.deleteQuery(qy); else e.deleteQueryEXT(qy);
                        _pf.q.shift();
                    }
                } catch (err) { _pf.ext = null; }
            }
            // Repaint the panel twice a second so the panel itself is not the thing being measured.
            if (_pf.last - _pf.lastPaint < 500) return;
            _pf.lastPaint = _pf.last;
            const q = (a, p) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
            const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
            const dt = _pf.dt, secs = dt.length ? dt.reduce((x, y) => x + y, 0) / 1000 : 1;
            const over17 = dt.filter(v => v > 16.7).length, over33 = dt.filter(v => v > 33.4).length, over50 = dt.filter(v => v > 50).length;
            const cvs = document.getElementById('webgl-canvas');
            const eff = cvs ? cvs.width / window.innerWidth : 0;
            const info = renderer ? renderer.info : null;
            // MEDIAN, not mean. A single outlier (a 500ms+ boot frame) is enough to push a mean above
            // its own p90, which this panel actually printed — an arithmetically impossible-looking
            // pair, and a misleading number to sit next to a framerate.
            const jsMean = mean(_pf.js), dtMean = mean(dt);
            const gpuP50 = q(_pf.gpu, 0.5);
            const gpuTxt = _pf.gpu.length ? 'p50 ' + gpuP50.toFixed(1) + 'ms  p90 ' + q(_pf.gpu, 0.9).toFixed(1)
                                            + 'ms  (' + _pf.gpu.length + ' samples)'
                                          : (_pf.ext ? 'sampling…' : 'n/a on this browser');
            const bound = _pf.gpu.length
                ? (gpuP50 > dtMean * 0.6 ? 'GPU-BOUND' : (jsMean > dtMean * 0.6 ? 'CPU-BOUND' : 'vsync / mixed'))
                : (jsMean > dtMean * 0.6 ? 'CPU-BOUND' : 'GPU or vsync (no GPU timer)');
            _pf.el.textContent =
                'KIASA perf  (tap to copy)\n'
              + 'gpu    ' + _pf.vendor_ + ' / ' + _pf.renderer_ + '\n'
              + 'screen ' + window.innerWidth + 'x' + window.innerHeight + ' css  dpr ' + (window.devicePixelRatio || 1)
                          + '  ' + (screen.width + 'x' + screen.height) + ' screen\n'
              + 'canvas ' + (cvs ? cvs.width + 'x' + cvs.height : '-') + '  effDPR ' + eff.toFixed(2)
                          + (eff + 0.001 < (window.devicePixelRatio || 1) ? '  << BELOW NATIVE' : '  (native or better)') + '\n'
              + 'fps    ' + (dtMean ? (1000 / dtMean).toFixed(1) : '0') + '\n'
              + 'frame  mean ' + dtMean.toFixed(1) + '  p90 ' + q(dt, 0.9).toFixed(1) + '  p95 ' + q(dt, 0.95).toFixed(1)
                          + '  p99 ' + q(dt, 0.99).toFixed(1) + 'ms\n'
              // Labelled separately: this is SESSION-wide while every other frame figure is the
              // rolling window. Unlabelled it read as the worst frame of the last few seconds.
              + 'worst  ' + _pf.worstEver.toFixed(0) + 'ms  (whole session, usually a boot/compile frame)\n'
              + 'hitch  >16.7ms ' + over17 + '  >33ms ' + over33 + '  >50ms ' + over50
                          + '   (last ' + secs.toFixed(0) + 's, ' + dt.length + ' frames)\n'
              + 'js     mean ' + jsMean.toFixed(2) + 'ms  p95 ' + q(_pf.js, 0.95).toFixed(1) + '  p99 ' + q(_pf.js, 0.99).toFixed(1) + 'ms\n'
              + 'gputime ' + gpuTxt + '\n'
              + 'verdict ' + bound + '\n'
              + (() => { const Q = window.__wtQuality();
                  return 'gov    tier ' + Q.tier + '/' + Q.tiers + '  ' + Q.state
                          + (Q.tier === Q.tiers ? '  AT FLOOR' : '')
                          + '  changes ' + Q.changes
                          + (Q.sinceChangeMs !== null ? ' (last ' + (Q.sinceChangeMs / 1000).toFixed(1) + 's ago)' : ' (none)')
                          + '  win ' + Q.lastFps.toFixed(0) + 'fps  good ' + Q.good + ' bad ' + Q.bad + '\n'
                       + '       dpr ' + Q.dpr.toFixed(2) + '/' + Q.baseDpr.toFixed(2)
                          + '  bloom ' + (Q.bloom * 100).toFixed(0) + '%  msaa ' + Q.msaa + 'x'
                          + (Q.nextCost !== null ? '  next tier costs ' + Q.nextCost + 'x frame time' : '  at top tier')
                          + (Q.noClimb.length ? '  wont-try ' + Q.noClimb.join(',') : '')
                          + (Q.holdMs ? '  interacting ' + (Q.holdMs / 1000).toFixed(1) + 's' : '')
                          + (Q.restored ? '\n       TAB WAS RESTORED — the first seconds after are not representative' : '') + '\n'; })()
              + 'rtargs ' + (() => { const r = _perfTargets(); return r.length + '   ' + r.join('  '); })() + '\n'
              + 'draws  ' + _pf.calls + '  tris ' + _pf.tris
                          + '  progs ' + (info ? info.programs.length : '?') + '\n'
              + 'mem    tex ' + (info ? info.memory.textures : '?') + '  geo ' + (info ? info.memory.geometries : '?')
                          + (performance.memory ? '  jsHeap ' + (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + 'MB' : '') + '\n'
              + 'uptime ' + ((performance.now() - _pf.startedAt) / 1000).toFixed(0) + 's'
                          + (window.__lenis ? '  lenis:on' : '  lenis:OFF');
        }

        // ══════════════════════════════════════════════════════════════════════════════════════════
        //  THE PAGE'S ONE ANIMATION LOOP
        // ══════════════════════════════════════════════════════════════════════════════════════════
        // There used to be two: three.js's renderer.setAnimationLoop(animate), plus a second bare rAF
        // loop whose only job was to call lenis.raf(). Two callbacks per frame, and because `animate`
        // was registered first, the scene rendered using the scroll position Lenis would only advance
        // afterwards — every frame reacted to the previous frame's scroll. Driving Lenis from the top
        // of this one loop removes the extra callback and closes that one-frame gap.
        //
        // The loop stays alive even when the WebGL context is lost or rendering is otherwise off,
        // because Lenis's integrator and the batched scroll/pointer passes hang off it.
        let _renderEnabled = true;   // false only while the GL context is dead
        let _loopRunning = false;
        function _frame(time) {
            if (!_loopRunning) return;
            window.__WT_FRAMES = _frameNo;   // read by the dev verification harness; costs nothing
            requestAnimationFrame(_frame);
            // ?perf=1 only. The jsStart timestamp is taken here and read again at the very end of the
            // frame, so `js` is the page's own work and the remainder of the frame interval is
            // compositing plus GPU wait — which is what makes CPU-bound vs GPU-bound distinguishable
            // without a GPU timer (iOS Safari has none).
            const _pStart = _pf ? performance.now() : 0;
            if (_pf) _perfFrameStart(time);
            if (window.__lenis) window.__lenis.raf(time);
            if (_renderEnabled) animate(time);
            else {
                // Keep the DOM half of the page working without touching the dead context.
                _frameNo++;
                if (_maxScroll === 0 || (_frameNo & 31) === 0) _maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
                if (_scrollDirty) { _scrollDirty = false; triggerReveals(); }
                _pointerPass(time);
            }
            if (_pf) _perfFrameEnd(performance.now() - _pStart);
        }
        function _startLoop() { if (_loopRunning) return; _loopRunning = true; requestAnimationFrame(_frame); }
        function _stopLoop()  { _loopRunning = false; }

        function animate(time) {
            _frameNo++;
            // The governor itself runs for EVERY visitor. It used to be inside `if (__WT_ADAPTIVE)`,
            // i.e. only with ?adaptive=1 in the URL — so in production the page had no frame-rate
            // protection whatsoever.
            // The badge is gated on __WT_ADAPTIVE_BADGE, NOT on __WT_ADAPTIVE. Those were the same flag
            // until ?noadaptive=1 was added, at which point __WT_ADAPTIVE became true by default — so
            // this line would have put the debug badge on the page for every visitor.
            if (__WT_ADAPTIVE_BADGE && !_qBadge) _adaptiveInit();
            _adaptiveTick(time);
            const t = time * 0.001;

            // Perf: cache maxScroll (reading scrollHeight forces a layout) — refresh ~2x/sec, not every frame.
            // This has to happen BEFORE the scroll pass, which now reads _maxScroll instead of taking
            // its own forced layout for the two progress indicators.
            if (_maxScroll === 0 || (_frameNo & 31) === 0) _maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);

            // Drain the frame's scroll and pointer work — once, batched, reads before writes.
            if (_scrollDirty) { _scrollDirty = false; triggerReveals(); }
            _pointerPass(time);

            scrollVelocity = currentScrollY - lastScrollY;
            lastScrollY    = currentScrollY;
            const progress  = _maxScroll > 0 ? Math.max(0, Math.min(currentScrollY/_maxScroll, 1)) : 0;

            // Cinematic fly-in owns the camera until it converges — stepped here so the page keeps a
            // single animation loop (it used to drive itself from its own rAF chain).
            if (_flyInArmed && _flyInStep) _flyInStep();

            // Skip camera override during cinematic fly-in
            const cinematicDone = window._cinematicEntryDone ? window._cinematicEntryDone() : true;

            // ── Interaction hold for the adaptive governor ─────────────────────────────────────
            // Placed HERE because scrollVelocity is only resolved a few lines above and cinematicDone
            // on the line above that. scrollVelocity is px per FRAME (currentScrollY - lastScrollY),
            // not per second, so 0.5 is about 30px/s at 60fps — deliberately low, to catch the tail of
            // a Lenis glide rather than only fast bursts. Lenis writes fractional scroll values, so
            // the settle is visible in this number.
            // `time` is the rAF timestamp, the same clock and origin _adaptiveTick(time) is fed.
            //
            // The fly-in is deliberately NOT a hold reason, though it was in the first version. Boot is
            // already excluded by the warm window, so counting it here double-excludes it — and worse,
            // it keeps _holdSince non-zero, which disables the urgent path during precisely the seconds
            // a weak machine most needs it. Measured: the first descent moved from ~9.5s to 11.2s and
            // the tier took 19.2s to settle instead of 9.9s. The fly-in is also only a camera lerp; it
            // adds no draw cost, and a machine that cannot render during it cannot render after it
            // either (this laptop measured 24.7fps at tier 0 sustained, not just during the fly-in).
            if (Math.abs(scrollVelocity) > 0.5 || isModalOpen) _adaptiveHold(time);
            else if (time > _holdUntil) _holdSince = 0;   // genuinely stopped: fresh continuous-hold clock
            if (cinematicDone) {
                const targetZ = isModalOpen ? (20 - progress*TUNNEL_DEPTH) - 5 : (20 - progress*TUNNEL_DEPTH);
                camera.position.z += (targetZ - camera.position.z) * 0.1;
                camera.position.x  = mouseParallax.x * 2.0;
                camera.position.y  = mouseParallax.y * 2.0;
            }
            {
                const baseFov = _isMobileAnim ? 36 : 35;
                const targetFOV = isModalOpen ? 30 : (baseFov + Math.min(Math.abs(scrollVelocity)*0.15, 25));
                const _fovStep = (targetFOV - camera.fov) * 0.1; camera.fov += _fovStep;
                if (Math.abs(_fovStep) > 0.001) camera.updateProjectionMatrix();
            }

            // Mobile only: advance the touch-follow warp before the uniform is read. No-op on desktop.
            _mwStep();
            if (masterPass) {
                masterPass.uniforms.uTime.value = t; masterPass.uniforms.uMouse.value.copy(mouse);
                masterPass.uniforms.uWarp.value = _MWARP_FOLLOW ? _mwInt : 1;
                clickChromaDecay *= 0.88;
                const chromaTarget = Math.max(-50, Math.min(50, scrollVelocity)) + clickChromaDecay;
                masterPass.uniforms.uScrollVelocity.value += (chromaTarget - masterPass.uniforms.uScrollVelocity.value) * 0.1;
            }

            // ---- Audio reactive (simulated) ----
            let bass = 0, mid = 0;
            {
                bass = (Math.sin(t * 1.3) * 0.5 + 0.5) * 0.6;
                mid  = (Math.sin(t * 2.1 + 1.2) * 0.5 + 0.5) * 0.5;
                if (ringMesh) ringMesh.material.emissiveIntensity = 2.0 + bass * 4.0;
                if (particles && particles.material) particles.material.size = 0.08 + mid * 0.06;
                // Fit the whole brand — the wordmark and the ring around it —
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
                const _wmSpan = Math.max(WORDMARK_SIZE.width, ringMesh ? ringMesh.geometry.parameters.radius * 2 : 0);
                const _wmVisibleW = (2 * Math.tan(35 * Math.PI / 360) * 45) * camera.aspect;
                const _wmFitScale = Math.min(1, (_wmVisibleW * 0.9) / _wmSpan);
                const baseScale = _wmFitScale;
                const audioScale = baseScale * (1.0 + bass * 0.04);
                logoGroup.scale.setScalar(logoGroup.scale.x + (audioScale - logoGroup.scale.x) * 0.15);
            }

            // ---- Scene color shift by scroll section (uses pre-allocated _fogPalette) ----
            {
                const fogIdx = Math.min(Math.floor(progress * _fogPalette.length), _fogPalette.length - 1);
                const fogNext = Math.min(fogIdx + 1, _fogPalette.length - 1);
                const fogT    = (progress * _fogPalette.length) - fogIdx;
                scene.fog.color.lerpColors(_fogPalette[fogIdx].color, _fogPalette[fogNext].color, fogT);
                const targetDensity = _fogPalette[fogIdx].density + (_fogPalette[fogNext].density - _fogPalette[fogIdx].density) * fogT;
                scene.fog.density += (targetDensity - scene.fog.density) * 0.05;
            }

            // ---- Camera micro-shake on fast scroll ----
            {
                const absVel = Math.abs(scrollVelocity);
                if (absVel > 8) {
                    cameraShakeX = (Math.random() - 0.5) * absVel * 0.00025;
                    cameraShakeY = (Math.random() - 0.5) * absVel * 0.00025;
                } else {
                    cameraShakeX *= 0.82;
                    cameraShakeY *= 0.82;
                }
                const tunnelRoll = Math.sin(progress * Math.PI * 3) * 0.025;
                camera.rotation.z = cameraShakeX + tunnelRoll;
                // ASSIGN, do not accumulate. The line above sets roll absolutely each frame; pitch
                // used `+=`, so every frame added the shake term on top of the previous frame's
                // total and nothing ever brought it back. cameraShakeY is a signed random, so it
                // random-walks rather than cancelling: a burst of fast scrolling leaves the horizon
                // permanently tilted, and because the fly-in only zeroes pitch once at the end of
                // the entry there is no path that ever corrects it for the rest of the session.
                // The fly-in owns pitch until entryDone, so hold off while it is still running.
                if (window.__wtEntryDone !== false) camera.rotation.x = cameraShakeY * 0.3;
            }

            // Reel video plays at native 1x speed — no dynamic rate changes
            // (changing playbackRate every frame forces constant re-buffering)

            // W logo: centered at rest, drifts + orbits on scroll
            let lX = Math.max(0, (WORDMARK_SIZE.width - 4.8) * 0.22), lY = Math.sin(t * 0.6) * 0.3;
            let lZ = camera.position.z - 25;
            if (isModalOpen) {
                lX = 10; lY = 0;
            } else if (progress > 0.02) {
                lX = Math.sin(progress * Math.PI * 5) * 7;
                lY = Math.cos(progress * Math.PI * 3) * 3 + Math.sin(t * 0.6) * 0.4;
            }
            logoGroup.position.x += ((lX + mouseParallax.x * 1.5) - logoGroup.position.x) * 0.04;
            logoGroup.position.y += ((lY + mouseParallax.y * 1.5) - logoGroup.position.y) * 0.04;
            logoGroup.position.z += (lZ - logoGroup.position.z) * 0.08;
            logoGroup.rotation.y  = Math.sin(t*0.5)*0.15 + mouseParallax.x*0.1;
            logoGroup.rotation.x  = mouseParallax.y * 0.2;
            logoGroup.rotation.z  = Math.cos(t*0.3) * 0.1;

            // ── Fog culling ───────────────────────────────────────────────────────────────────────
            // The same argument the particle field uses, applied to the expensive objects. scene.fog
            // is FogExp2 at density 0.012, so transmittance is exp(-(0.012 d)^2): 0.24 at 100 units,
            // 0.039 at 150, 0.003 at 200, 1e-4 at 260. Past ~260 units an object contributes nothing
            // measurable, and anything behind the camera cannot be seen at all (no yaw, only roll and
            // a fractional-degree pitch).
            //
            // This matters far more here than it did for the particles. The orbs and shards are
            // MeshPhysicalMaterial with transmission, the most expensive fragment shader on the page —
            // three.js shades them against a full-resolution mip-mapped backdrop texture. Roughly half
            // the orbs and three of the five portal rings sit outside the visible band at any moment,
            // and every one of them was fully shaded every frame to contribute under 0.5% of its
            // colour. Frustum culling does not catch them: they are inside the frustum, just fogged.
            const _camZ = camera.position.z;
            const _fogNear = _camZ + 30, _fogFar = _camZ - 260;
            const _inFog = z => z <= _fogNear && z >= _fogFar;

            glassOrbs.forEach((orb, i) => {
                orb.visible = _inFog(orb.position.z);
                if (!orb.visible) return;
                orb.rotation.x += 0.002*(i%2===0?1:-1);
                orb.rotation.y += 0.003;
                orb.position.y += Math.sin(t+i)*0.02;
                // The "fake depth of field" that used to be here was writing nothing. All 20 orbs
                // share ONE MeshPhysicalMaterial instance (buildLiquidGlassOrbs creates `mat` once
                // outside the loop), so each frame the value was overwritten 19 times and only the
                // last orb's distance survived — and that material has no `transparent: true`, so
                // even the surviving value did nothing. Removed rather than repaired: making it work
                // needs a material per orb plus transparency, which changes how the orbs read, and
                // that is a deliberate art-direction call rather than a bug fix. Deleting it costs
                // nothing visually and drops 20 pointless writes per frame.
            });

            glassShards.forEach((shard, i) => {
                if (!_inFog(shard.position.z)) { shard.visible = false; return; }
                shard.rotation.x += shard.userData.rotSpeed.x;
                shard.rotation.y += shard.userData.rotSpeed.y;
                shard.rotation.z += shard.userData.rotSpeed.z;
                shard.position.y += Math.sin(t * shard.userData.floatSpeed + shard.userData.floatOffset) * 0.008;
                // Fade based on distance to camera
                const dist = Math.abs(shard.position.z - camera.position.z);
                const op = Math.max(0, 0.18 - dist * 0.0005);
                shard.material.opacity = op;
                // Don't submit a draw for a fully faded shard. These are transparent MeshPhysicalMaterial
                // with transmission, so a shard at opacity 0 still cost a sorted transparent draw and a
                // full pass of the most expensive fragment shader in the scene to contribute nothing.
                shard.visible = op > 0.002;
            });

            // Orbiting lights (UPGRADE 1)
            orbitLights.forEach((light, i) => {
                const angle = t * light.userData.speed + light.userData.offset;
                light.position.x = logoGroup.position.x + Math.cos(angle) * light.userData.radius;
                light.position.y = logoGroup.position.y + light.userData.baseY + Math.sin(t * 0.3 + i) * 1.5;
                light.position.z = logoGroup.position.z + Math.sin(angle) * light.userData.radius;
                light.intensity = 2.5 + bass * 4.0;
            });

            // Wireframe icosphere (UPGRADE 2)
            if (wireSphere) {
                wireSphere.position.x += (logoGroup.position.x - wireSphere.position.x) * 0.05;
                wireSphere.position.y += (logoGroup.position.y - wireSphere.position.y) * 0.05;
                wireSphere.position.z += (logoGroup.position.z - wireSphere.position.z) * 0.05;
                wireSphere.rotation.x += 0.003;
                wireSphere.rotation.y += 0.005;
                wireSphere.rotation.z += 0.002;
                wireSphere.material.opacity = 0.05 + bass * 0.12;
                wireSphere.scale.setScalar(1.0 + mid * 0.08);
            }

            // Vignette pulse + God rays.
            // Both are full-viewport layers (#scene-vignette a viewport radial gradient, #god-rays a
            // 120%x130% conic gradient under an infinite rotate) and both had their opacity written
            // from JS every frame — a whole-document style recalculation per frame, forever, plus a
            // `transition: opacity 0.1s` on the vignette that was restarted before it could finish.
            // `bass` cycles in ~4.8s, so between frames it moves by well under a thousandth:
            // quantising writes only when the composited result could differ, and a browser cannot
            // show more precision than that anyway.
            {
                if (!_elsCached) { _vigEl = document.getElementById('scene-vignette'); _grEl = document.getElementById('god-rays'); _elsCached = true; }
                if (_vigEl) {
                    const v = (0.6 + bass * 0.4).toFixed(2);
                    if (v !== _lastVigOp) { _vigEl.style.opacity = v; _lastVigOp = v; }
                }
                if (_grEl) {
                    const g = (0.03 + bass * 0.05 + Math.abs(scrollVelocity) * 0.001).toFixed(3);
                    if (g !== _lastGrOp) { _grEl.style.opacity = g; _lastGrOp = g; }
                }
            }

            if (helixStrand) {
                helixStrand.rotation.y = t * 0.15;
                helixStrand.position.y = Math.sin(t * 0.2) * 3;
                helixStrand.material.opacity = 0.3 + bass * 0.3;
            }

            // W-shape particle pulse every 8 seconds (UPGRADE 10).
            // Desktop only, because on mobile it has never been visible: the only thing that flags
            // `particles.geometry.attributes.position` for re-upload is the turbulence block below,
            // and that block is already desktop-only. So on every phone this loop walked all 2000
            // particles and mutated a buffer the GPU was never told about — for ~1.5 seconds out of
            // every 8, forever, with literally nothing to show for it. Guarding it keeps mobile
            // pixel-for-pixel identical and gives those frames back.
            {
                wPulseTimer += 0.016;
                if (wPulseTimer > 8) wPulseTimer = 0;
                const wPulseStrength = (!_isMobileAnim && wPulseTimer < 1.5) ? Math.sin(wPulseTimer * Math.PI / 1.5) * 0.015 : 0;
                if (wPulseStrength > 0 && particles && particleBasePositions) {
                    const pPos = particles.geometry.attributes.position.array;
                    const wPoints = [
                        [-2.4, 2.0], [-1.2, -2.0], [0.0, 1.0], [1.2, -2.0], [2.4, 2.0]
                    ];
                    for (let i = 0; i < pPos.length; i += 3) {
                        const dist = Math.abs(pPos[i+2] - logoGroup.position.z);
                        if (dist > 30) continue;
                        const wIdx = Math.floor((i / 3) % wPoints.length);
                        const wx = logoGroup.position.x + wPoints[wIdx][0];
                        const wy = logoGroup.position.y + wPoints[wIdx][1];
                        pPos[i]   += (wx - pPos[i])   * wPulseStrength;
                        pPos[i+1] += (wy - pPos[i+1]) * wPulseStrength;
                    }
                }
            }

            // Portal rings (UPGRADE 3)
            portalRings.forEach((ring, i) => {
                ring.visible = _inFog(ring.position.z);
                if (!ring.visible) return;
                ring.rotation.z += ring.userData.rotSpeed;
                ring.material.opacity = 0.08 + Math.sin(t * 1.2 + ring.userData.pulseOffset) * 0.07 + bass * 0.1;
                const camDist = Math.abs(ring.position.z - camera.position.z);
                const scale = Math.max(0.2, 1.0 - camDist * 0.002);
                ring.scale.setScalar(scale);
            });

            // Mirror floor (UPGRADE 9)
            if (mirrorFloor) {
                mirrorFloor.material.opacity = 0.3 + bass * 0.2;
            }

            _spawnTrailForFrame();
            if (trailPoints) {
                // Only re-upload the buffers and draw when a particle is actually alive.
                // buildCursorTrail() runs unconditionally but onMouseMove returns early on mobile,
                // so on every phone trailLife stayed all-zero for the entire session while these two
                // needsUpdate flags still forced a full re-upload of both attributes every frame and
                // the Points object was still drawn — permanent GPU traffic and a draw call for
                // something with nothing in it. On desktop it is the same waste whenever the pointer
                // has been still for a second.
                let alive = false;
                for (let i=0; i<MAX_TRAIL; i++) {
                    if (trailLife[i] > 0) {
                        alive = true;
                        trailLife[i] -= 0.02;
                        const i3=i*3; trailPos[i3]+=trailVel[i3]; trailPos[i3+1]+=trailVel[i3+1]; trailPos[i3+2]+=trailVel[i3+2];
                    }
                }
                if (alive) {
                    trailPoints.visible = true;
                    trailPoints.geometry.attributes.position.needsUpdate = true;
                    trailPoints.geometry.attributes.aLife.needsUpdate    = true;
                } else if (trailPoints.visible) {
                    // One final upload so the last frame's fade-out is committed, then go quiet.
                    trailPoints.geometry.attributes.aLife.needsUpdate = true;
                    trailPoints.visible = false;
                }
            }

            const targetOpacity = isModalOpen ? 0.0 : 1.0;
            projectCards.forEach((card, i) => {
                const d=card.userData, u=uniformsMap[i];
                u.uOpacity.value += (targetOpacity - u.uOpacity.value) * 0.1;
                card.children[0].material.opacity += (targetOpacity - card.children[0].material.opacity) * 0.1;
                if (_isMobileAnim) {
                    // Mobile: static positions, no hover/floating animation, skip uTime (saves shader recompute)
                    card.position.x += (d.baseX - card.position.x) * 0.05;
                    card.position.y += (d.baseY - card.position.y) * 0.05;
                    card.position.z += (d.baseZ - card.position.z) * 0.05;
                } else {
                    u.uTime.value = t;
                    if (i === window.hoveredProjectIndex && !isModalOpen) {
                        u.uHover.value += (1.0 - u.uHover.value) * 0.1;
                        card.position.x += ((d.baseX>0?4:-4) + mouseParallax.x*2 - card.position.x) * 0.1;
                        card.position.y += (mouseParallax.y*2 - card.position.y) * 0.1;
                        card.position.z += ((camera.position.z - 18) - card.position.z) * 0.1;
                        card.rotation.y += (mouseParallax.x*0.5 - card.rotation.y) * 0.1;
                        card.rotation.x += (-mouseParallax.y*0.5 - card.rotation.x) * 0.1;
                        card.scale.setScalar(card.scale.x + (1.2 - card.scale.x) * 0.1);
                    } else {
                        u.uHover.value += (0.0 - u.uHover.value) * 0.1;
                        card.position.x += (d.baseX - card.position.x) * 0.05;
                        card.position.y += ((d.baseY + Math.cos(t+i)*0.3) - card.position.y) * 0.05;
                        card.position.z += (d.baseZ - card.position.z) * 0.05;
                        card.rotation.y += (d.baseRotY + Math.sin(t*0.5+i)*0.05 - card.rotation.y) * 0.05;
                        card.rotation.x += (0 - card.rotation.x) * 0.05;
                        card.scale.setScalar(card.scale.x + (1.0 - card.scale.x) * 0.1);
                    }
                }
            });

            // Turbulence field (UPGRADE 4) — desktop only.
            //
            // The most expensive JavaScript loop on the page: 2000 particles x (three sines, three
            // cosines, a square root) every frame — ~12,000 transcendental calls per frame, 720,000
            // per second at 60fps — and it ran over the whole field wherever the camera was.
            //
            // It now integrates only the particles that can actually be seen, which is provably a
            // strict subset. The field spans z = +20 to about -680; the camera walks 20 to -580
            // looking down -z, so:
            //   * pz above the camera is BEHIND it. The camera has no yaw, only roll and a
            //     fractional-degree pitch, so it can never come into frame (+40 slack for the near
            //     plane and the mouse parallax offset).
            //   * pz more than 260 units ahead is erased by fog first. FogExp2 at density 0.012 has
            //     transmittance exp(-(0.012 d)^2): 0.24 at 100 units, 0.039 at 150, 0.003 at 200,
            //     1e-4 at 260. Against a 0.6-opacity additive material that is not sub-pixel, it is
            //     nothing.
            // Culled particles hold position rather than resetting, and the window is deep enough
            // that one has hundreds of frames to resume drifting before it could be seen — the spring
            // toward particleBasePositions is what would have moved them anyway.
            if (!_isMobileAnim && particleVelocities && particles) {
                const pPos = particles.geometry.attributes.position.array;
                const count3 = pPos.length;
                const camZ = camera.position.z;
                const zNear = camZ + 40, zFar = camZ - 260;
                // Loop invariants, hoisted: these three were recomputed 2000 times per frame from
                // values that cannot change inside the loop.
                const repelX = mouseParallax.x * 18, repelY = mouseParallax.y * 18;
                const repelRadius = 12;
                for (let i = 0; i < count3; i += 3) {
                    const pz0 = pPos[i+2];
                    if (pz0 > zNear || pz0 < zFar) continue;
                    const px = pPos[i], py = pPos[i+1], pz = pz0;
                    const nx = Math.sin(px * 0.15 + t * 0.3) * Math.cos(pz * 0.1 + t * 0.2);
                    const ny = Math.cos(py * 0.15 + t * 0.25) * Math.sin(px * 0.1 + t * 0.15);
                    const nz = Math.sin(pz * 0.1 + t * 0.2) * Math.cos(py * 0.12 + t * 0.3);
                    particleVelocities[i]   += nx * 0.0008;
                    particleVelocities[i+1] += ny * 0.0008;
                    particleVelocities[i+2] += nz * 0.0006;
                    particleVelocities[i]   *= 0.98;
                    particleVelocities[i+1] *= 0.98;
                    particleVelocities[i+2] *= 0.98;
                    pPos[i]   += particleVelocities[i];
                    pPos[i+1] += particleVelocities[i+1];
                    pPos[i+2] += particleVelocities[i+2];
                    const bi = i;
                    pPos[i]   += (particleBasePositions[bi]   - pPos[i])   * 0.001;
                    pPos[i+1] += (particleBasePositions[bi+1] - pPos[i+1]) * 0.001;
                    pPos[i+2] += (particleBasePositions[bi+2] - pPos[i+2]) * 0.001;
                    const rdx = pPos[i]   - repelX;
                    const rdy = pPos[i+1] - repelY;
                    const rdz = pPos[i+2] - camZ;
                    // Reject on the squared distance before paying for the square root — only the
                    // handful of particles inside a 12-unit sphere ever need the real length.
                    const rd2 = rdx*rdx + rdy*rdy + rdz*rdz;
                    if (rd2 < 144 && rd2 > 0.0001) {
                        const rdist = Math.sqrt(rd2);
                        const force = ((repelRadius - rdist) / repelRadius) * 0.04;
                        particleVelocities[i]   += (rdx / rdist) * force;
                        particleVelocities[i+1] += (rdy / rdist) * force;
                    }
                }
                particles.geometry.attributes.position.needsUpdate = true;
            }
            if (bokehParticles) bokehParticles.position.z = Math.sin(t*0.5)*10;

            // ---- Dust motes — follow camera, drift slowly ----
            if (dustMotes) {
                dustMotes.position.z = camera.position.z; // always at camera depth
                const dPos = dustMotes.geometry.attributes.position.array;
                for (let i = 0; i < dPos.length; i += 3) {
                    dPos[i]   += Math.sin(t * 0.18 + i * 0.4) * 0.003;
                    dPos[i+1] += Math.cos(t * 0.12 + i * 0.6) * 0.003 - 0.001; // gentle downward drift
                    if (dPos[i+1] < -9) dPos[i+1] = 9; // wrap top/bottom
                }
                dustMotes.geometry.attributes.position.needsUpdate = true;
                dustMotes.material.opacity = 0.25 + bass * 0.15;
            }

            // ---- Constellation lines between nearby particles (throttled to every 2nd frame: O(n^2) + slow-moving = imperceptible) ----
            if (constellationLines && particles && (_frameNo & 1) === 0) {
                const pPos   = particles.geometry.attributes.position.array;
                const lPos   = constellationLines.geometry.attributes.position.array;
                const maxLines = lPos.length / 6;
                let lineCount = 0;
                const camZ    = camera.position.z;
                // Sample a small subset of particles for perf
                const step = 12;
                outer: for (let i = 0; i < pPos.length / 3 && lineCount < maxLines; i += step) {
                    if (Math.abs(pPos[i*3+2] - camZ) > 40) continue;
                    for (let j = i + step; j < pPos.length / 3 && lineCount < maxLines; j += step) {
                        if (Math.abs(pPos[j*3+2] - camZ) > 40) continue;
                        const dx = pPos[i*3]-pPos[j*3], dy = pPos[i*3+1]-pPos[j*3+1], dz = pPos[i*3+2]-pPos[j*3+2];
                        const dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
                        if (dist < 6.0) {
                            const l6 = lineCount * 6;
                            lPos[l6]   = pPos[i*3];   lPos[l6+1] = pPos[i*3+1]; lPos[l6+2] = pPos[i*3+2];
                            lPos[l6+3] = pPos[j*3];   lPos[l6+4] = pPos[j*3+1]; lPos[l6+5] = pPos[j*3+2];
                            lineCount++;
                        }
                    }
                }
                constellationLines.geometry.attributes.position.needsUpdate = true;
                constellationLines.geometry.setDrawRange(0, lineCount * 2);
                constellationLines.material.opacity = 0.08 + (mid || 0) * 0.1;
            }

            if (composer) composer.render(); else renderer.render(scene, camera);
        }

        // ==========================================
        // UPGRADE 1: Magnetic button physics
        // ==========================================
        function setupMagneticButtons() {
            document.querySelectorAll('.magnetic').forEach(el => {
                el.addEventListener('mousemove', e => {
                    const r = el.getBoundingClientRect();
                    const cx = r.left + r.width/2, cy = r.top + r.height/2;
                    const dx = e.clientX - cx, dy = e.clientY - cy;
                    el.style.transform = `translate(${dx*0.35}px, ${dy*0.35}px)`;
                    const inner = el.querySelector('button, a');
                    if (inner) inner.style.transform = `translate(${dx*0.15}px, ${dy*0.15}px)`;
                });
                el.addEventListener('mouseleave', () => {
                    el.style.transform = '';
                    const inner = el.querySelector('button, a');
                    if (inner) inner.style.transform = '';
                    el.style.transition = 'transform 0.5s cubic-bezier(0.16,1,0.3,1)';
                    setTimeout(() => el.style.transition = '', 500);
                });
            });
        }

        // ==========================================
        // UPGRADE 2: 3D card tilt
        // ==========================================
        function setupCardTilt() {
            document.querySelectorAll('.h-project').forEach(card => {
                card.addEventListener('mousemove', e => {
                    const r = card.getBoundingClientRect();
                    const x = (e.clientX - r.left) / r.width - 0.5;
                    const y = (e.clientY - r.top)  / r.height - 0.5;
                    card.style.transform = `perspective(800px) rotateY(${x*12}deg) rotateX(${-y*10}deg) scale(1.02)`;
                    card.style.transition = 'transform 0.1s ease';
                });
                card.addEventListener('mouseleave', () => {
                    card.style.transform = '';
                    card.style.transition = 'transform 0.6s cubic-bezier(0.16,1,0.3,1)';
                });
            });
        }

        // ==========================================
        // Cursor gravity on headings
        // ==========================================
        function setupHeadingGravity() {
            // Runs inside _pointerPass now — see the cached-centres note there. Kept as a named
            // no-op so the desktop-only setup list in init() still reads as the inventory of
            // desktop behaviours rather than silently losing one.
            _refreshHeadingRects();
        }

        // ==========================================
        // UPGRADE 9: Manifesto word reveal
        // ==========================================
        function setupManifestoReveal() {
            const el = document.querySelector('.manifesto-text');
            if (!el) return;
            const words = el.textContent.trim().split(/\s+/);
            el.innerHTML = words.map((w,i) =>
                `<span class="m-word" style="--i:${i}">${w} </span>`
            ).join('');
            const io = new IntersectionObserver(entries => {
                entries.forEach(e => {
                    if (e.isIntersecting) { e.target.classList.add('revealed'); io.unobserve(e.target); }
                });
            }, { threshold: 0.2 });
            io.observe(el);
        }

        // ==========================================
        // Reel Section Clickable (opens modal)
        // ==========================================
        function setupCursorMorphing() {
            // Reel section — no modal, just background video
        }

        // ==========================================
        // Staggered Project Card Entrance
        // ==========================================
        function setupCardEntrance() {
            const cards = document.querySelectorAll('.h-project');
            const io = new IntersectionObserver((entries) => {
                entries.forEach((entry, i) => {
                    if (entry.isIntersecting) {
                        setTimeout(() => entry.target.classList.add('card-visible'), i * 120);
                        io.unobserve(entry.target);
                    }
                });
            }, { threshold: 0.15, rootMargin: '0px' });
            cards.forEach(c => io.observe(c));
        }

        // ==========================================
        // Real-Time Singapore Clock
        // ==========================================
        function setupSingaporeClock() {
            const el = document.getElementById('dubai-time');
            if (!el) return;
            function update() {
                const now = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' });
                el.textContent = now;
            }
            update();
            setInterval(update, 30000);
        }

        // ==========================================
        // UI Sound Effects
        // ==========================================
        function setupUISounds() {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            let sfxEnabled = true;

            function playTone(freq, dur, vol) {
                if (window.__wtSfxOn && !window.__wtSfxOn()) return;
                if (!sfxEnabled) return;
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
                gain.gain.setValueAtTime(vol, audioCtx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(); osc.stop(audioCtx.currentTime + dur);
            }

            // Hover sound on nav links
            document.querySelectorAll('.nav-link, .m-link').forEach(el => {
                el.addEventListener('mouseenter', () => playTone(1200, 0.06, 0.03));
            });
            // Click sound on buttons
            document.querySelectorAll('button, .submit-btn, .h-project-click').forEach(el => {
                el.addEventListener('click', () => playTone(800, 0.1, 0.04));
            });
            // Section transition sound.
            // This used to walk seven ids on every scroll event — seven getElementById lookups and
            // seven getBoundingClientRect calls, i.e. roughly half of the 51 layout reads per event
            // this page was doing, to decide whether to play a 0.15s beep. The batched scroll pass
            // already measures exactly those seven sections and tracks which one straddles the
            // viewport centre, so it just calls this when that changes.
            _uiSoundTone = () => playTone(600, 0.15, 0.02);

            // Tie to mute button.
            // Read the class AT PLAY TIME rather than caching it on click. The cached version was
            // always stale: setupSoundToggle's own click handler removes/adds `muted` inside a
            // promise callback (audio.play() resolves asynchronously), and this handler ran first,
            // so it sampled the class from before the toggle took effect. The two handlers raced on
            // every click and sfxEnabled settled permanently wrong — the UI sounds were simply off.
            // Nothing to keep in sync if it is never stored.
            const muteBtn = document.getElementById('sound-toggle');
            window.__wtSfxOn = () => !(muteBtn && muteBtn.classList.contains('muted'));

            // Resume AudioContext on interaction
            document.addEventListener('click', () => {
                if (audioCtx.state === 'suspended') audioCtx.resume();
            }, { once: true });
        }

        // ==========================================
        // Cursor Trail Glow
        // ==========================================
        function setupCursorTrailGlow() {
            // Runs inside _pointerPass now. This was two separate document-level mousemove listeners,
            // the second of which cleared and created a fresh 200ms setTimeout on every event.
        }

        // ==========================================
        // Cinematic Camera Fly-In on Load
        // ==========================================
        function setupCinematicEntry() {
            if (!camera) return;
            const isMobile = window.innerWidth < 1024;

            // Mobile: start closer so scene isn't fogged out
            const startZ = isMobile ? -30 : -200;
            const startY = isMobile ? 3 : 8;
            const speed  = isMobile ? 0.06 : 0.025;

            camera.position.z = startZ;
            camera.position.y = startY;
            camera.rotation.x = isMobile ? -0.03 : -0.1;
            // Tell animate() that the fly-in owns camera pitch until this finishes, so its
            // per-frame absolute assignment does not fight the entry's decay.
            window.__wtEntryDone = false;

            const targetZ = 20;
            const targetY = 0;
            let entryDone = false;

            // Stepped from animate(), not from a requestAnimationFrame loop of its own.
            // Measured, this was a genuine SECOND animation loop running alongside the renderer for
            // the first ~4 seconds of every visit — precisely the window in which textures are
            // uploading and shader programs are being compiled, so the least affordable moment to be
            // paying for an extra rAF callback and a second pass over the camera. Both loops ran at
            // the same rAF cadence, so stepping it here is arithmetically identical: same easing, same
            // 0.5-unit convergence test, same handover of pitch to animate().
            _flyInStep = () => {
                if (entryDone) return;
                const dz = targetZ - camera.position.z;
                const dy = targetY - camera.position.y;
                camera.position.z += dz * speed;
                camera.position.y += dy * (speed * 1.2);
                camera.rotation.x *= 0.96;

                if (Math.abs(dz) < 0.5) {
                    camera.position.z = targetZ;
                    camera.position.y = targetY;
                    camera.rotation.x = 0;
                    entryDone = true;
                    window.__wtEntryDone = true;   // hand pitch back to animate()
                    _flyInStep = null;
                }
            };

            // Start fly-in after preloader fades
            setTimeout(() => { _flyInArmed = true; }, 800);
            // Store reference so animate() doesn't override during fly-in
            window._cinematicEntryDone = () => entryDone;
        }
        let _flyInStep = null, _flyInArmed = false;

        // ==========================================
        // Stats Re-Count on Re-Entry
        // ==========================================
        function setupStatsRecount() {
            const nums = document.querySelectorAll('.stat-num');
            const io = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const el = entry.target;
                        const target = parseInt(el.dataset.target, 10);
                        const dur = target > 999 ? 2200 : 1400;
                        const start = performance.now();
                        el.textContent = '0';
                        const tick = (now) => {
                            const p = Math.min((now - start) / dur, 1);
                            const ease = 1 - Math.pow(1 - p, 3);
                            el.textContent = Math.floor(ease * target);
                            if (p < 1) requestAnimationFrame(tick);
                            else el.textContent = target;
                        };
                        requestAnimationFrame(tick);
                    }
                });
            }, { threshold: 0.3 });
            nums.forEach(n => io.observe(n));
        }

        // ==========================================
        // Text Split Letter Animation for Kickers
        // ==========================================
        function setupTextSplitKickers() {
            const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (prefersReduced) return;

            document.querySelectorAll('.kicker').forEach(el => {
                const text = el.textContent.trim();
                el.innerHTML = text.split('').map((c, i) => {
                    if (c === ' ') return `<span class="split-char sp" style="transition-delay:${i * 0.025}s"> </span>`;
                    return `<span class="split-char" style="transition-delay:${i * 0.025}s">${c}</span>`;
                }).join('');
            });

            const io = new IntersectionObserver(entries => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        e.target.classList.add('split-revealed');
                        io.unobserve(e.target);
                    }
                });
            }, { threshold: 0.5 });
            document.querySelectorAll('.kicker').forEach(el => io.observe(el));
        }

        // ==========================================
        // Touch Swipe for Mobile Project Cards
        // ==========================================
        function setupTouchSwipe() {
            // No-op. The work track is NOT natively swipeable: #work-wrapper is a 500vh section and
            // the strip is translated horizontally from vertical scroll progress, so there is no
            // touch gesture to handle. This comment used to claim the track "uses native horizontal
            // scroll-snap", which is wrong — measured scrollWidth <= clientWidth and
            // scroll-snap-type: none — and that claim nearly caused Lenis to be told to ignore touch
            // across the whole section.
            return;
        }

        // ==========================================
        // Haptic Feedback on Interactions
        // ==========================================
        function setupHapticFeedback() {
            if (!navigator.vibrate) return;
            document.querySelectorAll('button, .submit-btn, .h-project, .bento-item').forEach(el => {
                el.addEventListener('click', () => navigator.vibrate(8));
            });
            document.querySelectorAll('.nav-link, .faq-question, .t-dot, .m-link').forEach(el => {
                el.addEventListener('click', () => navigator.vibrate(5));
            });
        }

        // ==========================================
        // Lazy Load Background Images
        // ==========================================
        function setupLazyBackgrounds() {
            const io = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const el = entry.target;
                        const bg = el.getAttribute('data-lazy-bg');
                        if (bg) {
                            el.style.backgroundImage = `url('${bg}')`;
                            el.removeAttribute('data-lazy-bg');
                        }
                        io.unobserve(el);
                    }
                });
            }, { rootMargin: '200px' });

            // Observe project cards that are off-screen
            document.querySelectorAll('.h-project[data-bg]').forEach((card, i) => {
                if (i > 2) { // lazy load cards 4-7
                    const bg = card.style.backgroundImage.replace(/url\(['"]?([^'"]+)['"]?\)/, '$1');
                    card.setAttribute('data-lazy-bg', bg);
                    card.style.backgroundImage = 'none';
                    io.observe(card);
                }
            });
        }

        // ==========================================
        // Contact submission -> /api/lead.php (validated + stored server-side)
        // ==========================================
        window.submitForm = function() {
            const btn = document.getElementById('submit-btn');
            const errEl = document.getElementById('form-error');
            const name = document.getElementById('form-name').value.trim();
            const email = document.getElementById('form-email').value.trim();
            const phone = document.getElementById('form-phone').value.trim();
            const service = document.getElementById('form-service').value;
            const budget = document.getElementById('form-budget').value;
            const message = document.getElementById('form-message').value.trim();
            const company = (document.getElementById('form-company')||{}).value?.trim() || '';
            const website = (document.getElementById('form-website')||{}).value?.trim() || '';
            const honeypot = document.getElementById('form-hp').value;

            errEl.style.display = 'none';

            // Honeypot — bots fill hidden fields
            if (honeypot) return;

            // Validation
            if (!name || name.length < 2) { showErr('Please enter your full name.'); return; }
            if (!company) { showErr('Please enter your company or brand name.'); return; }

            // Email validation
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
            if (!email || !emailRegex.test(email)) { showErr('Please enter a valid email address.'); return; }
            // Block disposable email domains
            const disposable = ['mailinator.com','guerrillamail.com','tempmail.com','throwaway.email','yopmail.com','10minutemail.com','trashmail.com'];
            const emailDomain = email.split('@')[1]?.toLowerCase();
            if (disposable.includes(emailDomain)) { showErr('Please use a real email address.'); return; }

            // Phone validation — country-aware, via Assets/wt-phone.js.
            //
            // The old rule was /^\+?[0-9]{7,15}$/ after stripping spaces, hyphens and parens. It
            // accepted "+9710501234567" (the trunk 0 left in after the country code — the commonest
            // real paste error), accepted any 7 digits from anywhere, and REJECTED "050.902.7130"
            // because dots were never stripped. It also told us nothing about which country the
            // number was from.
            //
            // `phoneE164` is the other half of the job and matters more than the validation: Meta and
            // Google match hashed phone numbers in E.164, so "050 902 7130" hashed as "0509027130"
            // matched nothing at either. It is what gets submitted and what gets passed to wtTrack.
            //
            // Falls back to the old shape if wt-phone.js failed to load — a CDN-free local file, so
            // that is unlikely, but a blocked script must never make the form unsubmittable.
            let phoneE164 = phone.replace(/\D/g, '');
            if (window.wtPhone) {
                const p = window.wtPhone.parse(phone, window.__wtCC ? window.__wtCC.cc() : '971');
                if (!p.ok) { showErr(p.reason); return; }
                phoneE164 = p.e164;
            } else if (!phone || !/^\+?[0-9]{7,15}$/.test(phone.replace(/[\s\-\(\)\.]/g, ''))) {
                showErr('Please enter a valid phone number.'); return;
            }

            if (!service) { showErr('Please select a service.'); return; }
            if (!budget) { showErr('Please select an estimated budget.'); return; }

            function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }

            btn.textContent = 'Sending...';
            btn.disabled = true;

            // Posted to OUR OWN endpoint. There is no third-party form service any more.
            //
            // api/lead.php validates every field server-side, stores the lead in the `leads` table
            // BEFORE attempting delivery, then emails the notification over authenticated SMTP from
            // our own domain. The validation above this line is a courtesy to the visitor; the
            // enforcement is on the server, where it cannot be skipped by anything that bypasses the
            // page. Storing first is what makes a mail outage survivable — the enquiry exists either
            // way, so a lead can no longer be lost to a spam filter.
            //
            // No provider key in this markup: nothing in the page source is a credential now.
            fetch('/api/lead.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({
                    wt_form: 'home',
                    from_name: name,
                    email: email,
                    // E.164 so the owner's inbox shows a dialable international number, and so
                    // it matches what was hashed for Meta/Google.
                    phone: (typeof phoneE164 === 'string' && phoneE164) ? ('+' + phoneE164) : phone,
                    service: service,
                    budget: budget,
                    message: message || '(No additional details)',
                    company: company, website: website,
                    // Country the visitor selected, kept beside the E.164 number — it cannot be
                    // recovered from the digits afterwards (+1 is shared by 20-odd countries).
                    phone_country_iso:  window.__wtCC ? window.__wtCC.iso()  : '',
                    phone_dial_code:    window.__wtCC ? window.__wtCC.dial() : '',
                    phone_country_name: window.__wtCC ? window.__wtCC.name() : '',
                    phone_raw: phone,
                    // Turnstile injects this hidden input into the widget container. The server
                    // verifies it against Cloudflare; the value here proves nothing on its own.
                    'cf-turnstile-response': (document.querySelector('.cf-turnstile [name="cf-turnstile-response"]')||{}).value || '',
                    source_page: location.pathname,
                    // The REAL honeypot value. This was hardcoded to '' for as long as the field has
                    // existed, so the hidden input at #form-hp was decorative: a bot that filled it
                    // still had its submission forwarded. The client-side `if (honeypot) return`
                    // above only stops a bot that runs our JavaScript, which is the one case that
                    // does not need stopping.
                    botcheck: honeypot
                // The campaign that paid for this visitor, captured on their LANDING page by
                // wt-track.js and kept for the session. Reading the query string here instead would
                // attribute nearly every real lead to nothing.
                }, (window.wtUtm ? window.wtUtm() : {})))
            })
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    // Fire the Lead conversion. This panel is a <div> with an onclick button rather
                    // than a real <form>, so no `submit` event is ever dispatched and wt-track.js's
                    // submit delegate — the only thing in the codebase that emits Lead — never ran.
                    // The homepage contact form, the site's main lead-capture path, was producing
                    // zero Lead events browser-side AND zero server-side via CAPI, so Meta campaigns
                    // pointed at it could neither optimise for nor attribute a single conversion,
                    // while /start (a real form) worked. wtTrack dual-fires Pixel + CAPI with one
                    // shared event_id and re-hashes the PII server-side.
                    try {
                        window.wtTrack && window.wtTrack('Lead',
                            { content_name: 'contact_form_home', service: service, budget: budget },
                            { email: String(email).trim().toLowerCase(), phone: phoneE164 });
                    } catch (e) {}
                    btn.textContent = 'Sent ✓';
                    ['form-name','form-email','form-phone','form-message'].forEach(id => document.getElementById(id).value = '');
                    document.querySelectorAll('.custom-select').forEach(cs => cs._reset && cs._reset());
                    setTimeout(() => { btn.textContent = 'Send Dispatch'; btn.disabled = false; }, 3000);
                } else {
                    btn.textContent = 'Failed — Try Again';
                    btn.disabled = false;
                    // Turnstile tokens are single-use; without a reset the corrected resubmission
                    // fails for a reason the visitor has no way to see.
                    try { if (window.turnstile) window.turnstile.reset(); } catch (e) {}
                    // Show the gateway's reason. A changed button label alone told the visitor
                    // nothing about which field it objected to.
                    if (data && data.message) showErr(data.message);
                }
            })
            .catch(() => {
                btn.textContent = 'Failed — Try Again';
                btn.disabled = false;
            });
        };

        // Custom Select Dropdowns
        document.querySelectorAll('.custom-select').forEach(cs => {
            const trigger = cs.querySelector('.custom-select-trigger');
            const label = trigger.querySelector('span');
            const optionEls = cs.querySelectorAll('.custom-select-option');
            const options = Array.from(optionEls);
            const hiddenSelect = cs.closest('.select-group').querySelector('select');
            const placeholder = label.textContent;
            let focusIdx = -1;

            function selectOption(opt) {
                const val = opt.dataset.value;
                label.textContent = opt.textContent;
                cs.classList.add('has-value');
                closeDropdown();
                let existingOpt = hiddenSelect.querySelector(`option[value="${val}"]`);
                if (!existingOpt) {
                    existingOpt = document.createElement('option');
                    existingOpt.value = val;
                    hiddenSelect.appendChild(existingOpt);
                }
                hiddenSelect.value = val;
                options.forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
            }

            function openDropdown() {
                document.querySelectorAll('.custom-select.open').forEach(other => {
                    if (other !== cs) { other.classList.remove('open'); other.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false'); }
                });
                cs.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
                focusIdx = -1;
                options.forEach(o => o.classList.remove('kb-focus'));
            }

            function closeDropdown() {
                cs.classList.remove('open');
                trigger.setAttribute('aria-expanded', 'false');
                focusIdx = -1;
                options.forEach(o => o.classList.remove('kb-focus'));
            }

            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                cs.classList.contains('open') ? closeDropdown() : openDropdown();
            });

            options.forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    selectOption(opt);
                });
            });

            // Keyboard navigation
            trigger.addEventListener('keydown', (e) => {
                // Commit an arrow-key highlight BEFORE the open/close toggle. This branch used to
                // come last, but the toggle above matches 'Enter' unconditionally, so it always won
                // and closeDropdown() reset focusIdx to -1 — the selection branch was dead code and
                // a keyboard user could open the list and move through it but never choose anything,
                // which made the whole contact form unusable without a mouse.
                if (e.key === 'Enter' && focusIdx >= 0 && cs.classList.contains('open')) {
                    e.preventDefault();
                    selectOption(options[focusIdx]);
                } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    cs.classList.contains('open') ? closeDropdown() : openDropdown();
                } else if (e.key === 'Escape') {
                    closeDropdown();
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (!cs.classList.contains('open')) openDropdown();
                    focusIdx = Math.min(focusIdx + 1, options.length - 1);
                    options.forEach(o => o.classList.remove('kb-focus'));
                    options[focusIdx].classList.add('kb-focus');
                    options[focusIdx].scrollIntoView({ block: 'nearest' });
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (!cs.classList.contains('open')) openDropdown();
                    focusIdx = Math.max(focusIdx - 1, 0);
                    options.forEach(o => o.classList.remove('kb-focus'));
                    options[focusIdx].classList.add('kb-focus');
                    options[focusIdx].scrollIntoView({ block: 'nearest' });
                }
            });

            // Enter on focused option
            cs.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && focusIdx >= 0 && cs.classList.contains('open')) {
                    e.preventDefault();
                    selectOption(options[focusIdx]);
                }
            });

            cs._reset = () => {
                label.textContent = placeholder;
                cs.classList.remove('has-value');
                options.forEach(o => o.classList.remove('selected', 'kb-focus'));
                hiddenSelect.value = '';
                trigger.setAttribute('aria-expanded', 'false');
            };
        });

        // Close dropdowns on outside click or Escape
        document.addEventListener('click', () => {
            document.querySelectorAll('.custom-select.open').forEach(cs => {
                cs.classList.remove('open');
                cs.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
            });
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.custom-select.open').forEach(cs => {
                    cs.classList.remove('open');
                    cs.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
                });
            }
        });

        // ==========================================
        // Typed Text Effect — Hero Subtitle
        // ==========================================
        function setupTypedText() {
            const el = document.getElementById('typed-text');
            if (!el) return;
            const words = ['WEB SOLUTIONS', 'IMMERSIVE EXPERIENCES', 'SMART AUTOMATION', 'BRAND SYSTEMS'];
            // An infinitely looping typewriter inside an <h1> is the single most disruptive thing on
            // this page for a reduced-motion visitor, and it never stops. Print the first phrase and
            // leave it alone.
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                el.textContent = words[0];
                return;
            }
            let wordIdx = 0, charIdx = 0, isDeleting = false;

            function tick() {
                const current = words[wordIdx];
                if (!isDeleting) {
                    el.textContent = current.substring(0, charIdx + 1);
                    charIdx++;
                    if (charIdx === current.length) {
                        setTimeout(() => { isDeleting = true; tick(); }, 2200);
                        return;
                    }
                    setTimeout(tick, 70 + Math.random() * 40);
                } else {
                    el.textContent = current.substring(0, charIdx - 1);
                    charIdx--;
                    if (charIdx === 0) {
                        isDeleting = false;
                        wordIdx = (wordIdx + 1) % words.length;
                        setTimeout(tick, 400);
                        return;
                    }
                    setTimeout(tick, 35);
                }
            }

            // Start after preloader finishes
            setTimeout(tick, 2500);
        }

        // ==========================================
        // Retro Pixel Light-Up Footer Watermark
        // ==========================================
        function setupRetroFooter() {
            const wm = document.getElementById('footer-wm');
            if (!wm) return;
            const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (prefersReduced) return;

            const text = wm.textContent.trim();
            wm.textContent = '';
            const chars = [];
            text.split('').forEach(c => {
                const span = document.createElement('span');
                if (c === ' ') { span.innerHTML = '&nbsp;'; } else { span.textContent = c; span.classList.add('retro-char'); }
                wm.appendChild(span);
                if (c !== ' ') chars.push(span);
            });

            const colors = ['rgba(168,85,247,0.9)', 'rgba(139,92,246,0.8)', 'rgba(255,255,255,0.7)', 'rgba(192,132,252,0.85)', 'rgba(99,102,241,0.75)'];

            function spawnPixel() {
                if (chars.length === 0) return;
                const charEl = chars[Math.floor(Math.random() * chars.length)];
                const pixel = document.createElement('span');
                pixel.classList.add('retro-pixel');
                const x = Math.random() * 100;
                const y = 60 + Math.random() * 40;
                pixel.style.left = x + '%';
                pixel.style.bottom = y + '%';
                pixel.style.background = colors[Math.floor(Math.random() * colors.length)];
                pixel.style.boxShadow = `0 0 6px ${pixel.style.background}`;
                const dur = 800 + Math.random() * 1200;
                pixel.style.animation = `pixelRise ${dur}ms ease-out forwards`;
                charEl.appendChild(pixel);
                setTimeout(() => pixel.remove(), dur + 50);
            }

            // Spawn pixels at random intervals.
            // The interval is now started and stopped by the observer instead of running for the whole
            // session with an `if (!active) return` guard inside it. The footer sits at the very bottom
            // of a 14,400px page, so for the overwhelming majority of any visit that guard was waking
            // the main thread 5.6 times a second to decide to do nothing — and it kept doing so in a
            // backgrounded tab, where timers are throttled but not stopped. Tied to visibility as well
            // so a hidden tab parked on the footer does not keep spawning and animating DOM nodes.
            let ticker = null;
            const spawnTick = () => {
                // Spawn 1-3 pixels per tick for subtle randomness
                const count = 1 + Math.floor(Math.random() * 3);
                for (let i = 0; i < count; i++) spawnPixel();
            };
            let visible = false;
            const sync = () => {
                const want = visible && !document.hidden;
                if (want && !ticker) ticker = setInterval(spawnTick, 180);
                else if (!want && ticker) { clearInterval(ticker); ticker = null; }
            };
            const io = new IntersectionObserver(entries => {
                visible = entries[0].isIntersecting;
                sync();
            }, { threshold: 0.1 });
            io.observe(wm);
            document.addEventListener('visibilitychange', sync);
        }

        // Cursor click ripple
        document.addEventListener('click', (e) => {
            const r = document.createElement('div');
            r.className = 'cursor-ripple';
            r.style.left = e.clientX + 'px';
            r.style.top  = e.clientY + 'px';
            document.body.appendChild(r);
            setTimeout(() => r.remove(), 700);
        });

        // UPGRADE 5: Chromatic aberration burst on click
        document.addEventListener('click', () => {
            clickChromaDecay = 80.0;
        });

        if (window.__WT_LITE) {
            // Lite fallback: skip the WebGL scene + Lenis entirely. Reveal content, native scroll.
            var _pre = document.getElementById('preloader'); if (_pre) _pre.style.display = 'none';
            document.querySelectorAll('.fade-up, .decode-text, .hero-center-label, .h-project, .h-project-inner')
                .forEach(function(el){ el.classList.add('in-view', 'card-visible'); });
            var _tt = document.getElementById('typed-text'); if (_tt && !_tt.textContent.trim()) _tt.textContent = 'IMMERSIVE EXPERIENCES';
            var _rv = document.querySelector('.reel-video'); if (_rv) { try { _rv.play(); } catch (e) {} }
        } else {
            init();
        }
    // Country selector on the phone field. Mounted once the tracker's phone module is available;
    // it writes the ISO, dial code, raw entry and country name as hidden inputs beside the field.
    (function mountCC(){
        var el = document.getElementById('form-phone');
        if (!el) return;
        if (!window.wtPhone) return void setTimeout(mountCC, 120);   // wt-phone.js is deferred
        window.__wtCC = window.wtPhone.mountSelector(el, { iso: 'AE' });
    })();

    