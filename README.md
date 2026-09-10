# Utsubo — Next.js rebuild

The utsubo.com website rebuilt on **Next.js 16 (App Router), React 19 and TypeScript (strict)**.
The visual design, content, animations, scroll behaviour, audio and page structure of the
original site are preserved; the runtime underneath was rewritten to fix the audio start-up
problems and the freezes/leaks of the original build. `docs/ANALYSIS.md` documents the
investigation and the root causes.

## Requirements

* Node.js 20 or newer (tested with Node 24) and npm
* A browser with `OffscreenCanvas` (Chrome/Edge 69+, Firefox 105+, Safari 16.4+). WebGPU is
  used when available, WebGL otherwise.
* Google Chrome installed locally for the end-to-end tests (they run headed, on a real GPU).

## Install & run

```bash
npm install
npm run dev        # http://localhost:3000 (Turbopack dev server)
```

Production:

```bash
npm run build
npm run start      # serves the production build on http://localhost:3000
```

Quality gates:

```bash
npm run lint       # ESLint (next/core-web-vitals + typescript)
npm run typecheck  # tsc --noEmit (strict)
npm run test       # Vitest unit tests
npm run test:e2e   # Playwright functional + screenshot suite (needs a running build, see below)
```

`start-dev.cmd` in the project root starts the dev server and opens the browser in one step.

## Project structure

```
app/
  layout.tsx                 root layout: metadata, viewport, Google Tag Manager
  (experience)/layout.tsx    WebGL experience shell (header, menu, loader, canvas host)
  (experience)/…/page.tsx    /, /about, /contact, /ja, /ja/about, /ja/contact, /fr, /fr/about, /fr/contact
  (content)/[...slug]/       245 static pages (blog, landing pages, legal) rendered from content/pages
  error.tsx, not-found.tsx   error boundary and 404
components/
  experience/generated/      JSX of the experience markup, generated 1:1 from the original HTML
  content/                   client enhancements of the content pages
  GoogleTagManager.tsx, JsonLd.tsx, PageEffects.tsx
features/experience/
  ExperienceShell.tsx        persistent chrome (server component)
  ExperienceRuntime.tsx      boots/disposes the runtime on the client
  ExperienceView.tsx         page view wrapper that drives the enter/leave transitions
  runtime/                   the orchestration layer (TypeScript port of the original bundle)
    engine.ts                worker boot, Comlink RPC, GPU tier / dpr detection
    events.ts, store.ts      main-thread event bus and shared state
    navigation.ts            client-side transitions between experience routes
    scroll/                  Lenis setup, sections, auto-scroll, magnet, pagination, interaction button
    ui/                      menu, sound button, language links, sub-page tabs, masks
    audio-transitions.ts     scene transition stems driven by scroll progress
    video.ts, text.ts        showreel frame feed and SDF text atlas for the worker
    gyro.ts, banner.ts       device orientation, console banner
lib/
  audio/                     AudioManager, AudioContext unlocking, resilient sounds, music, effects
  content/                   content page behaviours (contact form, FAQ, copy buttons, tracking)
  analytics.ts, metadata.ts  dataLayer helpers, <head> → Metadata conversion
content/
  pages/*.json               extracted content pages (markup, metadata, stylesheets, features)
  experience/*.json          <head> metadata of the experience pages
public/
  engine/                    vendored render worker (Three.js WebGPU scene) — see below
  cdn/                       models, textures, HDR, EXR, audio (previously served from a CDN)
  styles/, fonts/, top/, basis/, draco/, icons/, share/, _astro/ (images of the content pages)
  clients/, authors/, landing/, blog/…  media of the content pages (857 files recovered from
                             the live site; the original download had missed them)
scripts/
  extract-content.mjs        rebuilds content/ from original-site/
  generate-experience-components.mjs, html-to-jsx.mjs
    ↳ dev-only: these read the old build, which has been deleted (see below)
styles/experience.css        stylesheet of the experience pages (unchanged)
tests/unit, tests/e2e        Vitest and Playwright suites
docs/ANALYSIS.md             stage-one analysis, measurements and root causes
```

## Architecture decisions

* **Server Components by default.** Layouts, pages, the experience shell and the content
  pages are server components. Client components are limited to the runtime boot
  (`ExperienceRuntime`), the view wrapper (`ExperienceView`), page effects and content
  enhancements.
