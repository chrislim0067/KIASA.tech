
        // Stagger case cards entrance
        (function() {
            const cards = document.querySelectorAll('.case-card');
            const cardIO = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        const idx = [...cards].indexOf(e.target);
                        setTimeout(() => e.target.classList.add('in-view'), idx * 150);
                        cardIO.unobserve(e.target);
                    }
                });
            }, { threshold: 0.1 });
            cards.forEach(c => cardIO.observe(c));

            // Stagger filter tabs
            const tabs = document.querySelectorAll('.filter-tab');
            tabs.forEach((t, i) => {
                setTimeout(() => t.classList.add('in-view'), 200 + i * 80);
            });
        })();

        // Filter
        function filterCases(cat, btn) {
            document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.case-card').forEach(card => {
                if (cat === 'all' || card.dataset.category === cat) {
                    card.style.display = '';
                } else {
                    card.style.display = 'none';
                }
            });
        }
    