
      (function(){
        window.__WT_LITE = new URLSearchParams(location.search).get('lite') === '1';
        if (window.__WT_LITE) document.documentElement.classList.add('wt-lite');
        // CDN safety net: the whole hero is one ES module importing three from a CDN. If that
        // import fails (offline CDN, firewall, region block), init() never runs and #preloader
        // (z-index 99999) would cover the page forever. If the module hasn't signalled ready in
        // 10s, drop to the lite layout, hide the preloader, and reveal content so the page is usable.
        setTimeout(function(){
          if (window._heroReady) return;
          document.documentElement.classList.add('wt-lite');
          var p = document.getElementById('preloader');
          if (p) { p.style.opacity = '0'; p.style.visibility = 'hidden'; p.style.display = 'none'; }
          document.querySelectorAll('.fade-up, .decode-text, .hero-center-label').forEach(function(el){ el.classList.add('in-view'); });
        }, 10000);
      })();
    