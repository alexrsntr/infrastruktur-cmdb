import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { App, Button, Card, Col, Empty, Popconfirm, Progress, Result, Row, Skeleton, Space, Table, Tabs, Tag, Typography } from 'antd';
import { CodeOutlined, DeleteOutlined, DisconnectOutlined, DragOutlined, EditOutlined, FileExcelOutlined, HddOutlined, PlusOutlined } from '@ant-design/icons';
import { RACK_ITEM_KIND_META, formatRackUnits, type RackAsset, type RackItem } from '../../../shared/model';
import { ApiError, errorText, http } from '../lib/api';
import { dash } from '../lib/format';
import { useInvalidate, useRack } from '../lib/queries';
import { useSession } from '../lib/session';
import { PageHeader } from '../components/PageHeader';
import { AboutCard, download, exportUrl, MoreMenu } from '../components/PageParts';
import { journalTabs } from '../components/Journal';
import { RackElevation, RackLegend, type RackSelection } from '../components/RackElevation';
import { MountModal, RackFormModal } from '../components/RackForms';
import { StatusDot, TypeIcon } from '../components/Simple';

interface ContentRow {
  key: string;
  kind: 'asset' | 'item';
  u: number | null;
  height: number;
  label: string;
  asset?: RackAsset;
  item?: RackItem;
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid #f0f2f5' }}>
      <span className="muted" style={{ width: 90, flex: 'none' }}>
        {label}
      </span>
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{children}</span>
    </div>
  );
}

