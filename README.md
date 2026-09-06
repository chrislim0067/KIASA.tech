# KIASA — React / Next.js / TypeScript rebuild

A technical rebuild of the studio site on Next.js 16 (App Router), React 19 and
TypeScript, then rebranded to KIASA. **No design, layout, animation or behaviour
was changed** — only the brand name, the hero wordmark and the domain. The
pre-rebrand original is kept in `legacy/` (git-ignored) as the extraction source,
so every route can still be diffed against it.

```bash
npm install
npm run dev      # http://localhost:3100
npm run build
npm start        # http://localhost:3100
```

> Port **3100**, not 3000 — the other project in `Desktop\KIA\New website` already
> owns 3000, and two dev servers sharing a port silently serve each other's pages.

## How fidelity is achieved

The original is 59 pages / 14 MB, with CSS and JS inlined per page (the homepage
alone is 94 KB of CSS and 240 KB of JS). Retyping that by hand would guarantee
drift, so **nothing is retyped**: `scripts/extract.mjs` splits each original page
into parts and copies the CSS and JS **byte for byte**.

| Original | Becomes | Notes |
|---|---|---|
| `<body>` markup | `content/pages/<key>.html` | server-rendered verbatim |
| inline `<style>` | `public/generated/<key>/page.css` | linked, so cascade order is unchanged |
| inline `<script>` | `public/generated/<key>/NN.js` / `.mjs` | classic vs module preserved |
| `<script src>` | kept as-is | same URLs, same order |
| `<title>` / meta / OG | Next `metadata` export | |
| JSON-LD, import maps | re-emitted per page | |

`components/legacy/LegacyRuntime.tsx` then restores the original document at
runtime: it dissolves the server wrapper so the markup becomes **direct children
of `<body>`**, then loads the scripts in original document order.

Both of those matter. The gallery's `_setGalleryModalIsolation` marks every
`document.body.children` entry `inert` when a modal opens — with a wrapper still
in place it would inert the modal itself and trap the user.

## Layout

```
app/(site)/        en / ltr routes      app/(ar)/     ar / rtl routes
app/api/           4 route handlers     components/   LegacyPage, LegacyRuntime
lib/               page loader          types/        shared types
content/pages/     extracted markup     public/Assets/ original filenames, unchanged
public/generated/  extracted css + js   legacy/       the crawled original
scripts/           extract, verify, diff tooling
```

Two root layouts (route groups) because a nested layout cannot own `<html>`, and a
client-side `dir` swap would flash LTR before flipping to RTL.

The `?s=` / `?slug=` families (`/service`, `/estimate`, `/start`, `/blog-post`) are
**one route each**, picking the variant from the query string exactly as the PHP
page did with `$_GET`. 61 extracted pages → 19 routes.

## API

`next.config.ts` rewrites the original `.php` URLs onto clean handlers, so no page
script needed editing (`wt-track.js` has `CAPI_URL = '/api/track.php'` hard-coded).

| URL | Handler | Local behaviour |
|---|---|---|
| `/api/lead.php` | `app/api/lead` | validates + honeypot, returns `{success:true}` |
| `/api/track.php` | `app/api/track` | acknowledges only — forwarding writes real conversions |
| `/api/estimate.php` | `app/api/estimate` | echoes `{usd}` |
| `/api/blog-posts.php` | `app/api/blog-posts` | serves the real 20 posts (`scripts/gen-blog.mjs`) |

Set `WT_API_PROXY=1` to forward to production instead. **Deliberate deviation:**
GTM / GA4 / Meta Pixel are held back unless `NEXT_PUBLIC_WT_ANALYTICS=1`, so a dev
session does not appear as real traffic and real conversions. Everything else runs.

## Deliberate change: the hero wordmark is KIASA, not W

The original hero logo is **not text** — `buildWLogo` traced ten 2D points into a
`THREE.Shape` and extruded it. There is no font in that scene, so changing the
letter means supplying new outlines.

