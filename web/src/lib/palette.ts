/**
 * Colour helpers that work in the light and the dark scheme (see the CSS variables in styles.css).
 * tintBg: soft background derived from a signal colour, tintFg: that colour, lightened in dark mode.
 */
export const tintBg = (color: string) => `color-mix(in srgb, ${color} var(--cmdb-tint-bg), var(--cmdb-surface))`;
export const tintFg = (color: string) => `color-mix(in srgb, ${color} var(--cmdb-tint-fg), var(--cmdb-text))`;
