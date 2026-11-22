// Appearance of the installation: company and app name, primary colour, header style, logo, density.
// Configured by administrators (Administration → Settings → Appearance); environment variables win.

export const HEADER_STYLES = ['dark', 'primary', 'light'] as const;
export type HeaderStyle = (typeof HEADER_STYLES)[number];
export const HEADER_STYLE_META: Record<HeaderStyle, { label: string; hint: string }> = {
  dark: { label: 'Dark', hint: 'Dark navigation bar (default)' },
  primary: { label: 'Primary colour', hint: 'Navigation bar in a dark shade of the primary colour' },
  light: { label: 'Light', hint: 'Light navigation bar with a fine line below' },
};

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];
export const DENSITY_META: Record<Density, { label: string; hint: string }> = {
  comfortable: { label: 'Comfortable', hint: 'Large controls and rows – good for touch screens (default)' },
  compact: { label: 'Compact', hint: 'Smaller rows and spacing – more on the screen' },
};

/** Neutral colour presets. Every preset is readable as link and button colour in the light and the dark scheme. */
export const COLOR_PRESETS = [
  { key: 'blue', label: 'Blue', color: '#2563eb' },
  { key: 'teal', label: 'Petrol', color: '#0f766e' },
  { key: 'green', label: 'Green', color: '#15803d' },
  { key: 'violet', label: 'Violet', color: '#7c3aed' },
  { key: 'red', label: 'Red', color: '#c8102e' },
  { key: 'graphite', label: 'Graphite', color: '#3f4a56' },
] as const;

export const DEFAULT_BRAND_NAME = 'Infrastruktur';
export const DEFAULT_APP_NAME = 'IT Infrastructure';
export const DEFAULT_PRIMARY_COLOR = '#2563eb';
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const LOGO_VARIANTS = ['light', 'dark'] as const;
/** light = logo for light backgrounds (login page, light header), dark = for dark backgrounds (dark header) */
export type LogoVariant = (typeof LOGO_VARIANTS)[number];
export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_MAX_SIDE = 2000;
export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** What administrators set in the app; null = not set (default or environment variable) */
export interface AppearanceSettings {
  brandName: string | null;
  appName: string | null;
  primaryColor: string | null;
  headerStyle: HeaderStyle;
  density: Density;
}

export interface LogoInfo {
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** Changes with every upload – part of the logo URL, so browsers may cache it */
  version: string;
}

/** Values in effect (environment variable > setting in the app > default) */
export interface EffectiveAppearance {
  brandName: string;
  appName: string;
  primaryColor: string;
  headerStyle: HeaderStyle;
  density: Density;
  /** URLs of the uploaded logos (null = built-in mark) */
  logoUrl: { light: string | null; dark: string | null };
}

export interface AppearanceStatus {
  settings: AppearanceSettings;
  /** Fields set by an environment variable – they win and cannot be changed in the app */
  env: { brandName: boolean; appName: boolean; primaryColor: boolean };
  effective: EffectiveAppearance;
  logos: Record<LogoVariant, LogoInfo | null>;
  updatedAt: string | null;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  brandName: null,
  appName: null,
  primaryColor: null,
  headerStyle: 'dark',
  density: 'comfortable',
};

export function logoUrl(variant: LogoVariant, info: LogoInfo | null): string | null {
  return info ? `/api/branding/logo/${variant}?v=${info.version}` : null;
}
