
    // A Turnstile token is single-use, so a failed attempt needs a fresh challenge before the
    // visitor can retry.
    function resetTurnstile(){ try { if (window.turnstile) window.turnstile.reset(); } catch (e) {} }
    async function submitNewsletter(e) {
        e.preventDefault();
        const btn = document.getElementById('newsletter-btn');
        const email = document.getElementById('newsletter-email').value.trim();
        if (!email) return;
        const hp = document.getElementById('newsletter-hp');
        if (hp && hp.value) return;                       // a human never fills a display:none field
        btn.textContent = 'Sending...';
        btn.disabled = true;
        try {
            // Our own endpoint. A signup is stored in the `leads` table with form_type 'newsletter'
            // and emailed over authenticated SMTP — no third-party form service, no access key here.
            // This form needs only an email; api/lead.php relaxes the name and phone requirements for
            // the newsletter profile and requires them for the three lead forms.
            const res = await fetch('/api/lead.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({
                    wt_form: 'newsletter',
                    from_name: 'KIASA Newsletter',
                    email: email,
                    message: 'New subscriber: ' + email,
                    botcheck: hp ? hp.value : '',
                    'cf-turnstile-response': (document.querySelector('#newsletter-form [name="cf-turnstile-response"]')||{}).value || '',
                    source_page: location.pathname
                }, (window.wtUtm ? window.wtUtm() : {})))
            });
            const data = await res.json();
            if (data.success) {
                btn.textContent = 'Subscribed! ✓';
                document.getElementById('newsletter-email').value = '';
                // Subscribe fires HERE, on confirmed delivery. It reaches Meta (pixel + CAPI),
                // GA4 as the recommended `sign_up` event, and — once a Newsletter Signup conversion
                // action exists in the Ads account — a Google Ads conversion. Until this call
                // existed on the success path, a signup was counted whether or not it worked.
                try {
                    window.wtTrack && window.wtTrack('Subscribe',
                        { content_name: 'newsletter' }, { email: email.trim().toLowerCase() });
                } catch (e) {}
            }
            else { btn.textContent = 'Try Again'; btn.disabled = false; resetTurnstile(); }
        } catch { btn.textContent = 'Try Again'; btn.disabled = false; resetTurnstile(); }
    }
    