/* ══════════════════════════════════════════════════════════════════════════════════════════════
   /estimate — the flow controller.  Renders generated steps; owns no pricing.
   ══════════════════════════════════════════════════════════════════════════════════════════════

   Pricing and flow logic live in Assets/estimate-engine.js (a port of the PHP engine). This file
   only turns what that returns into DOM, and turns clicks back into state. It has no prices, no
   step numbers and no per-service special cases — a new group in $WT_CAT renders here with no
   change to this file, which is the test of whether Pass 2 actually generated the flow or just
   moved the hardcoding.

   THE INVALIDATION RULE, which is the load-bearing part:
     every state change goes through set(), and set() re-prunes, re-derives the active list and
     re-clamps the cursor. There is no path that mutates SEL directly, so there is no path that can
     leave a hidden answer in the total. */
(function () {
  'use strict';

  var BOOT = window.WT_EST_BOOT;
  var E = window.WTEstimate;
  if (!BOOT || !E) { return; }
  var CAT = BOOT.cat;

  var stage = document.getElementById('wt-stage');
  var live = document.getElementById('wt-live');
  var liveUsd = document.getElementById('wt-live-usd');
  var liveAed = document.getElementById('wt-live-aed');
  var liveMo = document.getElementById('wt-live-mo');
  var pctEl = document.getElementById('wt-pct');
  var fillEl = document.getElementById('wt-fill');
  var prevBtn = document.getElementById('wt-prev');
  var nextBtn = document.getElementById('wt-next');

  /* ── state ────────────────────────────────────────────────────────────────────────────────── */
  var S = {
    ident: { name: '', email: '', phone: '', company: '' },
    service: '',
    ids: {},
    qty: {},
    i: 0,
    touched: {},   // which steps have been attempted, so errors only show after a real try
    sending: false,
    sent: false,   // set only on a server-confirmed success; gates the conversion event
    routeAck: {},  // routes the visitor has already been shown, so the notice appears once
    lastPick: '',  // the most recent option chosen, so a dense group can describe the right one
    verify: null,  // the server's authoritative result once fetched
    verifyState: '', // '' | 'pending' | 'agreed' | 'corrected' | 'unavailable'
    /* The country selector's API, from wt-phone.js. Re-mounted every time the phone step renders,
       because this flow replaces the whole stage on any state change. */
    cc: null,
    phoneMeta: { iso: '', dial: '', name: '', raw: '', e164: '' },
    /* What the last change deleted, as labels. Rewritten by every set(), so it describes the most
       recent action and nothing older. */
    dropped: []
  };
  var STEPS = [];
  var PRICE = null;

  function sel() { return { ids: S.ids, qty: S.qty, service: S.service }; }

  /* The single mutation point. Everything else calls this. */
  function set(mutate) {
    var before = Object.keys(S.ids).length;
    mutate();
    S.dropped = [];
    if (S.service && CAT.services[S.service]) {
      /* pruneFor, never prune: the resolved service includes the shared groups, and pruning
         against the unresolved one would silently discard every answer given in them. */
      var p = E.pruneFor(CAT, S.service, { ids: S.ids, qty: S.qty });
      /* SAY WHAT IT DELETED. prune() has always returned the list and set() has always thrown it
         away, so a visitor who went back and changed "Online store" to "Brochure" watched the total
         fall by four figures with no sentence anywhere explaining which answers went with it. That
         is the single fastest way to stop trusting a number.
         Not reported when the visitor switched service — S.ids is emptied deliberately there and
         listing thirty deleted answers as a warning would be describing the thing they just asked
         for. */
      if (p.removed && p.removed.length && before) {
        S.dropped = labelsOf(p.removed);
      }
      S.ids = p.ids;
      S.qty = p.qty;
    }
    STEPS = E.activeSteps(CAT, S.service, sel());
    if (S.i > STEPS.length - 1) { S.i = STEPS.length - 1; }
    if (S.i < 0) { S.i = 0; }
    PRICE = S.service ? E.price(CAT, S.service, { ids: S.ids, qty: S.qty }) : null;
    render();
  }

  /** Human labels for a list of option ids, for the removal notice. */
  function labelsOf(ids) {
    var svc = E.service(CAT, S.service);
    if (!svc) { return []; }
    var ix = E.index(svc);
    var out = [];
    ids.forEach(function (id) {
      var hit = ix[id];
      if (hit && hit.o && out.indexOf(hit.o.label) === -1) { out.push(hit.o.label); }
    });
    return out;
  }

  /* Rendered on whatever step the visitor is looking at, because that is where they were when the
     deletion happened. Three names then a count: a list of eleven is not read, and "11 earlier
     answers" alone is not checkable. */
  function droppedNotice() {
    if (!S.dropped.length) { return ''; }
    var shown = S.dropped.slice(0, 3).map(esc).join(', ');
    var rest = S.dropped.length - 3;
    return '<p class="wt-dropped" role="status">That change removed ' +
      (S.dropped.length === 1 ? 'an earlier answer' : S.dropped.length + ' earlier answers') +
      ' &mdash; ' + shown + (rest > 0 ? ' and ' + rest + ' more' : '') +
      '. The total has come down to match.</p>';
  }

  /* ── formatting. USD leads, AED is derived and secondary, everywhere. ─────────────────────── */
  function usd(n) { return '$' + Number(n).toLocaleString('en-US'); }
  function aed(n) { return 'AED ' + Number(n).toLocaleString('en-US'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* The price chip beside an option. Included says Included — a "+$0" reads as a bug. */
  /* WHAT ELSE THIS TICK BUYS. An option with `min_level` pulls a whole level of another group in
     with it — "User accounts" needs somewhere to keep the accounts. The engine has always done it
     and the result screen has always labelled the extra line "Required by your selection", but the
     card the visitor actually presses said "+$270" while the total moved $1,220.
     Derived from the catalogue every render, never stored: it depends on what is already selected,
     and it disappears the moment the level is covered. */
  function liftedBy(o) {
    if (!o.min_level || !S.service) { return null; }
    var svc = E.service(CAT, S.service);
    if (!svc) { return null; }
    var gid = o.min_level[0], want = o.min_level[1] || 0;
    var target = null;
    svc.groups.forEach(function (gg) { if (gg.id === gid) { target = gg; } });
    if (!target) { return null; }
    /* Covered by an equal or higher level — whether the visitor chose it or an earlier tick
       already lifted it. Read from the priced LINES, not from S.ids: an auto-lifted level is
       charged without ever being selected, so testing selection alone would keep warning
       "adds $950" on the next four cards after the $950 had already been added once. */
    var charged = {};
    if (PRICE && PRICE.lines) {
      PRICE.lines.forEach(function (l) { charged[l.id] = true; });
    }
    var covered = target.options.some(function (t) {
      return (S.ids[t.id] || charged[t.id]) && (t.level || 0) >= want;
    });
    if (covered) { return null; }
    var lift = null;
    target.options.forEach(function (t) { if ((t.level || 0) === want) { lift = t; } });
    return (lift && lift.price) ? lift : null;
  }

  function priceChip(o, g) {
    if (o.review) { return '<span class="wt-opt-p">Review</span>'; }
    if (o.routes) { return '<span class="wt-opt-p is-inc">Priced separately</span>'; }
    /* multi_band prices the COUNT, not the item, so every option in the group carries price 0 and
       every card said "Included". Eleven cards all reading Included, followed by a total that jumps
       by $950, is worse than saying nothing — it reads as a promise. The band and its price are
       stated once under the grid instead, where they are true. */
    if (g && g.method === 'multi_band' && !o.price && o.id !== (g.zero_option && g.zero_option.id)) {
      return '';
    }
    /* A branching question — "What kind of website is this?", "How advanced should it be?" — has no
       priced option at all, because the answer only decides what we ask next. Every card said
       "Included", which reads as a list of things being given away. Say nothing on the card; the
       note under the grid explains it once. */
    if (g && g.allFree) { return ''; }
    /* TWO NUMBERS, BOTH ALREADY CHARGED. Every Marketing channel carries `price` AND `monthly`,
       and both engines bill both — the setup into its bucket and the management fee into the
       monthly one. The card printed the setup only. A $400 card was a $6,400 first year, and the
       group's own help text promised the two were "shown separately so you can see exactly what
       recurs". Nothing here changes a price: the second number was already in the total, and the
       card was the only place it did not appear. */
    var mo = o.monthly ? '<span class="wt-opt-p2">' + usd(o.monthly) + ' / month</span>' : '';
    var yr = o.annual ? '<span class="wt-opt-p2">' + usd(o.annual) + ' / year</span>' : '';
    if (!o.price) {
      if (mo || yr) { return mo + yr; }
      /* Same rule as the result list: "Included" is a promise, and on a card the visitor is about
         to press in order to DECLINE something — "None", "You supply images", "Nothing saved" — it
         promises to deliver the thing they are declining. Only what genuinely ships with the build
         regardless of the answer says Included. */
      return o.always
        ? '<span class="wt-opt-p is-inc">Included</span>'
        : '<span class="wt-opt-p is-inc">No charge</span>';
    }
    var suffix = o.bucket === 'monthly' ? ' / mo' : (o.bucket === 'annual' ? ' / yr' : '');
    var each = o.per_unit ? ' each' : '';
    return '<span class="wt-opt-p">+' + usd(o.price) + suffix + each +
      ((mo || yr) ? ' setup' : '') + '</span>' + mo + yr;
  }

  /* ── rendering ────────────────────────────────────────────────────────────────────────────── */
  /* Set by render() immediately before it calls a renderer, read by stepEl. A module flag rather than
     a parameter threaded through all five renderers: it is written and read inside one synchronous
     render pass and never survives it. See the .wt-step--still comment in estimate.php for why the
     class exists at all. */
  var STILL = false;

  function stepEl(inner, num, q, subtitle, flag) {
    return '<section class="wt-step is-active' + (STILL ? ' wt-step--still' : '') + '">' +
      '<div class="wt-in wt-in--wide">' +
      (num ? '<span class="wt-num">' + esc(num) + '</span>' : '') +
      (q ? '<h2 class="wt-q" tabindex="-1">' + q + '</h2>' : '') +
      (flag || '') +
      (subtitle ? '<p class="wt-sub">' + subtitle + '</p>' : '') +
      droppedNotice() +
      inner +
      '<p class="wt-err" id="wt-err" role="alert" aria-live="assertive"></p>' +
      '<div class="wt-acts"><button type="button" class="wt-btn" data-act="next">' +
      'Next <span class="arw">&rarr;</span></button></div>' +
      '<span class="wt-kbd">or press <b>Enter</b></span>' +
      '</div></section>';
  }

  function renderIntro() {
    return '<section class="wt-step is-active"><div class="wt-in">' +
      '<h1 class="wt-q" tabindex="-1">Build Your Package,<br>See The <em>Price Move</em></h1>' +
      '<p class="wt-sub">Pick only the parts you need. A one-page site prices like a one-page ' +
      'site &mdash; and a flagship still prices like a flagship.</p>' +
      '<div class="wt-acts"><button type="button" class="wt-btn" data-act="next">' +
      'Start here <span class="arw">&rarr;</span></button></div>' +
      '<span class="wt-kbd">Press <b>Enter</b> &crarr;</span>' +
      '</div></section>';
  }

  var FIELD_Q = {
    name: ['What&rsquo;s your <em>name?</em>', 'John Doe', 'name'],
    email: ['Where do we send<br>the <em>proposal?</em>', 'john@company.com', 'email'],
    phone: ['Best <em>number</em> to reach you?', '50 123 4567', 'tel'],
    company: ['And your <em>company?</em>', 'Company name', 'organization']
  };

  function renderField(st, n) {
    var f = FIELD_Q[st.id];
    var v = S.ident[st.id] || '';
    var inner = '<div class="wt-one"><input type="' + st.type + '" id="wt-f" ' +
      'value="' + esc(v) + '" placeholder="' + esc(f[1]) + '" autocomplete="' + f[2] + '" ' +
      'aria-label="Your ' + st.id + '"' + (st.required ? ' required' : '') + '></div>';
    /* The one optional identity field wears the same badge as an optional question, rather than
       saying the same thing in a different place in a different voice. */
    return stepEl(inner, n, f[0], '', st.required ? ''
      : '<span class="wt-opt-flag">Optional &mdash; skip if you don&rsquo;t need it</span>');
  }

  function renderService(n) {
    var tiles = BOOT.services.map(function (s) {
      var on = S.service === s.id ? ' is-on' : '';
      return '<label class="wt-opt' + on + '" data-sid="' + esc(s.id) + '">' +
        '<input type="radio" name="wt-svc"' + (on ? ' checked' : '') + '>' +
        '<span class="wt-opt-t">' + esc(s.name) + '</span>' +
        (s.tagline ? '<span class="wt-opt-d">' + esc(s.tagline) + '</span>' : '') +
        '</label>';
    }).join('');
    return stepEl('<div class="wt-opts wt-opts--wide" id="wt-svc-grid">' + tiles + '</div>',
      n, 'What do you need <em>built?</em>',
      'This decides which questions you get &mdash; nothing else.');
  }

  /* Human wording for an unmet requirement. A disabled tile with no reason is worse than an
     enabled tile that quietly does nothing, so every gate has to say what it wants. */
  var GATE_TEXT = {
    'cw.cms:collection': 'needs a CMS collection to filter',
    'cw.cms:any': 'needs a CMS first',
    'cw.backend:1+': 'needs a backend first',
    'pf.accounts:1+': 'needs accounts first'
  };
  function gateReason(token) {
    if (GATE_TEXT[token]) { return GATE_TEXT[token]; }
    /* a specific-id list: name what it needs, using the catalogue's own labels */
    var ix = E.index(E.service(CAT, S.service));
    var names = String(token).split('|').map(function (t) {
      return ix[t] ? ix[t].o.label : t;
    });
    return 'needs ' + names.join(' or ');
  }

  /* The exclusion note. A <details> rather than always-on body text: it matters at the moment
     someone is deciding, and it would be noise on every other screen. Closed by default, so the
     interface stays scannable and the information is still one tap away rather than buried in a
     proposal nobody reads before signing. */
  function exclusionPanel(g) {
    if (!g.not_included) { return ''; }
    return '<details class="wt-excl"><summary>What this does not include</summary>' +
      '<p>' + esc(g.not_included) + '</p></details>';
  }

  /* Which groups accept more than one answer — and therefore which ones a click can UNDO.
     `per_unit` belongs here and was missing, which is the whole bug: it fell through to the
     single-choice branch, so clicking the selected card re-selected it and there was no way to
     clear it. Nothing on the screen offered an escape either, because the "tap again to remove"
     hint was gated on the same test. A per_unit group is additive by nature — you can want an
     extra layout AND some entries keyed in, each with its own quantity — so it was never a
     pick-one. single / levels / band genuinely hold exactly one answer and stay excluded: those
     are required by stepValid, and clearing one would only disable Next. */
  function isMulti(g) {
    return g.method === 'multi' || g.method === 'multi_band' || g.method === 'per_unit';
  }

  function optionMarkup(g, o, on, blockedReason) {
    var qty = '';
    if (o.per_unit && on) {
      var v = S.qty[o.id] || 1;
      /* aria-label names the thing being counted. "Fewer" alone, repeated down a grid, tells a
         screen-reader user nothing about which quantity they are changing. */
      var unit = esc(o.unit || 'each');
      qty = '<span class="wt-qty" data-qty="' + esc(o.id) + '">' +
        '<button type="button" data-step-qty="-1" aria-label="One fewer ' + unit + ', ' +
          esc(o.label) + '"' + (v <= 1 ? ' disabled' : '') + '>&minus;</button>' +
        '<output aria-label="' + esc(o.label) + ' quantity">' + v + '</output>' +
        '<button type="button" data-step-qty="1" aria-label="One more ' + unit + ', ' +
          esc(o.label) + '"' + (v >= 99 ? ' disabled' : '') + '>+</button>' +
        '<span class="wt-qty-u">' + unit + '</span></span>';
    }
    var multi = isMulti(g);
    var isBlocked = !!blockedReason;
    /* The studio's recommendation, from the catalogue. A visitor facing ten priced bands has no way
       to know which one people like them usually need, and the commonest response to that is to
       leave. It is deliberately a badge and a hairline, not a pre-selection: nothing is chosen for
       anyone, and the total still starts from what they actually pick. Suppressed when blocked,
       because recommending something the visitor cannot currently choose is just a taunt. */
    var rec = (o.recommended && !isBlocked)
      ? '<span class="wt-opt-rec">Recommended</span>' : '';
    return '<label class="wt-opt' + (on ? ' is-on' : '') +
      (o.recommended && !isBlocked ? ' is-rec' : '') +
      (isBlocked ? ' is-blocked' : '') + '" data-oid="' + esc(o.id) + '"' +
      (isBlocked ? ' aria-disabled="true" title="' + esc(gateReason(blockedReason)) + '"' : '') +
      '>' + rec +
      '<input type="' + (multi ? 'checkbox' : 'radio') + '" name="g-' + esc(g.id) + '"' +
      (on ? ' checked' : '') + (o.always || isBlocked ? ' disabled' : '') + '>' +
      '<span class="wt-opt-t">' + esc(o.label) +
      /* The tick is the answer to "how do I remove this?" — it marks the card as a thing that is
         currently ON, which implies it can be turned off. A border colour alone does not. */
      (on ? '<span class="wt-opt-tick" aria-hidden="true">&check;</span>' : '') + '</span>' +
      (isBlocked ? '<span class="wt-opt-p is-inc">' + esc(gateReason(blockedReason)) + '</span>'
                 : priceChip(o, g)) +
      (o.desc && !isBlocked ? '<span class="wt-opt-d">' + esc(o.desc) + '</span>' : '') +
      (isBlocked ? '' : liftNote(o)) +
      qty + '</label>';
  }

  function liftNote(o) {
    var lift = liftedBy(o);
    if (!lift) { return ''; }
    return '<span class="wt-opt-lift">Also needs <b>' + esc(lift.label) + '</b> ' +
      '&mdash; adds ' + usd(lift.price) + '</span>';
  }

  /* ── MATRIX GROUPS ────────────────────────────────────────────────────────────────────────────
     A group whose options are every combination of two axes. cw.sections drew all ten of
     style x count as separate cards, which is ten boxes on a phone for what is really two
     decisions — and the labels ("Standard · 6–8") only make sense once you have worked out that
     they are a grid flattened into a list.

     Asked as two axes instead: which kind, then how many, on a stepper. The ids and the prices are
     untouched — the pair resolves back to exactly one of the ten options the engine already knows,
     so nothing downstream changes and no price moves. */
  function matrixOf(g) {
    var styles = [], tiers = [];
    g.options.forEach(function (o) {
      if (o.style && styles.indexOf(o.style) === -1) { styles.push(o.style); }
      if (o.tier && tiers.indexOf(o.tier) === -1) { tiers.push(o.tier); }
    });
    return { styles: styles, tiers: tiers };
  }

  function matrixFind(g, style, tier) {
    var hit = null;
    g.options.forEach(function (o) {
      if (o.style === style && o.tier === tier) { hit = o; }
    });
    return hit;
  }

  /** The option currently chosen in a matrix group, or null. */
  function matrixCurrent(g) {
    var hit = null;
    g.options.forEach(function (o) { if (S.ids[o.id]) { hit = o; } });
    return hit;
  }

  function renderMatrix(g, n) {
    return stepEl(matrixBody(g), n, esc(g.q || g.label), groupSub(g), skipBadge(g));
  }

  /* The matrix control with no step chrome around it, so it can also ride on another question's
     screen as an addon. */
  function matrixBody(g) {
    var ax = matrixOf(g);
    var cur = matrixCurrent(g);
    /* Default the stepper to the smallest tier, but select nothing until the visitor acts — the
       Next button stays disabled, exactly as it would for any other single-choice question. */
    var style = cur ? cur.style : null;
    var tier = cur ? cur.tier : (g._tier || ax.tiers[0]);
    var ti = ax.tiers.indexOf(tier);
    if (ti < 0) { ti = 0; tier = ax.tiers[0]; }

    var cards = ax.styles.map(function (sname) {
      var o = matrixFind(g, sname, tier);
      var on = !!(cur && cur.style === sname);
      var note = (g.style_notes && g.style_notes[sname]) || '';
      return '<label class="wt-opt wt-opt--matrix' + (on ? ' is-on' : '') +
        '" data-mstyle="' + esc(sname) + '">' +
        '<input type="radio" name="m-' + esc(g.id) + '"' + (on ? ' checked' : '') + '>' +
        '<span class="wt-opt-t">' + esc(sname) +
        (on ? '<span class="wt-opt-tick" aria-hidden="true">&check;</span>' : '') + '</span>' +
        (o ? '<span class="wt-opt-p">+' + usd(o.price) + '</span>' : '') +
        (note ? '<span class="wt-opt-d">' + esc(note) + '</span>' : '') +
        '</label>';
    }).join('');

    var stepper =
      '<div class="wt-mx">' +
        '<span class="wt-mx-q">' + esc((g.matrix && g.matrix.tier) || 'How many?') + '</span>' +
        '<span class="wt-mx-ctl">' +
          '<button type="button" data-mstep="-1" aria-label="Fewer"' +
            (ti === 0 ? ' disabled' : '') + '>&minus;</button>' +
          '<output class="wt-mx-v">' + esc(tier) + '</output>' +
          '<button type="button" data-mstep="1" aria-label="More"' +
            (ti === ax.tiers.length - 1 ? ' disabled' : '') + '>+</button>' +
        '</span>' +
      '</div>';

    /* data-mg names the owning group. Until a screen could hold two questions the handler could
       assume STEPS[S.i].group and be right; now it has to be told. */
    var body = '<div class="wt-mx-g" data-mg="' + esc(g.id) + '">' + stepper +
      '<span class="wt-mx-q wt-mx-q--2">' + esc((g.matrix && g.matrix.style) || 'Which kind?') + '</span>' +
      '<div class="wt-opts wt-opts--matrix">' + cards + '</div></div>';
    var hint = cur
      ? '<p class="wt-hint">Change the number above and the price follows.</p>'
      : '<p class="wt-hint">Set the number, then pick which kind.</p>';
    return body + hint + exclusionPanel(g);
  }

  /* ── ONE SCREEN, TWO QUESTIONS ───────────────────────────────────────────────────────────────
     A step carries a host group and, when the catalogue asks for it, one or more addon groups —
     see activeSteps in estimate-engine.js for why. Each renders its own controls, its own help
     text and its own exclusion panel. Only the step chrome is shared: the number, the Next button
     and the error line. The routing hand-off is emitted once for the SCREEN rather than once per
     question on it, because it is a property of the whole estimate. */
  function renderGroup(st, n) {
    var g = st.group;
    var addons = st.addons || [];
    if (!addons.length) {
      if (g.matrix) { return renderMatrix(g, n); }
      return stepEl(groupBody(g) + routeBlock(), n, esc(g.q || g.label), groupSub(g), skipBadge(g));
    }
    var body = (g.matrix ? matrixBody(g) : groupBody(g)) +
      addons.map(function (a) {
        return '<section class="wt-addon">' +
          '<h3 class="wt-addon-q" id="wt-addon-' + esc(a.id) + '">' + esc(a.q || a.label) + '</h3>' +
          skipBadge(a) +
          (a.help_text ? '<p class="wt-addon-s">' + helpHtml(a) + '</p>' : '') +
          (a.matrix ? matrixBody(a) : groupBody(a)) +
          '</section>';
      }).join('') + routeBlock();
    return stepEl(body, n, esc(g.q || g.label), groupSub(g), skipBadge(g));
  }

  /* The help text is the answer to "what am I even choosing here?" and sits directly under the
     question, where it is read. A few entries are written as two lines and the break is meaningful,
     so it survives escaping. */
  function helpHtml(g) {
    return esc(g.help_text).replace(/\n/g, '<br>');
  }

  /* CAN THIS BE SKIPPED? 49 of the 87 questions can, and nothing on the screen said so — the
     visitor read every card of a nineteen-option grid looking for the one they were supposed to
     choose. The engine already knows the answer: single / levels / band must hold exactly one, and
     anything the catalogue marks `required` must hold at least one. Everything else is optional by
     construction, so this cannot drift out of step with what Next actually enforces. */
  function isOptional(g) {
    return !(g.method === 'single' || g.method === 'levels' || g.method === 'band' || g.required);
  }

  function skipBadge(g) {
    return isOptional(g)
      ? '<span class="wt-opt-flag">Optional &mdash; skip if you don&rsquo;t need it</span>'
      : '';
  }

  function groupSub(g) {
    if (g.help_text) { return helpHtml(g); }
    return isMulti(g) ? 'Pick any that apply, or none.' : '';
  }

  function routeBlock() {
    var route = pendingRoute();
    return route ? routeNotice(route) : '';
  }

  function groupBody(g) {
    /* bandOptions, not g.options: three groups are a level x page-band product and the band came
       from a question already answered, so only that band's cells are on offer. Nineteen cards
       become four. The engine filters the same way, so nothing can be selected that is not shown. */
    var offered = E.bandOptions(E.service(CAT, S.service), g, Object.keys(S.ids));
    var opts = offered.filter(function (o) { return !o.always || o.price; });
    if (g.zero_option) { opts = [g.zero_option].concat(opts); }
    var dense = opts.length > 8;
    var blk = (PRICE && PRICE.blocked) || {};
    var html = opts.map(function (o) {
      return optionMarkup(g, o, !!S.ids[o.id], blk[o.id]);
    }).join('');
    /* Dense groups hide per-card descriptions, because nineteen of them cannot share a phone screen.
       That left the one description the visitor actually cares about — the option they just chose —
       invisible. It now appears once, below the grid, for the most recent selection. One block
       instead of nineteen: the context is there without the page growing.

       S.lastPick is the ONLY reason this needs state. Reading "the selected one" is ambiguous the
       moment a multi-select group holds three. */
    var selDesc = '';
    if (dense) {
      var focus = null;
      if (S.lastPick && S.ids[S.lastPick]) {
        focus = opts.filter(function (o) { return o.id === S.lastPick; })[0] || null;
      }
      if (!focus) {
        var on = opts.filter(function (o) { return S.ids[o.id] && o.desc; });
        focus = on.length ? on[on.length - 1] : null;
      }
      if (focus && focus.desc) {
        selDesc = '<div class="wt-seldesc"><span class="wt-seldesc-l">Selected</span>' +
          '<p><b>' + esc(focus.label) + '</b> &mdash; ' + esc(focus.desc) + '</p></div>';
      }
    }
    var cls = 'wt-opts' + (dense ? ' wt-opts--dense' : '');
    /* Only wrap in the bounded scroller when the count genuinely cannot centre. Below that the
       grid handles it and the page stays a single centred question. */
    var body = opts.length > 10
      ? '<div class="wt-opts-wrap"><div class="' + cls + '">' + html + '</div></div>'
      : '<div class="' + cls + '">' + html + '</div>';
    var multiSel = isMulti(g);
    var anyOn = g.options.some(function (o) { return S.ids[o.id] && !o.always; });
    var note = g.note ? '<p class="wt-fine">' + esc(g.note) + '</p>' : '';
    note += exclusionPanel(g);
    /* The help text sits under the question, where it is read — groupSub() owns it now, because on
       a shared screen the host's help text is the step subtitle and an addon's belongs to the addon
       block. The hint below the options is the answer to "I clicked that by mistake" and is stated
       only once something is actually selected, because until then it is noise. */
    /* Where a multi_band group's price actually comes from. The cards cannot carry it — the price is
       a function of how many are ticked, not of which ones — so it is stated once, here, and updates
       as they tick. Without this the group looked free until the total moved. */
    /* Derived, not stored: a group where nothing is priced is a branching question. Marking it on
       the group object once means priceChip and the note below agree by construction. */
    g.allFree = g.options.every(function (o) { return !o.price; })
      && !(g.bands && g.bands.length) && g.method !== 'per_unit';

    var bandNote = '';
    if (g.allFree) {
      bandNote = '<p class="wt-hint">Nothing on this screen is priced &mdash; your answer decides ' +
        'which questions come next.</p>';
    } else if (g.method === 'multi_band' && g.bands && g.bands.length) {
      var n = g.options.filter(function (o) { return !!S.ids[o.id]; }).length;
      var hit = null;
      for (var bi = 0; bi < g.bands.length; bi++) {
        if (n <= g.bands[bi][0] || bi === g.bands.length - 1) { hit = g.bands[bi]; break; }
      }
      if (!n) {
        bandNote = '<p class="wt-hint">Nothing selected &mdash; nothing charged for this.</p>';
      } else if (hit) {
        bandNote = '<p class="wt-hint"><b>' + n + (n === 1 ? ' selected' : ' selected') +
          '</b> &mdash; ' + esc(hit[2]) + ', ' + usd(hit[3]) +
          '. Priced by how many you pick, not which.</p>';
      }
    }

    /* Only the removal hint survives here. "Choose as many as apply — or none" is now stated
       above the options, where it is read before the reading starts rather than after it. */
    var hint = '';
    if (multiSel && anyOn) {
      hint = '<p class="wt-hint">Tap a selected option again to remove it.</p>';
    }
    return body + selDesc + bandNote + hint + note;
  }

  /** Labels compared as a buyer reads them: case, spacing and punctuation are not the difference
      between two rows saying the same word. */
  function flat(v) {
    return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function renderResult() {
    var p = PRICE;
    if (!p) { return stepEl('', '', 'Pick a service first'); }
    var byBucket = { build: [], setup: [], monthly: [], annual: [] };
    p.lines.forEach(function (l) { byBucket[l.bucket].push(l); });
    /* One shared suffix for every place a price is printed, so a monthly fee can never render as a
       one-time one. buildPayload() already appended this to the emailed scope; the screen the buyer
       actually forwards did not, so a Marketing scope showed "Google Ads +$400" (one-time) and
       "Optimisation +$350" (every month) in one undifferentiated column. */
    var BUCKET_SUFFIX = { monthly: ' / month', annual: ' / year' };

    var rows = function (arr) {
      return arr.map(function (l) {
        /* A review line is not free and it is not a number yet — it is the one the studio has to
           look at. It was printing "Included", which on the two most expensive rows in a scope
           reads as a promise to do them for nothing. */
        var v;
        if (l.review && !l.included) {
          /* A review line is not free and it is not a number yet — it is the one the studio has to
             look at. It was printing "Included", which on the two most expensive rows in a scope
             reads as a promise to do them for nothing. */
          v = 'To be quoted';
        } else if (l.absorbed) {
          /* Name the absorber's GROUP when its option is called the same thing as this one, which
             is exactly what happens across the Web Platforms modules: "Filters — Included with
             Filters" is a tautology where the point was to show the visitor they are not being
             charged twice. */
          var same = flat(l.absorbed) === flat(l.label);
          v = 'Included with ' + esc(same && l.absorbed_group ? l.absorbed_group : l.absorbed);
        } else if (l.included) {
          /* "Included" is a promise. Against a row the visitor chose in order to DECLINE something
             — "None", "Not needed", "You supply images" — it was a promise to deliver the thing
             they had just said they did not want. It belongs to what comes with the build. */
          v = (l.always || l.auto) ? 'Included' : 'No charge';
        } else {
          v = '+' + usd(l.amount) + (BUCKET_SUFFIX[l.bucket] || '');
        }
        var meta = [];
        if (l.qty > 1) { meta.push(l.qty + ' × ' + usd(l.unit)); }
        if (l.auto && !l.included) { meta.push('Required by your selection'); }
        if (l.review) { meta.push('needs review'); }
        return '<div class="wt-res-l"><span class="wt-res-n">' + esc(l.label) +
          (meta.length ? '<small>' + esc(meta.join(' · ')) + '</small>' : '') +
          '</span><span class="wt-res-v' + (l.included ? ' is-inc' : '') +
          (l.review && !l.included ? ' is-review' : '') + '">' + v +
          '</span></div>';
      }).join('');
    };

    /* A heading per non-empty bucket. Without them the four groups run together as one list and the
       reader has no way to tell which rows recur. */
    var BUCKET_HEAD = {
      build: 'One-time build', setup: 'One-time setup',
      monthly: 'Every month', annual: 'Every year'
    };
    var section = function (key) {
      var arr = byBucket[key];
      if (!arr || !arr.length) { return ''; }
      /* Only label when more than one bucket is in play — a build-only scope needs no headings. */
      var many = ['build', 'setup', 'monthly', 'annual']
        .filter(function (k) { return byBucket[k] && byBucket[k].length; }).length > 1;
      return (many ? '<div class="wt-res-h">' + esc(BUCKET_HEAD[key]) + '</div>' : '') + rows(arr);
    };
    var head = p.state === 'review'
      ? '<span class="wt-badge wt-badge--review">Custom review required</span>'
      : '<span class="wt-badge">Estimate</span>';
    var main = p.marketing ? p.buckets.setup : p.buckets.build;
    var mainLabel = p.marketing ? 'Setup, one-time' : 'Build, one-time';
    var totals = '<div class="wt-res-tot"><b>' +
      (p.state === 'review' ? 'From ' + usd(main.usd) : usd(main.usd)) +
      '</b><span>' +
      (p.state === 'review' ? 'Estimated configured scope' : mainLabel) +
      '<br>&asymp; ' + aed(main.aed) + '</span></div>';
    if (p.buckets.monthly.usd) {
      totals += '<div class="wt-res-sub"><span>Monthly management</span><span>' +
        usd(p.buckets.monthly.usd) + ' / month &nbsp;&asymp; ' + aed(p.buckets.monthly.aed) +
        '</span></div>';
    }
    if (p.buckets.annual.usd) {
      totals += '<div class="wt-res-sub"><span>Care plan</span><span>' +
        usd(p.buckets.annual.usd) + ' / year &nbsp;&asymp; ' + aed(p.buckets.annual.aed) +
        '</span></div>';
    }
    if (p.marketing) {
      totals += '<div class="wt-res-sub"><span><b>Initial payment</b> (setup + first month)</span>' +
        '<span><b>' + usd(p.initial.usd) + '</b> &nbsp;&asymp; ' + aed(p.initial.aed) +
        '</span></div>' +
        '<p class="wt-fine">Ad spend is paid separately to the advertising platforms and is never ' +
        'part of a KIASA fee.</p>';
    }
    /* Only a service whose day data is a real commitment gets an exact figure. Custom Websites
       printed "2 working days" on every scope it can produce, because one priced option out of 128
       carries a `days` value — a $23,315 bilingual build and a $550 one-pager made the same promise.
       Owner decision, 22 Aug 2026: say what is true rather than invent the number. */
    var delivery = p.days_state === 'review'
      ? 'confirmed after technical review'
      : (p.days_state === 'fixed' && p.days
        ? p.days + ' working days'
        : 'confirmed after scope review');
    totals += '<div class="wt-res-sub"><span>Delivery timeline</span><span>' +
      delivery + '</span></div>';
    /* Checkout eligibility is DETERMINED and shown even though no provider is wired. Getting the
       state right now is what makes Pass 5 a matter of connecting a provider rather than working out
       the rules under time pressure. */
    var cta = (p.state === 'review' || !p.payable)
      ? 'Send for review'
      : 'Send this to KIASA';
    var verifyNote = '';
    if (S.verifyState === 'corrected') {
      verifyNote = '<p class="wt-fine"><b>We recalculated your scope before submission.</b> ' +
        'The figures above are the confirmed ones.</p>';
    } else if (S.verifyState === 'unavailable') {
      verifyNote = '<p class="wt-fine">We will confirm these figures when your enquiry ' +
        'reaches us.</p>';
    }
    var msg = '';
    if (p.state === 'review') {
      msg = '<p class="wt-fine">Some parts of this project need technical review before we can ' +
        'confirm a final price and delivery timeline: <b>' +
        esc(p.review.map(function (r) { return r.label; }).join(', ')) +
        '</b>. Your complete scope comes through with the enquiry.</p>';
    } else if (!p.payable) {
      msg = '<p class="wt-fine">Your scope is below our online checkout minimum of ' +
        usd(p.floor.usd) + '. Send it to us and we&rsquo;ll review the best way to help.</p>';
    }
    /* "You can add later" — genuinely addable things only, capped at four.
       Excluded on purpose: groups that are not currently visible (they are not offered), auto
       groups (never asked), anything blocked by an unmet dependency, and any group whose only
       remaining options are Review or routed elsewhere. A suggestion the visitor cannot act on is
       worse than no suggestion, and a wall of them turns a quote into a sales page. */
    var blk = p.blocked || {};
    var addable = [];
    (E.service(CAT, S.service).groups || []).forEach(function (g) {
      if (addable.length >= 4) { return; }
      if (p.visible.indexOf(g.id) === -1 || g.method === 'auto') { return; }
      /* A group that MUST be answered is never an "add later": if it is unanswered here the visitor
         could not have reached this screen, and if it is answered the branch below already skips
         it. Listing one would be offering to sell them a question they were required to settle. */
      if (g.method === 'single' || g.method === 'levels' || g.method === 'band' || g.required) { return; }
      /* ANY selection counts as answered, not just a priced one. Testing `o.price` meant a visitor
         who explicitly chose the free "No monitoring" option was then told "You can add later:
         Monitoring from $675" — the estimator re-offering the thing they had just declined, which
         reads as not having listened. A zero-priced choice is still a choice.
         The zero_option is checked too: it is not in g.options. */
      var chosen = g.options.some(function (o) { return S.ids[o.id]; })
        || !!(g.zero_option && S.ids[g.zero_option.id]);
      if (chosen) { return; }
      var real = g.options.filter(function (o) {
        return o.price && !o.review && !o.routes && !blk[o.id];
      });
      if (!real.length) { return; }
      var cheapest = real.reduce(function (a, b) { return b.price < a.price ? b : a; });
      /* Carry the bucket, or "$675" silently means "$8,100 a year". */
      addable.push({ label: g.label, from: cheapest.price, bucket: cheapest.bucket });
    });
    /* "You can add later" read as a list of things the visitor might already have bought — it sat
       directly under a total, in the same column of prices, with nothing saying which side of the
       line it was on. The heading now says so in the first four words, and the prices are marked as
       starting points rather than quotes: `cheapest` is the lowest option in the group, and the
       group usually contains several. */
    var up = addable.length
      ? '<p class="wt-upsell"><b>Not in this estimate.</b> You can add any of these later, ' +
        'starting from:<br>' +
        addable.map(function (a) {
          return '<span class="wt-upsell-i">' + esc(a.label) + ' <b>' + usd(a.from) +
            (BUCKET_SUFFIX[a.bucket] || '') + '</b></span>';
        }).join('') + '</p>'
      : '';
    var inner = '<div class="wt-res">' + head + totals +
      '<div class="wt-res-list">' +
      section('build') + section('setup') +
      section('monthly') + section('annual') +
      '</div>' + verifyNote + msg + up +
      (p.note ? '<p class="wt-fine">' + esc(p.note) + '</p>' : '') +
      '</div>';
    return '<section class="wt-step is-active"><div class="wt-in wt-in--wide">' +
      '<h2 class="wt-q" tabindex="-1" style="font-size:clamp(1.5rem,4vw,2.2rem)">' +
      'Your <em>scope</em></h2>' + inner +
      '<div class="wt-acts"><button type="button" class="wt-btn" data-act="send">' +
      cta + ' <span class="arw">&rarr;</span></button></div>' +
      '<p class="wt-err" id="wt-err" role="alert" aria-live="assertive"></p>' +
      '<span class="wt-fine">' +
      (p.payable && p.state !== 'review'
        ? 'Online payment opens once this scope is confirmed in writing.'
        : 'No payment is taken here.') +
      '</span></div></section>';
  }

  /* The identity of the question on screen — not the index. S.i alone is wrong: the step list is
     regenerated on every selection, so answering one question can change which step index a given
     question occupies, and an index comparison would then call a genuine step change "still". */
  var LAST_KEY = null;
  function stepKey(st) {
    return st ? st.k + ' ' + (st.id || (st.group && st.group.id) || '') : '';
  }

  function render() {
    if (!STEPS.length) { STEPS = E.activeSteps(CAT, S.service, sel()); }
    var st = STEPS[S.i];
    var key = stepKey(st);
    var moved = (key !== LAST_KEY);
    STILL = !moved;
    LAST_KEY = key;
    /* ── WHAT SURVIVES A SAME-QUESTION RE-RENDER ──────────────────────────────────────────────
       Every click rebuilds the stage, because a selection can reveal options, block others or drop
       an answer the engine pruned — patching one card would be wrong. But rebuilding threw away
       everything the visitor had positioned: the page jumped to the top of the question, an open
       "What this does not include" snapped shut, an inner list lost its place, and focus left the
       card that was just pressed.

       Captured before the swap and restored after, and ONLY when the question is the same. Moving
       to a new question should start at the top — that is not a bug, it is the point.
       No second state system: this reads the DOM, restores the DOM, and keeps nothing. */
    var keep = null;
    if (STILL) {
      var stepEl_ = stage.querySelector('.wt-step');
      var active = document.activeElement;
      keep = {
        stepTop: stepEl_ ? stepEl_.scrollTop : 0,
        inner: [].slice.call(stage.querySelectorAll('.wt-opts-wrap, .wt-res-list'))
          .map(function (el, i) { return { i: i, cls: el.className, top: el.scrollTop }; }),
        /* by option id, because <details> elements are recreated and index would drift the moment
           a reveal adds or removes a group */
        openExcl: !!stage.querySelector('.wt-excl[open]'),
        focusOid: active && active.closest ? (active.closest('[data-oid]') || {}).getAttribute
          ? (active.closest('[data-oid]') || {}).getAttribute('data-oid') : null : null,
        focusAct: active && active.getAttribute ? active.getAttribute('data-act') : null,
        /* the quantity stepper's own buttons: they are neither a [data-oid] nor a [data-act], so
           without this a keyboard user pressing + three times lost focus on the first press */
        focusQty: active && active.closest && active.closest('[data-step-qty]')
          ? { id: (active.closest('.wt-qty') || {}).getAttribute
                ? active.closest('.wt-qty').getAttribute('data-qty') : null,
              d: active.closest('[data-step-qty]').getAttribute('data-step-qty') }
          : null
      };
    }

    var n = S.i > 0 && st.k !== 'result' ? ('0' + S.i).slice(-2) : '';
    var html;
    if (st.k === 'intro') { html = renderIntro(); }
    else if (st.k === 'field') { html = renderField(st, n); }
    else if (st.k === 'service') { html = renderService(n); }
    else if (st.k === 'group') { html = renderGroup(st, n); }
    else { html = renderResult(); }
    stage.innerHTML = html;

    /* Restore, synchronously, before the browser paints — an assignment made in the same task as
       the innerHTML swap never shows the intermediate position. */
    if (keep) {
      if (keep.openExcl) {
        var ex = stage.querySelector('.wt-excl');
        if (ex) { ex.open = true; }
      }
      var st2 = stage.querySelector('.wt-step');
      if (st2 && keep.stepTop) { st2.scrollTop = keep.stepTop; }
      var inners = stage.querySelectorAll('.wt-opts-wrap, .wt-res-list');
      keep.inner.forEach(function (rec) {
        var el = inners[rec.i];
        /* only when the same kind of scroller came back in the same slot — a revealed group can
           change the list and restoring a stale offset would be worse than starting at the top */
        if (el && el.className === rec.cls && rec.top) { el.scrollTop = rec.top; }
      });
    }

    /* The Turnstile widget is fixed above the flow and shown only here — see the .cf-turnstile
       comment in estimate.php. Toggling a body class rather than moving the element keeps
       Cloudflare's iframe mounted: re-parenting or re-rendering the stage would destroy a widget
       that may already hold a solved challenge, and the visitor would have to start it again. */
    document.body.classList.toggle('wt-on-result', st.k === 'result');
    if (st.k === 'result') { verifyWithServer(); }
    if (st.k === 'field' && st.id === 'phone') { mountPhone(); }

    /* progress from the derived list, never a constant */
    var pct = STEPS.length > 1 ? Math.round((S.i / (STEPS.length - 1)) * 100) : 0;
    pctEl.textContent = pct;
    fillEl.style.width = pct + '%';
    prevBtn.disabled = (S.i === 0);
    nextBtn.disabled = (S.i >= STEPS.length - 1);

    /* the running total */
    if (PRICE && st.k !== 'intro' && st.k !== 'result') {
      var m = PRICE.marketing ? PRICE.buckets.setup : PRICE.buckets.build;
      liveUsd.textContent = usd(m.usd);
      liveAed.textContent = '≈ ' + aed(m.aed);
      liveMo.textContent = PRICE.buckets.monthly.usd
        ? '+ ' + usd(PRICE.buckets.monthly.usd) + ' / mo' : '';
      live.classList.add('is-on');
    } else {
      live.classList.remove('is-on');
    }

    /* focus: the text field if there is one, otherwise the heading, so a screen reader and a
       keyboard user both land somewhere useful. Never :focus-visible-dependent.

       Only on an actual step change. Re-focusing the heading after every click pulled focus off the
       card the visitor had just pressed, which flickered the focus ring and — worse for a screen
       reader — re-announced the whole question on every selection instead of announcing what changed.
       The one exception is a text field, which has to be re-focused because the re-render replaced
       the element the caret was in. */
    var f = stage.querySelector('input[type=text], input[type=email], input[type=tel]');
    if (f) {
      f.focus({ preventScroll: true });
      try { var L = f.value.length; f.setSelectionRange(L, L); } catch (_) {}
    } else if (moved) {
      (stage.querySelector('.wt-q') || stage).focus({ preventScroll: true });
    } else if (keep && keep.focusQty && keep.focusQty.id) {
      var qsel = '.wt-qty[data-qty="' + (window.CSS && CSS.escape ? CSS.escape(keep.focusQty.id) : keep.focusQty.id) +
        '"] [data-step-qty="' + keep.focusQty.d + '"]';
      var qb = stage.querySelector(qsel);
      /* − disables itself at one, and focusing a disabled button silently drops focus to <body>.
         Hand it to the other end of the stepper instead, which is where the visitor can still act. */
      if (qb && !qb.disabled) { qb.focus({ preventScroll: true }); }
      else {
        var other = stage.querySelector('.wt-qty[data-qty="' + (window.CSS && CSS.escape ? CSS.escape(keep.focusQty.id) : keep.focusQty.id) + '"] [data-step-qty]:not([disabled])');
        if (other) { other.focus({ preventScroll: true }); }
      }
    } else if (keep && (keep.focusOid || keep.focusAct)) {
      /* Put the keyboard user back on the control they were using. Without this, Tab after a
         selection restarted at the top of the question and a keyboard visitor had to walk the whole
         grid again to reach the next card. preventScroll because the scroll position was already
         restored above and focus() would otherwise fight it. */
      var back = keep.focusOid
        ? stage.querySelector('[data-oid="' + (window.CSS && CSS.escape ? CSS.escape(keep.focusOid) : keep.focusOid) + '"]')
        : stage.querySelector('[data-act="' + keep.focusAct + '"]');
      /* [data-oid] is the <label>, and a label is not focusable — calling focus() on one silently
         does nothing and leaves focus on <body>, which is the whole failure this branch exists to
         prevent. The focusable thing is the input it wraps. */
      if (back && back.tagName === 'LABEL') { back = back.querySelector('input') || back; }
      if (back && !back.disabled) { back.focus({ preventScroll: true }); }
    }

    if (S.touched[stepKey(st)]) { showError(); }
    cueScrollers();
  }

  /* ── "there is more below" ────────────────────────────────────────────────────────────────────
     A bounded inner list is the whole reason the page itself never scrolls, and it only works if
     the visitor can tell it is a list. On a phone there is no scrollbar to give that away: a group
     of nineteen options looked exactly like a group of the eight that happened to fit, and the
     eleven below the fold were, in practice, not on the page.

     A mask rather than an overlay, because the wrap is the scroller — an ::after inside it would
     scroll away with the content, and a sibling would have to track the wrap's box through every
     reflow. The state is on the element as data-more so CSS owns the appearance, and it clears at
     each end so the last row is never left permanently dimmed. */
  function cueScrollers() {
    var list = stage.querySelectorAll('.wt-opts-wrap, .wt-res-list');
    for (var i = 0; i < list.length; i++) { cueOne(list[i]); }
  }

  function cueOne(el) {
    /* 2px of slack: fractional scrollHeight on a 2x/3x screen means scrollTop never reaches
       scrollHeight - clientHeight exactly, and a fade that never clears reads as a broken edge. */
    var more = el.scrollHeight - el.clientHeight > 2;
    var atTop = el.scrollTop <= 2;
    var atEnd = el.scrollTop >= el.scrollHeight - el.clientHeight - 2;
    el.setAttribute('data-more', !more ? '' : (atTop ? 'bottom' : (atEnd ? 'top' : 'both')));
  }

  /* scroll does not bubble, so this listens in the capture phase. */
  stage.addEventListener('scroll', function (e) {
    var el = e.target;
    if (el && el.classList && (el.classList.contains('wt-opts-wrap') || el.classList.contains('wt-res-list'))) {
      cueOne(el);
    }
  }, true);
  window.addEventListener('resize', cueScrollers);

  /* ── routing hand-off ─────────────────────────────────────────────────────────────────────────
     A route means "this belongs to another service" — substantial 3D on a website, an accompanying
     website inside a 3D build. The engine reports it; this offers the switch.

     It is OFFERED, never silent. Moving someone to a different service changes every question and
     every price, and doing that without a sentence of explanation reads as the page breaking. The
     contact fields survive the switch because re-typing a name and email is the fastest way to lose
     a lead; the service-specific answers cannot survive, because they are answers to questions the
     new service does not ask. */
  function pendingRoute() {
    if (!PRICE || !PRICE.routes || !PRICE.routes.length) { return null; }
    for (var i = 0; i < PRICE.routes.length; i++) {
      var r = PRICE.routes[i];
      if (!S.routeAck[r.id] && CAT.services[r.to]) { return r; }
    }
    return null;
  }

  function routeNotice(r) {
    var toLabel = (CAT.services[r.to] || {}).label || r.to;
    return '<div class="wt-route" id="wt-route">' +
      '<p class="wt-route-t">This project fits <em>' + esc(toLabel) + '</em> better.</p>' +
      '<p class="wt-route-d">' + esc(r.label) + ' is priced there, not here &mdash; we do not ' +
      'charge for the same work in two services. We can continue your estimate in ' +
      esc(toLabel) + ', keeping your name, email, phone and company. The answers you gave for ' +
      esc((E.service(CAT, S.service) || {}).label) + ' will be cleared, because ' +
      esc(toLabel) + ' asks different questions.</p>' +
      '<div class="wt-route-a">' +
      '<button type="button" class="wt-btn wt-btn--sm" data-route-to="' + esc(r.to) + '" ' +
      'data-route-id="' + esc(r.id) + '">Continue in ' + esc(toLabel) +
      ' <span class="arw">&rarr;</span></button>' +
      '<button type="button" class="wt-btn wt-btn--ghost wt-btn--sm" data-route-stay="' +
      esc(r.id) + '">Stay here</button></div></div>';
  }

  function takeRoute(to, routeId) {
    set(function () {
      S.service = to;
      S.ids = {};                 // answers to the old service's questions cannot transfer
      S.qty = {};
      S.routeAck = {};
      S.i = E.IDENTITY.length - 1;   // land on the service step so the switch is visible
      /* S.ident is deliberately untouched: name, email, phone and company all survive. */
    });
  }

  /* ── validation feedback ──────────────────────────────────────────────────────────────────── */
  function currentValid() {
    var st = STEPS[S.i];
    /* The phone step defers to wt-phone.js, which knows the per-country length rules — a UAE
       mobile and a US number are not the same shape and the engine's digit count cannot tell them
       apart. The engine keeps its own looser rule for the Node tests, where wtPhone does not exist,
       so this is an upgrade at runtime rather than a second source of truth. */
    if (st.k === 'field' && st.id === 'phone' && window.wtPhone) {
      var m = readPhone();
      return !!m.e164;
    }
    return E.stepValid(st, sel(), S.ident);
  }
  function showError() {
    var el = stage.querySelector('#wt-err');
    if (!el) { return; }
    if (currentValid()) { el.style.display = 'none'; return; }
    var st = STEPS[S.i];
    var msg = 'Pick one to continue.';
    if (st.k === 'field') {
      /* wt-phone.js returns a reason per failure — wrong length for the chosen country, letters in
         the field, a leading zero it stripped. That beats one generic sentence. */
      var phoneReason = (st.id === 'phone' && S.phoneMeta && S.phoneMeta.reason)
        ? S.phoneMeta.reason : '';
      msg = st.type === 'email' ? 'That email doesn&rsquo;t look right.'
        : st.type === 'tel' ? (phoneReason || 'That number looks too short.')
          : 'Please fill this in.';
    } else if (st.k === 'service') { msg = 'Choose a service to continue.'; }
    else {
      /* NAME THE QUESTION. One screen can now hold two, and "Pick one to continue." under a screen
         with two headings is an instruction with no address — the visitor answers the one they can
         see and presses Next again. */
      var miss = E.unanswered(st, sel());
      if (miss && st.addons && st.addons.length) {
        msg = 'Answer &ldquo;' + esc(miss.q || miss.label) + '&rdquo; to continue.';
      }
    }
    el.innerHTML = msg;
    el.style.display = 'block';
  }

  /* ── WHICH QUESTION WAS THAT? ────────────────────────────────────────────────────────────────
     A step used to be exactly one group, so every handler could read STEPS[S.i].group and be
     right. A step can now carry a host question and addons, so the handlers have to resolve the
     group from the element that was clicked. Getting this wrong would not throw — it would apply
     one group's select-one/select-many rule to another group's options, which is a wrong answer
     recorded silently. */
  function stepGroupsNow() {
    var st = STEPS[S.i];
    return (st && st.k === 'group') ? [st.group].concat(st.addons || []) : [];
  }

  /** The group that owns this option id, among the questions currently on screen. */
  function groupOfOption(oid) {
    var list = stepGroupsNow();
    for (var i = 0; i < list.length; i++) {
      var opts = list[i].options || [];
      for (var j = 0; j < opts.length; j++) {
        if (opts[j].id === oid) { return list[i]; }
      }
    }
    return null;
  }

  /** The matrix group whose control was clicked, read from the data-mg wrapper. */
  function groupOfMatrix(el) {
    var host = el && el.closest ? el.closest('[data-mg]') : null;
    var id = host ? host.getAttribute('data-mg') : null;
    var list = stepGroupsNow();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

  /* ── navigation ───────────────────────────────────────────────────────────────────────────── */
  function go(delta) {
    /* Once the server has confirmed the send, the flow is over. This is the single choke point —
       the nav buttons, the arrow keys and Enter all route through here — so closing it here means
       no path can reopen a questionnaire whose answers have already been submitted. */
    if (S.sent) { return; }
    if (delta > 0) {
      /* Keyed by the QUESTION, not by its index. S.i is a position in a list that is rebuilt on
         every answer, so touching step 7 and then changing an earlier answer that reveals a new
         group left step 7's flag pointing at a different question — which then rendered with a
         validation error before the visitor had touched it. */
      S.touched[stepKey(STEPS[S.i])] = true;
      if (!currentValid()) { showError(); return; }
    }
    set(function () { S.i = Math.max(0, Math.min(STEPS.length - 1, S.i + delta)); });
  }

  /* ── events ───────────────────────────────────────────────────────────────────────────────── */
  stage.addEventListener('click', function (e) {
    /* THE WHOLE QUANTITY ZONE, not just its two buttons.
       The stepper is rendered INSIDE the option's <label>, so a tap that lands on the number, on
       the unit word, or on the padding between them bubbled to the tile handler and DESELECTED the
       option the visitor was adjusting — losing the quantity with it. Only the +/- buttons were
       ever guarded. Anything inside .wt-qty is now the stepper's business, and preventDefault stops
       the label activating its checkbox natively as well. */
    var qtyZone = e.target.closest('.wt-qty');
    if (qtyZone) {
      e.preventDefault();
      var qtyBtn = e.target.closest('[data-step-qty]');
      if (!qtyBtn) { return; }              // the number or the unit: adjust nothing, toggle nothing
      var id = qtyZone.getAttribute('data-qty');
      var d = parseInt(qtyBtn.getAttribute('data-step-qty'), 10);
      set(function () {
        S.qty[id] = Math.max(1, Math.min(99, (S.qty[id] || 1) + d));
      });
      return;
    }
    var toBtn = e.target.closest('[data-route-to]');
    if (toBtn) {
      takeRoute(toBtn.getAttribute('data-route-to'), toBtn.getAttribute('data-route-id'));
      return;
    }
    var stayBtn = e.target.closest('[data-route-stay]');
    if (stayBtn) {
      var rid = stayBtn.getAttribute('data-route-stay');
      set(function () { S.routeAck[rid] = true; });
      return;
    }
    var act = e.target.closest('[data-act]');
    if (act) {
      if (act.getAttribute('data-act') === 'next') { go(1); }
      else { send(); }
      return;
    }
    var svcTile = e.target.closest('[data-sid]');
    if (svcTile) {
      var sid = svcTile.getAttribute('data-sid');
      set(function () {
        if (S.service !== sid) { S.ids = {}; S.qty = {}; }   // a new service invalidates everything
        S.service = sid;
      });
      return;
    }
    /* Matrix groups: the stepper moves the count axis, the cards pick the style axis, and either
       one resolves the pair back to a single existing option id. Stepping with a style already
       chosen keeps that style — that is the whole point of asking the two axes separately. */
    var mstep = e.target.closest('[data-mstep]');
    if (mstep && !mstep.disabled) {
      var mg = groupOfMatrix(mstep);
      if (mg && mg.matrix) {
        var axs = matrixOf(mg);
        var curS = matrixCurrent(mg);
        var shown = stage.querySelector('.wt-mx-v');
        var atNow = curS ? curS.tier : (shown ? shown.textContent : axs.tiers[0]);
        var idx = axs.tiers.indexOf(atNow);
        if (idx < 0) { idx = 0; }
        idx = Math.max(0, Math.min(axs.tiers.length - 1,
          idx + parseInt(mstep.getAttribute('data-mstep'), 10)));
        var wantTier = axs.tiers[idx];
        set(function () {
          /* The pending tier lives on the group so a re-render shows it. Selecting nothing until a
             style is picked is deliberate: the count alone is not an answer, and Next stays
             disabled exactly as it does for any other single-choice question. */
          mg._tier = wantTier;
          if (curS) {
            mg.options.forEach(function (o) { delete S.ids[o.id]; });
            var swap = matrixFind(mg, curS.style, wantTier);
            if (swap) { S.ids[swap.id] = true; S.lastPick = swap.id; }
          }
        });
      }
      return;
    }
    var mcard = e.target.closest('[data-mstyle]');
    if (mcard) {
      var mg2 = groupOfMatrix(mcard);
      if (mg2 && mg2.matrix) {
        var want = mcard.getAttribute('data-mstyle');
        var cur2 = matrixCurrent(mg2);
        var shown2 = stage.querySelector('.wt-mx-v');
        var tierNow = cur2 ? cur2.tier : (mg2._tier || matrixOf(mg2).tiers[0]);
        set(function () {
          mg2.options.forEach(function (o) { delete S.ids[o.id]; });
          /* tapping the chosen style again clears it, like every other card on the page */
          if (!cur2 || cur2.style !== want) {
            var pick = matrixFind(mg2, want, tierNow);
            if (pick) { S.ids[pick.id] = true; S.lastPick = pick.id; }
          }
        });
      }
      return;
    }

    var tile = e.target.closest('[data-oid]');
    if (tile) {
      if (tile.getAttribute('aria-disabled') === 'true') { return; }   // deterministic: no-op
      var oid = tile.getAttribute('data-oid');
      /* Focus the tile's own control BEFORE the re-render, not as a side effect of it. A label
         normally focuses its checkbox as part of the click's default action — but that happens
         after every listener has run, and this one has already replaced the whole step by then. So
         a touch or a switch tap left focus on <body>, and the next Tab restarted at the top of the
         question. Doing it here means render()'s capture sees a real element to put back.
         No focus ring appears for a pointer: :focus-visible does not match a programmatic focus
         that follows a mouse or touch interaction. */
      var tileInput = tile.querySelector('input');
      if (tileInput) { try { tileInput.focus({ preventScroll: true }); } catch (_) {} }
      var g = groupOfOption(oid);
      if (!g) { return; }
      var multi = isMulti(g);
      set(function () {
        if (multi) {
          /* Deselecting drops the quantity with it. Leaving a stale S.qty behind meant re-selecting
             a per_unit option silently brought back the count from last time. */
          if (S.ids[oid]) { delete S.ids[oid]; delete S.qty[oid]; S.lastPick = ''; }
          else {
            /* A zero option is exclusive with everything else in its group. "No CMS" sat in the
               same multi-select as Blog and Products and could be ticked alongside them, so the
               scope could say the site needs no CMS and also a product collection. */
            var zid = g.zero_option && g.zero_option.id;
            if (zid && oid === zid) {
              g.options.forEach(function (o) { delete S.ids[o.id]; delete S.qty[o.id]; });
            } else if (zid) {
              delete S.ids[zid];
            }
            /* Tiers of the same thing replace each other. "Posts 4-8 / month" and "Posts 9-16 /
               month" are one answer at two sizes, and both were tickable — a retainer priced for two
               post volumes at once. Picking one clears its siblings rather than adding to them. */
            var fam = null;
            g.options.forEach(function (o) { if (o.id === oid) { fam = o.family || null; } });
            if (fam) {
              g.options.forEach(function (o) {
                if (o.id !== oid && o.family === fam && o.band === undefined) {
                  delete S.ids[o.id]; delete S.qty[o.id];
                }
              });
            }
            S.ids[oid] = true; S.lastPick = oid;
          }
        } else {
          S.lastPick = oid;
          g.options.forEach(function (o) { delete S.ids[o.id]; });
          if (g.zero_option) { delete S.ids[g.zero_option.id]; }
          S.ids[oid] = true;
        }
      });
    }
  });

  stage.addEventListener('input', function (e) {
    if (e.target.id !== 'wt-f') { return; }
    var st = STEPS[S.i];
    if (st.id === 'phone') {
      readPhone();                 // owns S.ident.phone; do not overwrite it with the raw value
      if (S.touched[stepKey(STEPS[S.i])]) { showError(); }
      return;
    }
    S.ident[st.id] = e.target.value;
    PRICE = S.service ? E.price(CAT, S.service, { ids: S.ids, qty: S.qty }) : PRICE;
    if (S.touched[stepKey(STEPS[S.i])]) { showError(); }
  });

  /* Controls that OWN Enter. Pressing Enter on a button must press that button — a global
     Enter-to-advance that fires first means Previous goes forward, the quantity minus advances the
     step, and a <summary> never opens. The visitor sees the interface disobeying them.
     `role="button"` is included because the route hand-off uses it, and a link because Enter
     follows a link. */
  function ownsEnter(el) {
    if (!el || !el.closest) { return false; }
    return !!el.closest(
      'button, a[href], summary, details, [role="button"], [data-act], ' +
      '[data-step-qty], [data-mstep], .wt-qty, .wt-cc, select, textarea'
    );
  }

  document.addEventListener('keydown', function (e) {
    if (e.target.closest && e.target.closest('.wt-cc')) { return; }
    /* Mid-composition Enter commits the candidate in a Japanese, Chinese or Korean IME. Advancing
       the step there discards what the visitor was writing. 229 is the legacy keyCode browsers
       still send for a composing keydown. */
    if (e.isComposing || e.keyCode === 229) { return; }
    if (e.key === 'Enter') {
      if (STEPS[S.i].k === 'result') { return; }
      if (ownsEnter(e.target)) { return; }   // let the control handle its own Enter
      e.preventDefault(); go(1);
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      if (e.target.tagName === 'INPUT') { return; }
      e.preventDefault(); go(1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      if (e.target.tagName === 'INPUT') { return; }
      e.preventDefault(); go(-1);
    }
  });

  prevBtn.addEventListener('click', function () { go(-1); });
  nextBtn.addEventListener('click', function () { go(1); });

  /* ── phone: the existing selector, not a second implementation ────────────────────────────────
     Assets/wt-phone.js owns the country directory, the per-country plans, the parser and the E.164
     normaliser. It is already loaded on this page via partials/head.php, and /contact, /start and
     the homepage all mount it the same way. Reimplementing any part of it here would put a second
     copy of a 228-country table in the tree, and the two would drift.

     Two wrinkles this flow has that the static forms do not:

       1. wt-phone.js is `defer`red, so it may not exist when the step first renders. Same retry as
          contact.php and start.php: re-try in 120ms rather than failing silently.
       2. the stage is re-rendered on EVERY state change, so the input node is destroyed and
          recreated. The selector is therefore mounted per render, and the country choice is carried
          across in S.phoneMeta.iso so going back to the step does not reset it to AE.

     mountSelector also writes its own hidden inputs beside the field; those die with the re-render,
     which is why the value is read through the returned api and cached, never scraped from the DOM. */
  function mountPhone() {
    var el = stage.querySelector('#wt-f');
    if (!el || el.type !== 'tel') { return; }
    if (!window.wtPhone) { setTimeout(mountPhone, 120); return; }   // deferred script
    try {
      S.cc = window.wtPhone.mountSelector(el, { iso: S.phoneMeta.iso || 'AE' });
      readPhone();
    } catch (_) {
      S.cc = null;   // a failed mount must leave a usable plain tel field, not a dead step
    }
  }

  /** Cache what the selector currently holds, so it survives the next re-render. */
  function readPhone() {
    var el = stage.querySelector('#wt-f');
    var raw = el ? el.value : S.phoneMeta.raw;
    var cc = S.cc;
    var dialCC = cc ? cc.cc() : '971';
    var out = { iso: cc ? cc.iso() : S.phoneMeta.iso, dial: cc ? cc.dial() : S.phoneMeta.dial,
                name: cc ? cc.name() : S.phoneMeta.name, raw: raw || '', e164: '' };
    if (window.wtPhone && out.raw) {
      var r = window.wtPhone.parse(out.raw, dialCC);
      out.e164 = (r && r.ok && r.e164) ? r.e164 : '';
      out.reason = (r && !r.ok) ? r.reason : '';
    }
    S.phoneMeta = out;
    S.ident.phone = out.e164 || out.raw;
    return out;
  }

  /* ── server verification ──────────────────────────────────────────────────────────────────────
     The result screen asks the server to price the same selection, and the server's answer wins.

     This is not belt-and-braces. The preview engine is a PORT, and a port drifts: one of them gets
     a fix the other does not, and the visitor is shown a number the business never agreed to. The
     cross-check in the test suite catches that for the scenarios it covers; this catches it for the
     configuration actually in front of this visitor.

     When they disagree the preview is REPLACED, not annotated. A page showing two totals is asking
     the visitor to decide which is real. The wording says what happened without teaching anyone
     that tampering is a thing that exists. */
  function verifyWithServer() {
    if (!S.service || !PRICE) { return; }
    var want = JSON.stringify({ s: S.service, i: Object.keys(S.ids).sort(), q: S.qty });
    if (S.verify && S.verify._for === want) { return; }   // already ATTEMPTED this exact selection
    /* Claim the attempt BEFORE the request, not after it succeeds.
       render() calls this on every result-screen render, and the catch below calls render(). With
       the claim only on the success path, one dropped packet produced fetch -> fail -> render ->
       fetch, forever: a request storm that burns api/estimate.php's own 60-per-300s rate limit
       within seconds, after which every response is a 429 and the loop can never self-heal.
       The success handler replaces this sentinel with the real result, so nothing downstream reads
       a half-object. */
    S.verify = { _for: want, pending: true };
    S.verifyState = 'pending';
    fetch('/api/estimate.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema: 'wt-estimate/1',
        service: S.service,
        option_ids: Object.keys(S.ids),
        quantities: S.qty
      })
    }).then(function (res) { return res.json(); }).then(function (r) {
      if (!r || !r.ok) { throw new Error(r && r.error || 'recompute failed'); }
      r._for = want;
      S.verify = r;
      var b = PRICE.buckets;
      var agrees = r.totals.build.usd === b.build.usd
        && r.totals.setup.usd === b.setup.usd
        && r.totals.monthly.usd === b.monthly.usd
        && r.totals.annual.usd === b.annual.usd
        && r.state === PRICE.state
        && r.checkout_eligible === PRICE.payable;
      S.verifyState = agrees ? 'agreed' : 'corrected';
      if (!agrees) {
        /* Adopt the server's figures wholesale, so everything downstream — the displayed total, the
           CTA, the payload — reads from the authority rather than from the loser of the comparison. */
        PRICE.buckets.build = r.totals.build;
        PRICE.buckets.setup = r.totals.setup;
        PRICE.buckets.monthly = r.totals.monthly;
        PRICE.buckets.annual = r.totals.annual;
        PRICE.initial = r.totals.initial;
        PRICE.state = r.state;
        PRICE.payable = r.checkout_eligible;
        PRICE.days = r.days;
        PRICE.days_state = r.timeline_state;
        try {
          console.warn('[wt-estimate] preview disagreed with the server; server result adopted');
        } catch (_) {}
      }
      /* Only when something on screen actually differs. When the server agrees — the normal case —
         the figures are identical and a re-render costs the visitor their scroll position in the
         middle of reading the scope. */
      if (!agrees && STEPS[S.i] && STEPS[S.i].k === 'result') { render(); }
    }).catch(function () {
      /* Unreachable server is not a reason to block an enquiry. The preview stays on screen, the
         result is not claimed as confirmed, and api/lead.php recomputes on arrival anyway — so the
         figure the business quotes from is server-side regardless of what happened here. */
      S.verifyState = 'unavailable';
      if (STEPS[S.i] && STEPS[S.i].k === 'result') { render(); }
    });
  }

  /* ── structured payload ───────────────────────────────────────────────────────────────────────
     What goes to /api/lead.php. Ids and quantities are the load-bearing part: Pass 5's server
     recompute reads THOSE and rebuilds the price itself. The totals here are included so a human
     can see what the visitor was shown when a figure is disputed — they are explicitly labelled
     preview, and there is deliberately no field a checkout could mistake for an amount to charge.
     No `amount`, no `price`, no `total_to_charge`. */
  var PAYLOAD_SCHEMA = 'wt-estimate/1';

  function buildPayload() {
    var p = PRICE;
    var svc = E.service(CAT, S.service);
    var explicit = Object.keys(S.ids).filter(function (id) { return id.indexOf('__') !== 0; });
    var auto = [], absorbed = [], bands = [], scope = [];
    (p ? p.lines : []).forEach(function (l) {
      if (l.auto) { auto.push({ id: l.id, label: l.label, for: l.auto_for || null }); }
      if (l.absorbed) { absorbed.push({ id: l.id, label: l.label, through: l.absorbed }); }
      if (l.id.indexOf('.band.') !== -1) { bands.push({ id: l.id, label: l.label }); }
      scope.push({
        group: l.group,
        label: l.label,
        value: l.included
          ? (l.absorbed ? 'Included through ' + l.absorbed : 'Included')
          : ('+' + usd(l.amount) + (l.bucket === 'monthly' ? ' / mo'
             : l.bucket === 'annual' ? ' / yr' : ''))
             + (l.qty > 1 ? '  (' + l.qty + ' x ' + usd(l.unit) + ')' : '')
      });
    });
    return {
      schema: PAYLOAD_SCHEMA,
      generated_at: new Date().toISOString(),
      service: S.service,
      service_label: svc ? svc.label : '',
      option_ids: explicit,
      quantities: S.qty,
      bands: bands,
      auto_added: auto,
      absorbed: absorbed,
      review: p ? p.review : [],
      routes: p ? p.routes : [],
      blocked: p ? Object.keys(p.blocked || {}) : [],
      marketing: !!(p && p.marketing),
      totals: p ? {
        build_usd: p.buckets.build.usd,     build_aed: p.buckets.build.aed,
        setup_usd: p.buckets.setup.usd,     setup_aed: p.buckets.setup.aed,
        monthly_usd: p.buckets.monthly.usd, monthly_aed: p.buckets.monthly.aed,
        annual_usd: p.buckets.annual.usd,   annual_aed: p.buckets.annual.aed,
        initial_usd: p.initial.usd,         initial_aed: p.initial.aed,
        note: 'browser preview only - not authoritative, server recompute pending'
      } : null,
      days: p ? p.days : 0,
      timeline_state: p ? p.days_state : 'fixed',
      checkout_eligible: !!(p && p.payable),
      floor_usd: p ? p.floor.usd : null,
      contact: {
        name: S.ident.name, email: S.ident.email,
        phone: S.ident.phone, company: S.ident.company
      },
      scope: scope,
      summary: scopeSummary(),
      /* So a lead records whether the browser and the server ever disagreed for this visitor.
         api/lead.php recomputes independently regardless — this is diagnostics, not authority. */
      verify_state: S.verifyState || 'not-run'
    };
  }

  /* A readable one-paragraph version, so the lead is legible even where JSON is not. */
  function scopeSummary() {
    var p = PRICE;
    if (!p) { return ''; }
    var paid = p.lines.filter(function (l) { return !l.included; })
      .map(function (l) { return l.label + (l.qty > 1 ? ' x' + l.qty : ''); });
    var out = (E.service(CAT, S.service) || {}).label + ': ' + paid.join(', ') + '.';
    if (p.buckets.build.usd) { out += ' Build ' + usd(p.buckets.build.usd) + '.'; }
    if (p.buckets.setup.usd) { out += ' Setup ' + usd(p.buckets.setup.usd) + '.'; }
    if (p.buckets.monthly.usd) { out += ' Monthly ' + usd(p.buckets.monthly.usd) + '.'; }
    if (p.buckets.annual.usd) { out += ' Care ' + usd(p.buckets.annual.usd) + '/yr.'; }
    if (p.state === 'review') { out += ' NEEDS REVIEW.'; }
    return out;
  }

  /* ── send ─────────────────────────────────────────────────────────────────────────────────
     Pass 4 replaces this with the structured lead payload and Pass 5 adds the server recompute.
     Until then it is deliberately inert rather than posting a total nothing has verified. */
  function send() {
    if (S.sending || S.sent) { return; }          // no duplicate submission, ever
    var btn = stage.querySelector('[data-act=send]');
    var el = stage.querySelector('#wt-err');
    var token = document.querySelector('[name="cf-turnstile-response"]');
    var botcheck = document.getElementById('wt-botcheck');
    var payload = buildPayload();
    window.WT_EST_LAST_PAYLOAD = payload;

    S.sending = true;
    if (btn) { btn.disabled = true; btn.innerHTML = 'Sending&hellip;'; }
    if (el) { el.style.display = 'none'; }

    /* FormData, matching every other form on the site: api/lead.php parses multipart itself and its
       honeypot, rate limit, origin check and Turnstile verification all read $_POST. Posting JSON
       instead would have meant a second parse path in the endpoint for no gain. */
    var fd = new FormData();
    /* wt_form, not form_type. api/lead.php:238 reads `wt_form` and every other form on the site
       sends that; this one sent `form_type`, so $formType resolved empty and every estimator lead
       was stored as unspecified — leaving the 'Scope builder (/estimate)' label at lead.php:528 as
       unreachable dead code and the leads.form_type column unfilterable for this funnel. */
    fd.append('wt_form', 'estimate');
    fd.append('name', S.ident.name);
    fd.append('email', S.ident.email);
    /* E.164 where the parser could produce one, the raw entry otherwise. The four companion fields
       are ones api/lead.php already caps and stores — the ISO cannot be recovered from the digits
       later, because +1 is shared by the US, Canada and twenty Caribbean territories. */
    fd.append('phone', S.phoneMeta.e164 || S.ident.phone);
    fd.append('phone_raw', S.phoneMeta.raw || '');
    fd.append('phone_country_iso', S.phoneMeta.iso || '');
    fd.append('phone_dial_code', S.phoneMeta.dial || '');
    fd.append('phone_country_name', S.phoneMeta.name || '');
    fd.append('company', S.ident.company);
    fd.append('service', (E.service(CAT, S.service) || {}).label || S.service);
    fd.append('message', payload.summary);
    fd.append('estimate', JSON.stringify(payload));
    fd.append('source_page', location.pathname + location.search);
    fd.append('botcheck', botcheck && botcheck.checked ? '1' : '');
    if (token) { fd.append('cf-turnstile-response', token.value); }

    fetch('/api/lead.php', { method: 'POST', body: fd })
      .then(function (res) {
        /* Read the BODY, not just the status. A 2xx carrying success:false is how a honeypot
           rejection comes back, and treating that as delivered would show a fake success screen. */
        return res.json().catch(function () { return null; }).then(function (out) {
          return { ok: res.ok, out: out };
        });
      })
      .then(function (r) {
        if (!r.ok || !r.out || !r.out.success) {
          /* Mark the error as server-authored ONLY when the body actually parsed and carried a
             message. The catch shows the written fallback for everything else, so a network failure
             can never surface the browser's own wording to a buyer. */
          var msg = r.out && r.out.message;
          var e = new Error(msg || 'send failed');
          e.fromServer = !!msg;
          throw e;
        }
        S.sending = false;
        S.sent = true;
        fireConversion();                          // ONLY here: the server confirmed it
        renderSent();
      })
      .catch(function (err) {
        S.sending = false;
        if (btn) { btn.disabled = false; btn.innerHTML = 'Try again <span class="arw">&rarr;</span>'; }
        var e2 = stage.querySelector('#wt-err');
        if (e2) {
          /* Precedence inverted. `err.message` came first, so the visitor saw "Failed to fetch" —
             the browser's own words for a dead network — at the exact moment of conversion, and the
             written sentence carrying an email address was unreachable in every code path. A
             server-authored message is shown only when the response actually parsed and said
             something; anything else gets the sentence a person can act on. */
          e2.textContent = (err && err.fromServer && err.message)
            ? err.message
            : 'We could not send that just now. Please try again, or email info@kiasa.tech.';
          e2.style.display = 'block';
        }
        /* A Turnstile token is single-use, so a failed attempt must be given a fresh challenge or
           the corrected resubmission fails for a reason the visitor cannot see. Same as /start. */
        try { if (window.turnstile) { window.turnstile.reset(); } } catch (_) {}
        /* State is untouched: every answer and every contact field survives a failed send. */
      });
  }

  /* Exactly one conversion, fired on confirmed delivery only. Never on reaching the result screen,
     never on a retry: S.sent gates send() itself, so this cannot run twice. */
  var _fired = false;
  function fireConversion() {
    if (_fired) { return; }
    _fired = true;
    try {
      var parts = (S.ident.name || '').trim().split(/\s+/).filter(Boolean);
      if (window.wtTrack) {
        window.wtTrack('Lead', { content_name: 'estimate_builder' }, {
          email: (S.ident.email || '').trim().toLowerCase(),
          phone: (S.phoneMeta.e164 || S.ident.phone || '').trim(),
          first_name: (parts[0] || '').toLowerCase(),
          last_name: parts.slice(1).join(' ').toLowerCase()
        });
      }
    } catch (_) {}
  }

  function renderSent() {
    var p = PRICE;
    stage.innerHTML = '<section class="wt-step is-active"><div class="wt-in">' +
      '<h2 class="wt-q" tabindex="-1">Got it &mdash; <em>scope received</em></h2>' +
      '<p class="wt-sub">We have your full configuration' +
      (p && p.state === 'review'
        ? ', including the parts that need a technical look. '
        : '. ') +
      'You will hear back with an itemised proposal within one working day.</p>' +
      '<span class="wt-kbd">You can close this tab.</span>' +
      '</div></section>';
    live.classList.remove('is-on');
    /* SENT IS TERMINAL. Back used to re-enter the questionnaire after a successful send: the buyer
       revised something, pressed Send, and `if (S.sending || S.sent) { return; }` swallowed it
       without a word — so the last thing a converted visitor experienced was the site appearing to
       break. Both nav buttons and the arrow-key path are closed off here; go() checks S.sent too,
       so nothing can reopen the flow from a route this does not know about. */
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    var q = stage.querySelector('.wt-q');
    if (q) { q.focus({ preventScroll: true }); }
  }

  /* ── THE ON-SCREEN KEYBOARD ───────────────────────────────────────────────────────────────────
     On a phone the first four steps are text fields, and tapping one opens a keyboard that covers
     roughly half the screen. The step is `position: fixed; inset: 0` and vertically centred, and by
     default the keyboard resizes only the VISUAL viewport — the layout viewport stays full height —
     so the page does not know it shrank. The field and the Next button end up centred in a space
     the visitor can only see the top half of, and Next is behind the keyboard: you can type, and
     then you are stuck.

     visualViewport is the only reliable measure of what is actually on screen. Its height goes into
     a custom property, the flow is bound to that height while the keyboard is open, and a class on
     <body> lets the CSS drop the two fixed widgets that would otherwise be trapped behind it. The
     result is that the field and Next sit together in the visible strip.

     Guarded for absence: without visualViewport (older Safari, any desktop) nothing here runs and
     the layout is exactly what it was. */
  (function keyboardAware() {
    var vv = window.visualViewport;
    if (!vv) { return; }
    var root = document.documentElement;
    var raf = 0;

    function sync() {
      raf = 0;
      var h = Math.round(vv.height);
      root.style.setProperty('--wt-vvh', h + 'px');
      root.style.setProperty('--wt-vvt', Math.round(vv.offsetTop) + 'px');
      /* "Is a keyboard open?" has no API. The test is that the visual viewport is meaningfully
         shorter than the window — 0.8 clears browser UI appearing and hiding on scroll, which is a
         much smaller delta than any keyboard. */
      var open = h < window.innerHeight * 0.8;
      document.body.classList.toggle('wt-kb', open);
      if (open) {
        /* Keep the focused field in view even on the shortest phones, where the field plus the
           button plus the question may still not all fit. `nearest` scrolls the minimum needed
           rather than yanking the field to the top of the strip. */
        var f = stage.querySelector('input:focus, textarea:focus');
        if (f) { try { f.scrollIntoView({ block: 'nearest' }); } catch (_) {} }
      }
    }

    function queue() { if (!raf) { raf = requestAnimationFrame(sync); } }
    vv.addEventListener('resize', queue);
    vv.addEventListener('scroll', queue);
    window.addEventListener('orientationchange', queue);
    sync();
  }());

  /* ── boot ─────────────────────────────────────────────────────────────────────────────────── */
  set(function () {
    if (BOOT.preselect && CAT.services[BOOT.preselect]) { S.service = BOOT.preselect; }
  });
  window.WT_EST_DEBUG = {
    state: function () { return S; },
    steps: function () { return STEPS.map(function (s) { return s.id; }); },
    /* One entry per SCREEN, listing every question asked on it — a step is no longer one group. */
    screens: function () {
      return STEPS.map(function (s) {
        return { id: s.id, k: s.k,
          asks: s.k === 'group' ? [s.group.id].concat((s.addons || []).map(function (a) { return a.id; })) : [] };
      });
    },
    price: function () { return PRICE; },
    go: go,
    set: set
  };
}());