`scripts/gen-brand-logo.mjs` converts real glyphs into the same kind of outline
data **at build time** using Syncopate Bold (the site's own heading face), and
writes `public/brand/wordmark.js`. The runtime stays plain three.js — no font
loading, no extra request. Counters (the two `A`s) are validated as real holes
during generation, so a filled letter fails the build rather than the page.

```bash
npm run brand                       # regenerate + re-patch
node scripts/gen-brand-logo.mjs "OTHER TEXT"
BRAND_WIDTH=12 npm run brand        # default width is 10.5 world units
```

Because `npm run extract` regenerates `public/generated/**` verbatim, the hero
edit lives in `scripts/apply-patches.mjs` as six anchored replacements that throw
if an anchor moves. Beyond swapping the outlines it retunes what the wordmark's
aspect ratio breaks — none of this is cosmetic preference, each one was a visible
failure first:

| Change | Why |
|---|---|
| depth/bevel from cap height | the W was 4.0 tall with 0.4 depth; reusing 0.4 on shorter letters reads as blocks |
| ring radius tracks width | `TorusGeometry(3.8)` cut straight through a wordmark 3x wider |
| yaw ±0.3 → ±0.15 rad | a wide wordmark foreshortens into an unreadable sliver at ±0.3 |
| rest position shifted right | otherwise "KIA" sits behind the left-aligned "WORLD CLASS …" headline |

Size is the thing to watch: at 10 units wide (1.8 tall) the letters are present
and correct but effectively invisible — glass letters need vertical mass to catch
light against a black scene. 10.5 x 1.9 is the current setting and about the
floor; the W was 4.8 x 4.0.

`/` therefore no longer pixel-matches the original by design. Every other route
still does.

## Rebrand: Web Tactics -> KIASA

`scripts/rebrand.mjs` runs last in `npm run extract`, so the rename is
reproducible rather than a one-off find-and-replace: extraction regenerates the
pages verbatim from `legacy/`, then the rebrand rewrites branding on top. It is
idempotent — 2,377 occurrences across 192 files, then zero on a second run.

It also renames `Web Tactics Promo.mp4` / `Web Tactics Audio.mp3` and rewrites
`webtactics.org` to `kiasa.tech`, including the Arabic transliteration
(**ويب تاكتيكس** -> **كياسا**), which no Latin rule would have caught.

Four things it deliberately leaves alone:

| Left as-is | Why |
|---|---|
| `instagram.com/webtactics`, `youtube.com/@Webtacticsorg` | **real accounts.** Rewriting the handle points visitors at a different, unrelated profile. Supply KIASA's handles and I'll swap them. |
| `wa.me/971509027130` | a real phone number, not a brand string |
| `wt-` prefixes (`wt-nav`, `wt-track.js`, `window.wtTrack`) | runtime-sensitive identifiers shared across markup, CSS and JS |
| `scripts/` | build tooling legitimately names the *source* brand — an earlier pass rebranded this script's own rules into `KIASA -> KIASA` no-ops |

### Must be replaced before launch

These are the previous brand's accounts and will otherwise report KIASA's traffic
into someone else's properties. They are held back locally by the analytics gate,
so nothing fires until you opt in.

- GTM `GTM-W8BKMGHG`, GA4 `G-VFSLMX9BD4`, Meta Pixel `31244315035216040`
- The Cloudflare Turnstile site key (domain-locked to the old domain)
- `google-site-verification` — removed rather than carried over; add KIASA's own

## Authentication (Supabase)

Supabase Auth via `@supabase/ssr`, using the cookie-based SSR pattern for the App
Router. Credentials are read from `process.env` only — nothing is hardcoded, and
no secret or service-role key is used anywhere in this app.

| Path | What it does |
|---|---|
| `proxy.ts` | Next 16 Proxy (formerly Middleware). Refreshes the session cookie and applies coarse route policy. |
| `lib/supabase/client.ts` | Browser client. Created on demand, never at module scope. |
| `lib/supabase/server.ts` | Server Components / Route Handlers / Server Actions. Per request. |
| `lib/supabase/proxy-session.ts` | Session refresh + optimistic redirects. |
| `lib/supabase/env.ts` | Env access and the missing-configuration error. |
| `lib/auth/routes.ts` | Which paths are protected, and the open-redirect guard. |
| `app/auth/callback/route.ts` | Handles both PKCE (`?code`) and OTP (`?token_hash&type`) links. |
| `app/auth/actions.ts` | `signOut` Server Action. |

Routes: `/signup`, `/login`, `/forgot-password`, `/reset-password`,
`/auth/callback`, `/dashboard`.

**Two-layer protection.** The proxy redirects signed-out visitors away from
`/dashboard`, but the Next docs are explicit that Proxy is not an authorization
boundary — so `/dashboard` independently calls `supabase.auth.getUser()`, which
revalidates the token with Supabase rather than trusting the cookie. Anonymous
requests short-circuit before any Supabase call (no `sb-` cookie means no session
to refresh), so ordinary marketing traffic costs nothing.

Set locally in `.env.local` — never commit it:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
```

Without them the public site serves normally and the auth screens explain which
variable is missing; `/dashboard` stays closed.

### Entering the marketing site from the app

**A legacy route may only be entered by a document load, never by a client-side
navigation.** Those pages are a multi-page app whose hero resolves the bare
specifier `three` through a `<script type="importmap">`, and a browser only
honours an import map parsed with the document. After a `<Link>` or a Server
Action `redirect()` the map is inert, the module throws, the preloader is never
dismissed and the page falls back to its degraded `wt-lite` mode.

So: link to them with a plain `<a>`, and redirect to them with a `303` from a
Route Handler — which is why sign-out is `app/auth/signout/route.ts` rather than
a Server Action. `npm run test:auth` is the regression suite for this (48 checks:
sign-out navigation, homepage health, scroll/menu/audio interaction, repeated
sign-outs, back/forward, protected-route redirect, mobile).

### Supabase redirect URLs

Authentication → URL Configuration:

- Site URL: `https://kiasa.tech`
- Redirect URLs: `https://kiasa.tech/auth/callback`, `http://localhost:3100/auth/callback`
  (add your Vercel preview domain too if you use preview deployments)

## Verifying against the original

```bash
npm run legacy        # serves legacy/ at :8140 on the original URLs
npm run dev
npm run verify        # pixel diff + DOM diff + console diff, per route
```

Latest run against a production build (`pixels` = share of viewport pixels differing):

```
/case-studies /privacy /terms /web-design-agency-dubai
/service?s=… /blog-post?slug=… /ar/arabic-website-design      0.00%
/start 0.04%   /  1.26%   /contact 1.28%   /about 3.17%
/pricing 5.50%   /blog 7.87%   /gallery 10.65%
```

Element counts and rendered text match (`/contact` 882→897 elements, text
identical; `/start` 1000→1013, text identical). The constant +13/14 elements is
Next's own `<link>`/`<script>`/route-announcer overhead.

The non-zero pages animate continuously — the 3D hero, the WebGL gallery corridor,
scroll reveals — so two independent page loads are never on the same frame. `/blog`
differs because the rebuild serves 20 real posts where the static mirror shows its
"unavailable" state.

Other tools: `scripts/debug-page.mjs <url>` (scripts, DOM, console, failed
requests; `PROBE=<js>` for a custom expression) and `scripts/diff-styles.mjs <route>`
(computed-style diff between original and rebuild).

## Pre-existing bugs in the original — preserved, not fixed

These are reproduced as-is because the brief was to change nothing. Each is a
one-line fix if you want it.

1. **Smooth scroll is dead on 36 of 59 pages.** They load
   `cdn.jsdelivr.net/npm/lenis@1.0.42/dist/lenis.min.js`, which 404s — at 1.0.42 the
   package was `@studio-freight/lenis`. The failure is silent. `gallery.html`'s own
   comments already record this; the fix was applied there (vendored locally) but
   not to the other 36.
2. **A broken `<img>` on the homepage** whose `src` is the literal, unresolved
   template string `${bg}`, so it loads the page HTML as an image.
3. **Turnstile error 110200.** The embedded site key is domain-locked to the
   *previous* domain, so it now fails on localhost and will fail on kiasa.tech
   too. Issue a new Cloudflare Turnstile key for this domain before launch.

## Not yet done

- Pages are rendered through the byte-faithful legacy bridge. The shared chrome
  (nav, footer, cookie notice, widgets) and the homepage hero are the natural next
  candidates to become hand-written typed React components; `hooks/`, `shaders/` and
  `workers/` are scaffolded for that and are currently empty.
- Page CSS is per-page and duplicated (2.58 MB total across 61 files, mostly the
  shared chrome repeated). Deduplicating is safe but changes cascade order, so it
  should be done with `npm run verify` watching.
- The PHP source was not available, so the four handlers reproduce the *observed*
  wire contract. Drop the real PHP in and reconcile.
