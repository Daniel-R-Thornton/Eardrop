/**
 * src/ui/lib/colors.ts — Color constants for tone visualization.
 *
 * Re-exports from modem/types to eliminate duplication between
 * MainApp.tsx and the modem layer.
 */
import { TONE_COLORS } from '../../modem/types';

export { TONE_COLORS };

/** Nominal tone frequencies (pilot 800Hz + offsets for default config) */
export const TONE_FREQUENCIES = [850, 1050, 1250, 1450];
