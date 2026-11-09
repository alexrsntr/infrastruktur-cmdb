import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Skeleton, Tag } from 'antd';
import { CRITICALITY_META, RELATION_TYPES } from '../../../shared/model';
import type { ImpactResult } from '../../../shared/applications';
import { http } from '../lib/api';
import { TypeIcon } from './Simple';

/** "If this device fails": devices and applications that depend on it (directly or indirectly). */
export function ImpactCard({ assetId, assetName }: { assetId: string; assetName: string }) {
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['impact', assetId], queryFn: () => http.get<ImpactResult>(`/api/assets/${assetId}/impact`) });
  const data = q.data;
  const shown = all ? data?.affected : data?.affected.slice(0, 8);
  return (
    <Card title="If this device fails">
      {!data ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : !data.affected.length && !data.applications.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing documented depends on this device." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {data.redundant.length > 0 && (
            <Alert
              type="info"
              showIcon
              message={
                <span>
                  Redundant with{' '}
                  {data.redundant.map((r, i) => (
                    <span key={r.id}>
                      {i > 0 && ', '}
                      <Link to={`/assets/${r.id}`}>{r.name}</Link>
                    </span>
                  ))}{' '}
                  – the real impact may be lower.
                </span>
              }
            />
          )}
          {data.applications.length > 0 && (
            <div>
              <div className="muted" style={{ marginBottom: 6 }}>
                Applications affected ({data.applications.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {data.applications.map((a) => (
                  <Link key={a.id} to={`/applications/${a.id}`}>
                    <Tag color={CRITICALITY_META[a.criticality].color} style={{ cursor: 'pointer', marginInlineEnd: 0 }}>
                      {a.name}
                    </Tag>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {data.affected.length > 0 && (
            <div>
              <div className="muted" style={{ marginBottom: 6 }}>
                Devices affected ({data.affected.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {shown!.map((d) => (
                  <div key={d.id} style={{ display: 'flex', gap: 10, alignItems: 'center', paddingLeft: Math.min(d.depth - 1, 4) * 14 }}>
                    <TypeIcon type={d.type} />
                    <div style={{ minWidth: 0 }}>
                      <Link to={`/assets/${d.id}`} style={{ fontWeight: 600 }}>
                        {d.name}
                      </Link>
                      <div className="muted" style={{ fontSize: 12.5 }}>
                        {RELATION_TYPES[d.relation].label} {d.via_name === assetName ? 'this device' : d.via_name}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {data.affected.length > 8 && (
                <Button type="link" style={{ paddingLeft: 0 }} onClick={() => setAll(!all)}>
                  {all ? 'Show less' : `Show all ${data.affected.length}`}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
