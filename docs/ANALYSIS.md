# Stage One — Analysis of the existing Utsubo website

This document records what was found before any code was rewritten. The measurements were
taken against the original production build (Astro static output), which was kept in
`original-site/` during the rebuild and deleted once the comparison was finished; the
reference screenshots from that comparison remain in `tests/e2e/__screenshots__/original/`.

## 1. Project structure of the original build

| Area | Files | Notes |
|---|---|---|
| Experience pages | `/`, `/about`, `/contact`, `/ja`, `/ja/about`, `/ja/contact`, `/fr`, `/fr/about`, `/fr/contact` | Share one stylesheet (`about.DmsAZD90.css`) and one orchestration bundle (`CommonScripts…js`, 170 KB minified). |
| Content pages | 245 pages: `/blog/**`, `/ja/blog/**`, `/fr/blog/**`, landing pages (`/webgl-threejs-development`, `/osaka-web-agency`, …), `/privacy`, `/links`, `/ja/company` … | Static HTML, three stylesheets, one tiny script (outbound-link tracking). No WebGL. |
| 3D engine | `offscreen-CCfMP6GY.js` (300 KB, web-worker entry) + `vendor-ap6iFCXC.js` (988 KB, Three.js WebGPU build + troika + comlink) | Runs entirely in a Worker on an `OffscreenCanvas`. Renders with WebGPU when available, WebGL otherwise. |
| Fallback engine | `renderer.js`, `main.js`, `site.js`, `vendor.BZHSwLvj.js`, `debug-tools.js` | Main-thread renderer used only when `OffscreenCanvas` is unavailable or `?debug` is present. |
| Assets | 40 models/textures/HDR/EXR (50 MB) and 26 sounds × 3 formats (4.5 MB) | Served from a **separate CDN** (`https://cdn.utsubo.io/v2/`) in production. |

Bundled libraries identified: Three.js (WebGPU/TSL build), GSAP 3.12.5 (+ScrollToPlugin),
Lenis 1.1.18, Howler 2.2.4, Comlink 4, Taxi.js (page transitions), detect-gpu 5.0.70,
troika-three-text.

## 2. Runtime behaviour inventory (what must be preserved)

**Loading sequence** — `loading-logo` + looping `loading.mp4/webm`, percentage counter fed by
the worker (`loadProgress`), "BETTER WITH SPEAKERS ON" line, then `#loader.complete` shows the
"BEGIN EXPERIENCE" button (desktop). On viewports narrower than 767 px the site starts
automatically without the button. Start triggers the `open_website` sound, `startWebsite` on
the worker, header slide-in (`#head.active`), `.htibtn_cont_pulsar.loaded`, loader
`close` → `hide` (700 ms).

**Scroll** — Lenis smooth scroll (`wheelMultiplier .5`, `touchMultiplier .8`, `lerp .1`,
`syncTouch`) drives a 0–1 progress that is mapped onto ten section ranges (`section1` 1.5
screens, `section2` 3.5, `section3` 2, `section4` 3.5, `section5` 2 → `#app` is 12.5 × 100vh).
Progress values are sent to the worker every frame (`sectionProgress`). Extra behaviours:
auto-scroll through section 3 and the end of section 2 (`Autoscroll` class, speed curves,
slow-down on mouse hold, keyboard speed-up), "magnet" scroll at the end (0.73→0.95 snaps to 1
with GSAP ScrollTo, 7 s forward / 5 s back, `sine.inOut`), keyboard scrolling
(arrows/page/space, step 1 or 60), scroll lock while interacting (`data-lenis-prevent`).

**Section UI** — headline overlays per section (DOM headlines only on touch devices, Firefox
or low-speed GPUs; otherwise rendered as 3D text in the worker using an SDF atlas generated
on the main thread), section 1 description fade (2.5 s after start; "SCROLL TO CONTINUE"
fades in/out 5 s later), pagination dots (`.section-pag`, chapter labels shown 2.3 s), end
section (`.end` shows at progress > .952), interaction areas in sections 2 and 4 (hold-to-interact
cursor button with two SVG progress rings: 150 ms hold threshold, 250 ms ring, 4 s locked
ring; tap-to-interact on touch with a "TAP ANYWHERE TO CLOSE" button after 1.5 s), cheetah
"anger" on mouse/touch down at the very top (150 ms cooldown, 350 ms duration).

