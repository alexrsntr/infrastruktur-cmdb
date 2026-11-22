import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import {
  DEFAULT_APPEARANCE,
  DENSITIES,
  HEADER_STYLES,
  HEX_COLOR_RE,
  LOGO_MAX_BYTES,
  LOGO_MAX_SIDE,
  LOGO_MIME_TYPES,
  LOGO_VARIANTS,
  logoUrl,
  type AppearanceSettings,
  type AppearanceStatus,
  type EffectiveAppearance,
  type LogoInfo,
  type LogoVariant,
} from '../../shared/appearance';
import type { Config } from '../config';
import type { DbClient } from '../db/pool';
import { badRequest, HttpError } from '../lib/http';
import { readImageSize } from '../lib/image';
import { readSetting, writeSetting } from './mailer';

/**
 * Appearance of the installation (Administration → Settings → Appearance). Stored in app_setting:
 *   appearance              names, primary colour, header style, density
 *   appearance.logo.<light|dark>   one uploaded logo each (metadata + image as base64, at most 256 KB)
 * Environment variables (BRAND_NAME, APP_NAME, BRAND_PRIMARY_COLOR) win over the values set in the app.
 */

const KEY = 'appearance';
const logoKey = (variant: LogoVariant) => `appearance.logo.${variant}`;

interface StoredLogo extends LogoInfo {
  data: string;
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function normalise(v: Partial<AppearanceSettings> | undefined): AppearanceSettings {
  const s = v ?? {};
  return {
    brandName: text(s.brandName, 60),
    appName: text(s.appName, 60),
    primaryColor: typeof s.primaryColor === 'string' && HEX_COLOR_RE.test(s.primaryColor) ? s.primaryColor.toLowerCase() : null,
    headerStyle: HEADER_STYLES.includes(s.headerStyle as never) ? (s.headerStyle as AppearanceSettings['headerStyle']) : DEFAULT_APPEARANCE.headerStyle,
    density: DENSITIES.includes(s.density as never) ? (s.density as AppearanceSettings['density']) : DEFAULT_APPEARANCE.density,
  };
}

export async function loadAppearanceSettings(db: DbClient): Promise<{ settings: AppearanceSettings; updatedAt: string | null }> {
  const row = await readSetting<Partial<AppearanceSettings>>(db, KEY);
  return { settings: normalise(row?.value), updatedAt: row?.updatedAt ?? null };
}

/** Metadata of the uploaded logos – without the image data */
export async function loadLogoInfos(db: DbClient): Promise<Record<LogoVariant, LogoInfo | null>> {
  const { rows } = await db.query<{ key: string; info: LogoInfo }>(`SELECT key, value - 'data' AS info FROM app_setting WHERE key = ANY($1::text[])`, [
    LOGO_VARIANTS.map(logoKey),
  ]);
  const byKey = new Map(rows.map((r) => [r.key, r.info]));
  return { light: byKey.get(logoKey('light')) ?? null, dark: byKey.get(logoKey('dark')) ?? null };
}

function resolve(config: Config, settings: AppearanceSettings) {
  return {
    brandName: config.uiEnv.brandName ? config.ui.brandName : (settings.brandName ?? config.ui.brandName),
    appName: config.uiEnv.appName ? config.ui.appName : (settings.appName ?? config.ui.appName),
    primaryColor: config.uiEnv.primaryColor ? config.ui.primaryColor : (settings.primaryColor ?? config.ui.primaryColor),
  };
}

/** Company and app name in effect – for e-mails and exports */
export async function effectiveNames(db: DbClient, config: Config): Promise<{ brandName: string; appName: string }> {
  const { settings } = await loadAppearanceSettings(db);
  const { brandName, appName } = resolve(config, settings);
  return { brandName, appName };
}

function toEffective(config: Config, settings: AppearanceSettings, logos: Record<LogoVariant, LogoInfo | null>): EffectiveAppearance {
  return {
    ...resolve(config, settings),
    headerStyle: settings.headerStyle,
    density: settings.density,
    logoUrl: { light: logoUrl('light', logos.light), dark: logoUrl('dark', logos.dark) },
  };
}

export async function loadEffectiveAppearance(db: DbClient, config: Config): Promise<EffectiveAppearance> {
  const [{ settings }, logos] = await Promise.all([loadAppearanceSettings(db), loadLogoInfos(db)]);
  return toEffective(config, settings, logos);
}

export async function appearanceStatus(db: DbClient, config: Config): Promise<AppearanceStatus> {
  const [{ settings, updatedAt }, logos] = await Promise.all([loadAppearanceSettings(db), loadLogoInfos(db)]);
  return { settings, env: { ...config.uiEnv }, effective: toEffective(config, settings, logos), logos, updatedAt };
}

export async function saveAppearanceSettings(db: DbClient, input: AppearanceSettings, userId: string | null): Promise<AppearanceSettings> {
  const next = normalise(input);
  await writeSetting(db, KEY, next, userId);
  return next;
}

/** Checks and stores a logo: PNG, JPEG or WebP (by content, not by file name), at most 256 KB and 2000 px. */
export async function saveLogo(db: DbClient, variant: LogoVariant, data: Buffer, userId: string | null): Promise<LogoInfo> {
  if (data.length > LOGO_MAX_BYTES) throw new HttpError(413, `The logo is too large – at most ${LOGO_MAX_BYTES / 1024} KB.`);
  const image = readImageSize(data);
  if (!image || !LOGO_MIME_TYPES.includes(image.mime as never)) throw badRequest('The logo must be a PNG, JPEG or WebP image.');
  if (!image.width || !image.height || image.width > LOGO_MAX_SIDE || image.height > LOGO_MAX_SIDE)
    throw badRequest(`The logo must be at most ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} pixels.`);
  const info: LogoInfo = {
    mime: image.mime,
    width: image.width,
    height: image.height,
    bytes: data.length,
    version: crypto.createHash('sha256').update(data).digest('hex').slice(0, 16),
  };
  await writeSetting(db, logoKey(variant), { ...info, data: data.toString('base64') } satisfies StoredLogo, userId);
  return info;
}

export async function deleteLogo(db: DbClient, variant: LogoVariant): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM app_setting WHERE key = $1', [logoKey(variant)]);
  return (rowCount ?? 0) > 0;
}

export function isLogoVariant(v: unknown): v is LogoVariant {
  return LOGO_VARIANTS.includes(v as never);
}

/**
 * GET /api/branding/logo/:variant – public (the sign-in page shows the logo). The URL carries the version, so the
 * browser may keep the image; the ETag answers re-validations with 304.
 */
export function logoHandler(pool: Pool) {
  return async (req: Request, res: Response) => {
    const variant = req.params.variant;
    if (!isLogoVariant(variant)) return res.status(404).end();
    const row = await readSetting<StoredLogo>(pool, logoKey(variant));
    if (!row) return res.status(404).end();
    const etag = `"${row.value.version}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.type(row.value.mime).send(Buffer.from(row.value.data, 'base64'));
  };
}
