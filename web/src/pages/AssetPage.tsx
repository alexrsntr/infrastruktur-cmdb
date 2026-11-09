import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { App, Button, Card, Col, Dropdown, Empty, Result, Row, Skeleton, Tabs, Tag, Tooltip, Typography, type MenuProps } from 'antd';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DownOutlined,
  EditOutlined,
  LinkOutlined,
  MoreOutlined,
  SwapOutlined,
  UpOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import {
  ASSET_STATUSES,
  ASSET_STATUS_META,
  ASSET_TYPES,
  ATTENTION_DAYS,
  CRITICALITY_META,
  RELATION_TYPES,
  formatRackUnits,
  type AssetDetail,
  type AssetRelation,
} from '../../../shared/model';
import { ApiError, buildUrl, errorText, http } from '../lib/api';
import { fmtDate, fmtDateTime, fromNow } from '../lib/format';
import { useAsset, useAssetTypes, useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';
import { PageHeader } from '../components/PageHeader';
import { AssetFormModal } from '../components/AssetFormModal';
import { RelationFormModal } from '../components/RelationFormModal';
import { FloorPlanPreview } from '../components/FloorPlanPreview';
import { journalTabs } from '../components/Journal';
import { PortsPanel, usePorts } from '../components/PortsPanel';
import { WarrantyDate } from '../components/Tags';
import { StatusDot, TypeIcon } from '../components/Simple';

/** label/value rows of the About card – only filled values unless `all` */
function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 38%) 1fr', rowGap: 10, columnGap: 16 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span className="muted">{k}</span>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

const filled = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);

