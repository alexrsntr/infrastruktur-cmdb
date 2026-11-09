import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Card, Col, Empty, Input, Row, Segmented, Skeleton, Typography } from 'antd';
import { AppstoreOutlined, BankOutlined, ClusterOutlined, EnvironmentOutlined, FileExcelOutlined, GlobalOutlined, PlusOutlined, ScheduleOutlined, SearchOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { ASSET_TYPES, ASSET_TYPE_KEYS, type Plant } from '../../../shared/model';
import { PlantFormModal } from '../components/LocationForms';
import { PageHeader } from '../components/PageHeader';
import { download, exportUrl, MoreMenu } from '../components/PageParts';
import { StatTile } from '../components/Simple';
import { WorldMap } from '../components/WorldMap';
import { useDashboard, usePlants } from '../lib/queries';
import { useSession } from '../lib/session';
import { tintBg, tintFg } from '../lib/palette';

function PlantCard({ p, onOpen }: { p: Plant; onOpen: () => void }) {
  return (
    <Card hoverable onClick={onOpen} styles={{ body: { padding: 22 } }} style={{ height: '100%' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14 }}>
        <span className="stat-icon" style={{ background: tintBg('#2563eb'), color: tintFg('#2563eb'), fontSize: 15, fontWeight: 800, width: 56 }}>
          {p.code}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.25 }}>{p.name}</div>
          <Typography.Text type="secondary">
            <EnvironmentOutlined /> {[p.city, p.country].filter(Boolean).join(', ') || 'No address yet'}
          </Typography.Text>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 16px' }}>
        {ASSET_TYPE_KEYS.filter((t) => (p.asset_counts?.[t] ?? 0) > 0).map((t) => (
          <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: ASSET_TYPES[t].color, flex: 'none' }} />
            <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{p.asset_counts?.[t] ?? 0}</span>
            <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ASSET_TYPES[t].plural}
            </span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--cmdb-border-soft)', display: 'flex', justifyContent: 'space-between', color: 'var(--cmdb-text-2)' }}>
        <span>
          <ClusterOutlined /> {p.building_count ?? 0} building{p.building_count === 1 ? '' : 's'}
        </span>
        <span style={{ fontWeight: 600 }}>{p.asset_count ?? 0} devices</span>
      </div>
    </Card>
  );
}

export function PlantsPage() {
  const { can, scoped } = useSession();
  const plants = usePlants();
  const dashboard = useDashboard();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<'cards' | 'map'>('cards');
  const [filter, setFilter] = useState('');

  const q = filter.trim().toLowerCase();
  const rows = (plants.data ?? []).filter((p) => !q || [p.code, p.name, p.city, p.country].some((v) => v?.toLowerCase().includes(q)));
  const totals = dashboard.data?.totals;

  return (
    <div>
      <PageHeader
        title="Plants"
        subtitle="Choose a plant to see its buildings, racks and devices."
        extra={
          <>
            {can('location.write') && !scoped && (
              <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                Add plant
              </Button>
            )}
            <MoreMenu
              items={[
                { key: 'xlsx', icon: <FileExcelOutlined />, label: 'Export plants (Excel)', onClick: () => download(exportUrl('plants', 'xlsx')), hidden: !can('export') },
                { key: 'csv', icon: <UnorderedListOutlined />, label: 'Export plants (CSV)', onClick: () => download(exportUrl('plants', 'csv')), hidden: !can('export') },
                { key: 'map', icon: <GlobalOutlined />, label: 'Open full-screen map', onClick: () => navigate('/map') },
              ]}
            />
          </>
        }
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} lg={6}>
          <StatTile icon={<BankOutlined />} value={totals?.plants ?? '–'} label="Plants" />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile icon={<ClusterOutlined />} value={totals?.buildings ?? '–'} label="Buildings" color="#127a7a" />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile icon={<AppstoreOutlined />} value={totals?.assets ?? '–'} label="Devices" color="#6b35b5" to="/inventory" />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile icon={<ScheduleOutlined />} value={totals?.openActivities ?? '–'} label="Open activities" color="#b26a00" to="/activities" />
        </Col>
      </Row>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <Input
          allowClear
          size="large"
          prefix={<SearchOutlined className="muted" />}
          placeholder="Find a plant by name, code or city"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ maxWidth: 420 }}
        />
        <div style={{ flex: 1 }} />
        <Segmented
          size="large"
          value={view}
          onChange={(v) => setView(v as 'cards' | 'map')}
          options={[
            { value: 'cards', label: 'Cards', icon: <AppstoreOutlined /> },
            { value: 'map', label: 'Map', icon: <GlobalOutlined /> },
          ]}
        />
      </div>

      {plants.isLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : view === 'map' ? (
        <Card styles={{ body: { padding: 0 } }}>
          <WorldMap plants={rows} height="calc(100vh - 420px)" />
        </Card>
      ) : rows.length ? (
        <Row gutter={[16, 16]}>
          {rows.map((p) => (
            <Col key={p.id} xs={24} md={12} xl={8}>
              <PlantCard p={p} onOpen={() => navigate(`/plants/${p.id}`)} />
            </Col>
          ))}
        </Row>
      ) : (
        <Card>
          <Empty description={q ? 'No plant matches your search.' : 'No plants yet. Add your first plant to start documenting buildings and devices.'}>
            {!q && can('location.write') && !scoped && (
              <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                Add plant
              </Button>
            )}
          </Empty>
        </Card>
      )}

      <PlantFormModal open={creating} onClose={() => setCreating(false)} onSaved={(p) => navigate(`/plants/${p.id}`)} />
    </div>
  );
}
