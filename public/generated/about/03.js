
        // ===== Cinematic Founder 3D Reveal =====
        (function() {
            const wrap = document.querySelector('.founder-image-wrap');
            const info = document.querySelector('.founder-info');
            const img  = wrap ? wrap.querySelector('.founder-image') : null;
            if (!wrap || !img) return;

            wrap.style.perspective = '1000px';

            // Initial hidden state
            img.style.opacity = '0';
            img.style.transform = 'rotateY(12deg) rotateX(-5deg) scale(0.82) translateZ(-60px)';
            img.style.filter = 'brightness(0.3) blur(6px)';
            info.style.opacity = '0';
            info.style.transform = 'translateY(60px)';

            let revealed = false;
            const founderIO = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (e.isIntersecting && !revealed) {
                        revealed = true;

                        // Phase 1: Image cinematic entrance (0ms)
                        img.style.transition = 'transform 1.6s cubic-bezier(0.16,1,0.3,1), opacity 1.2s ease-out, filter 1.4s ease-out';
                        img.style.opacity = '1';
                        img.style.transform = 'rotateY(0deg) rotateX(0deg) scale(1) translateZ(0)';
                        img.style.filter = 'brightness(1) blur(0px)';
                        wrap.classList.add('revealed');

                        // Phase 2: Info text entrance (staggered 400ms later)
                        setTimeout(() => {
                            info.style.transition = 'transform 1.2s cubic-bezier(0.16,1,0.3,1), opacity 1s ease-out';
                            info.style.opacity = '1';
                            info.style.transform = 'translateY(0)';
                            info.classList.add('revealed');
                        }, 400);

                        founderIO.unobserve(wrap);
                    }
                });
            }, { threshold: 0.2 });
            founderIO.observe(wrap);

            // Continuous subtle parallax on scroll (after reveal). rAF-paced.
            let ticking = false;
            window.addEventListener('scroll', () => {
                if (!revealed || ticking) return;
                ticking = true;
                requestAnimationFrame(() => {
                    const rect = wrap.getBoundingClientRect();
                    const vh = window.innerHeight;
                    if (rect.bottom < 0 || rect.top > vh) { ticking = false; return; }
                    const center = (rect.top + rect.height / 2 - vh / 2) / vh; // -0.5 to 0.5
                    img.style.transition = '';
                    img.style.transform = `rotateY(${center * -4}deg) rotateX(${center * 2}deg) scale(1)`;
                    ticking = false;
                });
            }, { passive: true });
        })();

        // ===== Value Cards Stagger =====
        (function() {
            const cards = document.querySelectorAll('.value-card');
            const io = new IntersectionObserver((entries) => {
                entries.forEach((e, i) => {
                    if (e.isIntersecting) {
                        setTimeout(() => e.target.classList.add('in-view'), i * 120);
                        io.unobserve(e.target);
                    }
                });
            }, { threshold: 0.15 });
            cards.forEach(c => io.observe(c));
        })();

        // ===== Timeline Items Reveal =====
        (function() {
            const items = document.querySelectorAll('.timeline-item');
            const io = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (e.isIntersecting) { e.target.classList.add('in-view'); io.unobserve(e.target); }
                });
            }, { threshold: 0.2 });
            items.forEach(item => io.observe(item));
        })();
    