* **The 3D engine is a vendored worker bundle** (`public/engine/offscreen-CCfMP6GY.js` +
  `vendor-ap6iFCXC.js`). It contains the Three.js WebGPU scene, shaders, baked animations
  and asset loading. It runs in a Web Worker on an `OffscreenCanvas`, off the main thread,
  and is the only way to keep the visuals identical. Everything that talks to it (boot,
  Comlink RPC, input/resize forwarding, scroll progress, audio, navigation, UI) is
  TypeScript in `features/experience/runtime`.
* **Markup is generated from the original HTML** (`scripts/generate-experience-components.mjs`)
  so class names, ids, SVGs, letter-split labels and ARIA attributes are byte-identical; the
  original stylesheets are used unchanged. The only intentional markup differences are
  `aria-hidden=""` → `aria-hidden="true"` (same meaning, valid ARIA) and the removal of the
  Astro scoped attribute from `<html>`.
* **Routing.** Taxi.js was replaced by the App Router plus a transition controller
  (`runtime/navigation.ts`) that reproduces the original leave/enter sequence and timings
  (600 ms, 1000 ms with the menu open, `pageTransition`/`menuOpen`/`inSubPage` messages to
  the worker). Links to content pages stay full page loads, as before. The experience
  layout reads the requested pathname (set by `proxy.ts`) so the loader is rendered in the
  right language on the first request and the shell then persists across client
  navigations.
* **Content pages** are extracted once into JSON (`npm run extract:content`) and rendered
  verbatim with their own stylesheets hoisted into `<head>` by React 19. Their inline
  scripts (contact form, FAQ accordion, copy buttons, X-posts parallax, outbound tracking,
  attribution) were ported to typed modules in `lib/content`.
* **No unnecessary state libraries.** The runtime keeps its state in a small typed store; no
  React state crosses the worker boundary.
* **Reduced motion** adds `html.reduced-motion` for styling hooks without altering the
  normal experience.

## Audio implementation (`lib/audio`)

Howler 2.2.4 is kept (identical decoding and format behaviour) behind a new `AudioManager`:

* **Assets ship with the site** (`public/cdn/audio`). The original loaded them from a
  separate CDN; a blocked host or 404 silenced the site (root cause of the "no audio" report).
* **Format fallback on load failure.** `ManagedSound` keeps the ordered candidates
  (opus → webm → mp3) and rebuilds the Howl with the next supported format on `loaderror`.
  Howler alone only picks a format by codec support and never retries.
* **Reliable unlocking.** `AudioUnlocker` resumes the `AudioContext` on
  pointer/touch/mouse/key/click gestures, on `visibilitychange`, and on `statechange`
  (`interrupted` on iOS). Music starts from a promise that resolves once the context is
  actually `running`, instead of Howler's one-shot `unlock` event. No autoplay policy is
  bypassed: on desktop the "Begin experience" button is the gesture, on mobile the first tap.
* **Same mix and routing** as the original: 10 UI sounds, 6 music tracks with cross-fades and
  the section-4 kick layer, 10 transition/interaction stems, reverb group for the menu
  sounds, cursor-speed low-pass on the logo loop, "night-club" low-pass while the menu or a
  sub-page is open or the user interacts.
* **Mute/volume state** persists in `localStorage.isMuted`; the master volume is tweened
  over 1 s as before and restored on navigation and reload.
* **No duplicate playback** of loops; every Howl, Web Audio node, timer and listener is
  released in `dispose()`.

## Performance and stability improvements

* Event bus handlers were registered twice and never fully removed in the original
  (every callback ran twice, listeners leaked on each navigation). Fixed.
* Every controller has a `dispose()`; leaving a page or unmounting the runtime removes all
  DOM listeners, timers, rAF loops, GSAP tweens, the worker and the canvas. Repeated
  About/Contact navigations no longer grow the DOM (5 000 nodes and ~30 listeners per round
  trip before).
* One shared `requestAnimationFrame` loop (`ticker.ts`) drives Lenis, GSAP and the smooth
  scroll progress; it pauses while the tab is hidden. The video frame feed uses
  `requestVideoFrameCallback` with a single in-flight frame.
* The showreel video, fonts, SDF text generation and heavy engine assets are cached
  immutably (`next.config.ts` headers) and only requested once per session.
* Worker rejections are caught (a lost GPU device can no longer surface as unhandled
  promise rejections), and the engine reports `engineError` on the bus.