export function AssetPage() {
  const { assetId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const { message, modal } = App.useApp();
  const invalidate = useInvalidate();
  const asset = useAsset(assetId);
  const types = useAssetTypes();
  const ports = usePorts(assetId ?? '');
  const onPlans = useQuery({
    queryKey: ['asset-plans', assetId],
    queryFn: () => http.get<{ id: string; title: string }[]>(`/api/assets/${assetId}/plans`),
    enabled: !!assetId,
  });
  const [editing, setEditing] = useState(false);
  const [relating, setRelating] = useState(false);
  const [allFields, setAllFields] = useState(false);

  if (asset.isLoading) return <Skeleton active paragraph={{ rows: 14 }} />;
  if (asset.error || !asset.data) {
    const status = asset.error instanceof ApiError ? asset.error.status : 500;
    return (
      <Result
        status={status === 403 ? '403' : status === 404 ? '404' : 'error'}
        title={status === 403 ? 'No access' : status === 404 ? 'Device not found' : 'Could not load the device'}
        subTitle={errorText(asset.error)}
        extra={<Button onClick={() => navigate('/inventory')}>Back to devices</Button>}
      />
    );
  }

  const a: AssetDetail = asset.data;
  const typeDef = ASSET_TYPES[a.type];
  const tab = params.get('tab') ?? 'log';

  const changeStatus = async (status: string) => {
    try {
      await http.patch(`/api/assets/${a.id}/status`, { status });
      message.success(`Status set to ${ASSET_STATUS_META[status as keyof typeof ASSET_STATUS_META].label}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const remove = () =>
    modal.confirm({
      title: `Delete ${a.name}?`,
      content: 'Its connections, notes, activities and files are deleted as well. The change history is kept in the audit log.',
      okText: 'Delete',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await http.del(`/api/assets/${a.id}`);
          message.success(`${a.name} deleted`);
          await invalidate();
          navigate(`/inventory/${typeDef.slug}`);
        } catch (e) {
          message.error(errorText(e));
        }
      },
    });

  const removeRelation = (r: AssetRelation) =>
    modal.confirm({
      title: `Remove the connection to ${r.other_name}?`,
      okText: 'Remove',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await http.del(`/api/relations/${r.id}`);
          await invalidate();
        } catch (e) {
          message.error(errorText(e));
        }
      },
    });

  const moreItems: MenuProps['items'] = [
    ...(can('asset.status')
      ? [
          {
            key: 'status',
            icon: <SwapOutlined />,
            label: 'Change status',
            children: ASSET_STATUSES.map((s) => ({ key: `status:${s}`, label: <StatusDot status={s} />, disabled: s === a.status })),
          },
        ]
      : []),
    ...(can('asset.write') ? [{ key: 'relation', icon: <LinkOutlined />, label: 'Add connection' }] : []),
    ...(can('export')
      ? [
          {
            key: 'export',
            icon: <DownloadOutlined />,
            label: 'Export device',
            children: [
              { key: 'export:xlsx', label: 'Excel (.xlsx)' },
              { key: 'export:json', label: 'JSON' },
            ],
          },
        ]
      : []),
    ...(can('asset.delete') ? [{ type: 'divider' as const }, { key: 'delete', icon: <DeleteOutlined />, label: 'Delete device', danger: true }] : []),
  ];

  const onMore: MenuProps['onClick'] = ({ key }) => {
    if (key.startsWith('status:')) void changeStatus(key.slice(7));
    else if (key === 'relation') setRelating(true);
    else if (key.startsWith('export:')) window.location.href = buildUrl(`/api/export/asset/${a.id}`, { format: key.slice(7) });
    else if (key === 'delete') remove();
  };

  // ---- About ----
  const basics: [string, unknown, React.ReactNode?][] = [
    ['IP address', a.ip_address, <Typography.Text copyable className="mono">{a.ip_address}</Typography.Text>],
    ['Model', [a.manufacturer, a.model].filter(Boolean).join(' ')],
    ['Serial number', a.serial_number, <Typography.Text copyable className="mono">{a.serial_number}</Typography.Text>],
    ['MAC address', a.mac_address, <span className="mono">{a.mac_address}</span>],
    ['Hostname (FQDN)', a.fqdn, <span className="mono">{a.fqdn}</span>],
    ['OS / firmware', a.os],
    ['Warranty until', a.warranty_end, <WarrantyDate value={a.warranty_end} warnDays={ATTENTION_DAYS.warranty} />],
    ['Vendor support until', a.support_end, <WarrantyDate value={a.support_end} warnDays={ATTENTION_DAYS.support} />],
    ['End of life', a.end_of_life, <WarrantyDate value={a.end_of_life} warnDays={ATTENTION_DAYS.eol} />],
    ['Responsible', a.owner],
    ['Inventory no.', a.asset_tag],
  ];
  const extra: [string, unknown, React.ReactNode?][] = [
    ...types.fields(a.type).map((f): [string, unknown, React.ReactNode?] => {
      const v = a.attributes?.[f.key];
      if (f.type === 'date' && typeof v === 'string' && v) return [f.label, v, fmtDate(v)];
      return [f.label, v, typeof v === 'boolean' ? (v ? 'Yes' : 'No') : f.unit && filled(v) ? `${v} ${f.unit}` : (v as React.ReactNode)];
    }),
    ['Criticality', a.criticality, CRITICALITY_META[a.criticality].label],
    ['Cost center', a.cost_center],
    ['Support contract', a.support_contract],
    ['Last seen on the network', a.last_seen_at, <Tooltip title={fmtDateTime(a.last_seen_at)}>{fromNow(a.last_seen_at)}</Tooltip>],
    ['Purchase date', a.purchase_date, fmtDate(a.purchase_date)],
    ['Tags', a.tags, a.tags.map((t) => <Tag key={t}>{t}</Tag>)],
    ['Description', a.description, <span className="note-body">{a.description}</span>],
    ['Added', a.created_at, `${fmtDateTime(a.created_at)}${a.created_by_name ? ` · ${a.created_by_name}` : ''}`],
    ['Last change', a.updated_at, `${fmtDateTime(a.updated_at)}${a.updated_by_name ? ` · ${a.updated_by_name}` : ''}`],
  ];
  const toRows = (list: [string, unknown, React.ReactNode?][], showEmpty: boolean) =>
    list.filter(([, v]) => showEmpty || filled(v)).map(([k, v, node]): [string, React.ReactNode] => [k, filled(v) ? (node ?? String(v)) : <span className="muted">–</span>]);
  const aboutRows = [...toRows(basics, false), ...(allFields ? toRows(extra, true) : [])];

  const locationRows: [string, React.ReactNode][] = [
    ['Plant', a.plant_id ? <Link to={`/plants/${a.plant_id}`}>{a.plant_code} – {a.plant_name}</Link> : <span className="muted">not set</span>],
    ...(a.building_id ? [['Building', <Link to={`/buildings/${a.building_id}`}>{a.building_name}</Link>] as [string, React.ReactNode]] : []),
    ...(a.floor_id ? [['Floor', <Link to={`/buildings/${a.building_id}?floor=${a.floor_id}`}>{a.floor_name}</Link>] as [string, React.ReactNode]] : []),
    ...(a.room ? [['Room', a.room] as [string, React.ReactNode]] : []),
    ...(a.rack_id
      ? [['Rack', <Link to={`/racks/${a.rack_id}`}>{a.rack_name}{a.rack_u ? ` · U${formatRackUnits(a.rack_u, a.rack_height_u)}` : ''}</Link>] as [string, React.ReactNode]]
      : []),
  ];

  return (
    <div>
      <PageHeader
        icon={<TypeIcon type={a.type} large />}
        crumbs={[{ title: 'Devices', to: '/inventory' }, { title: typeDef.plural, to: `/inventory/${typeDef.slug}` }]}
        title={a.name}
        tags={<StatusDot status={a.status} />}
        subtitle={[typeDef.label, [a.manufacturer, a.model].filter(Boolean).join(' '), [a.plant_code, a.building_name, a.room].filter(Boolean).join(' › ')].filter(Boolean).join(' · ')}
        extra={
          <>
            {can('asset.write') && (
              <Button size="large" icon={<EditOutlined />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {moreItems.length > 0 && (
              <Dropdown menu={{ items: moreItems, onClick: onMore }} trigger={['click']}>
                <Button size="large" icon={<MoreOutlined />}>
                  More
                </Button>
              </Dropdown>
            )}
          </>
        }
      />

      <Row gutter={[20, 20]}>
        <Col xs={24} xl={9}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <Card title="About">
              {aboutRows.length ? (
                <Facts rows={aboutRows} />
              ) : (
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  No details yet. {can('asset.write') ? 'Use “Edit” to add IP address, model, serial number and more.' : ''}
                </Typography.Paragraph>
              )}
              <Button type="link" style={{ paddingInline: 0, marginTop: 10, display: 'flex' }} onClick={() => setAllFields((v) => !v)} icon={allFields ? <UpOutlined /> : <DownOutlined />}>
                {allFields ? 'Show less' : 'Show all details'}
              </Button>
            </Card>

            <Card title="Location">
              <Facts rows={locationRows} />
              {a.floor_id && (
                <div style={{ marginTop: 14 }}>
                  <FloorPlanPreview asset={a} />
                </div>
              )}
              {!!onPlans.data?.length && (
                <div style={{ marginTop: 12 }}>
                  <span className="muted">Shown on: </span>
                  {onPlans.data.map((pl) => (
                    <Link key={pl.id} to={`/plans/${pl.id}`} style={{ marginRight: 12 }}>
                      {pl.title}
                    </Link>
                  ))}
                </div>
              )}
            </Card>

            <Card
              title={`Connections (${a.relations.length})`}
              extra={
                can('asset.write') && (
                  <Button icon={<LinkOutlined />} onClick={() => setRelating(true)}>
                    Add
                  </Button>
                )
              }
            >
              {!a.relations.length ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No connections documented" style={{ margin: 0 }} />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {a.relations.map((r) => (
                    <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <TypeIcon type={r.other_type} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div>
                          <span className="muted">
                            {r.direction === 'out' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />} {r.direction === 'out' ? RELATION_TYPES[r.relation].label : RELATION_TYPES[r.relation].inverse}{' '}
                          </span>
                          <Link to={`/assets/${r.other_id}`} style={{ fontWeight: 600 }}>
                            {r.other_name}
                          </Link>
                        </div>
                        {(r.local_port || r.remote_port) && (
                          <div className="mono muted" style={{ fontSize: 13 }}>
                            {r.local_port ?? '?'} ⇄ {r.remote_port ?? '?'}
                          </div>
                        )}
                      </div>
                      {can('asset.write') && <Button type="text" danger icon={<DeleteOutlined />} aria-label="Remove connection" onClick={() => removeRelation(r)} />}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </Col>

        <Col xs={24} xl={15}>
          <Card styles={{ body: { paddingTop: 4 } }}>
            <Tabs
              activeKey={tab}
              onChange={(key) => {
                const next = new URLSearchParams(params);
                if (key === 'log') next.delete('tab');
                else next.set('tab', key);
                setParams(next, { replace: true });
              }}
              items={[
                ...journalTabs('asset', a.id, a.name),
                ...(typeDef.physical || (ports.data?.length ?? 0) > 0
                  ? [{ key: 'ports', label: `Ports${ports.data?.length ? ` (${ports.data.length})` : ''}`, children: <PortsPanel assetId={a.id} assetName={a.name} /> }]
                  : []),
              ]}
            />
          </Card>
        </Col>
      </Row>

      <AssetFormModal open={editing} asset={a} onClose={() => setEditing(false)} />
      <RelationFormModal open={relating} asset={a} onClose={() => setRelating(false)} />
    </div>
  );
}
