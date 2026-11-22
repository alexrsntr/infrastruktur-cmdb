import { theme as antTheme, type ThemeConfig } from 'antd';
import type { Density } from '../../shared/appearance';

/**
 * Design tokens. Direction: clean infrastructure console in the style of HPE VM Essentials –
 * dark top navigation, light content area, big clear controls (≥ 40 px), generous spacing,
 * few colours: brand blue for actions, green/orange/red only for status.
 */
export const HEADER_BG = '#0b1f33';
export const HEADER_BG_2 = '#12304d';
export const PAGE_BG = '#f2f4f7';
export const TEXT = '#14202e';
export const TEXT_2 = '#4a5a6c';
export const BORDER = '#dfe4ea';
/** Signal colours as hex values – only for Ant Design tokens, which need real colours. Components use `C` below. */
export const STATUS = { ok: '#1e9e5a', warn: '#c47d00', bad: '#d9363e', idle: '#7f8c9b' };

/**
 * Colours for components: CSS variables from styles.css, so they follow the colour scheme (light / dark) and the
 * configured primary colour. Use them directly, or with tintBg / tintFg (lib/palette.ts) for soft backgrounds.
 * `…Text` variants have 4.5:1 contrast for text; the others are for dots, bars, icons and borders.
 */
export const C = {
  primary: 'var(--cmdb-primary)',
  ok: 'var(--cmdb-ok)',
  warn: 'var(--cmdb-warn)',
  bad: 'var(--cmdb-bad)',
  info: 'var(--cmdb-info)',
  idle: 'var(--cmdb-idle)',
  okText: 'var(--cmdb-ok-text)',
  warnText: 'var(--cmdb-warn-text)',
  badText: 'var(--cmdb-bad-text)',
  infoText: 'var(--cmdb-info-text)',
  teal: 'var(--cmdb-teal)',
  violet: 'var(--cmdb-violet)',
  slate: 'var(--cmdb-slate)',
  amber: 'var(--cmdb-amber)',
  text2: 'var(--cmdb-text-2)',
  muted: 'var(--cmdb-muted)',
} as const;

export const FONT_FAMILY = `'Segoe UI', 'Segoe UI Variable', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`;

export type ColorMode = 'light' | 'dark';

/** Dark scheme: same structure, values matching the CSS variables in styles.css ([data-theme='dark']). */
const DARK = {
  pageBg: '#0e1319',
  container: '#161d26',
  elevated: '#1b2430',
  text: '#e5eaf0',
  text2: '#a7b4c3',
  border: '#364252',
  borderSecondary: '#2a3441',
  subtle: '#1b2430',
  hover: '#1f2b3a',
  tagBg: '#222c39',
  segmentedTrack: '#0e1319',
  segmentedSelected: '#222c39',
};

// ---- contrast helpers: a configured primary colour must stay readable as link and button colour

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 1;
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/**
 * The primary colour as shown, readable as link and as button background with white text:
 * - light scheme: at least 4.5:1 against white (darkened step by step if needed – serves links and button text alike)
 * - dark scheme: at least 3:1 against the dark surface (lightened if needed, but not more, so white button text
 *   stays readable)
 * Colours that already meet this are used unchanged (the default blue in both schemes). Invalid values → blue.
 */
export function readablePrimary(primary: string, mode: ColorMode, purpose: 'fill' | 'text' = 'fill'): string {
  const rgb = parseHex(primary);
  if (!rgb) return DEFAULT_PRIMARY;
  const dark = mode === 'dark';
  const surface = dark ? DARK.container : '#ffffff';
  // links and selected tabs are text: 4.5:1 in both schemes
  const goal = dark && purpose === 'fill' ? 3 : 4.5;
  const target = dark ? [255, 255, 255] : [0, 0, 0];
  for (let step = 0; step <= 12; step++) {
    const hex = toHex(rgb.map((c, i) => c + (target[i] - c) * step * 0.06));
    if (contrastRatio(hex, surface) >= goal) return hex;
  }
  return toHex(target);
}

export const DEFAULT_PRIMARY = '#2563eb';