export function RackPage() {
  const { rackId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const rack = useRack(rackId);
  const [selected, setSelected] = useState<RackSelection>(null);
  const [editingRack, setEditingRack] = useState(false);
  const [mount, setMount] = useState<{ open: boolean; u?: number | null; asset?: RackAsset | null; item?: RackItem | null; mode?: 'device' | 'item' }>({ open: false });

  const r = rack.data;
  const rows: ContentRow[] = useMemo(() => {
    if (!r) return [];
    return [
      ...r.assets.map((a) => ({ key: `a:${a.id}`, kind: 'asset' as const, u: a.rack_u, height: a.rack_height_u, label: a.name, asset: a })),
      ...r.items.map((i) => ({ key: `i:${i.id}`, kind: 'item' as const, u: i.position_u, height: i.height_u, label: i.label, item: i })),
    ].sort((a, b) => (b.u ?? -1) - (a.u ?? -1));
  }, [r]);

  if (rack.isLoading) return <Skeleton active paragraph={{ rows: 14 }} />;
  if (rack.error || !r) {
    const status = rack.error instanceof ApiError ? rack.error.status : 500;
    return <Result status={status === 403 ? '403' : status === 404 ? '404' : 'error'} title={status === 404 ? 'Rack not found' : 'Could not load rack'} subTitle={errorText(rack.error)} extra={<Link to="/racks">Back to racks</Link>} />;
  }

  const canMount = can('asset.write');
  const canEquip = can('location.write');
  const used = Number(r.used_u ?? 0);
  const free = r.height_u - used;
  const tab = params.get('tab') ?? 'contents';
  const unitLabel = (u: number | null, h: number) => {
    if (!u) return 'not positioned';
    if (r.numbering === 'top_down') return formatRackUnits(r.height_u - (u + h - 1) + 1, h);
    return formatRackUnits(u, h);
  };

  const selAsset = selected?.kind === 'asset' ? r.assets.find((a) => a.id === selected.id) : undefined;
  const selItem = selected?.kind === 'item' ? r.items.find((i) => i.id === selected.id) : undefined;

  const unmount = async (a: RackAsset) => {
    try {
      await http.patch(`/api/assets/${a.id}/rack`, { rack_id: null, rack_u: null, rack_height_u: 1 });
      message.success(`${a.name} removed from the rack`);
      setSelected(null);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const removeItem = async (i: RackItem) => {
    try {
      await http.del(`/api/rack-items/${i.id}`);
      setSelected(null);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const removeRack = async () => {
    try {
      await http.del(`/api/racks/${r.id}`);
      message.success(`Rack ${r.name} deleted`);
      await invalidate();
      navigate(`/buildings/${r.building_id}?tab=racks`);
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const selectionCard = (
    <Card title={selAsset ? 'Selected device' : selItem ? 'Selected equipment' : 'Selection'}>
      {selAsset ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <TypeIcon type={selAsset.type} />
            <div style={{ minWidth: 0 }}>
              <Link to={`/assets/${selAsset.id}`} style={{ fontWeight: 700, fontSize: 17 }}>
                {selAsset.name}
              </Link>
              <div>
                <StatusDot status={selAsset.status} />
              </div>
            </div>
          </div>
          <InfoRow label="Units">
            U{unitLabel(selAsset.rack_u, selAsset.rack_height_u)} ({selAsset.rack_height_u} U)
          </InfoRow>
          <InfoRow label="Model">{[selAsset.manufacturer, selAsset.model].filter(Boolean).join(' ') || '–'}</InfoRow>
          <InfoRow label="Serial">{dash(selAsset.serial_number)}</InfoRow>
          <InfoRow label="IP">{dash(selAsset.ip_address)}</InfoRow>
          {canMount && (
            <Space wrap style={{ marginTop: 14 }}>
              <Button icon={<DragOutlined />} onClick={() => setMount({ open: true, asset: selAsset })}>
                Move
              </Button>
              <Popconfirm title={`Remove ${selAsset.name} from the rack?`} description="The device stays in the CMDB." onConfirm={() => unmount(selAsset)}>
                <Button icon={<DisconnectOutlined />}>Unmount</Button>
              </Popconfirm>
            </Space>
          )}
        </div>
      ) : selItem ? (
        <div>
          <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 8 }}>{selItem.label}</div>
          <InfoRow label="Kind">{RACK_ITEM_KIND_META[selItem.kind].label}</InfoRow>
          <InfoRow label="Units">
            U{unitLabel(selItem.position_u, selItem.height_u)} ({selItem.height_u} U)
          </InfoRow>
          <InfoRow label="Note">{dash(selItem.note)}</InfoRow>
          {canEquip && (
            <Space wrap style={{ marginTop: 14 }}>
              <Button icon={<EditOutlined />} onClick={() => setMount({ open: true, item: selItem })}>
                Edit
              </Button>
              <Popconfirm title={`Remove ${selItem.label}?`} onConfirm={() => removeItem(selItem)} okButtonProps={{ danger: true }}>
                <Button danger icon={<DeleteOutlined />}>
                  Remove
                </Button>
              </Popconfirm>
            </Space>
          )}
        </div>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 15 }}>
          Click a device or a panel in the rack to see it here.{canMount ? ' Click a free unit to mount something there.' : ''}
        </Typography.Text>
      )}
    </Card>
  );

  const contents = (
    <Table<ContentRow>
      rowKey="key"
      className="clickable-rows"
      dataSource={rows}
      pagination={false}
      scroll={{ x: 620 }}
      locale={{
        emptyText: (
          <Empty description="The rack is empty. Click “Mount device” or a free unit in the front view.">
            {canMount && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setMount({ open: true, mode: 'device' })}>
                Mount device
              </Button>
            )}
          </Empty>
        ),
      }}
      onRow={(row) => ({ onClick: () => setSelected({ kind: row.kind, id: row.asset?.id ?? row.item!.id }) })}
      rowClassName={(row) => ((row.asset && selected?.id === row.asset.id) || (row.item && selected?.id === row.item.id) ? 'ant-table-row-selected' : '')}
      columns={[
        { title: 'Units', key: 'u', width: 110, render: (_, row) => (row.u ? <span className="mono">U{unitLabel(row.u, row.height)}</span> : <Tag color="warning">no position</Tag>) },
        {
          title: 'Name',
          key: 'label',
          ellipsis: true,
          render: (_, row) =>
            row.asset ? (
              <Space size={10}>
                <TypeIcon type={row.asset.type} />
                <Link to={`/assets/${row.asset.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>
                  {row.label}
                </Link>
              </Space>
            ) : (
              <span>
                {row.label} <span className="muted">· {RACK_ITEM_KIND_META[row.item!.kind].label}</span>
              </span>
            ),
        },
        { title: 'Status', key: 'status', width: 150, render: (_, row) => (row.asset ? <StatusDot status={row.asset.status} /> : null) },
        { title: 'IP address', key: 'ip', width: 150, render: (_, row) => <span className="mono">{row.asset?.ip_address ?? ''}</span> },
      ]}
    />
  );

  return (
    <div>
      <PageHeader
        crumbs={[
          { title: 'Plants', to: '/plants' },
          { title: r.plant_code, to: `/plants/${r.plant_id}` },
          { title: r.building_name, to: `/buildings/${r.building_id}?tab=racks` },
          { title: r.name },
        ]}
        title={`Rack ${r.name}`}
        icon={
          <span className="stat-icon" style={{ background: '#3d465218', color: '#3d4652', width: 60, height: 60, fontSize: 28 }}>
            <HddOutlined />
          </span>
        }
        tags={<Tag color={free <= 2 ? 'red' : free <= 6 ? 'orange' : 'green'}>{free} U free</Tag>}
        subtitle={[...new Set([r.building_name, r.floor_name, r.room, `${r.height_u} U`].filter(Boolean))].join(' · ')}
        extra={
          <>
            {canMount && (
              <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setMount({ open: true, mode: 'device' })}>
                Mount device
              </Button>
            )}
            <MoreMenu
              items={[
                { key: 'equip', icon: <PlusOutlined />, label: 'Add patch panel / UPS / shelf', onClick: () => setMount({ open: true, mode: 'item' }), hidden: !canEquip },
                { key: 'edit', icon: <EditOutlined />, label: 'Edit rack', onClick: () => setEditingRack(true), hidden: !canEquip },
                { key: 'xlsx', icon: <FileExcelOutlined />, label: 'Export rack (Excel)', onClick: () => download(exportUrl(`rack/${r.id}`, 'xlsx')), hidden: !can('export'), divider: true },
                { key: 'json', icon: <CodeOutlined />, label: 'Export rack (JSON)', onClick: () => download(exportUrl(`rack/${r.id}`, 'json')), hidden: !can('export') },
                {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  label: 'Delete rack',
                  danger: true,
                  divider: true,
                  hidden: !canEquip,
                  onClick: removeRack,
                  confirm: { title: `Delete rack ${r.name}?`, content: 'Devices stay in the CMDB and are only removed from the rack.' },
                },
              ]}
            />
          </>
        }
      />

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={10} xl={8}>
          <Card title="Front view" extra={<Typography.Text type="secondary">{r.numbering === 'top_down' ? 'U1 at the top' : 'U1 at the bottom'}</Typography.Text>}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <RackElevation
                rack={r}
                assets={r.assets}
                items={r.items}
                unitHeight={r.height_u > 30 ? 21 : 26}
                selected={selected}
                onSelect={setSelected}
                onEmptyClick={canMount || canEquip ? (u) => setMount({ open: true, u, mode: canMount ? 'device' : 'item' }) : undefined}
                width={400}
              />
            </div>
            <div style={{ marginTop: 14 }}>
              <RackLegend />
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={14} xl={16}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <Row gutter={[24, 24]}>
              <Col xs={24} md={14}>
                {selectionCard}
              </Col>
              <Col xs={24} md={10}>
                <Card title="Capacity">
                  <Progress percent={Math.round((used / r.height_u) * 100)} status={free <= 2 ? 'exception' : 'normal'} strokeWidth={12} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 15 }}>
                    <span>
                      <strong>{used} U</strong> used
                    </span>
                    <span>
                      <strong>{free} U</strong> free
                    </span>
                    <span>
                      <strong>{r.assets.length}</strong> devices
                    </span>
                  </div>
                </Card>
              </Col>
            </Row>
            <Card styles={{ body: { paddingTop: 4 } }}>
              <Tabs
                activeKey={tab}
                onChange={(key) => {
                  const next = new URLSearchParams(params);
                  if (key === 'contents') next.delete('tab');
                  else next.set('tab', key);
                  setParams(next, { replace: true });
                }}
                items={[
                  { key: 'contents', label: `Contents (${rows.length})`, children: contents },
                  {
                    key: 'about',
                    label: 'About',
                    children: (
                      <AboutCard
                        title={null}
                        rows={[
                          ['Plant', <Link to={`/plants/${r.plant_id}`}>{r.plant_code} – {r.plant_name}</Link>],
                          ['Building', <Link to={`/buildings/${r.building_id}`}>{r.building_name}</Link>],
                          ['Floor', r.floor_name],
                          ['Room', r.room],
                          ['Height', `${r.height_u} U`],
                          ['Numbering', r.numbering === 'top_down' ? 'U1 at the top' : 'U1 at the bottom'],
                          ['Manufacturer', r.manufacturer],
                          ['Model', r.model],
                          ['Description', r.description],
                        ]}
                      />
                    ),
                  },
                  ...journalTabs('rack', r.id, `Rack ${r.name}`),
                ]}
              />
            </Card>
            {r.assets.some((a) => !a.rack_u) && (
              <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                Some devices have no position yet ({r.assets.filter((a) => !a.rack_u).map((a) => a.name).join(', ')}). Select them in the list and click “Move”.
              </Typography.Paragraph>
            )}
          </div>
        </Col>
      </Row>

      <RackFormModal open={editingRack} rack={r} buildingId={r.building_id} onClose={() => setEditingRack(false)} />
      <MountModal
        open={mount.open}
        onClose={() => setMount({ open: false })}
        rack={{ id: r.id, name: r.name, height_u: r.height_u, numbering: r.numbering, plant_id: r.plant_id, building_id: r.building_id }}
        startU={mount.u}
        asset={mount.asset}
        item={mount.item}
        mode={mount.mode}
      />
    </div>
  );
}
