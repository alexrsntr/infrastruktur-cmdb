// Attachments (files) and plan markers – shared between API and UI.
import type { AssetStatus, AssetType, EntityType } from './model';

export const ATTACHMENT_CATEGORIES = ['photo', 'plan', 'document', 'contract', 'config', 'other'] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];
export const ATTACHMENT_CATEGORY_META: Record<AttachmentCategory, { label: string; color: string }> = {
  photo: { label: 'Photo', color: 'cyan' },
  plan: { label: 'Plan / drawing', color: 'blue' },
  document: { label: 'Document', color: 'default' },
  contract: { label: 'Contract / warranty', color: 'gold' },
  config: { label: 'Configuration', color: 'purple' },
  other: { label: 'Other', color: 'default' },
};

/** Image types that can be shown inline and used as plans */
export const PLAN_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Types the server serves inline (everything else is forced to download) */
export const INLINE_SAFE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain'] as const;

export interface Attachment {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  entity_label?: string | null;
  plant_id: string | null;
  file_name: string;
  content_type: string;
  size_bytes: number;
  category: AttachmentCategory;
  title: string | null;
  description: string | null;
  image_width: number | null;
  image_height: number | null;
  is_plan: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  /** Only on plan listings */
  marker_count?: number;
}

export interface PlanMarker {
  id: string;
  attachment_id: string;
  asset_id: string | null;
  building_id: string | null;
  label: string | null;
  x: number;
  y: number;
  asset_name?: string | null;
  asset_type?: AssetType | null;
  asset_status?: AssetStatus | null;
  asset_ip?: string | null;
  asset_model?: string | null;
  building_name?: string | null;
  building_code?: string | null;
}

/** A plan image together with its markers */
export interface PlanDetail extends Attachment {
  markers: PlanMarker[];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
