import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Skeleton, Tag, Tooltip } from 'antd';
import { ATTENTION_KINDS, ATTENTION_META, type AttentionData, type AttentionItem, type AttentionKind } from '../../../shared/model';
import { http } from '../lib/api';
import { daysUntil, fmtDate, fromNow } from '../lib/format';
import { TypeIcon } from './Simple';

export const useAttention = (plantId?: string, limit = 6) =>
  useQuery({ queryKey: ['attention', plantId ?? '', limit], queryFn: () => http.get<AttentionData>('/api/attention', { plantId, limit }) });

/** Link to the device list filtered by one or all "Needs attention" reasons */
export function attentionLink(kinds: AttentionKind[] = [...ATTENTION_KINDS], plantId?: string): string {
  const q = new URLSearchParams({ attention: kinds.join(',') });
  if (plantId) q.set('plantId', plantId);
  return `/inventory?${q.toString()}`;
}

function reason(item: AttentionItem, kind: AttentionKind): string {
  const when = (date: string | null, past: string, future: string) => {
    const d = daysUntil(date);
    return d !== null && d < 0 ? `${past} ${fmtDate(date)}` : `${future} ${fmtDate(date)}`;
  };
  switch (kind) {
    case 'warranty_expiring':
    case 'warranty_expired':
      return when(item.warranty_end, 'Warranty ended', 'Warranty ends');
    case 'support_ending':
    case 'support_ended':
      return when(item.support_end, 'Support ended', 'Support ends');
    case 'eol':
      return when(item.end_of_life, 'End of life since', 'End of life');
    case 'not_seen':
      return `Last seen ${fromNow(item.last_seen_at)}`;
  }
}

/** Counts per reason as clickable tags plus the most urgent devices */
export function AttentionList({ plantId, limit = 6 }: { plantId?: string; limit?: number }) {
  const { data, isLoading } = useAttention(plantId, limit);
  if (isLoading || !data) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (!data.total) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {ATTENTION_KINDS.filter((k) => data.counts[k]).map((k) => (
          <Tooltip key={k} title={ATTENTION_META[k].description}>
            <Link to={attentionLink([k], plantId)}>
              <Tag color={ATTENTION_META[k].color} style={{ cursor: 'pointer', marginInlineEnd: 0 }}>
                {ATTENTION_META[k].label}: {data.counts[k]}
              </Tag>
            </Link>
          </Tooltip>
        ))}
      </div>
      {data.items.map((item) => (
        <div key={item.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <TypeIcon type={item.type} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <Link to={`/assets/${item.id}`} style={{ fontWeight: 600 }}>
              {item.name}
            </Link>
            <div className="muted" style={{ fontSize: 13.5 }}>
              {[...new Set(item.kinds.map((k) => reason(item, k)))].join(' · ')}
              {item.plant_code ? ` · ${item.plant_code}` : ''}
            </div>
          </div>
        </div>
      ))}
      {data.total > data.items.length && (
        <Link to={attentionLink(undefined, plantId)} style={{ fontSize: 13.5 }}>
          Show all {data.total} devices
        </Link>
      )}
    </div>
  );
}
