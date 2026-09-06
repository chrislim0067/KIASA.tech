
        function wtStagger(sel, step){ const els=document.querySelectorAll(sel); if(!els.length) return; const io=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){const i=[...els].indexOf(e.target);setTimeout(()=>e.target.classList.add('in-view'), i*step);io.unobserve(e.target);}});},{threshold:0.12}); els.forEach(x=>io.observe(x)); }
        wtStagger('.metric', 90);

        // Pre-select a service pill if arriving from a "Get an estimate" link (?s=slug)
        (function(){
            const p = new URLSearchParams(location.search).get('s');
            if(!p) return;
            const slug = p.replace(/[^a-z0-9-]/g,'');
            const cb = document.querySelector('#qservices input[data-slug="'+slug+'"]');
            if(cb) cb.checked = true;
            // Also fill the hidden field. It existed and was ticked-but-never-populated, so every
            // brief reported an empty service_preselect and the "came from the Get-an-estimate
            // link for service X" signal never reached the inbox.
            const hid = document.getElementById('service_preselect');
            if(hid) hid.value = cb ? (cb.value || slug) : slug;
        })();

        /* Arriving from the cost calculator on /estimate. It writes its selection to sessionStorage
           (not the query string — the summary is multi-line prose, and a budget belongs in nobody's
           browser history), and this reads it once and prefills.

           Guarded three ways on purpose: nothing is overwritten if the visitor has already typed,
           the payload is validated as a plain object with a string summary before use, and every
           value is assigned through .value / .checked — never innerHTML — so a tampered storage key
           cannot put markup on the page. Written as a best-effort convenience: if any of it fails
           the form is exactly the form it was before. */
        (function(){
            var raw;
            try { raw = sessionStorage.getItem('wt_estimate'); } catch(_) { return; }
            if (!raw) return;
            try { sessionStorage.removeItem('wt_estimate'); } catch(_) {}
            var d; try { d = JSON.parse(raw); } catch(_) { return; }
            if (!d || typeof d !== 'object' || typeof d.summary !== 'string') return;

            var ta = document.querySelector('#qform textarea[name=message]');
            if (ta && !ta.value.trim()) ta.value = d.summary;

            if (Array.isArray(d.slugs)) {
                d.slugs.forEach(function(s){
                    if (typeof s !== 'string') return;
                    var cb = document.querySelector('#qservices input[data-slug="' + s.replace(/[^a-z0-9-]/g,'') + '"]');
                    if (cb) cb.checked = true;
                });
            }
            // Preselect the band the calculator's LOW figure falls into, so the visitor confirms a
            // number rather than re-deriving one. Deliberately the low end: nudging someone into a
            // higher band than their own estimate showed them would be a sales trick, not a prefill.
            var u = Number(d.usdLow);
            if (u > 0) {
                // Bands changed on 23 Aug 2026: the floor moved to $3,000 and two lower bands were
                // added. This mapping was not updated with them, so a $1,800 scope preselected
                // "$5,000 – $10,000" – three times what the calculator had just shown the visitor
                // – and anything under $5,000 matched no pill at all, so nothing was preselected.
                // EVERY threshold below must exist as a pill above, or the querySelector finds nothing.
                var band = u < 3000  ? 'Under $3,000'
                         : u < 5000  ? '$3,000 – $5,000'
                         : u < 10000 ? '$5,000 – $10,000'
                         : u < 25000 ? '$10,000 – $25,000'
                         : u < 50000 ? '$25,000 – $50,000'
                         : '$50,000+';
                var r = document.querySelector('#qbudget input[name=budget][value="' + band + '"]');
                if (r && !document.querySelector('#qbudget input[name=budget]:checked')) r.checked = true;
            }
        })();

        // Budget pills → low-budget soft message
        (function(){
            const soft=document.getElementById('qsoft');
            document.querySelectorAll('#qbudget input[name=budget]').forEach(r=>{
                // Always visible: the price floor is something every visitor should see rather than
                // only the ones who self-select into the cheapest band. There IS an "Under $3,000"
                // pill again since 23 Aug 2026, deliberately below the floor — someone with $2,000 is
                // a real enquiry worth routing to an entry point rather than losing in silence.
                r.addEventListener('change', ()=>{ if(soft) soft.style.display = 'block'; });
            });
        })();

        // Qualifier form → /api/lead.php
        (function(){
            const f=document.getElementById('qform'); if(!f) return;
            const err=document.getElementById('qerr');
            // Country selector. Writes phone_country_iso / phone_dial_code / phone_raw /
            // phone_country_name as hidden inputs inside the form, so FormData carries them.
            //
            // Mounted on a retry rather than inline: wt-phone.js is loaded with `defer`, so it has
            // NOT executed when this inline script runs. Reading window.wtPhone here directly left
            // the selector unmounted on this page while the two panel forms — which already used a
            // retry — worked, which is exactly the kind of difference that only shows up in a test.
            let cc = null;
            (function mountCC(){
                const el = f.querySelector('input[name=phone]');
                if (!el) return;
                if (!window.wtPhone) return void setTimeout(mountCC, 120);
                cc = window.wtPhone.mountSelector(el, { iso: 'AE' });
            })();
            const showErr=(m)=>{ if(err){ err.textContent=m; err.style.display='block'; } };
            f.addEventListener('submit', async (e)=>{
                e.preventDefault();
                if(err) err.style.display='none';
                // Country-aware phone validation. This form previously validated NOTHING: a brief
                // submitted fine with a blank phone, or with garbage in it. Email is gated by the
                // native `required` (this is a real <form> with no novalidate), but phone was not
                // even required until now.
                const phoneEl=f.querySelector('input[name=phone]');
                let phoneE164='';
                if(window.wtPhone && phoneEl){
                    // Validate against the SELECTED country, not a hard-coded default.
                    const r=window.wtPhone.parse(phoneEl.value, cc ? cc.cc() : '971');
                    if(!r.ok){ showErr(r.reason); phoneEl.focus(); return; }
                    phoneE164=r.e164;
                    // Submit the dialable international form, not whatever was typed.
                    phoneEl.value='+'+r.e164;
                }
                const btn=f.querySelector('.qform-submit'); btn.disabled=true; btn.textContent='Sending…';
                try {
                    const fd=new FormData(f);
                    // This is a real <form>, so the fields come from FormData rather than a hand-built
                    // JSON body — the page context has to be appended explicitly.
                    fd.append('source_page', location.pathname + location.search);
                    try {
                        const utm = window.wtUtm ? window.wtUtm() : {};
                        for (const k in utm) if (utm[k]) fd.append(k, utm[k]);
                    } catch(_) {}
                    const res=await fetch('/api/lead.php', { method:'POST', body:fd });
                    // Read the BODY, not just the status. res.ok alone would show the success screen
                    // for any 2xx that reported success:false — including a honeypot rejection — so a
                    // visitor could be told "brief received" when nothing was sent.
                    const out=await res.json().catch(()=>null);
                    if(res.ok && out && out.success){
                        f.style.display='none';
                        document.getElementById('qdone').style.display='block';
                        // Fire Lead HERE, on confirmed delivery — not from wt-track.js's capture-phase
                        // submit delegate, which ran before this fetch and so counted a conversion even
                        // when the send failed. The form carries data-wt-manual-track to suppress that.
                        // Matches how the homepage and /contact panels already behave.
                        try {
                            const emailEl=f.querySelector('input[name=email]');
                            const nameEl=f.querySelector('input[name=name]');
                            const parts=(nameEl&&nameEl.value||'').trim().split(/\s+/).filter(Boolean);
                            window.wtTrack && window.wtTrack('Lead',
                                { content_name:'project_brief_start' },
                                { email:(emailEl&&emailEl.value||'').trim().toLowerCase(),
                                  phone:phoneE164,
                                  first_name:(parts[0]||'').toLowerCase(),
                                  last_name:parts.slice(1).join(' ').toLowerCase() });
                        } catch(_) {}
                        // Exactly one Lead fires for this page, and it is the wtTrack call above.
                        // There is no raw fbq('track','Lead') here, and wt-track.js's capture-phase
                        // submit delegate is suppressed by data-wt-manual-track on the form — which
                        // is what stops the double count Meta used to record for /start.
                    } else { throw new Error((out && out.message) || 'bad'); }
                } catch(err){
                    btn.disabled=false; btn.textContent='Try again →';
                    // A Turnstile token is single-use. Any failed attempt must get a fresh challenge,
                    // or the corrected resubmission fails for a reason the visitor cannot see.
                    try { if (window.turnstile) window.turnstile.reset(); } catch(_) {}
                    // Surface the server's reason. Without this a rejected brief showed only a
                    // button label change and the visitor had no idea which field was wrong.
                    showErr((err && err.message && err.message !== 'bad')
                        ? err.message
                        : 'We could not send that just now. Please try again, or email info@kiasa.tech.');
                }
            });
        })();
    