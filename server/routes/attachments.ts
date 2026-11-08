import crypto from 'node:crypto';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ATTACHMENT_CATEGORIES, INLINE_SAFE_TYPES, PLAN_IMAGE_TYPES, type AttachmentCategory } from '../../shared/attachments';
import { ENTITY_TYPES, can, type EntityType } from '../../shared/model';
import type { Config } from '../config';
import { requirePermission } from '../auth/context';
import { withTransaction } from '../db/pool';
import { audit } from '../lib/audit';
import { badRequest, forbidden, HttpError, notFound, parse, queryString, requireUuid } from '../lib/http';
import { readImageSize } from '../lib/image';
import { log } from '../lib/log';
import { optText } from '../lib/schemas';
import { hasPlantAccess, resolveEntity, resolveEntityWithAccess } from '../lib/scope';
import { ATTACHMENT_FROM, ATTACHMENT_SELECT, initAttachments, purgeBlobs } from '../services/attachments';
import { sanitizeFileName, StorageNotFoundError, storageKey } from '../services/storage';

/** Never accepted: executables, scripts and active web content */
export const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.js', '.mjs', '.cjs', '.jar', '.scr', '.sh',
  '.html', '.htm', '.xhtml', '.svg', '.hta', '.dll', '.lnk',
]);

const CONFIG_EXTENSIONS = new Set(['.cfg', '.conf', '.txt', '.json', '.yaml', '.yml', '.xml', '.log', '.ini']);

const EXTENSION_TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.log': 'text/plain', '.cfg': 'text/plain', '.conf': 'text/plain', '.ini': 'text/plain',
  '.csv': 'text/csv', '.json': 'application/json', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'application/xml',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.vsd': 'application/vnd.visio', '.vsdx': 'application/vnd.ms-visio.drawing', '.zip': 'application/zip',
  '.msg': 'application/vnd.ms-outlook', '.eml': 'message/rfc822', '.dwg': 'application/acad', '.dxf': 'application/dxf',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.mp4': 'video/mp4',
};
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.vsd', '.vsdx', '.csv', '.dwg', '.dxf']);

interface Detected {
  contentType: string;
  width: number | null;
  height: number | null;
  isImage: boolean;
}

/** Determines the content type from the file content (images, PDF) or the extension – never from the client. */
export function detectFile(buf: Buffer, fileName: string): Detected {
  let img: ReturnType<typeof readImageSize> = null;
  try {
    img = readImageSize(buf);
  } catch {
    img = null;
  }
  if (img && img.width > 0 && img.height > 0) return { contentType: img.mime, width: img.width, height: img.height, isImage: true };
  if (buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    return { contentType: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), isImage: true };
  }
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { contentType: 'application/pdf', width: null, height: null, isImage: false };
  const ext = path.extname(fileName).toLowerCase();
  const byExt = EXTENSION_TYPES[ext];
  if (byExt) return { contentType: byExt, width: null, height: null, isImage: byExt.startsWith('image/') };
  return { contentType: 'application/octet-stream', width: null, height: null, isImage: false };
}

function defaultCategory(d: Detected, fileName: string): AttachmentCategory {
  const ext = path.extname(fileName).toLowerCase();
  if (d.isImage) return 'photo';
  if (d.contentType === 'application/pdf' || DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  if (CONFIG_EXTENSIONS.has(ext)) return 'config';
  return 'other';
}

/** RFC 6266 / 5987 Content-Disposition with ASCII fallback */
export function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

const uploadFieldsSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().uuid(),
  category: z
    .enum([...ATTACHMENT_CATEGORIES, 'auto'] as [string, ...string[]])
    .optional()
    .transform((v) => (v && v !== 'auto' ? (v as AttachmentCategory) : undefined)),
  title: optText(200),
  description: optText(4000),
  isPlan: z
    .enum(['true', 'false', '1', '0', 'on', 'off'])
    .optional()
    .transform((v) => v === 'true' || v === '1' || v === 'on'),
});

const updateSchema = z.object({
  title: optText(200),
  description: optText(4000),
  category: z.enum(ATTACHMENT_CATEGORIES),
  is_plan: z.boolean().default(false),
});

