
        (function(){ const els=document.querySelectorAll('.pricing-card,.faq-item'); const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in-view');io.unobserve(e.target);}});},{threshold:0.12}); els.forEach(x=>io.observe(x)); })();
    