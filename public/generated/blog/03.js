
    // Load blog posts from /api/blog-posts.php and render the grid.
    //
    // There is no hardcoded article list any more. It used to sit in the markup as a fallback, and it
    // silently went stale — by the time it was noticed it was advertising six posts on a blog that had
    // ten, and would have shown the wrong set to anyone who hit it while the API was down. A generic
    // unavailable state cannot go out of date.
    (function() {
        // Set the moment real cards are in the DOM. The catch below is shared by the fetch and the
        // rendering that follows it, so without this a throw from the reveal-observer setup — after
        // the posts were already on screen — would replace ten good articles with an error message.
        var rendered = false;

        function showUnavailable() {
            var grid = document.getElementById('blog-grid');
            if (!grid) return;
            // Only ever called from the failure paths below, so the message cannot appear on a normal
            // load. Rebuilt rather than toggled, because a successful render replaces the grid's
            // innerHTML and the original status node is gone by then.
            grid.innerHTML =
                '<div class="blog-status" role="status" aria-live="polite">'
              + '<span class="blog-status-label">Articles unavailable</span>'
              + '<p>Articles are temporarily unavailable. Please refresh or try again shortly.</p>'
              + '<button type="button" id="blog-retry">Try again</button>'
              + '</div>';
            var retry = document.getElementById('blog-retry');
            if (retry) retry.addEventListener('click', function() { location.reload(); });
        }

        fetch('/api/blog-posts.php')
            .then(function(r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
            .then(function(posts) {
                // An empty list is a failure to show, not a blank page. Previously this returned early
                // and left whatever markup was already there.
                if (!Array.isArray(posts) || posts.length === 0) { showUnavailable(); return; }
                var grid = document.getElementById('blog-grid');
                if (!grid) return;
                var html = '';
                posts.forEach(function(p, i) {
                    var isFeatured = p.featured && i === 0;
                    var date = p.post_date ? new Date(p.post_date).toLocaleDateString('en-GB', {month:'short', year:'numeric'}) : '';
                    var thumb = p.thumbnail
                        ? 'style="background-image:url(\'' + p.thumbnail.replace(/'/g, "\\'") + '\')"'
                        : '';
                    html += '<article class="blog-card ' + (isFeatured ? 'featured ' : '') + 'fade-up">';
                    html += '<div class="blog-thumb" ' + thumb + '><span class="blog-thumb-label">' + (p.category || '') + '</span></div>';
                    html += '<div class="blog-body">';
                    html += '<div class="blog-meta"><span>' + (p.category || '') + '</span>' + (date ? '<span>' + date + '</span>' : '') + (p.read_time ? '<span>' + p.read_time + '</span>' : '') + '</div>';
                    html += '<h3>' + p.title + '</h3>';
                    if (p.excerpt) html += '<p>' + p.excerpt + '</p>';
                    html += '<a href="/blog-post?slug=' + encodeURIComponent(p.slug) + '" class="blog-read">Read Article &rarr;</a>';
                    html += '</div></article>';
                });
                grid.innerHTML = html;
                rendered = true;
                // Re-trigger fade-up observer for new elements
                var newEls = grid.querySelectorAll('.fade-up');
                var io = new IntersectionObserver(function(entries) {
                    entries.forEach(function(e) { if (e.isIntersecting) { e.target.classList.add('in-view'); io.unobserve(e.target); } });
                }, { threshold: 0.12 });
                newEls.forEach(function(el) { io.observe(el); });
            })
            // Network error, non-200, malformed JSON, or a throw while building the cards. Never
            // after the cards are up — see the `rendered` note above.
            .catch(function() { if (!rendered) showUnavailable(); });
    })();
    