
(function(){
    const audio=document.getElementById('ambient-audio');const btn=document.getElementById('sound-toggle');
    if(audio&&btn){audio.volume=0.3;let unlocked=false;const savedTime=parseFloat(sessionStorage.getItem('wt-audio-time')||'0');const wasPlaying=sessionStorage.getItem('wt-audio-playing')==='1';if(savedTime>0&&isFinite(savedTime)){try{audio.currentTime=savedTime;}catch(e){}}
    function tryPlay(){if(unlocked)return;audio.play().then(()=>{unlocked=true;btn.classList.remove('muted');sessionStorage.setItem('wt-audio-playing','1');}).catch(()=>{});}
    if(wasPlaying)tryPlay();
    const EVENTS=['click','mousedown','touchstart','keydown','pointerdown'];function onUserGesture(){if(sessionStorage.getItem('wt-audio-playing')!=='0'&&wasPlaying)tryPlay();if(unlocked)EVENTS.forEach(ev=>document.removeEventListener(ev,onUserGesture));}
    EVENTS.forEach(ev=>document.addEventListener(ev,onUserGesture,{passive:true}));
    btn.addEventListener('click',(e)=>{e.stopPropagation();if(audio.paused){audio.play().then(()=>{btn.classList.remove('muted');unlocked=true;sessionStorage.setItem('wt-audio-playing','1');}).catch(()=>{});}else{audio.pause();btn.classList.add('muted');sessionStorage.setItem('wt-audio-playing','0');}});
    setInterval(()=>{if(!audio.paused)sessionStorage.setItem('wt-audio-time',audio.currentTime.toString());},500);
    window.addEventListener('pagehide',()=>{sessionStorage.setItem('wt-audio-time',audio.currentTime.toString());sessionStorage.setItem('wt-audio-playing',audio.paused?'0':'1');});}
    const wipe=document.getElementById('wt-page-wipe');
    if(wipe && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)){
        const parkWipe=()=>{wipe.style.transition='none';wipe.classList.remove('cover','uncover');wipe.style.transform='';requestAnimationFrame(()=>{wipe.style.transition='';});};
        requestAnimationFrame(()=>{wipe.classList.add('uncover');setTimeout(parkWipe,750);});
        document.addEventListener('click',(e)=>{const link=e.target.closest('a[href]');if(!link)return;const raw=link.getAttribute('href');if(!raw||raw.charAt(0)==='#')return;if(link.target==='_blank'||link.hasAttribute('download'))return;if(link.protocol==='mailto:'||link.protocol==='tel:')return;if(link.hostname!==location.hostname)return;if(link.pathname===location.pathname&&link.hash)return;if(/\.[a-z0-9]+$/i.test(link.pathname)&&!/\.(html?|php)$/i.test(link.pathname))return;e.preventDefault();wipe.classList.add('cover');setTimeout(()=>{window.location.href=raw;},650);});
        window.addEventListener('pageshow',(ev)=>{if(ev.persisted){parkWipe();if(mobileMenu&&mobileMenu.classList.contains('open'))toggleMobileMenu(false);}});
    }
})();
