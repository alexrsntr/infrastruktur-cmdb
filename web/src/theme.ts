import { theme as antTheme, type ThemeConfig } from 'antd';

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
export const STATUS = { ok: '#1e9e5a', warn: '#d98a00', bad: '#d9363e', idle: '#8c99a6' };
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

export function buildTheme(primary: string, mode: ColorMode = 'light'): ThemeConfig {
  const dark = mode === 'dark';
  return {
    algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
    token: {
      colorPrimary: primary,
      colorInfo: primary,
      colorLink: primary,
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
      Tabs: { titleFontSize: 16, horizontalItemPadding: '14px 4px', horizontalItemGutter: 28, inkBarColor: primary },
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
}