* Strict Mode / remount safe: the runtime is a ref-counted singleton (`runtime/singleton.ts`),
  so React never starts two workers.

Measured on the reference machine (production build, Chrome 152, NVIDIA GPU, WebGPU):

| Metric | Original | Rebuild |
|---|---|---|
| DOM nodes after 1 / 6 About+Contact round trips | 11 404 / 25 936 (growing) | 4 553 / 4 553 (flat) |
| JS event listeners over the same cycles | 123 → 239 | 454 → 454 |
| Live elements after 6 cycles | grows every cycle | 1 628 (constant) |
| Main-thread frames per second while scrolling | 77–107 | 83–238 |
| Hidden-tab CPU per 5 s | 0.16 s | 0.21 s |
| Console errors | `Bindings._update`, device-lost | none |
| Sounds loaded | 0 of 26 (assets 404) | 26 of 26 |

The 4 553 nodes the rebuild settles on are the Next.js router cache holding the About and
Contact trees; the count is flat from the first round trip onwards (verified over six
cycles with a forced garbage collection between each).

## Testing

Unit tests (`tests/unit`, Vitest + jsdom): event bus semantics, section ranges, easing
helpers, metadata mapping, audio manifest completeness.

End-to-end (`tests/e2e`, Playwright, headed Chrome):

```bash
npm run build && npm run start          # terminal 1
npm run test:e2e                        # terminal 2 (BASE_URL defaults to http://localhost:3000)
```

* `experience.spec.ts` — load, start, audio after the gesture, mute persistence, scroll →
  music/pagination, menu/About/Contact transitions with a DOM-leak assertion, browser
  back/forward, direct loads of every language route, tabs and contact links.
* `content.spec.ts` — blog, article contact form and copy buttons, landing page FAQ,
  language attributes, 404.
* `visual.spec.ts` — screenshots at 1920×1080, 1440×900, 1024×768, 768×1024, 430×932 and
  390×844 of loader, start, scrolled, menu, About and Contact, written to
  `tests/e2e/__screenshots__/rebuild/`. Setting `ORIGINAL_URL` to a served copy of the old
  build additionally captures it under `__screenshots__/original/` for comparison; the
  reference images from the pre-deletion comparison run are already in that folder.

## The removed `original-site/` reference copy

The project used to contain `original-site/`, an untouched 89 MB copy of the old Astro
production build. **It has been deleted.** It was never read at runtime or at build time,
which was verified before removal by moving it out of the project and running a clean
`npm run build`, `npm run typecheck`, `npm run test`, `npm run lint` and the 12 functional
Playwright tests — all passed with it absent, and all pass again now that it is gone.

Two developer scripts consumed it and can no longer run:

* `npm run extract:content` — regenerated `content/*.json` from the source HTML.
* `node scripts/generate-experience-components.mjs` — regenerated
  `components/experience/generated/*.tsx`.

Their output is committed, so the application is complete without them. They are kept in
`scripts/` for reference; to run either again, restore a copy of the old build into
`original-site/` first. Visual comparison against the original (`ORIGINAL_URL=…`) likewise
needs a served copy of it; `tests/e2e/visual.spec.ts` skips the comparison when the variable
is unset and only captures the rebuild.

## Browser support

Chrome, Edge, Firefox and Safari — current versions on desktop and mobile. The experience
requires `OffscreenCanvas` (Chrome/Edge 69+, Firefox 105+, Safari 16.4+). WebGPU is used on
Chrome/Edge when available; other browsers use the WebGL backend of the same worker. Without
`OffscreenCanvas` the header, menu and navigation still work and the loader closes, but the
3D scene is not rendered.

## Remaining limitations

* The render worker is minified third-party-style code and is used as-is; the WebGPU
  backend warnings it logs (`renderMultiDrawInstances` deprecation, TSL attribute notice)
  are unchanged. GPU device loss inside the worker is caught but the scene does not
  self-restart.
* The original main-thread renderer (used when `OffscreenCanvas` is missing or with
  `?debug`) was dropped; the `?debug` stats/GUI overlay is therefore not available.
* `<html lang>` is set on the client after hydration (one root layout serves all
  languages).
* Google Tag Manager, the reCAPTCHA of the contact forms and the contact form endpoint are
  the original third-party services.
* `detect-gpu` fetches its benchmark table from unpkg like the original; offline it falls
  back to the medium tier (device pixel ratio 1.2).
