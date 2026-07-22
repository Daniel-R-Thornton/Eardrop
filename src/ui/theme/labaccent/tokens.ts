/**
 * src/ui/theme/labaccent/tokens.ts — Design tokens for the "lab-accent" theme.
 *
 * Retro test-equipment (Tektronix-oscilloscope-style) accent theme: beige
 * faceplate panels, dark CRT screen insets, phosphor-green primary traces.
 * Paired with labaccent.css, which references these hex values directly.
 */

export const T = {
  panel: '#d8d2c4',        // beige faceplate
  panelEdge: '#b7b0a0',
  panelInk: '#2c2a24',     // screen-printed label
  screenBg: '#0b1410',     // CRT dark
  phosphor: '#3cff7a',     // primary trace
  phosphorDim: '#1f6f3c',
  amber: '#ffb03a',        // secondary trace / pilot
  cyan: '#49d0ff',
  grid: 'rgba(60,255,122,0.12)',
  led: '#ff5a3c',
  ledOn: '#57ff6a',
  mono: `'SF Mono','JetBrains Mono',ui-monospace,monospace`,
  radius: 4,
} as const;
export const TONE_TRACE = ['#3cff7a', '#49d0ff', '#ffb03a', '#ff7ad0', '#b3ff3c', '#9a7aff', '#ff5a3c', '#3cffe0'];
