/**
 * src/ui/styles/tokens.ts — Design tokens for the Eardrop UI.
 *
 * Used alongside CSS variables in style.css for consistent spacing,
 * typography, and color theming across all components.
 */

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const FONT_SIZE = {
  xs: 9,
  sm: 10,
  md: 12,
  base: 13,
  lg: 14,
  xl: 15,
  heading: 18,
} as const;

export const RADIUS = {
  sm: 6,
  md: 8,
  lg: 12,
} as const;

export const COLORS = {
  // Tone visualization (matches modem TONE_COLORS)
  toneBlue: '#4a9eff',
  toneRed: '#ff6b4a',
  toneTeal: '#5eead4',
  tonePink: '#f472b6',
  // Accent
  primary: '#6c6cff',
  success: '#34d399',
  error: '#f87171',
  // Neutral
  textPrimary: '#e0e0ee',
  textSecondary: '#6b7280',
} as const;

/** CSS variable names for dynamic theming */
export const CSS_VARS = {
  surface: 'var(--surface)',
  border: 'var(--border)',
  text: 'var(--text)',
  surfaceAlt: 'var(--surface-alt)',
} as const;
