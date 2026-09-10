/**
 * Brand and product tokens for the promo film.
 *
 * These MIRROR the CSS custom properties in styles/auth.css (`.kauth`, the
 * brand / app-chrome palette) and styles/profile.css (`.kprof`, the palette of
 * the candidate-facing product screens). They are copied rather than imported
 * on purpose: the video bundles through Remotion's own webpack, not Next's, and
 * must never pull app CSS, `next/font` or `server-only` modules into itself.
 *
 * If the brand changes, change the stylesheet first and then this file.
 */

/** `.kauth` — auth screens, dashboard shell, marketing accent. */
export const brand = {
  bg: '#020204',
  text: '#ffffff',
  muted: '#8892b0',
  accent: '#d8b4fe',
  accentDim: 'rgba(216, 180, 254, 0.15)',
  line: 'rgba(216, 180, 254, 0.22)',
  surface: 'rgba(255, 255, 255, 0.025)',
  success: '#7ee0b8',
  danger: '#ff8fa3',
} as const;

/** `.kprof` — the candidate profile, résumé import, and everything product. */
export const product = {
  bg: '#0b0c10',
  text: '#edeef2',
  muted: '#9aa2b1',
  accent: '#cbaaf7',
  accentDim: 'rgba(203, 170, 247, 0.13)',
  line: 'rgba(203, 170, 247, 0.24)',
  lineSoft: 'rgba(255, 255, 255, 0.09)',
  surface: 'rgba(255, 255, 255, 0.028)',
  surfaceRaised: 'rgba(255, 255, 255, 0.05)',
  /**
   * FILM ONLY. The screen values above are right on a display but a 2.8%
   * surface and a 9% hairline do not survive H.264 at web bitrates — the
   * cards disappear into the ground. Lifted just enough to be a card on
   * camera; still the same palette, still quieter than the raised state.
   */
  surfaceFilm: 'rgba(255, 255, 255, 0.045)',
  lineFilm: 'rgba(255, 255, 255, 0.13)',
  danger: '#ff96a8',
  warn: '#f0c977',
  success: '#7fdcb4',
  radius: 8,
  radiusSm: 6,
} as const;

/**
 * Faces. Syncopate is the wordmark and every heading; Rajdhani is the body face
 * of the auth screens and marketing copy. The product forms deliberately use a
 * neutral system stack (profile.css:5), so product UI in the film does too.
 */
export const font = {
  head: "'Syncopate', 'Segoe UI', sans-serif",
  body: "'Rajdhani', 'Segoe UI', sans-serif",
  ui: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, 'Cascadia Mono', Menlo, Consolas, monospace",
} as const;

/** The one easing curve both stylesheets use: `cubic-bezier(0.16, 1, 0.3, 1)`. */
export const EASE = [0.16, 1, 0.3, 1] as const;
