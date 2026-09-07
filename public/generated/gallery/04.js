
  (function() {
    /*
      CLASSIC UI FUNCTION GUIDE (runs even if the Three.js module/CDN fails)

      toggleMobileMenu(force) - Opens/closes the full-screen menu and locks document scrolling. It
        also pauses/resumes _lenisInstance if one exists; today one never does (the pinned Lenis
        build 404s), so the document-level scroll lock is what actually holds the page.
      setGalleryTheme(theme,persist) - Synchronizes the DOM palette, accessible switch, persistence,
        browser chrome, and the existing Three.js scene.
      setGuide(open,remember) - Shows the recoverable device-aware controls guide and remembers
        dismissal after the visitor has seen it.
      peek(v) / move(d) / look(d) - Small bridge functions from buttons/keyboard to module
        functions exposed later as window._galleryPeek / _galleryMove / _galleryLook. The whole
        pad is hold-to-act: move(d) walks, look(d) turns, both stop on release and keep their
        state. peek(0) is the separate "give up the free look and recentre" request.
      wake() - Reveals the controller after activity and restarts its 3.5-second idle-hide timer.
      bind(btn, fn, val) - Gives a controller button press/hold/release behavior and active styling.
      on()/off() - Per-button handlers created by bind; start an action on press and stop it on any
        release, pointer cancellation, pointer exit, or lost focus.
      setOpen(open) - Opens/closes the mobile controller cluster and synchronizes aria-expanded.
      u() - Refreshes the standalone Singapore clock; called immediately and every 30 seconds.
      tryPlay() / onUserGesture() - Restore ambient audio only after browser autoplay rules permit it.
      parkWipe() - Resets the page-transition overlay after its entrance animation is complete.

      The remaining event callbacks route Escape/WASD/arrow keys, persist audio time/state in
      sessionStorage, toggle mute/play, intercept eligible internal links for a branded page wipe,
      and reload a browser back-forward-cache restore because the WebGL context was disposed.
    */
    // Shared modal helpers. Only elements made inert by the current overlay are marked, so closing
    // one overlay does not accidentally reactivate the other initially-inert overlays.
    window._setGalleryModalIsolation = function(keep, on) {
      if (!document.body) return;
      if (on) {
        Array.prototype.forEach.call(document.body.children, function(el) {
          if (el === keep || el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT') return;
          if (!el.inert) { el.inert = true; el.setAttribute('data-gallery-modal-inert', '1'); }
        });
      } else {
        document.querySelectorAll('[data-gallery-modal-inert="1"]').forEach(function(el) {
          el.inert = false;
          el.removeAttribute('data-gallery-modal-inert');
        });
      }
    };
    window._galleryTrapFocus = function(container, e) {
      if (!container || e.key !== 'Tab') return;
      var items = Array.prototype.filter.call(container.querySelectorAll('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])'), function(el) {
        return !el.inert && el.getClientRects().length > 0;
      });
      if (!items.length) { e.preventDefault(); container.focus(); return; }
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };

    // First-visit instructions stay non-modal and can always be reopened from the navigation.
    (function(){
      var panel = document.getElementById('gallery-guide');
      var toggle = document.getElementById('guide-toggle');
      var close = document.getElementById('guide-close');
      if (!panel || !toggle) return;
      function setGuide(open, remember) {
        var wasOpen = panel.classList.contains('open');
        panel.classList.toggle('open', !!open);
        panel.setAttribute('aria-hidden', open ? 'false' : 'true');
        panel.inert = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        document.body.classList.toggle('guide-open', !!open);
        // Only record "seen" if it was actually ON SCREEN. openIndex / openPiece / _startAutoTour
        // all call setGuide(false, true) defensively, and on a first visit where the visitor taps a
        // painting before the guide has opened, that persisted the flag for a guide they never saw —
        // so the one-time controls explainer was silently consumed and never shown again.
        if (!open && remember && wasOpen) { try { localStorage.setItem('wt-gallery-guide-seen-v2', '1'); } catch (_) {} }
      }
      window._toggleGalleryGuide = setGuide;
      toggle.addEventListener('click', function(e){
        e.stopPropagation();
        if (document.body.classList.contains('end-cta')) { setGuide(false, true); return; }
        setGuide(!panel.classList.contains('open'), panel.classList.contains('open'));
      });
      if (close) close.addEventListener('click', function(){ setGuide(false, true); toggle.focus(); });
      document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && panel.classList.contains('open')) { setGuide(false, true); toggle.focus(); } });
      var seen = false;
      try { seen = localStorage.getItem('wt-gallery-guide-seen-v2') === '1'; } catch (_) {}
      if (!seen) {
        var revealOnExplore = function(){
          if (window.scrollY < 2) return;
          window.removeEventListener('scroll', revealOnExplore);
          if (!document.body.classList.contains('menu-open') && !document.body.classList.contains('index-open') && !document.body.classList.contains('lb-open')) setGuide(true, false);
        };
        window.addEventListener('scroll', revealOnExplore, { passive:true });
      }
    })();

    // Nav stays consistent at all scroll positions — no scrolled state toggle

    // Mobile menu
    var menuReturnFocus = null;
    window.toggleMobileMenu = function(force) {
      var menu = document.getElementById('mobile-menu');
      var ham  = document.getElementById('hamburger');
      if (!menu || !ham) return;
      var open = (typeof force === 'boolean') ? force : !menu.classList.contains('open');
      if (open) menuReturnFocus = document.activeElement;
      if (open && window._toggleGalleryGuide) window._toggleGalleryGuide(false, false);
      menu.classList.toggle('open', open);
      ham.classList.toggle('open', open);
      ham.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
      document.body.classList.toggle('menu-open', open);
      document.documentElement.classList.toggle('menu-open', open);
      // Hard-lock the real scroller. This is the ONLY thing holding the page — no Lenis instance has
      // ever existed to stop (its pinned CDN build 404s), and body overflow alone doesn't hold it.
      document.documentElement.style.overflowY = open ? 'hidden' : '';
      if (window._lenisInstance) { open ? window._lenisInstance.stop() : window._lenisInstance.start(); }
      if (open) {
        menu.inert = false;
        window._setGalleryModalIsolation(menu, true);
        requestAnimationFrame(function(){ var close = menu.querySelector('.mobile-close'); if (close) close.focus(); else menu.focus(); });
      } else {
        window._setGalleryModalIsolation(menu, false);
        menu.inert = true;
        if (menuReturnFocus && typeof menuReturnFocus.focus === 'function') menuReturnFocus.focus(); else ham.focus();
        menuReturnFocus = null;
      }
    };
    document.getElementById('hamburger').addEventListener('click', function(){ toggleMobileMenu(); });
    document.addEventListener('keydown', function(e){
      var menu = document.getElementById('mobile-menu');
      if (!menu || !menu.classList.contains('open')) return;
      if (e.key === 'Escape') toggleMobileMenu(false);
      else window._galleryTrapFocus(menu, e);
    });

    // Navigation d-pad — hold to move (up=forward, down=back) or look (left/right). Keyboard:
    // W/↑ forward, S/↓ back, A/← look left, D/→ look right. Auto-hides when idle.
    (function(){
      var up = document.getElementById('move-up'),   dn = document.getElementById('move-down');
      var lb = document.getElementById('look-left'),  rb = document.getElementById('look-right');
      if (!up || !dn || !lb || !rb) return;
      function peek(v){ if (window._galleryPeek) window._galleryPeek(v); }
      function move(d){ if (window._galleryMove) window._galleryMove(d); }
      function look(d){ if (window._galleryLook) window._galleryLook(d); }

      // Idle auto-hide: reveal on any activity, fade out after a few seconds of stillness.
      var idleTimer;
      // Held controls count as activity. The idle timer only ever restarted on pointer/wheel/key
      // EVENTS, and a press-and-hold generates none after the initial pointerdown — so holding ▲ to
      // walk for more than 3.5s faded #look-controls to opacity 0 with pointer-events:none, out
      // from under the user's own finger, mid-walk. _wtHolding is set by bindHold and by the
      // keyboard path while any control is down.
      window._wtHolding = 0;
      function wake(){
        document.body.classList.remove('ui-idle');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(function(){
          if (window._wtHolding > 0) { wake(); return; }   // still held — re-arm instead of hiding
          document.body.classList.add('ui-idle');
        }, 3500);
      }
      ['pointermove','pointerdown','wheel','touchstart','keydown'].forEach(function(ev){
        window.addEventListener(ev, wake, { passive: true });
      });
      wake();

      // Walking is hold-to-move: press and hold ▲/▼, release to stop.
      function bindHold(btn, fn, val){
        var down = false;
        function on(e){ if (e && e.cancelable) e.preventDefault(); if (!down) { down = true; window._wtHolding++; } wake(); fn(val); btn.classList.add('active'); }
        function off(){ if (down) { down = false; window._wtHolding = Math.max(0, window._wtHolding - 1); wake(); } fn(0); btn.classList.remove('active'); }
        btn.addEventListener('pointerdown', on);
        btn.addEventListener('pointerup', off);
        btn.addEventListener('pointerleave', off);
        btn.addEventListener('pointercancel', off);
        btn.addEventListener('blur', off);
      }
      bindHold(up, move,  1);   // ▲ forward
      bindHold(dn, move, -1);   // ▼ back

      // Looking is hold-to-TURN, the same contract as ▲/▼: hold to act, release to stop, and the
      // state you left it in persists. Releasing does not spring back — the view simply stays
      // pointing where you stopped turning. That is what makes the corridor free to explore
      // instead of offering three fixed viewpoints: there is no "correct" angle to be snapped to,
      // and you can keep holding all the way round to the wall behind you.
      bindHold(lb, look,  1);   // ◄ turn left  (camera.rotateY(+) turns the view left)
      bindHold(rb, look, -1);   // ► turn right
      // Releases the d-pad: stops turning and un-presses the buttons. It deliberately does NOT
      // recentre the view — it used to call peek(0), and because _galleryPeek also clears the
      // phone's swipe-look state, the swipe handler was wiping the very values it had just set two
      // lines earlier and sideways swipes did nothing at all. Callers that genuinely want the view
      // brought back to dead ahead call _recentreLook() on the module side, which the lightbox,
      // the swipe and the auto tour all already do.
      window._resetLookUI = function(){
        look(0);
        lb.classList.remove('active');
        rb.classList.remove('active');
      };

      // Keyboard mirrors the pad exactly — every one of these is hold-to-act. ↑/↓ are kept from
      // native-scrolling because we drive the walk ourselves; ←/→ are NOT prevented, so they still
      // reach the lightbox's own prev/next handler when a painting is open (the module ignores
      // turn input while the lightbox owns the camera).
      var MOVEKEYS = { ArrowUp:[1,up], KeyW:[1,up], ArrowDown:[-1,dn], KeyS:[-1,dn] };
      var LOOKKEYS = { ArrowLeft:[1,lb], KeyA:[1,lb], ArrowRight:[-1,rb], KeyD:[-1,rb] };
      var _held = {};
      document.addEventListener('keydown', function(e){
        var menu = document.getElementById('mobile-menu');
        if (menu && menu.classList.contains('open')) return;
        // The full-screen index panel is a modal too. Without this, ←/→ (and A/D) kept driving
        // _galleryLook while it was open, silently rotating the corridor behind the panel — so
        // closing it dropped you somewhere you never chose to look.
        if (document.body.classList.contains('index-open')) return;
        var isLook = !MOVEKEYS[e.code] && !!LOOKKEYS[e.code];
        var mv = MOVEKEYS[e.code] || LOOKKEYS[e.code];
        if (!mv) return;
        if (e.code === 'ArrowUp' || e.code === 'ArrowDown') e.preventDefault();
        if (e.repeat) return;
        wake();
        (isLook ? look : move)(mv[0]);
        mv[1].classList.add('active');
        _held[e.code] = [mv, isLook];
        window._wtHolding++;   // keep the controls awake for the whole hold (see wake())
      });
      document.addEventListener('keyup', function(e){
        var h = _held[e.code]; if (!h) return;
        (h[1] ? look : move)(0);
        h[0][1].classList.remove('active');
        delete _held[e.code];
        window._wtHolding = Math.max(0, window._wtHolding - 1);
        wake();
      });
      // Release everything when the window loses focus. keyup is NOT delivered to a page that is no
      // longer focused, so alt-tabbing (or hitting Cmd/Ctrl+T, or the OS stealing focus) while a key
      // was down left _moveDir/_lookDir latched at ±1 with no event able to clear them — you came
      // back to a camera walking or spinning on its own, and the only fix was a reload.
      function _releaseAllKeys() {
        for (var code in _held) {
          var h = _held[code];
          (h[1] ? look : move)(0);
          h[0][1].classList.remove('active');
          delete _held[code];
          window._wtHolding = Math.max(0, window._wtHolding - 1);
        }
      }
      window.addEventListener('blur', _releaseAllKeys);
      document.addEventListener('visibilitychange', function(){ if (document.hidden) _releaseAllKeys(); });
    })();

    // Mobile: the FAB toggles the controller open/closed; tap-away closes it.
    (function(){
      var fab = document.getElementById('nav-toggle');
      if (!fab) return;
      function setOpen(open){
        document.body.classList.toggle('nav-open', open);
        fab.classList.toggle('open', open);
        fab.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      fab.addEventListener('click', function(e){ e.stopPropagation(); setOpen(!document.body.classList.contains('nav-open')); });
      document.addEventListener('pointerdown', function(e){
        if (!document.body.classList.contains('nav-open')) return;
        if (e.target.closest('#look-controls') || e.target.closest('#nav-toggle')) return;
        setOpen(false);
      });
    })();
    // Singapore clock in the nav (Gallery is standalone — doesn't load site.js)
    (function () {
      var el = document.getElementById('dubai-time');
      if (!el) return;
      var u = function () { el.textContent = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit' }); };
      u(); setInterval(u, 30000);
    })();

    // Audio persistence
    var audio = document.getElementById('ambient-audio');
    var btn   = document.getElementById('sound-toggle');
    if (audio && btn) {
      audio.volume = 0.3;
      var unlocked = false;
      var savedTime  = parseFloat(sessionStorage.getItem('wt-audio-time') || '0');
      var playState  = sessionStorage.getItem('wt-audio-playing');
      var wasPlaying = playState === '1';
      if (savedTime > 0 && isFinite(savedTime)) { try { audio.currentTime = savedTime; } catch(e) {} }
      function tryPlay() {
        if (unlocked) return;
        audio.play().then(function() { unlocked = true; btn.classList.remove('muted'); sessionStorage.setItem('wt-audio-playing','1'); }).catch(function(){});
      }
      if (wasPlaying) tryPlay();
      var EVENTS = ['click','mousedown','touchstart','keydown','pointerdown'];
      function onUserGesture() {
        if (sessionStorage.getItem('wt-audio-playing') !== '0' && wasPlaying) tryPlay();
        if (unlocked) EVENTS.forEach(function(ev){ document.removeEventListener(ev, onUserGesture); });
      }
      EVENTS.forEach(function(ev){ document.addEventListener(ev, onUserGesture, { passive: true }); });
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (audio.paused) { audio.play().then(function(){ btn.classList.remove('muted'); unlocked = true; sessionStorage.setItem('wt-audio-playing','1'); }).catch(function(){}); }
        else { audio.pause(); btn.classList.add('muted'); sessionStorage.setItem('wt-audio-playing','0'); }
      });
      setInterval(function(){ if (!audio.paused) sessionStorage.setItem('wt-audio-time', audio.currentTime.toString()); }, 500);
      window.addEventListener('pagehide', function(){ sessionStorage.setItem('wt-audio-time', audio.currentTime.toString()); sessionStorage.setItem('wt-audio-playing', audio.paused ? '0' : '1'); });
    }

    // Page wipe transition
    var wipe = document.getElementById('wt-page-wipe');
    if (wipe && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      var parkWipe = function(){ wipe.style.transition='none'; wipe.classList.remove('cover','uncover'); wipe.style.transform=''; requestAnimationFrame(function(){ wipe.style.transition=''; }); };
      requestAnimationFrame(function() {
        wipe.classList.add('uncover');
        setTimeout(parkWipe, 750);
      });
      document.addEventListener('click', function(e) {
        var link = e.target.closest('a[href]');
        if (!link) return;
        var raw = link.getAttribute('href');
        if (!raw || raw.charAt(0) === '#') return;
        // Modifier-clicks and non-primary buttons belong to the browser — see index.html.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button && e.button !== 0)) return;
        if (e.defaultPrevented) return;
        if (link.target === '_blank' || link.hasAttribute('download')) return;
        if (link.protocol === 'mailto:' || link.protocol === 'tel:') return;
        if (link.hostname !== location.hostname) return;
        if (link.pathname === location.pathname && link.hash) return;
        if (/\.[a-z0-9]+$/i.test(link.pathname) && !/\.(html?|php)$/i.test(link.pathname)) return;
        e.preventDefault(); wipe.classList.add('cover'); setTimeout(function(){ window.location.href = raw; }, 650);
      });
    }
    // bfcache recovery must also run for reduced-motion visitors, for whom the wipe is skipped.
    // Gallery disposes its WebGL renderer on pagehide; a persisted restore therefore needs a rebuild.
    window.addEventListener('pageshow', function(ev){ if (ev.persisted) location.reload(); });
  })();
  