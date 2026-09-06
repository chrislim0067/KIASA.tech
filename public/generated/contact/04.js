
        // ----- Custom dropdowns (Service + Budget) -----
        document.querySelectorAll('.custom-select').forEach(cs => {
            const trigger = cs.querySelector('.custom-select-trigger');
            const label = trigger.querySelector('span');
            const options = Array.from(cs.querySelectorAll('.custom-select-option'));
            const hiddenSelect = cs.closest('.select-group').querySelector('select');
            const placeholder = label.textContent;
            let focusIdx = -1;
            function selectOption(opt) {
                label.textContent = opt.textContent;
                cs.classList.add('has-value');
                closeDropdown();
                const val = opt.dataset.value;
                let existing = hiddenSelect.querySelector('option[value="' + val + '"]');
                if (!existing) { existing = document.createElement('option'); existing.value = val; hiddenSelect.appendChild(existing); }
                hiddenSelect.value = val;
                options.forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
            }
            function openDropdown() {
                document.querySelectorAll('.custom-select.open').forEach(other => { if (other !== cs) { other.classList.remove('open'); other.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false'); } });
                cs.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); focusIdx = -1; options.forEach(o => o.classList.remove('kb-focus'));
            }
            function closeDropdown() { cs.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); focusIdx = -1; options.forEach(o => o.classList.remove('kb-focus')); }
            trigger.addEventListener('click', (e) => { e.stopPropagation(); cs.classList.contains('open') ? closeDropdown() : openDropdown(); });
            options.forEach(opt => opt.addEventListener('click', (e) => { e.stopPropagation(); selectOption(opt); }));
            trigger.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cs.classList.contains('open') ? closeDropdown() : openDropdown(); }
                else if (e.key === 'Escape') { closeDropdown(); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); if (!cs.classList.contains('open')) openDropdown(); focusIdx = Math.min(focusIdx + 1, options.length - 1); options.forEach(o => o.classList.remove('kb-focus')); options[focusIdx].classList.add('kb-focus'); options[focusIdx].scrollIntoView({ block: 'nearest' }); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); if (!cs.classList.contains('open')) openDropdown(); focusIdx = Math.max(focusIdx - 1, 0); options.forEach(o => o.classList.remove('kb-focus')); options[focusIdx].classList.add('kb-focus'); options[focusIdx].scrollIntoView({ block: 'nearest' }); }
            });
            cs.addEventListener('keydown', (e) => { if (e.key === 'Enter' && focusIdx >= 0 && cs.classList.contains('open')) { e.preventDefault(); selectOption(options[focusIdx]); } });
            cs._reset = () => { label.textContent = placeholder; cs.classList.remove('has-value'); options.forEach(o => o.classList.remove('selected', 'kb-focus')); hiddenSelect.value = ''; trigger.setAttribute('aria-expanded', 'false'); };
        });
        document.addEventListener('click', () => { document.querySelectorAll('.custom-select.open').forEach(cs => { cs.classList.remove('open'); cs.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false'); }); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.querySelectorAll('.custom-select.open').forEach(cs => { cs.classList.remove('open'); cs.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false'); }); } });

        // ----- Submit → /api/lead.php (same validation as the homepage) -----
        window.submitForm = function () {
            const btn = document.getElementById('submit-btn');
            const errEl = document.getElementById('form-error');
            const name = document.getElementById('form-name').value.trim();
            const email = document.getElementById('form-email').value.trim();
            const phone = document.getElementById('form-phone').value.trim();
            const service = document.getElementById('form-service').value;
            const budget = document.getElementById('form-budget').value;
            const message = document.getElementById('form-message').value.trim();
            const company = (document.getElementById('form-company')||{}).value?.trim() || '';
            const website = (document.getElementById('form-website')||{}).value?.trim() || '';
            const honeypot = document.getElementById('form-hp').value;
            errEl.style.display = 'none';
            if (honeypot) return;
            function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
            if (!name || name.length < 2) return showErr('Please enter your full name.');
            if (!company) return showErr('Please enter your company or brand name.');
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
            if (!email || !emailRegex.test(email)) return showErr('Please enter a valid email address.');
            const disposable = ['mailinator.com','guerrillamail.com','tempmail.com','throwaway.email','yopmail.com','10minutemail.com','trashmail.com'];
            if (disposable.includes((email.split('@')[1] || '').toLowerCase())) return showErr('Please use a real email address.');
            // Country-aware phone validation via Assets/wt-phone.js. See the long note on the
            // homepage's copy: the old /^\+?[0-9]{7,15}$/ accepted a trunk 0 left in after the
            // country code, accepted any 7 digits from anywhere, and rejected dotted numbers.
            // phoneE164 is what gets submitted and hashed — Meta and Google match on E.164, so a
            // locally-formatted UAE number previously matched nothing at either.
            let phoneE164 = phone.replace(/\D/g, '');
            if (window.wtPhone) {
                const p = window.wtPhone.parse(phone, window.__wtCC ? window.__wtCC.cc() : '971');
                if (!p.ok) return showErr(p.reason);
                phoneE164 = p.e164;
            } else if (!phone || !/^\+?[0-9]{7,15}$/.test(phone.replace(/[\s\-\(\)\.]/g, ''))) {
                return showErr('Please enter a valid phone number.');
            }
            if (!service) return showErr('Please select a service.');
            if (!budget) return showErr('Please select an estimated budget.');
            const original = btn.innerHTML;
            btn.textContent = 'Sending…'; btn.disabled = true;
            // Our own endpoint — see the long note on the homepage's copy. Validated server-side,
            // stored in the `leads` table before delivery is attempted, then emailed over
            // authenticated SMTP from our own domain. No third-party form service, no access key in
            // page source.
            fetch('/api/lead.php', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({
                    wt_form: 'contact',
                    from_name: name, email: email, phone: (phoneE164 ? '+' + phoneE164 : phone), service: service, budget: budget,
                    message: message || '(No additional details)', botcheck: honeypot,
                    company: company, website: website,
                    // Country the visitor selected, kept beside the E.164 number — it cannot be
                    // recovered from the digits afterwards (+1 is shared by 20-odd countries).
                    phone_country_iso:  window.__wtCC ? window.__wtCC.iso()  : '',
                    phone_dial_code:    window.__wtCC ? window.__wtCC.dial() : '',
                    phone_country_name: window.__wtCC ? window.__wtCC.name() : '',
                    phone_raw: phone,
                    // Turnstile injects this hidden input into the widget container. The server
                    // verifies it against Cloudflare; the value here proves nothing on its own.
                    'cf-turnstile-response': (document.querySelector('.cf-turnstile [name="cf-turnstile-response"]')||{}).value || '',
                    source_page: location.pathname
                // Campaign attribution captured on the landing page by wt-track.js.
                }, (window.wtUtm ? window.wtUtm() : {})))
            })
            .then(r => r.json())
            .then(d => {
                if (d.success) {
                    btn.textContent = 'Sent ✓';
                    // Fire the Lead conversion through wtTrack, not the raw Pixel.
                    //
                    // This panel is a <div> with an onclick button, not a real <form>, so no `submit`
                    // event is ever dispatched and wt-track.js's submit delegate — the thing that
                    // normally emits Lead — never runs here. index.html had exactly this bug and was
                    // fixed; this page was missed, and went on calling fbq('track','Contact')
                    // directly. That meant a lead submitted on the contact page produced: no Google
                    // Ads conversion, no GA4 event, no server-side CAPI (browser-only, so lost to any
                    // ad blocker), no PII for enhanced matching — and it was labelled Contact, which
                    // is the event for tapping a WhatsApp or email link, not for submitting a form.
                    //
                    // wtTrack dual-fires Pixel + CAPI under one shared event_id so Meta deduplicates
                    // them, emits GA4 generate_lead, and fires the Ads conversion. PII is hashed
                    // server-side; it is passed raw here exactly as index.html does.
                    try {
                        window.wtTrack && window.wtTrack('Lead',
                            { content_name: 'contact_form_contact_page', service: service, budget: budget },
                            { email: String(email).trim().toLowerCase(), phone: phoneE164 });
                    } catch (e) {}
                    ['form-name','form-email','form-phone','form-message'].forEach(id => document.getElementById(id).value = '');
                    document.querySelectorAll('.custom-select').forEach(cs => cs._reset && cs._reset());
                    setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 3200);
                } else {
                    btn.textContent = 'Failed — Try Again'; btn.disabled = false;
                    // Turnstile tokens are single-use; without a reset the corrected resubmission
                    // fails for a reason the visitor has no way to see.
                    try { if (window.turnstile) window.turnstile.reset(); } catch (e) {}
                    // Show the gateway's reason rather than only changing the button label.
                    if (d && d.message) showErr(d.message);
                }
            })
            .catch(() => { btn.textContent = 'Failed — Try Again'; btn.disabled = false; });
        };
    // Country selector on the phone field. Mounted once the tracker's phone module is available;
    // it writes the ISO, dial code, raw entry and country name as hidden inputs beside the field.
    (function mountCC(){
        var el = document.getElementById('form-phone');
        if (!el) return;
        if (!window.wtPhone) return void setTimeout(mountCC, 120);   // wt-phone.js is deferred
        window.__wtCC = window.wtPhone.mountSelector(el, { iso: 'AE' });
    })();

    