**Navigation** — menu button (500 ms cooldown, GSAP-masked label reveal), nav links
About/Contact with hover sounds and mask animation, logo links (scroll-to-top when on the top
page, close menu otherwise), language toggle (`en ↔ ja`, `fr → en`) with letter-split labels
rebuilt at runtime, Blog/Works/会社概要 links. About and Contact are client-side page
transitions (600 ms leave, 1000 ms when the menu is open; `.top-container/.about/.contact/.sections-headlines`
get `hide`; the worker receives `pageTransition`/`menuOpen`/`inSubPage`). Blog and other
content pages are full page loads (verified with Puppeteer). About has tabbed content
(`.tab-nav-item` → `.tabcntitm-n` mask animations); Contact has tabs, mail links with hover
masks, SNS links and a map link.

**Audio** — 10 UI sounds (menu in/out with a convolution-reverb group, about/contact hover,
simple hover in/out, menu-button hover in/out, logo loop with a cursor-speed-driven double
low-pass), 6 music tracks (one per section + a "kick" layer for section 4 driven by scroll
progress), 10 transition/interaction stems (scene 1→2, 2→3, 3→4, 4→5, interaction in/out/loop
for sections 2 and 4). Music cross-fades on section change (1500 ms on anchor scrolls,
500 ms otherwise), a "night-club" low-pass + gain dip while the menu is open, a subpage is
shown or the user is interacting. Mute state persists in `localStorage.isMuted`, master volume
tweened over 1 s.

**Misc** — mouse/pointer/wheel events are forwarded to the worker; resize forwards
`{width,height,dpr,ratio}`; the showreel video (`/top/showreel_128.mp4`) is decoded on the
main thread and every frame is transferred to the worker as `ImageData`; gyroscope support on
touch devices (permission button `.gyro-activate` on iOS); Google Tag Manager events
(`page_fully_loaded`, `enter_button_click`, `section_change`, `section_time_spent` every 14 s,
`user_fps`, `button_click`, `tab_navigation`, `set_user_properties`); a console banner with the
render backend when DevTools is open.

## 3. Reproduction of the reported problems

All measurements were taken with Chrome 152 driven by Puppeteer on the machine that reported
the problems (NVIDIA "lovelace" GPU, WebGPU available) plus a SwiftShader headless run.

### 3.1 Audio "cannot be heard"

1. **Root cause (local copy): missing audio assets.** The downloaded site references every
   sound on `https://cdn.utsubo.io/v2/audio/...`. Those files were not part of the site
   download, so every `Howl` received a 404 → Howler emitted `loaderror` and stayed silent
   (verified: 26 × `404 /cdn/audio/transitions/opus/*.opus` in the network log before the
   files were fetched). The rebuilt app ships all audio locally under `public/cdn/audio/`.
2. **No format fallback on load failure.** `getAudioPaths()` returns `[opus, mp3]`, but Howler
   only uses the list for *codec* selection: if the chosen file fails to load it does not try
   the next one. A single broken/blocked opus file silences that sound. Ad-blockers that block
   `cdn.*` hosts produce exactly this symptom on the live site.
3. **Autoplay handling depends on a one-shot Howler event.** Music starts only from
   `sounds.section1.once("unlock")`. Howler fires `unlock` once, after its own
   `touchend/click/keydown` listeners resume the context. If the first user gesture resumes the
   context through another path (e.g. the `video.play()` retry or a `pointerdown` that Howler
   does not listen to) or the context later reports `interrupted` (iOS after a phone call /
   Siri), the music never starts and there is no recovery.
4. **AudioContext created before any gesture** (`new Howl` in the constructor at page load)
   → Chrome logs "The AudioContext was not allowed to start". Combined with (3) this is the
   main fragility on desktop; on Safari the context can additionally stay `suspended` after
   tab switches.
5. **Cross-origin XHR** (`html5:false` → Web Audio buffers fetched with XHR) requires CORS
   headers from the CDN; any CORS failure is silent for the user.

Measured on this machine after the assets were restored: context `running`, `section1.opus`
playing at 0.8 after the Begin click, correct cross-fades while scrolling and correct mute
persistence — i.e. the audio *logic* works once the assets load, which pins (1)/(2) as the
cause of the reported silence.

### 3.2 Freezing / unresponsiveness

