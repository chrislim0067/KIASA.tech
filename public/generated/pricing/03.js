
        // Stagger reveal
        function wtStagger(sel, step){ const els=document.querySelectorAll(sel); if(!els.length) return; const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){const i=[...els].indexOf(e.target);setTimeout(()=>e.target.classList.add('in-view'), i*step);io.unobserve(e.target);}});},{threshold:0.12}); els.forEach(x=>io.observe(x)); }
        wtStagger('.pricing-card', 110);
        wtStagger('.metric', 90);
        wtStagger('.step', 90);
        wtStagger('.faq-item', 70);
        wtStagger('.testi-card', 120);

        // Hero — cross-fade through real project screenshots
        (function(){
            const box   = document.getElementById('hero-shots');
            const frame = box && box.querySelector('.hero-shots-frame');
            const glow  = box && box.querySelector('.hero-shots-glow');
            const shots = box ? box.querySelectorAll('.hero-shot') : [];
            // Dots live OUTSIDE #hero-shots (see the markup note) — query them by their own id.
            const dots  = document.querySelectorAll('#hero-dots .hero-dot');
            const tag   = document.getElementById('hero-shots-tag');
            if (!box || shots.length < 2) return;
            // Pause across the whole art column so hovering the dots pauses too, not just the case.
            const zone  = box.closest('.mkt-hero-art') || box;

            const reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
            let i = 0, timer = null;

            // Only shot 0 ships with a src; the rest carry data-src so they cannot compete with the
            // LCP image. Hydrating one frame before it is shown is enough — the cross-fade is 1.1s
            // and the image only has to decode, not download, by the time opacity starts moving.
            function hydrate(n) {
                const s = shots[(n + shots.length) % shots.length];
                if (s && !s.getAttribute('src') && s.dataset.src) s.src = s.dataset.src;
            }
            hydrate(1);                                   // the next one, immediately
            addEventListener('load', function () {        // the remainder, once nothing is competing
                requestAnimationFrame(function () { shots.forEach(function (_, n) { hydrate(n); }); });
            });

            function show(n) {
                n = (n + shots.length) % shots.length;
                if (n === i) return;
                hydrate(n); hydrate(n + 1);               // in case a dot jumps ahead of the hydration
                shots[i].classList.remove('on');
                if (dots[i]) { dots[i].classList.remove('on'); dots[i].removeAttribute('aria-current'); }
                i = n;
                shots[i].classList.add('on');
                if (dots[i]) { dots[i].classList.add('on'); dots[i].setAttribute('aria-current', 'true'); }
                if (tag) tag.textContent = shots[i].getAttribute('data-tag') || '';
            }

            // Autoplay is the only part reduced-motion switches off. The link and the dots stay live,
            // because those are navigation rather than decoration — the previous version returned
            // early and left the whole showcase inert for those visitors.
            function stop() { if (timer) { clearInterval(timer); timer = null; } }
            function play() { stop(); if (!reduced) timer = setInterval(function () { show(i + 1); }, 3400); }

            zone.addEventListener('mouseenter', stop);
            zone.addEventListener('mouseleave', play);
            zone.addEventListener('focusin', stop);     // tabbing to a dot or the link pauses too
            zone.addEventListener('focusout', play);
            dots.forEach(function (d) {
                d.addEventListener('click', function () { show(+d.getAttribute('data-i')); play(); });
            });
            play();

            /* ---- Cursor tilt + inner parallax (desktop, motion-permitting) ----
               Ported from index.html's setupCardTilt at roughly a third of its amplitude: 7deg/6deg
               across a -0.5..0.5 range is 3.5deg / 3deg at the corners. A display case should read as
               heavy glass, not a springy card.

               THIS ONLY WORKS BECAUSE heroFloat NOW ANIMATES `translate`, NOT `transform`. A running
               CSS animation wins the cascade for the property it animates, so a tilt written to
               `transform` while heroFloat also owned it would never have appeared at all. Same reason
               the inner parallax uses `translate` on the image: its `transform` is the 6s Ken Burns
               scale, and writing to it would kill that. */
            if (!frame) return;
            if (window.matchMedia && matchMedia('(pointer: coarse)').matches) return;
            if (window.innerWidth < 1024) return;

            /* Click the case to advance. Desktop only — on a phone the whole point is that tapping the
               hero does nothing surprising, and a tap would otherwise be indistinguishable from a
               scroll gesture landing on it. No timer reset here: a click means the pointer is over the
               case, so mouseenter has already paused autoplay, and mouseleave restarts it cleanly.
               Marked interactive with a class rather than a <button> so the dots stay the single
               keyboard control instead of being duplicated. Runs even under reduced motion — switching
               project on click is navigation, not animation. */
            frame.classList.add('is-clickable', 'interactable');
            frame.addEventListener('click', function () { show(i + 1); });

            if (reduced) return;

            frame.addEventListener('mousemove', function (e) {
                const r = box.getBoundingClientRect();
                const x = (e.clientX - r.left) / r.width  - 0.5;
                const y = (e.clientY - r.top)  / r.height - 0.5;
                frame.style.transition = 'transform 0.25s var(--ease-out)';
                frame.style.transform  = 'perspective(1400px) rotateY(' + (x * 7).toFixed(2) + 'deg) rotateX(' + (-y * 6).toFixed(2) + 'deg)';
                // Artwork drifts AGAINST the pointer, which is what reads as depth behind glass.
                // Max 5px / 4px — the .on scale of 1.025 is what keeps that inside the frame.
                if (shots[i]) shots[i].style.translate = (x * -10).toFixed(2) + 'px ' + (y * -8).toFixed(2) + 'px';
                // The glow moves WITH the pointer, so the light reads as belonging to the object it
                // is lighting rather than being painted behind it at a fixed angle.
                if (glow) glow.style.translate = (x * 26).toFixed(1) + 'px ' + (y * 22).toFixed(1) + 'px';
            });
            frame.addEventListener('mouseleave', function () {
                frame.style.transition = 'transform 0.9s var(--ease-out)';
                frame.style.transform  = '';
                shots.forEach(function (s) { s.style.translate = ''; });
                if (glow) glow.style.translate = '';
            });
        })();

        /* Hero copy — word stagger on the h1, one-pass sweep on the accent line, count-up on the
           trust row, and a slow scroll drift on the art column. Every one is an enhancement: the
           class that arms each effect is added here, so with JS off the markup renders as before. */
        (function(){
            const reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

            // ---- h1: split into words, keeping <br> and <em> intact ----
            const h1 = document.querySelector('.mkt-hero h1');
            if (h1 && !h1.dataset.wtSplit) {
                let n = 0;
                // Walked rather than regex-replaced on innerHTML: a naive split would flatten the
                // <br> that breaks the two sentences and destroy the <em> that carries the accent
                // styling AND the sweep. Recursing keeps both and still numbers words continuously.
                (function walk(node){
                    [].slice.call(node.childNodes).forEach(function(child){
                        if (child.nodeType === 3) {
                            const frag = document.createDocumentFragment();
                            child.textContent.split(/(\s+)/).forEach(function(part){
                                if (!part) return;
                                if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
                                const s = document.createElement('span');
                                s.className = 'h1-word';
                                s.style.setProperty('--i', n++);
                                s.textContent = part;
                                frag.appendChild(s);
                            });
                            node.replaceChild(frag, child);
                        } else if (child.nodeType === 1 && child.tagName !== 'BR') {
                            walk(child);
                        }
                    });
                })(h1);
                h1.dataset.wtSplit = '1';
                h1.classList.add('words-in');
                // Two frames: one for the split to be committed with words at opacity 0, one to flip
                // them. Flipping in the same frame would skip the transition entirely.
                requestAnimationFrame(function(){ requestAnimationFrame(function(){
                    h1.classList.add('words-go');
                    if (!reduced) h1.classList.add('sweep');
                }); });
            }

            // ---- trust row: stars fill left to right, numbers count up ----
            const trust = document.querySelector('.hero-trust');
            if (trust && !trust.dataset.wtCount) {
                trust.dataset.wtCount = '1';
                const starWrap = trust.querySelector('.stars');
                if (starWrap) {
                    const chars = starWrap.textContent.trim().split('');
                    starWrap.textContent = '';
                    chars.forEach(function(c, k){
                        const s = document.createElement('span');
                        s.className = 'star';
                        s.style.setProperty('--i', k);
                        s.textContent = c;
                        starWrap.appendChild(s);
                    });
                }
                // Only the DIGITS get their own element and a reserved width. Pinning the whole <b>
                // makes "300+ brands" an inline-block box, which reserves more than the digits need
                // and visibly widened the gaps in the sentence. A span around just "300", pinned in
                // `ch` against tabular-nums, reserves exactly the right space and leaves the words
                // flowing inline as before.
                const counters = [];
                [].slice.call(trust.querySelectorAll('b')).forEach(function(b){
                    const m = b.textContent.match(/^(\d+)(.*)$/);
                    if (!m) return;                       // a <b> with no leading number is left alone
                    // NO WIDTH RESERVATION, and that is the considered choice. Every way of holding
                    // the space needs `display:inline-block` on the digits, which costs a few px per
                    // counter to box rounding and lost kerning — measured at 6-8px across this
                    // sentence, whether pinned in `ch` or in measured px. That widening is PERMANENT
                    // and sits in the resting state people actually read. Letting the line reflow
                    // instead confines the cost to the ~1.1s of counting and leaves the settled
                    // sentence pixel-identical to before this feature existed. tabular-nums (in the
                    // stylesheet) keeps digit widths equal so the shift is smooth rather than jittery.
                    const span = document.createElement('span');
                    span.className = 'num';
                    span.textContent = m[1];
                    b.textContent = '';
                    b.appendChild(span);
                    b.appendChild(document.createTextNode(m[2]));
                    counters.push({ el: span, target: +m[1] });
                });
                function runCount(){
                    trust.classList.add('stars-go');
                    if (reduced) return;
                    counters.forEach(function(c){
                        const dur = 1100, t0 = performance.now();
                        c.el.textContent = '0';
                        (function tick(now){
                            const p = Math.min(1, (now - t0) / dur);
                            c.el.textContent = Math.round(c.target * (1 - Math.pow(1 - p, 3)));
                            if (p < 1) requestAnimationFrame(tick);
                            else c.el.textContent = c.target;   // land exactly, never 299
                        })(t0);
                    });
                }
                // Above the fold today, but observed rather than fired blind so it still works if the
                // hero layout ever moves it below.
                if ('IntersectionObserver' in window) {
                    const io = new IntersectionObserver(function(es){
                        es.forEach(function(e){ if (e.isIntersecting) { runCount(); io.disconnect(); } });
                    }, { threshold: 0.4 });
                    io.observe(trust);
                } else { runCount(); }
            }

            // ---- scroll drift: the art column leaves slightly slower than the copy ----
            const art  = document.querySelector('.mkt-hero-art');
            const hero = document.querySelector('.mkt-hero');
            if (!art || !hero || reduced) return;
            if (window.matchMedia && matchMedia('(pointer: coarse)').matches) return;
            if (window.innerWidth < 1024) return;
            // `translate`, not `transform` — .mkt-hero-art carries .fade-up, whose reveal owns
            // transform. Capped at 44px so it can never become a layout problem on a long page.
            let queued = false;
            function drift(){
                queued = false;
                const r = hero.getBoundingClientRect();
                if (r.bottom < 0 || r.top > window.innerHeight) return;
                const past = Math.min(1, Math.max(0, -r.top / Math.max(r.height, 1)));
                art.style.translate = '0 ' + (past * 44).toFixed(1) + 'px';
            }
            addEventListener('scroll', function(){
                if (!queued) { queued = true; requestAnimationFrame(drift); }
            }, { passive: true });
            drift();
        })();

        // FAQ accordion
        document.querySelectorAll('.faq-question').forEach(q=>{
            q.addEventListener('click', ()=>{
                const open = q.closest('.faq-item').classList.toggle('open');
                q.setAttribute('aria-expanded', open ? 'true' : 'false');
            });
        });
    