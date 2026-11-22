import { C, STATUS } from '../theme';

/**
 * Colour helpers that work in the light and the dark scheme (see the CSS variables in styles.css).
 * tintBg: soft background derived from a signal colour, tintFg: that colour, lightened in dark mode.
 */
export const tintBg = (color: string) => `color-mix(in srgb, ${color} var(--cmdb-tint-bg), var(--cmdb-surface))`;
export const tintFg = (color: string) => `color-mix(in srgb, ${color} var(--cmdb-tint-fg), var(--cmdb-text))`;

/**
 * Score 0–100 (data quality): colour for rings and bars – a real colour, because SVG attributes cannot use CSS
 * variables – and the text colour with enough contrast in both schemes.
 */
export const scoreFill = (score: number) => (score >= 90 ? STATUS.ok : score >= 70 ? STATUS.warn : STATUS.bad);
export const scoreText = (score: number) => (score >= 90 ? C.okText : score >= 70 ? C.warnText : C.badText);
