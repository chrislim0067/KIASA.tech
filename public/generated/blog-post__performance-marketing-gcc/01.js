
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '31244315035216040');
(function(){
  var id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'pv-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  fbq('track', 'PageView', {}, { eventID: id });
  try {
    var body = JSON.stringify({ event_name:'PageView', event_id:id, event_time:Math.floor(Date.now()/1000), event_source_url:location.href, action_source:'website', custom_data:{}, user_data:{} });
    var blob = new Blob([body], { type:'application/json' });
    if (!navigator.sendBeacon || !navigator.sendBeacon('/api/track.php', blob)) {
      fetch('/api/track.php', { method:'POST', headers:{'Content-Type':'application/json'}, body:blob, keepalive:true }).catch(function(){});
    }
  } catch(_){}
})();
