
    // One fallback entry point is shared by CDN timeout, renderer failure, and init failure.
    // Besides revealing the message/list, it removes the huge invisible camera-scroll runway and
    // turns hash-only portfolio links into readable, non-interactive fallback entries.
    window._activateGalleryFallback = function () {
      if (!document.body) return;
      document.body.classList.add('is-fallback');
      var l = document.getElementById('preloader'); if (l) l.remove();
      document.querySelectorAll('#works-index a').forEach(function (a) {
        a.removeAttribute('href');
        a.removeAttribute('tabindex');
      });
    };
    // Fail quickly when the module CDN never resolves, but allow a slower phone extra time once the
    // module has genuinely started and is decoding its small entrance set of artwork textures.
    // `_galleryReady` is set only after textures, bindings, and the render loop are actually ready.
    var galleryFallbackStartedAt = Date.now();
    function checkGalleryStartup() {
      if (window._galleryReady) return;
      if (window._galleryBootStarted && Date.now() - galleryFallbackStartedAt < 35000) {
        setTimeout(checkGalleryStartup, 4000);
        return;
      }
      window._activateGalleryFallback();
    }
    setTimeout(checkGalleryStartup, 18000);
  