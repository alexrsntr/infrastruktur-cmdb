import { useLocation, useParams } from 'react-router';
import { Card } from 'antd';
import { AppstoreOutlined } from '@ant-design/icons';
import { ASSET_TYPES, assetTypeBySlug, type AssetType } from '../../../shared/model';
import { PageHeader } from '../components/PageHeader';
import { AssetTable } from '../components/AssetTable';
import { StatTile } from '../components/Simple';
import { ASSET_TYPE_ICONS } from '../components/icons';
import { useAssetTypes, useDashboard } from '../lib/queries';
import { NotFoundPage } from './NotFoundPage';

export function AssetsPage() {
  const { typeSlug } = useParams();
  const location = useLocation();
  const type = assetTypeBySlug(typeSlug);
  const dashboard = useDashboard();
  const types = useAssetTypes();
  if (typeSlug && !type) return <NotFoundPage />;

  const counts = Object.fromEntries((dashboard.data?.byType ?? []).map((t) => [t.type, t.count])) as Record<string, number>;
  const total = dashboard.data?.totals.assets;
  // keep plant/search filters when switching the type tile
  const keep = new URLSearchParams(location.search);
  keep.delete('page');
  keep.delete('type');
  const qs = keep.toString() ? `?${keep.toString()}` : '';

  return (
    <div>
      <PageHeader
        title={type ? ASSET_TYPES[type].plural : 'Devices'}
        subtitle="All network, server, power, production and other devices of your plants. Click a device to see its details and activity log."
      />
      <div className="tile-grid" style={{ marginBottom: 20 }}>
        <StatTile to={`/inventory${qs}`} active={!type} icon={<AppstoreOutlined />} value={total ?? '–'} label="All devices" />
        {[...types.shown(counts as Partial<Record<AssetType, number>>), ...(type && !types.shown(counts as Partial<Record<AssetType, number>>).includes(type) ? [type] : [])].map((t) => (
          <StatTile
            key={t}
            to={`/inventory/${ASSET_TYPES[t].slug}${qs}`}
            active={type === t}
            icon={ASSET_TYPE_ICONS[t]}
            color={ASSET_TYPES[t].color}
            value={counts[t] ?? (dashboard.data ? 0 : '–')}
            label={ASSET_TYPES[t].plural}
          />
        ))}
      </div>
      <Card>
        <AssetTable key={type ?? 'all'} fixed={type ? { type } : {}} syncUrl />
      </Card>
    </div>
  );
}
