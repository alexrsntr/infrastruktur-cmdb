import type { ThemeConfig } from 'antd';

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

export function buildTheme(primary: string): ThemeConfig {
  return {
    token: {
      colorPrimary: primary,
      colorInfo: primary,
      colorLink: primary,
      colorSuccess: STATUS.ok,
      colorWarning: STATUS.warn,
      colorError: STATUS.bad,
      colorText: TEXT,
      colorTextSecondary: TEXT_2,
      colorBorder: '#cfd6de',
      colorBorderSecondary: BORDER,
      colorBgLayout: PAGE_BG,
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
      Layout: { headerBg: HEADER_BG, headerHeight: 64, headerPadding: '0 24px', bodyBg: PAGE_BG },
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
        headerBg: '#f6f8fa',
        headerColor: TEXT_2,
        rowHoverBg: '#eef4fb',
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
      Tag: { defaultBg: '#eef1f4' },
      Segmented: { itemSelectedBg: '#ffffff', trackBg: '#e6eaef', trackPadding: 4 },
      Descriptions: { labelBg: '#f6f8fa', itemPaddingBottom: 12 },
      Statistic: { contentFontSize: 30, titleFontSize: 14 },
      Dropdown: { controlItemBgHover: '#eef4fb', paddingBlock: 8 },
      Menu: { itemHeight: 44, iconSize: 18 },
    },
  };
}