async function loadAttachment(pool: Pool, id: string) {
  const { rows } = await pool.query(`SELECT ${ATTACHMENT_SELECT} ${ATTACHMENT_FROM} WHERE att.id = $1`, [id]);
  if (!rows[0]) throw notFound('Attachment');
  return rows[0];
}

/** Access check via the attachment's object (always current, even if the object moved to another plant). */
async function assertAccess(pool: Pool, req: Request, att: { entity_type: EntityType; entity_id: string }) {
  const ref = await resolveEntity(pool, att.entity_type, att.entity_id);
  if (!hasPlantAccess(req.user!, ref.plantId)) throw forbidden('This file is outside of your plant scope');
  return ref;
}

const PUBLIC_FIELDS = (row: Record<string, unknown>) => {
  const { sha256: _sha, ...rest } = row;
  return rest;
};

export function attachmentsRouter(pool: Pool, config: Config): Router {
  const r = Router();
  const { storage } = initAttachments(pool, config);
  const maxBytes = config.storage.maxUploadMb * 1024 * 1024;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1, fields: 10 }, defParamCharset: 'utf8' });
  const uploadSingle = (req: Request, res: Response, next: NextFunction) =>
    upload.single('file')(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
        return next(new HttpError(413, `The file is too large. The limit is ${config.storage.maxUploadMb} MB.`));
      if (err instanceof multer.MulterError) return next(badRequest(err.message));
      next(err);
    });

  r.get('/attachments', async (req, res) => {
    const entityType = queryString(req.query.entityType);
    const entityId = queryString(req.query.entityId);
    if (!entityType || !ENTITY_TYPES.includes(entityType as EntityType)) throw badRequest('entityType is required');
    const id = requireUuid(entityId, 'entityId');
    await resolveEntityWithAccess(pool, req.user!, entityType as EntityType, id);
    const { rows } = await pool.query(
      `SELECT ${ATTACHMENT_SELECT} ${ATTACHMENT_FROM} WHERE att.entity_type = $1 AND att.entity_id = $2 ORDER BY att.created_at DESC`,
      [entityType, id],
    );
    res.json(rows.map(PUBLIC_FIELDS));
  });

  r.post('/attachments', requirePermission('attachment.write'), uploadSingle, async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded (field "file")');
    const fields = parse(uploadFieldsSchema, req.body);
    const fileName = sanitizeFileName(req.file.originalname);
    const ext = path.extname(fileName).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) throw badRequest(`Files of type ${ext} are not allowed (executables, scripts and web pages are blocked).`);
    if (req.file.size === 0) throw badRequest('The file is empty');

    const ref = await resolveEntityWithAccess(pool, req.user!, fields.entityType, fields.entityId);
    const detected = detectFile(req.file.buffer, fileName);
    if (fields.isPlan && !PLAN_IMAGE_TYPES.includes(detected.contentType as never))
      throw badRequest('Only PNG, JPEG or WebP pictures can be used as a plan.');
    const category = fields.category ?? (fields.isPlan ? 'plan' : defaultCategory(detected, fileName));
    const id = crypto.randomUUID();
    const key = storageKey(ref.plantId, id, fileName);
    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    await storage.put(key, req.file.buffer, detected.contentType);
    try {
      await withTransaction(pool, async (db) => {
        await db.query(
          `INSERT INTO attachment (id, entity_type, entity_id, plant_id, file_name, content_type, size_bytes, sha256, storage_key, category,
             title, description, image_width, image_height, is_plan, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [id, fields.entityType, fields.entityId, ref.plantId, fileName, detected.contentType, req.file!.size, sha256, key, category,
            fields.title, fields.description, detected.width, detected.height, fields.isPlan, req.user!.id],
        );
        await audit(db, req, {
          action: 'attachment.add',
          entityType: fields.entityType,
          entityId: fields.entityId,
          entityLabel: ref.label,
          plantId: ref.plantId,
          changes: { file: fileName, size_bytes: req.file!.size, category, ...(fields.isPlan ? { plan: true } : {}) },
        });
      });
    } catch (err) {
      await purgeBlobs(pool, [key]);
      throw err;
    }
    res.status(201).json(PUBLIC_FIELDS(await loadAttachment(pool, id)));
  });

  r.get('/attachments/:id', async (req, res) => {
    const att = await loadAttachment(pool, requireUuid(req.params.id));
    await assertAccess(pool, req, att);
    res.json(PUBLIC_FIELDS(att));
  });

  r.get('/attachments/:id/file', async (req, res) => {
    const id = requireUuid(req.params.id);
    const { rows } = await pool.query('SELECT entity_type, entity_id, file_name, content_type, size_bytes, sha256, storage_key FROM attachment WHERE id = $1', [id]);
    const att = rows[0];
    if (!att) throw notFound('Attachment');
    await assertAccess(pool, req, att);

    const etag = `"${att.sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.get('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    let data: Buffer;
    try {
      data = await storage.get(att.storage_key);
    } catch (err) {
      if (err instanceof StorageNotFoundError) throw new HttpError(404, 'The file content is missing in the storage');
      throw err;
    }
    const inlineSafe = INLINE_SAFE_TYPES.includes(att.content_type) && req.query.download !== '1';
    const isPdf = att.content_type === 'application/pdf';
    res.setHeader('Content-Type', inlineSafe ? att.content_type : 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition(inlineSafe ? 'inline' : 'attachment', att.file_name));
    // PDFs need the browser's built-in viewer, which does not run inside a CSP sandbox; PDFs cannot run page scripts anyway.
    res.setHeader(
      'Content-Security-Policy',
      isPdf ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'" : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    );
    res.setHeader('Content-Length', String(data.length));
    res.end(data);
  });

  r.put('/attachments/:id', requirePermission('attachment.write'), async (req, res) => {
    const id = requireUuid(req.params.id);
    const input = parse(updateSchema, req.body);
    const before = await loadAttachment(pool, id);
    const ref = await assertAccess(pool, req, before);
    if (input.is_plan && !PLAN_IMAGE_TYPES.includes(before.content_type)) throw badRequest('Only PNG, JPEG or WebP pictures can be used as a plan.');
    await withTransaction(pool, async (db) => {
      await db.query('UPDATE attachment SET title=$2, description=$3, category=$4, is_plan=$5, updated_at=now() WHERE id=$1', [
        id, input.title, input.description, input.category, input.is_plan,
      ]);
      let removedMarkers = 0;
      if (before.is_plan && !input.is_plan) {
        const del = await db.query('DELETE FROM plan_marker WHERE attachment_id = $1', [id]);
        removedMarkers = del.rowCount ?? 0;
      }
      const changes: Record<string, unknown> = { file: before.file_name };
      for (const k of ['title', 'description', 'category', 'is_plan'] as const) {
        if ((before[k] ?? null) !== (input[k] ?? null)) changes[k] = { from: before[k] ?? null, to: input[k] ?? null };
      }
      if (removedMarkers) changes.plan_markers_removed = removedMarkers;
      if (Object.keys(changes).length > 1)
        await audit(db, req, { action: 'attachment.update', entityType: before.entity_type, entityId: before.entity_id, entityLabel: ref.label, plantId: ref.plantId, changes });
    });
    res.json(PUBLIC_FIELDS(await loadAttachment(pool, id)));
  });

  r.delete('/attachments/:id', async (req, res) => {
    const id = requireUuid(req.params.id);
    const att = await loadAttachment(pool, id);
    const ref = await assertAccess(pool, req, att);
    const user = req.user!;
    const mayDelete = can(user.role, 'asset.delete') || (att.created_by === user.id && can(user.role, 'attachment.write'));
    if (!mayDelete) throw forbidden('Only the uploader, editors or administrators can delete this file');
    const { rows } = await pool.query('SELECT storage_key FROM attachment WHERE id = $1', [id]);
    await withTransaction(pool, async (db) => {
      await db.query('DELETE FROM attachment WHERE id = $1', [id]);
      await audit(db, req, {
        action: 'attachment.delete',
        entityType: att.entity_type,
        entityId: att.entity_id,
        entityLabel: ref.label,
        plantId: ref.plantId,
        changes: { file: att.file_name, size_bytes: att.size_bytes, category: att.category },
      });
    });
    await purgeBlobs(pool, rows.map((x) => x.storage_key));
    log.debug('attachments: deleted', { id });
    res.status(204).end();
  });

  return r;
}
