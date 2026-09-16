/**
 * The fact-grid glyphs.
 *
 * Inline SVG rather than an icon package: there are six of them, they never
 * change, and a dependency for six paths is a dependency to audit, update and
 * ship. Each is 14×14 on a 24-unit viewBox and inherits `currentColor`, so the
 * CSS controls the colour and nothing here needs to know about themes.
 *
 * All are decorative — every one sits beside text that already says what the
 * value is — so each carries `aria-hidden` and adds nothing to the accessible
 * name of its row.
 */

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconPin = () => (
  <Glyph>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </Glyph>
);

export const IconClock = () => (
  <Glyph>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Glyph>
);

export const IconMoney = () => (
  <Glyph>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.5" />
  </Glyph>
);

export const IconHome = () => (
  <Glyph>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
  </Glyph>
);

export const IconBadge = () => (
  <Glyph>
    <circle cx="12" cy="9" r="5" />
    <path d="M8.5 13.5 7 22l5-2.5L17 22l-1.5-8.5" />
  </Glyph>
);

export const IconChart = () => (
  <Glyph>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Glyph>
);
