// Small building blocks of the simple UI: stat tiles, status dots, device type icons.
import { Link } from 'react-router';
import { ASSET_STATUS_META, ASSET_TYPES, type AssetStatus, type AssetType } from '../../../shared/model';
import { C } from '../theme';
import { ASSET_TYPE_ICONS } from './icons';
import { tintBg, tintFg } from '../lib/palette';

export function StatTile({
  icon,
  value,
  label,
  color = C.primary,
  to,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: React.ReactNode;
  color?: string;
  to?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      <span className="stat-icon" style={{ background: tintBg(color), color: tintFg(color) }}>
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </span>
    </>
  );
  if (to)
    return (
      <Link to={to} className={`stat-tile${active ? ' active' : ''}`}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={`stat-tile${active ? ' active' : ''}`}>
        {body}
      </button>
    );
  return <div className="stat-tile">{body}</div>;
}

export const STATUS_COLOR: Record<AssetStatus, string> = {
  active: C.ok,
  planned: C.info,
  maintenance: C.warn,
  defective: C.bad,
  retired: C.idle,
};

/** Coloured dot + word – readable without relying on colour alone */
export function StatusDot({ status }: { status: AssetStatus }) {
  return (
    <span className="status-dot" style={{ ['--dot' as string]: STATUS_COLOR[status] }}>
      {ASSET_STATUS_META[status]?.label ?? status}
    </span>
  );
}

export function TypeIcon({ type, large }: { type: AssetType; large?: boolean }) {
  return (
    <span className={`type-icon${large ? ' lg' : ''}`} style={{ background: ASSET_TYPES[type].color }} title={ASSET_TYPES[type].label}>
      {ASSET_TYPE_ICONS[type]}
    </span>
  );
}
