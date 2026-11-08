import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button, Card, Col, Empty, Input, Progress, Row, Select, Table } from 'antd';
import { AppstoreOutlined, DatabaseOutlined, FileExcelOutlined, HddOutlined, SearchOutlined, VerticalAlignMiddleOutlined } from '@ant-design/icons';
import type { Rack } from '../../../shared/model';
import { PageHeader } from '../components/PageHeader';
import { download, exportUrl, MoreMenu } from '../components/PageParts';
import { StatTile } from '../components/Simple';
import { usePlants, useRacks } from '../lib/queries';
import { useSession } from '../lib/session';

export function RacksPage() {
  const { can } = useSession();
  const navigate = useNavigate();
  const plants = usePlants();
  const [params, setParams] = useSearchParams();
  const plantId = params.get('plantId') ?? undefined;
  const [q, setQ] = useState('');
  const racks = useRacks({ plantId });

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (racks.data ?? []).filter((r) => !s || [r.name, r.room, r.building_name, r.plant_code, r.model].some((v) => v?.toLowerCase().includes(s)));
  }, [racks.data, q]);

  const totals = useMemo(() => {
    const all = racks.data ?? [];
    return {
      racks: all.length,
      free: all.reduce((sum, r) => sum + (r.height_u - Number(r.used_u ?? 0)), 0),
      devices: all.reduce((sum, r) => sum + Number(r.asset_count ?? 0), 0),
    };
  }, [racks.data]);

  const setPlant = (v?: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('plantId', v);
    else next.delete('plantId');
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader
        title="Racks"
        subtitle="All racks and wall cabinets with their free space. Open a rack to see its front view and mount devices."
        extra={
          <>
            <Button size="large" icon={<DatabaseOutlined />} onClick={() => navigate(plantId ? `/datacenters?plantId=${plantId}` : '/datacenters')}>
              Data centers
            </Button>
            <MoreMenu
              items={[
                { key: 'racks', icon: <FileExcelOutlined />, label: 'Export rack list (Excel)', onClick: () => download(exportUrl('racks', 'xlsx', { plantId })), hidden: !can('export') },
                { key: 'contents', icon: <FileExcelOutlined />, label: 'Export rack contents (Excel)', onClick: () => download(exportUrl('rack-contents', 'xlsx', { plantId })), hidden: !can('export') },
              ]}
            />
          </>
        }
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={8}>
          <StatTile icon={<HddOutlined />} value={racks.isLoading ? '–' : totals.racks} label="Racks" color="#3d4652" />
        </Col>
        <Col xs={12} sm={8}>
          <StatTile icon={<VerticalAlignMiddleOutlined />} value={racks.isLoading ? '–' : `${totals.free} U`} label="Free space" color="#1e9e5a" />
        </Col>
        <Col xs={12} sm={8}>
          <StatTile icon={<AppstoreOutlined />} value={racks.isLoading ? '–' : totals.devices} label="Devices in racks" color="#6b35b5" />
        </Col>
      </Row>

      <Card>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <Input
            allowClear
            size="large"
            prefix={<SearchOutlined className="muted" />}
            placeholder="Find a rack, room or building"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: 380 }}
          />
          <Select
            allowClear
            showSearch
            size="large"
            optionFilterProp="label"
            placeholder="All plants"
            style={{ width: 240 }}
            value={plantId}
            onChange={setPlant}
            options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
          />
        </div>
        <Table<Rack>
          rowKey="id"
          className="clickable-rows"
          loading={racks.isLoading}
          dataSource={rows}
          pagination={{ pageSize: 25, hideOnSinglePage: true }}
          scroll={{ x: 760 }}
          onRow={(r) => ({ onClick: () => navigate(`/racks/${r.id}`) })}
          locale={{ emptyText: <Empty description={q ? 'No rack matches your search.' : 'No racks yet. Open a building and click “New rack”.'} /> }}
          columns={[
            {
              title: 'Rack',
              dataIndex: 'name',
              sorter: (a, b) => a.name.localeCompare(b.name),
              render: (_, r) => (
                <div>
                  <Link to={`/racks/${r.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 700, fontSize: 15.5 }}>
                    {r.name}
                  </Link>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {r.height_u} U{r.room ? ` · ${r.room}` : ''}
                  </div>
                </div>
              ),
            },
            {
              title: 'Where',
              key: 'where',
              render: (_, r) => (
                <div>
                  <div>{r.building_name}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {r.plant_code} – {r.plant_name}
                  </div>
                </div>
              ),
            },
            {
              title: 'Free space',
              key: 'usage',
              width: 260,
              sorter: (a, b) => Number(a.used_u) / a.height_u - Number(b.used_u) / b.height_u,
              render: (_, r) => {
                const used = Number(r.used_u ?? 0);
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Progress percent={Math.round((used / r.height_u) * 100)} showInfo={false} strokeWidth={10} style={{ flex: 1, margin: 0 }} status={r.height_u - used <= 2 ? 'exception' : 'normal'} />
                    <span style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{r.height_u - used} U</span>
                  </div>
                );
              },
            },
            { title: 'Devices', dataIndex: 'asset_count', width: 110, align: 'right', sorter: (a, b) => Number(a.asset_count) - Number(b.asset_count) },
          ]}
        />
      </Card>
    </div>
  );
}
