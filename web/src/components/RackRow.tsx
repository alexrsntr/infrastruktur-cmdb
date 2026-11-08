import { Link } from 'react-router';
import { Empty, Progress, Skeleton, Typography } from 'antd';
import type { RackDetail } from '../../../shared/model';
import { RackElevation } from './RackElevation';

/** Compact elevations of several racks side by side, like walking along a row in the server room. */
export function RackRow({ racks, loading }: { racks: RackDetail[] | undefined; loading?: boolean }) {
  if (loading) return <Skeleton active />;
  if (!racks?.length) return <Empty description="No racks in this building yet. Click “New rack” to add the first one." />;
  return (
    <div style={{ display: 'flex', gap: 18, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
      {racks.map((r) => {
        const used = Number(r.used_u ?? 0);
        return (
          <Link key={r.id} to={`/racks/${r.id}`} style={{ color: 'inherit', flex: '0 0 auto' }}>
            <div className="rack-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <Typography.Text strong style={{ fontSize: 17 }}>
                  {r.name}
                </Typography.Text>
                <Typography.Text type="secondary">{r.height_u} U</Typography.Text>
              </div>
              <Typography.Text type="secondary" style={{ display: 'block', minHeight: 22 }} ellipsis>
                {[...new Set([r.floor_name, r.room].filter(Boolean))].join(' · ') || ' '}
              </Typography.Text>
              <Progress percent={Math.round((used / r.height_u) * 100)} showInfo={false} strokeWidth={8} status={r.height_u - used <= 2 ? 'exception' : 'normal'} />
              <div style={{ color: '#4a5a6c', marginBottom: 10 }}>
                <strong>{r.height_u - used} U</strong> free · <strong>{r.assets.length}</strong> devices
              </div>
              <RackElevation rack={r} assets={r.assets} items={r.items} unitHeight={r.height_u > 30 ? 9 : 12} compact width={206} />
            </div>
          </Link>
        );
      })}
      <style>{`.rack-card { width: 236px; padding: 16px; border: 1px solid #dfe4ea; border-radius: 12px; background: #fff; transition: box-shadow .15s, border-color .15s; }
        .rack-card:hover { border-color: #8fb6e0; box-shadow: 0 4px 14px rgba(0, 50, 100, .1); }`}</style>
    </div>
  );
}