| Finding | Evidence |
|---|---|
| **DOM + listener leak on every About/Contact navigation.** Taxi.js swaps the view but the orchestration keeps references: DOM nodes grow 5 018 → 11 404 → 18 200 → 22 074 → 25 936 over four About+Contact round-trips; JS event listeners 114 → 239. Sub-page controllers are killed, but the interaction button re-registers `top-entered` handlers, the scroll controller adds a new `.end` click listener and the analytics class a new `MutationObserver`/interval on every entry; old `[data-taxi-view]` trees stay referenced by closures. | Puppeteer `page.metrics()` snapshots. Growth is linear and never released → a long session becomes sluggish and eventually unresponsive. |
| **Renderer crash on the WebGPU path.** One of six headed runs lost the page 55 s into loading ("Session closed"), i.e. the renderer process died. The WebGPU run also logs `Bindings._update: binding should be available` (Three.js WebGPU backend) during section transitions and `THREE.WebGPURenderer: WebGL Device Lost` on the WebGL fallback in headless mode. | Probe logs. |
| **Long tasks during boot.** 5–6 long tasks up to 635 ms on the main thread while the bundles compile and the SDF glyph atlas is generated (`getTextRenderInfo` runs WebGL on the main thread). In the software-rendered run 548 long tasks (max 2.3 s) were recorded, showing what a weak GPU experiences. | `PerformanceObserver('longtask')`. |
| **Per-frame video decode on the main thread.** `showreel_128.mp4` is drawn to a 2D canvas and `getImageData` + transfer to the worker on every `requestVideoFrameCallback`; `drawImage` alone is 2.3 % of main-thread time. | CPU profile. |
| **Google Tag Manager is the heaviest JS function** during scrolling (1.7 % self time) and the site pushes `section_time_spent` from a 100 ms `setInterval` that is never cleared. | CPU profile. |
| **Multiple rAF loops.** Ticker, progress-ring loops, video frame loop, Lenis via ticker; ~50 000 rAF callbacks were counted while the loader was visible in headless mode. | rAF counter. |
| **No visibility handling for rendering.** Only analytics pauses on `visibilitychange`; the worker keeps rendering off-screen (Chrome throttles it, Safari does not). | Hidden-tab measurement. |

What was **not** reproducible on this hardware: a sustained main-thread freeze while
scrolling. The main thread was ≥ 90 % idle (rAF 78–215 fps) in both WebGPU and WebGL modes;
the rendering itself lives in the worker.

## 4. Screenshots and interaction references

Reference captures of the original (loader, after Begin, menu, About, Contact, scrolled,
mobile) are produced by the Playwright suite in `tests/e2e/` at 1920×1080, 1440×900,
1024×768, 768×1024, 430×932 and 390×844 and compared with the rebuild.

## 5. Decisions taken for the rebuild

* The Worker/OffscreenCanvas engine bundle is kept as a vendored library (`public/engine/`).
  It is minified third-party-style code (Three.js WebGPU scene, shaders, baked animations)
  and is the only way to preserve the visuals exactly. Everything that talks to it — boot,
  RPC, input forwarding, scroll, UI, audio, navigation — is rewritten in TypeScript.
* The main-thread fallback renderer (no `OffscreenCanvas`) is dropped: every browser in the
  support matrix (Chrome/Edge 69+, Firefox 105+, Safari 16.4+) supports OffscreenCanvas.
* Taxi.js is replaced by the Next.js App Router with a transition controller that reproduces
  the original leave/enter timings and fixes the leak (controllers are disposed on leave).
* Howler stays (identical decoding/format behaviour) behind a new `AudioManager` that fixes
  §3.1 (2)–(5).

## 6. Verification of the rebuild

Re-running the same instrumentation against the production build of the rebuild:

| Measurement | Original | Rebuild |
|---|---|---|
| Sounds loaded / playing after the Begin click | 0 of 26 (all 404 before the assets were restored) | 26 of 26, `section1` at 0.8 |
| AudioContext state | `running`, but music depended on Howler's one-shot `unlock` | `running`, music started from an explicit unlock promise |
| Mute persistence | works | works (`localStorage.isMuted`, volume tween 1 s) |
| DOM nodes after 1 / 6 About+Contact round trips | 11 404 / 25 936 | 4 553 / 4 553 |
| Listeners over the same cycles | 123 → 239 | 454 → 454 |
| FPS while scrolling (main thread) | 77–107 | 83–238 |
| Console errors | `Bindings._update`, WebGPU device lost, one renderer crash in six runs | none |
| Failed requests | analytics beacons aborted | none |

Automated coverage: 15 Vitest unit tests and 16 Playwright end-to-end tests (audio start,
mute persistence, scroll → music/pagination, menu and sub-page transitions with a DOM-leak
assertion, back/forward, direct loads of all nine experience routes, tabs and contact links,
content pages, contact form validation, FAQ, 404, mobile auto-start, resize, slow network,
repeated navigation), plus screenshots of both versions at the six required viewports.
