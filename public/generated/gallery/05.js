
  /*
    FALLBACK INDEX RENDERER
    esc(s) HTML-escapes project data before interpolation. render() builds the semantic list used by
    search engines, assistive technology, and the no-WebGL fallback.
  */
  // Render the accessible / crawlable / fallback index (works without WebGL or the 3D CDN).
  (function(){
    function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
    function render(){
      var host = document.getElementById('works-index');
      if (!host) return;
      var li = window.WT_WORKS.map(function(w){
        return '<li><a href="#' + esc(w.src) + '" tabindex="-1"><strong>' + esc(w.title) + '</strong> <span class="wi-tag">' + esc(w.tag) + '</span><span class="wi-desc">' + esc(w.desc) + '</span></a></li>';
      }).join('');
      host.innerHTML = '<h2>Selected Work — KIASA Portfolio</h2>' +
        '<p>A curated archive of ' + window.WT_WORKS.length + ' brand, web and identity projects by KIASA, a global digital studio. ' +
        'Explore the immersive 3D gallery above, or browse the full list below.</p><ul>' + li + '</ul>';
    }
    if (document.readyState !== 'loading') render(); else document.addEventListener('DOMContentLoaded', render);
  })();
  