export function buildTheme(configuredPrimary: string, mode: ColorMode = 'light', density: Density = 'comfortable'): ThemeConfig {
  const dark = mode === 'dark';
  const primary = readablePrimary(configuredPrimary, mode);
  const link = readablePrimary(configuredPrimary, mode, 'text');
  const theme: ThemeConfig = {
    algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
    token: {
      colorPrimary: primary,
      colorInfo: primary,
      colorLink: link,
      colorSuccess: STATUS.ok,
      colorWarning: STATUS.warn,
      colorError: STATUS.bad,
      colorText: dark ? DARK.text : TEXT,
      colorTextSecondary: dark ? DARK.text2 : TEXT_2,
      colorBorder: dark ? DARK.border : '#cfd6de',
      colorBorderSecondary: dark ? DARK.borderSecondary : BORDER,
      colorBgLayout: dark ? DARK.pageBg : PAGE_BG,
      ...(dark ? { colorBgContainer: DARK.container, colorBgElevated: DARK.elevated } : {}),
      fontFamily: FONT_FAMILY,
      fontSize: 15,
      fontSizeLG: 16,
      fontSizeHeading1: 30,
      fontSizeHeading2: 26,
      fontSizeHeading3: 22,
      fontSizeHeading4: 18,
      controlHeight: 40,
      controlHeightLG: 46,
      controlHeightSM: 32,
      borderRadius: 8,
      borderRadiusLG: 12,
      borderRadiusSM: 6,
      wireframe: false,
    },
    components: {
      Layout: { headerBg: dark ? '#0a1017' : HEADER_BG, headerHeight: 64, headerPadding: '0 24px', bodyBg: dark ? DARK.pageBg : PAGE_BG },
      Button: {
        fontWeight: 600,
        paddingInline: 20,
        paddingInlineLG: 24,
        borderRadius: 20,
        borderRadiusLG: 23,
        borderRadiusSM: 16,
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
      },
      Input: { paddingInline: 14 },
      Select: { optionHeight: 40, optionPadding: '9px 14px' },
      Table: {
        headerBg: dark ? DARK.subtle : '#f6f8fa',
        headerColor: dark ? DARK.text2 : TEXT_2,
        rowHoverBg: dark ? DARK.hover : '#eef4fb',
        cellPaddingBlock: 14,
        cellPaddingInline: 16,
        cellPaddingBlockMD: 11,
        cellPaddingBlockSM: 8,
        headerSplitColor: 'transparent',
      },
      Card: { headerFontSize: 17, headerHeight: 56, paddingLG: 24, headerBg: 'transparent' },
      Tabs: { titleFontSize: 16, horizontalItemPadding: '14px 4px', horizontalItemGutter: 28, inkBarColor: primary, itemSelectedColor: link, itemHoverColor: link, itemActiveColor: link },
      Modal: { titleFontSize: 20, paddingContentHorizontalLG: 28 },
      Form: { labelFontSize: 14, verticalLabelPadding: '0 0 6px', itemMarginBottom: 20 },
      Tag: { defaultBg: dark ? DARK.tagBg : '#eef1f4' },
      Segmented: { itemSelectedBg: dark ? DARK.segmentedSelected : '#ffffff', trackBg: dark ? DARK.segmentedTrack : '#e6eaef', trackPadding: 4 },
      Descriptions: { labelBg: dark ? DARK.subtle : '#f6f8fa', itemPaddingBottom: 12 },
      Statistic: { contentFontSize: 30, titleFontSize: 14 },
      Dropdown: { controlItemBgHover: dark ? DARK.hover : '#eef4fb', paddingBlock: 8 },
      Menu: { itemHeight: 44, iconSize: 18 },
    },
  };
  return density === 'compact' ? compact(theme) : theme;
}

/** Compact density: smaller controls, rows and paddings – more on the screen for desktop users. */
function compact(t: ThemeConfig): ThemeConfig {
  const c = t.components ?? {};
  return {
    ...t,
    token: { ...t.token, fontSize: 14, fontSizeLG: 15, controlHeight: 34, controlHeightLG: 40, controlHeightSM: 28 },
    components: {
      ...c,
      Button: { ...c.Button, paddingInline: 16, paddingInlineLG: 20 },
      Select: { ...c.Select, optionHeight: 34, optionPadding: '6px 12px' },
      Table: { ...c.Table, cellPaddingBlock: 9, cellPaddingInline: 12, cellPaddingBlockMD: 8, cellPaddingBlockSM: 6 },
      Card: { ...c.Card, headerFontSize: 16, headerHeight: 48, paddingLG: 18 },
      Tabs: { ...c.Tabs, titleFontSize: 15, horizontalItemPadding: '10px 4px', horizontalItemGutter: 24 },
      Form: { ...c.Form, itemMarginBottom: 16 },
      Statistic: { ...c.Statistic, contentFontSize: 26 },
      Menu: { ...c.Menu, itemHeight: 38 },
    },
  };
}
