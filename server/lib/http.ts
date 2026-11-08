import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { log } from './log';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const forbidden = (msg = 'You do not have permission to perform this action') => new HttpError(403, msg);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const conflict = (msg: string) => new HttpError(409, msg);

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'Validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Translate well-known PostgreSQL errors into HTTP errors */
function fromPg(err: { code?: string; constraint?: string; detail?: string }): HttpError | null {
  switch (err.code) {
    case '23505':
      return conflict(uniqueMessage(err.constraint) ?? 'An entry with these values already exists');
    case '23503':
      return conflict(
        err.detail?.includes('is still referenced')
          ? 'This entry is still referenced by other entries (e.g. assets). Move or delete those first.'
          : 'Referenced entry does not exist',
      );
    case '23514':
      return badRequest('A value is out of the allowed range');
    case '22P02':
      return badRequest('Invalid identifier or value format');
    default:
      return null;
  }
}

function uniqueMessage(constraint?: string): string | null {
  switch (constraint) {
    case 'plant_code_idx':
      return 'A plant with this code already exists';
    case 'building_code_idx':
      return 'A building with this code already exists in this plant';
    case 'asset_type_name_idx':
      return 'An asset of this type with this name already exists';
    case 'asset_relation_unique_idx':
      return 'This relation already exists';
    default:
      return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let httpErr: HttpError | null = null;
  if (err instanceof HttpError) httpErr = err;
  else if (err instanceof ZodError) httpErr = badRequest('Validation failed', err.issues);
  else if (err && typeof err === 'object' && 'code' in err) httpErr = fromPg(err as never);
  else if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large')
    httpErr = new HttpError(413, 'Request too large');

  if (!httpErr) {
    log.error('unhandled error', {
      path: req.path,
      method: req.method,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    httpErr = new HttpError(500, 'Internal server error');
  }
  res.status(httpErr.status).json({ error: httpErr.message, details: httpErr.details });
}

/** Small helper to build parameterised SQL incrementally */
export class SqlBuilder {
  params: unknown[] = [];
  where: string[] = [];

  /** Adds a parameter and returns its placeholder ($n) */
  p(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  and(clause: string) {
    this.where.push(clause);
    return this;
  }

  whereSql(): string {
    return this.where.length ? `WHERE ${this.where.join(' AND ')}` : '';
  }
}

export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function clampInt(value: unknown, def: number, min: number, max: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function queryString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim() || undefined;
  return undefined;
}

export function queryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function requireUuid(v: unknown, what = 'id'): string {
  if (!isUuid(v)) throw badRequest(`Invalid ${what}`);
  return v;
}
