import { Tag, Tooltip } from 'antd';
import {
  ACTIVITY_KIND_META,
  ACTIVITY_STATUS_META,
  ASSET_STATUS_META,
  ASSET_TYPES,
  CRITICALITY_META,
  ROLE_META,
  type ActivityKind,
  type ActivityStatus,
  type AssetStatus,
  type AssetType,
  type Criticality,
  type Role,
} from '../../../shared/model';
import { ASSET_TYPE_ICONS } from './icons';
import { daysUntil, fmtDate } from '../lib/format';

export const AssetStatusTag = ({ status }: { status: AssetStatus }) => (
  <Tag color={ASSET_STATUS_META[status]?.color}>{ASSET_STATUS_META[status]?.label ?? status}</Tag>
);

export const CriticalityTag = ({ value }: { value: Criticality }) => (
  <Tag color={CRITICALITY_META[value]?.color} variant="filled">
    {CRITICALITY_META[value]?.label ?? value}
  </Tag>
);

export const AssetTypeTag = ({ type, short }: { type: AssetType; short?: boolean }) => (
  <Tag icon={ASSET_TYPE_ICONS[type]} color={ASSET_TYPES[type].color} variant="solid">
    {short ? null : ` ${ASSET_TYPES[type].label}`}
  </Tag>
);

export const ActivityStatusTag = ({ status }: { status: ActivityStatus }) => (
  <Tag color={ACTIVITY_STATUS_META[status]?.color}>{ACTIVITY_STATUS_META[status]?.label ?? status}</Tag>
);

export const ActivityKindTag = ({ kind }: { kind: ActivityKind }) => (
  <Tag color={ACTIVITY_KIND_META[kind]?.color} variant="filled">
    {ACTIVITY_KIND_META[kind]?.label ?? kind}
  </Tag>
);

export const RoleTag = ({ role }: { role: Role }) => <Tag color={ROLE_META[role].color}>{ROLE_META[role].label}</Tag>;

/** Warranty end date coloured by urgency */
export function WarrantyDate({ value }: { value: string | null }) {
  const days = daysUntil(value);
  if (days === null) return <span className="muted">–</span>;
  const color = days < 0 ? '#cf1322' : days <= 90 ? '#d46b08' : undefined;
  const hint = days < 0 ? `expired ${-days} days ago` : `in ${days} days`;
  return (
    <Tooltip title={hint}>
      <span style={{ color, fontWeight: color ? 600 : undefined }}>{fmtDate(value)}</span>
    </Tooltip>
  );
}

export function DueDate({ value, status }: { value: string | null; status: ActivityStatus }) {
  const days = daysUntil(value);
  if (days === null) return <span className="muted">–</span>;
  const open = !['done', 'cancelled'].includes(status);
  const color = open && days < 0 ? '#cf1322' : open && days <= 7 ? '#d46b08' : undefined;
  return <span style={{ color, fontWeight: color ? 600 : undefined }}>{fmtDate(value)}</span>;
}
