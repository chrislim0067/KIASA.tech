/* ══════════════════════════════════════════════════════════════════════════════════════════════
   CLIENT PRICING PREVIEW + FLOW ENGINE.  Carries no prices of its own.
   ══════════════════════════════════════════════════════════════════════════════════════════════

   Every number this file produces comes from the catalogue object handed to it, which is emitted
   by partials/estimate-catalogue.php. Search this file for a dollar amount and you will not find
   one — that is deliberate and scripts/check-estimate-flow.mjs fails the build if one appears.

   It is a PORT of partials/estimate-engine.php, not a second opinion. The two must agree for
   every selection, which is what the cross-check in scripts/check-estimate-flow.mjs asserts by
   running both against the same catalogue. When they disagree, the PHP one is right: it is the
   only one a payment amount may ever come from.

   Loaded as a plain script (window.WTEstimate) and importable in Node for the tests. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  root.WTEstimate = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── catalogue helpers ──────────────────────────────────────────────────────────────────── */

  /* Resolve a service, splicing in the groups it SHARES from another service. See the PHP twin for
     why the shared groups keep their original ids. */
  var _svcCache = {};
  function service(cat, serviceId) {
    if (_svcCache[serviceId]) { return _svcCache[serviceId]; }
    var base = cat.services[serviceId];
    if (!base) { return null; }
    var svc = Object.assign({}, base, { groups: base.groups.slice() });
    (base.shared || []).forEach(function (gid) {
      var found = null;
      Object.keys(cat.services).forEach(function (k) {
        cat.services[k].groups.forEach(function (g) { if (g.id === gid && !found) { found = g; } });
      });
      if (found) { svc.groups.push(Object.assign({}, found, { shared_from: true })); }
    });
    _svcCache[serviceId] = svc;
    return svc;
  }

  function index(svc) {
    var ix = {};
    svc.groups.forEach(function (g) {
      g.options.forEach(function (o) { ix[o.id] = { o: o, g: g }; });
      (g.bands || []).forEach(function (b) {
        ix[b[1]] = { o: { id: b[1], label: b[2], price: b[3] }, g: g, band: true };
      });
      if (g.zero_option) { ix[g.zero_option.id] = { o: g.zero_option, g: g }; }
    });
    return ix;
  }

  /* -- requires / excludes ---------------------------------------------------------------------
     Port of wt_est_token_met / wt_est_requires / wt_est_blocked. Two shapes of requirement:
     a specific option id is unambiguous so the engine ADDS it; a group predicate ('cw.cms:any')
     names a decision only the visitor can make, so the engine GATES instead of guessing. Auto-
     picking a content type nobody asked for would put a price on a decision they never made. */
  var NONE_ISH = /\.(none|client|en|basic|wt|supplied|ready)$/;

  function tokenMet(token, svc, picked) {
    if (token.indexOf(':') === -1) { return picked.indexOf(token) !== -1; }
    var parts = token.split(':');
    var gid = parts[0], pred = parts.slice(1).join(':');
    var group = null;
    svc.groups.forEach(function (g) { if (g.id === gid) { group = g; } });
    if (!group) { return false; }
    if (pred === 'collection') {
      return group.options.some(function (o) {
        return !o.optin && picked.indexOf(o.id) !== -1;
      });
    }
    if (pred === '1+') {
      return group.options.some(function (o) {
        return (o.level || 0) > 0 && picked.indexOf(o.id) !== -1;
      });
    }
    return group.options.some(function (o) {
      if (picked.indexOf(o.id) === -1) { return false; }
      if (o.level === 0) { return false; }
      if (!o.price && NONE_ISH.test(o.id)) { return false; }
      return true;
    });
  }

  /* Can a required option be auto-added, or would that overwrite an answer already given?
     Adding i3.foundation.multi because section transitions need it would silently upgrade a chosen
     3D hero into a multi-section build - a much larger purchase nobody asked for. */
  function addableInto(t, ix, picked) {
    if (!ix[t]) { return false; }
    var g = ix[t].g;
    if (['single', 'levels', 'band'].indexOf(g.method) === -1) { return true; }
    return !g.options.some(function (o) { return picked.indexOf(o.id) !== -1; });
  }

  function reqSplit(o) {
    var add = [], gate = [];
    (o.requires || []).forEach(function (t) {
      if (t.indexOf(':') === -1) { add.push(t); } else { gate.push(t); }
    });
    return { add: add, gate: gate };
  }

  /** id -> the unmet token, for every option the current picks make impossible. */
  function blocked(svc, ix, picked) {
    var out = {};
    svc.groups.forEach(function (g) {
      g.options.forEach(function (o) {
        var r = reqSplit(o), stop = false;
        r.gate.forEach(function (t) {
          if (!stop && !tokenMet(t, svc, picked)) { out[o.id] = t; stop = true; }
        });
        if (stop) { return; }
        if (r.add.length) {
          var anyMet = r.add.some(function (t) { return picked.indexOf(t) !== -1; });
          if (!anyMet && !r.add.some(function (t) { return addableInto(t, ix, picked); })) {
            out[o.id] = r.add.join('|');
          }
        }
      });
    });
    return out;
  }

  /** Which groups are visible for a set of picks. Mirrors wt_est_visible() exactly. */
  /* ── PAGE BANDS ──────────────────────────────────────────────────────────────────────────────
     The mirror of the block of the same name in partials/estimate-engine.php. Three groups are a
     cross-product of a LEVEL and a PAGE BAND, and the band was answered two screens earlier — so
     nineteen cards were shown where four are relevant. This decides which existing id is the live
     one; it prices nothing.

     Any change here must be made in the PHP copy too. The browser previews with this file and the
     server recomputes with that one, and check-estimate-flow.mjs compares the two.              */
  var BANDS = ['1', '2-3', '4-5', '6-8', '9-12', '13-20'];

  function bandOf(svc, g, picked, ix) {
    if (!g.band_from) { return null; }
    ix = ix || index(svc);
    var from = [].concat(g.band_from);
    for (var i = 0; i < from.length; i++) {
      for (var j = 0; j < picked.length; j++) {
        var id = picked[j];
        if (!ix[id] || ix[id].g.id !== from[i]) { continue; }
        var pos = id.lastIndexOf('.');
        return pos === -1 ? null : id.slice(pos + 1);
      }
    }
    return null;
  }

  /* Exact match, else the largest band we sell — which is what "20+ pages" lands on, and that
     selection is already a review case in its own right. */
  function bandOption(g, family, band) {
    var best = null, bestRank = -1;
    for (var i = 0; i < g.options.length; i++) {
      var o = g.options[i];
      if (o.family !== family) { continue; }
      if (o.band === band) { return o.id; }
      var rank = BANDS.indexOf(o.band);
      if (rank > bestRank) { bestRank = rank; best = o.id; }
    }
    return best;
  }

  /* Re-point banded picks at the band the page count implies, so changing the page count keeps the
     LEVEL the visitor chose instead of silently discarding it. */
  function reband(svc, picked, ix) {
    ix = ix || index(svc);
    var out = [];
    picked.forEach(function (id) {
      var e = ix[id];
      if (!e || !e.o.band || !e.o.family || !e.g.band_from) { out.push(id); return; }
      var want = bandOf(svc, e.g, picked, ix);
      if (want === null || want === e.o.band) { out.push(id); return; }
      out.push(bandOption(e.g, e.o.family, want) || id);
    });
    return out.filter(function (id, i) { return out.indexOf(id) === i; });
  }

  /* What the group actually offers right now: everything untagged, plus the tagged options for the
     inherited band. */
  /* ── OFF THE SCREEN, NOT GREYED OUT ──────────────────────────────────────────────────────────
     `hide_unless: [ids]` — offer this option only if one of those ids is selected.
     `hide_if: [ids]`     — do not offer it if any of them is.

     Used where the answer that rules an option out is a question the visitor has ALREADY settled,
     so a blocked card is not an invitation to go back — it is just a row of noise. A brochure site
     is not offered "Card payment provider"; a site whose type is already Booking is not offered
     "Booking" a second time in the features list.

     Enforced in three places, and it has to be all three: here, so it is never rendered; in
     prune(), so a stale selection drops instead of being priced; and in wt_est_price() in the PHP
     twin, so a hand-edited payload cannot buy something the flow never offered. */
  function offerable(o, picked) {
    if (o.hide_unless && !o.hide_unless.some(function (t) { return picked.indexOf(t) !== -1; })) {
      return false;
    }
    if (o.hide_if && o.hide_if.some(function (t) { return picked.indexOf(t) !== -1; })) {
      return false;
    }
    return true;
  }

  function bandOptions(svc, g, picked, ix) {
    var band = bandOf(svc, g, picked, ix);
    var live = g.options.filter(function (o) { return offerable(o, picked); });
    if (band === null) { return live; }
    var out = live.filter(function (o) { return !o.band || o.band === band; });
    var tagged = out.filter(function (o) { return !!o.band; }).length;
    if (tagged === 0) {
      var fams = [];
      g.options.forEach(function (o) {
        if (o.family && fams.indexOf(o.family) === -1) { fams.push(o.family); }
      });
      fams.forEach(function (fam) {
        var id = bandOption(g, fam, band);
        live.forEach(function (o) { if (o.id === id) { out.push(o); } });
      });
    }
    return out;
  }

  /* One tier per family in a multi-select. mk.social lists "Posts 4-8 / month", "Posts 9-16" and
     "Posts 17-30" as three tickable options, so a retainer could be priced for two different post
     volumes at once. Keeps the FIRST in the group's own order — the smallest tier — because nobody
     should be charged for the larger of two answers they cannot both have meant. Deterministic, and
     mirrored in wt_est_price step 2b-ii. */
  /* Asking to manage a content type implies wanting the thing that manages it. cw.cms charges
     nothing until its `optin` is ticked, because "editable pages, no collections" and "no CMS at
     all" are different products — but that left a state where ticking Blog and Products cost $0 and
     produced a scope saying the site needs no CMS. Mirrors step 2b-iii in the PHP engine. */
  function implyOptin(svc, picked) {
    svc.groups.forEach(function (g) {
      if (!g.optin || picked.indexOf(g.optin) !== -1) { return; }
      var any = g.options.some(function (o) {
        return o.id !== g.optin && !o.optin && picked.indexOf(o.id) !== -1;
      });
      if (any) { picked.push(g.optin); }
    });
    return picked;
  }

  function oneTierPerFamily(svc, picked) {
    var drop = {};
    svc.groups.forEach(function (g) {
      if (g.method !== 'multi' && g.method !== 'multi_band') { return; }
      var seen = {};
      g.options.forEach(function (o) {
        if (!o.family || o.band !== undefined) { return; }
        if (picked.indexOf(o.id) === -1) { return; }
        if (seen[o.family]) { drop[o.id] = true; } else { seen[o.family] = true; }
      });
    });
    return picked.filter(function (id) { return !drop[id]; });
  }

  function visibleGroups(svc, picked) {
    var ix = index(svc), revealed = {};
    picked.forEach(function (id) {
      var o = ix[id] && ix[id].o;
      if (o && o.reveals) { o.reveals.forEach(function (gid) { revealed[gid] = true; }); }
    });
    var vis = {};
    svc.groups.forEach(function (g) {
      var shown = false;
      if (!g.when) { shown = true; }
      else if (revealed[g.id]) { shown = true; }
      else {
        for (var i = 0; i < g.when.length; i++) {
          if (picked.indexOf(g.when[i]) !== -1) { shown = true; break; }
        }
      }
      /* A group-level `requires` is a precondition, not a reveal: "backend add-ons" is not a
         question worth asking until there is a backend to add them to. Every token must be met. */
      if (shown && g.requires) {
        for (var j = 0; j < g.requires.length; j++) {
          if (!tokenMet(g.requires[j], svc, picked)) { shown = false; break; }
        }
      }
      /* `requires_any` is the OR of the same thing, and it exists for exactly one reason: a SHARED
         group's precondition names a group id, and the group it names is different in each service.
         "Who will add the content?" needs a CMS collection — which is cw.cms in Custom Websites and
         wp.cms in WordPress. Declared with `requires` it would demand both and be dead in both; it
         was declared against cw.cms alone and was silently unreachable in WordPress, so a WordPress
         buyer with ten content collections could not buy the entry work at any price. */
      if (shown && g.requires_any) {
        var anyMet = false;
        for (var k = 0; k < g.requires_any.length; k++) {
          if (tokenMet(g.requires_any[k], svc, picked)) { anyMet = true; break; }
        }
        if (!anyMet) { shown = false; }
      }
      /* `when_foundation` at GROUP level — the mirror of the block in wt_est_visible(). It was
         honoured only on options, so wp.pages, wp.sections and wp.design declared it and nothing
         read it: the WordPress repair and migration lanes were asked three new-build questions and
         charged a $380 floor for pages and layouts nobody was building. */
      if (shown && g.when_foundation) {
        var onFoundation = picked.some(function (p) { return ix[p] && ix[p].o && ix[p].o.foundation; });
        if (!onFoundation) { shown = false; }
      }
      if (shown) { vis[g.id] = true; }
    });
    return vis;
  }

  /* ── ONE ARGUMENT, TWO SHAPES ────────────────────────────────────────────────────────────────
     The browser holds its answers as a MAP ({id: true}) because that is what a toggle wants; every
     other caller — the payload, the recompute, the test harness — passes a LIST. Each engine used
     to read only its own shape and answer the other one with a silently wrong price rather than an
     error: a list handed to this engine priced as Object.keys() of an array, which is ["0","1"],
     none of which is an option id, so the total quietly fell back to whatever ships regardless.
     Normalised here, and identically in wt_est_ids() in the PHP twin. */
  function idList(v) {
    if (!v) { return []; }
    if (Array.isArray(v)) { return v.filter(function (x) { return typeof x === 'string'; }); }
    return Object.keys(v).filter(function (k) { return !!v[k]; });
  }

  /* ── invalidation ───────────────────────────────────────────────────────────────────────────
     The whole point of Pass 2. When an earlier answer changes, anything downstream that the new
     answer no longer permits has to go — otherwise a group the visitor can no longer see keeps
     contributing to the total, which is the exact class of bug that makes an estimator untrustworthy.
     Runs to a fixed point because dropping a pick can hide a group that was revealing another. */
  function prune(svc, sel) {
    var ix = index(svc);
    var all = idList(sel.ids);
    var ids = all.filter(function (id) { return ix[id]; });
    var removed = all.filter(function (id) { return !ix[id]; });
    for (var pass = 0; pass < 8; pass++) {
      var vis = visibleGroups(svc, ids);
      var keep = ids.filter(function (id) {
        return !!vis[ix[id].g.id] && offerable(ix[id].o, ids);
      });
      if (keep.length === ids.length) { break; }
      removed = removed.concat(ids.filter(function (id) { return keep.indexOf(id) === -1; }));
      ids = keep;
    }
    /* bands: re-point, then drop anything the inherited band does not offer. Mirrors step 2b in the
       PHP engine, and has to run before the single-answer sweep below — rebanding can map two picks
       onto the same id, and that duplicate is what the sweep is there to catch. */
    ids = reband(svc, ids, ix);
    ids = ids.filter(function (id) {
      var e = ix[id];
      if (!e || !e.o.band || !e.g.band_from) { return true; }
      var offered = bandOptions(svc, e.g, ids, ix);
      for (var i = 0; i < offered.length; i++) { if (offered[i].id === id) { return true; } }
      removed.push(id);
      return false;
    });

    ids = implyOptin(svc, ids);
    ids = oneTierPerFamily(svc, ids);

    /* a zero option and a real answer cannot both be true — "No CMS" and "Products" were both
       tickable. The explicit choices win. Mirrors step 2c in the PHP engine. */
    svc.groups.forEach(function (g) {
      if (!g.zero_option) { return; }
      var zid = g.zero_option.id;
      if (ids.indexOf(zid) === -1) { return; }
      var other = g.options.some(function (o) { return ids.indexOf(o.id) !== -1; });
      if (!other) { return; }
      removed.push(zid);
      ids.splice(ids.indexOf(zid), 1);
    });

    /* a `single`, `levels` or `band` group may hold at most one answer */
    var seen = {};
    ids.slice().reverse().forEach(function (id) {
      var g = ix[id].g;
      if (g.method === 'single' || g.method === 'levels' || g.method === 'band') {
        if (seen[g.id]) { removed.push(id); ids.splice(ids.indexOf(id), 1); }
        else { seen[g.id] = true; }
      }
    });
    var nextIds = {};
    ids.forEach(function (id) { nextIds[id] = true; });
    /* orphaned quantities go with their option */
    var nextQty = {};
    Object.keys(sel.qty || {}).forEach(function (id) {
      if (nextIds[id]) { nextQty[id] = sel.qty[id]; }
      else { removed.push(id + '#qty'); }
    });
    return { ids: nextIds, qty: nextQty, removed: removed };
  }

  /* ── pricing ────────────────────────────────────────────────────────────────────────────────
     A port of wt_est_price(). Same nine steps, same order. */
  function price(cat, serviceId, sel) {
    var svc = service(cat, serviceId);
    if (!svc) { return null; }
    var peg = cat.meta.peg, floor = cat.meta.floor;
    var ix = index(svc);
    var qty = sel.qty || {};
    var picked = idList(sel.ids).filter(function (id) { return ix[id]; });

    for (var pass = 0; pass < 6; pass++) {
      var v = visibleGroups(svc, picked);
      var keep = picked.filter(function (id) {
        return !!v[ix[id].g.id] && offerable(ix[id].o, picked);
      });
      if (keep.length === picked.length) { break; }
      picked = keep;
    }

    /* 2b + 2c, mirroring wt_est_price. These live here as well as in prune() because price() is
       called directly — the parity check does exactly that, and it caught the two engines
       disagreeing by $1,425 on a stale payload when only prune() rebanded. PHP does both inside its
       one entry point, so JS has to as well or "same input, same output" is not true. */
    picked = reband(svc, picked, ix);
    picked = picked.filter(function (id) {
      var e = ix[id];
      if (!e || !e.o.band || !e.g.band_from) { return true; }
      return bandOptions(svc, e.g, picked, ix).some(function (o) { return o.id === id; });
    });
    picked = implyOptin(svc, picked);
    picked = oneTierPerFamily(svc, picked);
    svc.groups.forEach(function (g) {
      if (!g.zero_option) { return; }
      var zid = g.zero_option.id;
      if (picked.indexOf(zid) === -1) { return; }
      if (!g.options.some(function (o) { return picked.indexOf(o.id) !== -1; })) { return; }
      picked.splice(picked.indexOf(zid), 1);
    });

    var vis = visibleGroups(svc, picked);

    svc.groups.forEach(function (g) {
      if (!vis[g.id]) { return; }
      g.options.forEach(function (o) {
        var auto = (g.method === 'auto') || o.always;
        if (auto && picked.indexOf(o.id) === -1) {
          if (o.when_foundation) {
            var onPath = picked.some(function (p) { return ix[p] && ix[p].o.foundation; });
            if (!onPath) { return; }
          }
          picked.push(o.id);
        }
      });
    });

    /* requires: drop the gated, add the specific. Iterated - an addition can itself require. */
    var autoReq = {};
    for (var rp = 0; rp < 6; rp++) {
      var before = picked.length;
      var blk = blocked(svc, ix, picked);
      picked = picked.filter(function (id) { return !blk[id]; });
      picked.slice().forEach(function (id) {
        var r = reqSplit(ix[id].o);
        if (!r.add.length) { return; }
        if (r.add.some(function (t) { return picked.indexOf(t) !== -1; })) { return; }
        for (var k = 0; k < r.add.length; k++) {
          if (addableInto(r.add[k], ix, picked)) {
            picked.push(r.add[k]); autoReq[r.add[k]] = id; break;
          }
        }
      });
      if (picked.length === before) { break; }
    }

    /* excludes: the EXCLUDING option wins and its victims are dropped. Order-independent, so the
       same id set always prices the same way - which the Pass 5 server recompute depends on. */
    var excluded = {};
    picked.forEach(function (id) {
      var toks = (ix[id].o.excludes || []).concat(ix[id].o.conflicts || []);
      toks.forEach(function (t) {
        picked.forEach(function (other) {
          if (other === id) { return; }
          if (other === t || ix[other].g.id === t) { excluded[other] = id; }
        });
      });
    });
    if (Object.keys(excluded).length) {
      picked = picked.filter(function (id) { return !excluded[id]; });
    }

    var required = {};
    picked.forEach(function (id) {
      var ml = ix[id].o.min_level;
      if (ml) { required[ml[0]] = Math.max(required[ml[0]] || 0, ml[1]); }
    });

    var charged = {}, superseded = {};
    svc.groups.forEach(function (g) {
      if (!vis[g.id]) { return; }
      if (g.method === 'levels') {
        var best = null, bestLvl = -1;
        g.options.forEach(function (o) {
          var lvl = o.level || 0;
          if (picked.indexOf(o.id) !== -1 && lvl > bestLvl) { best = o; bestLvl = lvl; }
        });
        var need = required[g.id] || 0, autoLifted = false;
        if (need > bestLvl) {
          g.options.forEach(function (o) {
            if ((o.level || 0) === need) { best = o; bestLvl = need; autoLifted = true; }
          });
        }
        if (best) {
          charged[best.id] = { auto: autoLifted };
          /* an explicitly-picked lower level is superseded, not deleted - see the PHP twin */
          g.options.forEach(function (o) {
            if (o.id === best.id) { return; }
            var lvl = o.level || 0;
            if (lvl <= 0 || lvl >= bestLvl) { return; }
            if (picked.indexOf(o.id) === -1) { return; }
            superseded[o.id] = best.id;
            charged[o.id] = { auto: false };
          });
        }
        return;
      }
      if (g.method === 'multi_band' && g.bands) {
        var n = 0;
        g.options.forEach(function (o) {
          if (o.optin) { return; }
          if (picked.indexOf(o.id) !== -1) { n++; }
        });
        var optedIn = !g.optin || picked.indexOf(g.optin) !== -1;
        if (!optedIn) {
          if (g.zero_option) { charged[g.zero_option.id] = { auto: false, count: 0 }; }
          return;
        }
        if (n === 0 && g.zero_option && !g.optin) {
          charged[g.zero_option.id] = { auto: false, count: 0 };
          return;
        }
        var hit = null;
        for (var i = 0; i < g.bands.length; i++) {
          if (n <= g.bands[i][0]) { hit = g.bands[i]; break; }
        }
        if (!hit) { hit = g.bands[g.bands.length - 1]; }
        charged[hit[1]] = { auto: false, count: n };
        return;
      }
      g.options.forEach(function (o) {
        if (picked.indexOf(o.id) !== -1) { charged[o.id] = { auto: false }; }
      });
    });

    var absorbedBy = Object.assign({}, superseded);
    Object.keys(charged).forEach(function (id) {
      (ix[id].o.absorbs || []).forEach(function (victim) {
        if (charged[victim] && !absorbedBy[victim]) { absorbedBy[victim] = id; }
      });
    });

    var buckets = { build: 0, setup: 0, monthly: 0, annual: 0 };
    var lines = [], days = 0, review = [];
    var marketing = svc.checkout === 'setup_plus_first_month';
    Object.keys(charged).forEach(function (id) {
      var o = ix[id].o, g = ix[id].g;
      var unit = o.price || 0;
      var q = o.per_unit ? Math.max(1, parseInt(qty[id], 10) || 1) : 1;
      var amount = unit * q;
      var bucket = o.bucket || (marketing ? 'setup' : 'build');
      var absorbed = !!absorbedBy[id];
      if (absorbed) { amount = 0; }
      if (o.review) { review.push({ id: id, label: o.label, group: g.label }); }
      buckets[bucket] += amount;
      /* absorbed work contributes no TIME either - see the PHP engine for the reasoning */
      if (!absorbed) { days += o.days || 0; }
      lines.push({
        id: id, group: g.label, label: o.label, qty: q, unit: unit, amount: amount,
        bucket: bucket, included: amount === 0,
        absorbed: absorbed ? ix[absorbedBy[id]].o.label : null,
        /* The absorber's GROUP as well as its option. Five Web Platforms rows render as
           "Filters — Included with Filters", because the two options that absorb each other are
           deliberately named the same thing in two modules. Absorption is the estimator's strongest
           trust signal and it was printing a tautology; the group name is what makes it a sentence. */
        absorbed_group: absorbed ? ix[absorbedBy[id]].g.label : null,
        /* "Included" is a promise, and it was printed against every zero row — including the ones
           where the visitor had explicitly chosen None. `always` separates the two: it marks the
           things that come with the build regardless. */
        always: !!o.always,
        auto: !!charged[id].auto || !!autoReq[id],
        auto_for: autoReq[id] ? (ix[autoReq[id]].o.label || null) : null,
        review: !!o.review, desc: o.desc || null, notice: o.notice || null
      });
      if (o.monthly) {
        buckets.monthly += o.monthly;
        lines.push({
          id: id + '#monthly', group: g.label, label: o.label + ' — management',
          qty: 1, unit: o.monthly, amount: o.monthly, bucket: 'monthly',
          included: false, absorbed: null, auto: true, review: false
        });
      }
    });

    var base = buckets.build + buckets.setup, pct = {};
    var flags = idList(sel.ids);
    if (flags.indexOf('__rush') !== -1 && svc.rush) {
      var r = Math.round(base * svc.rush);
      buckets.build += r; base += r;
      pct.rush = { label: 'Priority delivery', rate: svc.rush, amount: r };
    }
    if (flags.indexOf('__care') !== -1 && svc.care) {
      var c = Math.round(base * svc.care);
      buckets.annual += c;
      pct.care = { label: 'Care plan, per year', rate: svc.care, amount: c };
    }

    var initial = marketing ? buckets.setup + buckets.monthly : buckets.build + buckets.setup;
    var money = function (u) { return { usd: u, aed: Math.round(u * peg / 10) * 10 }; };

    var routes = [];
    picked.forEach(function (id) {
      if (ix[id].o.routes) {
        routes.push({ id: id, label: ix[id].o.label, to: ix[id].o.routes });
      }
    });

    return {
      /* The selection the engine actually resolved, after rebanding, tier collapsing, opt-in
         implication and zero-option removal. Not decoration: some of those rules are invisible in
         `lines` — a multi_band group emits its BAND, so a stray "No CMS" left in the selection would
         never show up there — and this is the list that describes the scope we would deliver. */
      selected: picked.slice().sort(),
      service: serviceId, label: svc.label, lines: lines,
      blocked: blocked(svc, ix, picked), excluded: excluded, auto_req: autoReq,
      /* Mirrors wt_est_price. `unconfirmed` means this service's `days` data is not a real
         commitment — see timeline_exact in the catalogue — so the result screen says so rather
         than printing a number computed from one option out of 128. */
      days_state: review.length ? 'review' : (svc.timeline_exact ? 'fixed' : 'unconfirmed'),
      routes: routes,
      buckets: {
        build: money(buckets.build), setup: money(buckets.setup),
        monthly: money(buckets.monthly), annual: money(buckets.annual)
      },
      initial: money(initial), percent: pct, days: days, review: review,
      state: review.length ? 'review' : 'estimate',
      payable: (!review.length && initial >= floor),
      floor: money(floor), marketing: marketing,
      visible: Object.keys(vis), note: svc.note || null
    };
  }

  /* ── flow ───────────────────────────────────────────────────────────────────────────────────
     The active step list. Never a hardcoded number: it is derived, so a branch that reveals two
     groups lengthens the flow and the progress bar follows without anything being told about it. */
  var IDENTITY = [
    { k: 'intro',   id: 'intro' },
    { k: 'field',   id: 'name',    label: 'name',    type: 'text',  required: true },
    { k: 'field',   id: 'email',   label: 'email',   type: 'email', required: true },
    { k: 'field',   id: 'phone',   label: 'phone',   type: 'tel',   required: true },
    { k: 'field',   id: 'company', label: 'company', type: 'text',  required: false },
    { k: 'service', id: 'service', required: true }
  ];

  /* ── ONE SCREEN, TWO QUESTIONS ────────────────────────────────────────────────────────────────
     A group may declare `addon_of: '<host group id>'`, which means "ask me on the host's screen,
     underneath it" rather than on a screen of my own.

     This is a STEP-LIST concept and nothing else. It does not touch pricing, which is computed per
     group over the selected ids and never looks at steps; it does not touch visibility, so the
     server recompute still accepts exactly the same id set; and there is no PHP twin to keep in
     sync, because the PHP engine has no step list — the flow is a browser concern.

     Used only where the two questions are one decision that the catalogue happens to price in two
     places: "how many pages" + "any extra one-off layouts", "which languages" + "how much content
     to adapt", "SEO level" + "keyword research". The addon's help text usually already refers to
     the host's answer, which only reads correctly on the same screen.

     FAIL-SAFE: if the host is not on screen — pruned away, gated off, or simply declared later in
     the array than its addon — the addon becomes its own step rather than disappearing. A question
     that silently vanishes takes its price with it. */
  function activeSteps(cat, serviceId, sel) {
    var out = IDENTITY.slice();
    if (serviceId && cat.services[serviceId]) {
      var svc = service(cat, serviceId);
      var picked = idList(sel.ids);
      var vis = visibleGroups(svc, picked);
      var hosts = {};
      svc.groups.forEach(function (g) {
        if (!vis[g.id]) { return; }
        if (g.method === 'auto') { return; }          // applied, never asked
        if (g.addon_of) {
          /* A LIST, because a shared group has a different host in each service that uses it:
             "Who will add the content?" rides on cw.cms in Custom Websites and on wp.cms in
             WordPress. First host present on screen wins. */
          var want = [].concat(g.addon_of);
          for (var h = 0; h < want.length; h++) {
            if (hosts[want[h]]) { hosts[want[h]].addons.push(g); return; }
          }
        }
        var step = { k: 'group', id: g.id, group: g, addons: [] };
        hosts[g.id] = step;
        out.push(step);
      });
      out.push({ k: 'result', id: 'result' });
    }
    return out;
  }

  /** Every group a step asks about: the host first, then anything riding along with it. */
  function stepGroups(step) {
    if (!step || step.k !== 'group') { return []; }
    return [step.group].concat(step.addons || []);
  }

  /** Does this step have everything it needs to move on? */
  function stepValid(step, sel, ident) {
    if (step.k === 'intro' || step.k === 'result') { return true; }
    if (step.k === 'field') {
      var v = (ident[step.id] || '').trim();
      if (!step.required) { return true; }
      if (!v) { return false; }
      if (step.type === 'email') { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
      if (step.type === 'tel')   { return v.replace(/\D/g, '').length >= 7; }
      return v.length >= 2;
    }
    if (step.k === 'service') { return !!sel.service; }
    /* Every group on the screen, not just the host. Sharing a screen is a layout decision; it must
       not quietly turn a question that had to be answered into one that can be walked past. */
    return stepGroups(step).every(function (g) { return groupAnswered(g, sel); });
  }

  /** The first group on this step that still needs an answer, or null. Drives the error message. */
  function unanswered(step, sel) {
    var list = stepGroups(step);
    for (var i = 0; i < list.length; i++) {
      if (!groupAnswered(list[i], sel)) { return list[i]; }
    }
    return null;
  }

  function groupAnswered(g, sel) {
    /* single / levels / band must hold exactly one answer. multi and multi_band are optional
       unless the catalogue marks them required — "no extras, thanks" is a real answer. */
    if (g.method === 'single' || g.method === 'levels' || g.method === 'band' || g.required) {
      return g.options.some(function (o) { return !!sel.ids[o.id]; });
    }
    return true;
  }

  /* Prune against the RESOLVED service. Calling prune() with cat.services[id] directly looks
     harmless and silently throws away every answer that came from a shared group, because those
     options are not in the unresolved service's index and prune drops unknown ids by design.
     Everything outside this file should use this, not prune(). */
  function pruneFor(cat, serviceId, sel) {
    var svc = service(cat, serviceId);
    if (!svc) { return { ids: {}, qty: {}, removed: idList(sel.ids) }; }
    return prune(svc, sel);
  }

  return {
    index: index,
    service: service,
    pruneFor: pruneFor,
    tokenMet: tokenMet,
    blocked: blocked,
    visibleGroups: visibleGroups,
    offerable: offerable,
    stepGroups: stepGroups,
    unanswered: unanswered,
    bandOf: bandOf,
    bandOptions: bandOptions,
    prune: prune,
    price: price,
    activeSteps: activeSteps,
    stepValid: stepValid,
    IDENTITY: IDENTITY
  };
}));
