import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { AutoComplete, Input, Space, Typography } from 'antd';
import { BankOutlined, ClusterOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult } from '../../../shared/model';
import { http } from '../lib/api';
import { AssetTypeTag } from './Tags';

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const routeFor = (r: SearchResult) => (r.kind === 'plant' ? `/plants/${r.id}` : r.kind === 'building' ? `/buildings/${r.id}` : `/assets/${r.id}`);

export function GlobalSearch() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim());
  const { data = [] } = useQuery({
    queryKey: ['search', q],
    queryFn: () => http.get<SearchResult[]>('/api/search', { q }),
    enabled: q.length >= 2,
  });

  const group = (kind: SearchResult['kind'], label: string) => {
    const rows = data.filter((r) => r.kind === kind);
    if (!rows.length) return null;
    return {
      label: <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase' }}>{label}</Typography.Text>,
      options: rows.map((r) => ({
        value: `${r.kind}:${r.id}`,
        label: (
          <Space size={8}>
            {r.kind === 'asset' && r.assetType ? <AssetTypeTag type={r.assetType} short /> : r.kind === 'plant' ? <BankOutlined /> : <ClusterOutlined />}
            <span>
              <strong>{r.title}</strong>
              {r.subtitle && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{r.subtitle}</span>}
            </span>
          </Space>
        ),
      })),
    };
  };

  const options = [group('asset', 'Assets'), group('plant', 'Plants'), group('building', 'Buildings')].filter(Boolean) as { label: React.ReactNode; options: { value: string; label: React.ReactNode }[] }[];

  return (
    <AutoComplete
      value={text}
      options={options}
      style={{ width: '100%', maxWidth: 560 }}
      onChange={setText}
      onSelect={(value: string) => {
        const [kind, id] = value.split(':');
        const r = data.find((x) => x.kind === kind && x.id === id);
        setText('');
        if (r) navigate(routeFor(r));
      }}
      popupMatchSelectWidth={560}
    >
      <Input
        prefix={<SearchOutlined className="muted" />}
        placeholder="Search devices, IP, serial number, plant…"
        allowClear
        onPressEnter={() => {
          if (text.trim().length >= 2) {
            navigate(`/inventory?q=${encodeURIComponent(text.trim())}`);
            setText('');
          }
        }}
        style={{ background: 'var(--cmdb-surface)' }}
      />
    </AutoComplete>
  );
}
