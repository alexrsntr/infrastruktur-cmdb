import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { App, Button, Card, Col, Dropdown, Result, Row, Tabs, Tag, Tooltip, Typography } from 'antd';
import {
  QrcodeOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CameraOutlined,
  DeleteOutlined,
  DownloadOutlined,
  DownOutlined,
  EditOutlined,
  FormOutlined,
  LinkOutlined,
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
  isPassiveType,
  type AssetDetail,
  type AssetRelation,
} from '../../../shared/model';
import { api, ApiError, buildUrl, errorText, http } from '../lib/api';
import { fmtDate, fmtDateTime, fromNow } from '../lib/format';
import { useAsset, useAssetTypes, useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';
import { DetailHeader, type Fact } from '../components/DetailHeader';
import { MoreMenu, type MoreItem } from '../components/PageParts';
import { EmptyState, LoadingState } from '../components/EmptyState';
import { ASSET_TYPE_ICONS } from '../components/icons';
import { AssetFormModal } from '../components/AssetFormModal';
import { RelationFormModal } from '../components/RelationFormModal';
import { FloorPlanPreview } from '../components/FloorPlanPreview';
import { ActivityLog } from '../components/ActivityLog';
import { AttachmentsPanel } from '../components/AttachmentsPanel';
import { PortsPanel, usePorts } from '../components/PortsPanel';
import { ImpactCard } from '../components/ImpactCard';
import { QualityBadge } from '../components/QualityBadge';
import { ExternalRefsCard, MonitoringTag } from '../components/ExternalRefsCard';
import { WarrantyDate } from '../components/Tags';
import { StatusDot, TypeIcon } from '../components/Simple';

/** Old tab names in links and bookmarks → the tabs of today */
const TAB_ALIASES: Record<string, string> = { ports: 'connections' };

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
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  if (asset.isLoading) return <LoadingState rows={14} />;
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
  const rawTab = params.get('tab') ?? 'overview';
  const tab = TAB_ALIASES[rawTab] ?? rawTab;
  const setTab = (key: string) => {
    const next = new URLSearchParams(params);
    if (key === 'overview') next.delete('tab');
    else next.set('tab', key);
    setParams(next, { replace: true });
  };

  /** On site: write a note or log an activity – opens the activity log with the input box focused */
  const writeNote = () => {
    setTab('log');
    setTimeout(() => {
      const box = document.querySelector<HTMLTextAreaElement>('.activity-composer textarea');
      box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      box?.focus();
    }, 80);
  };

  /** On site: take a photo with the phone camera (or pick a picture) and attach it to the device */
  const uploadPhoto = async (file: File) => {
    setUploadingPhoto(true);
    try {
      const fd = new FormData();
      fd.append('entityType', 'asset');
      fd.append('entityId', a.id);
      fd.append('category', 'photo');
      fd.append('isPlan', 'false');
      fd.append('file', file);
      await api('/api/attachments', { method: 'POST', formData: fd });
      message.success('Photo added to the files');
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setUploadingPhoto(false);
      if (photoInput.current) photoInput.current.value = '';
    }
  };

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

  const moreItems: MoreItem[] = [
    { key: 'relation', icon: <LinkOutlined />, label: 'Add connection', onClick: () => setRelating(true), hidden: !can('asset.write') },
    { key: 'label', icon: <QrcodeOutlined />, label: 'Print QR label', onClick: () => navigate(`/labels?ids=${a.id}&format=single`) },
    {
      key: 'export-xlsx',
      icon: <DownloadOutlined />,
      label: 'Export device (Excel)',
      onClick: () => (window.location.href = buildUrl(`/api/export/asset/${a.id}`, { format: 'xlsx' })),
      hidden: !can('export'),
    },
    {
      key: 'export-json',
      icon: <DownloadOutlined />,
      label: 'Export device (JSON)',
      onClick: () => (window.location.href = buildUrl(`/api/export/asset/${a.id}`, { format: 'json' })),
      hidden: !can('export'),
    },
    { key: 'delete', icon: <DeleteOutlined />, label: 'Delete device', danger: true, divider: true, onClick: remove, hidden: !can('asset.delete') },
  ];

  const statusButton = can('asset.status') && (
    <Dropdown
      trigger={['click']}
      menu={{
        items: ASSET_STATUSES.map((st) => ({ key: st, label: <StatusDot status={st} />, disabled: st === a.status })),
        onClick: ({ key }) => void changeStatus(key),
      }}
    >
      <Button size="large" icon={<SwapOutlined />} aria-label={`Status: ${ASSET_STATUS_META[a.status].label} – change`}>
        Status
      </Button>
    </Dropdown>
  );

  // ---- About ----
  type FactRow = [string, unknown, React.ReactNode?];
  const passive = isPassiveType(a.type);
  const typeFieldList = types.fields(a.type);
  const fieldRow = (f: (typeof typeFieldList)[number]): FactRow => {
    const v = a.attributes?.[f.key];
    if (f.type === 'date' && typeof v === 'string' && v) return [f.label, v, fmtDate(v)];
    return [f.label, v, typeof v === 'boolean' ? (v ? 'Yes' : 'No') : f.unit && filled(v) ? `${v} ${f.unit}` : (v as React.ReactNode)];
  };
  // cabling: medium, category, A/B side, links and length are its main facts (instead of IP, serial number …)
  const leadFields = passive ? typeFieldList.slice(0, 6) : [];
  const basics: FactRow[] = passive
    ? [
        ...leadFields.map(fieldRow),
        ['Product', [a.manufacturer, a.model].filter(Boolean).join(' ')],
        ['System warranty until', a.warranty_end, <WarrantyDate value={a.warranty_end} warnDays={ATTENTION_DAYS.warranty} />],
        ['Responsible', a.owner],
        ['Inventory no.', a.asset_tag],
      ]
    : [
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
  const extra: FactRow[] = [
    ...typeFieldList.slice(leadFields.length).map(fieldRow),
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
  const toRows = (list: FactRow[], showEmpty: boolean) =>
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

  const location = [a.plant_code, a.building_name, a.room].filter(Boolean).join(' › ');
  const facts: Fact[] = [
    { label: 'Location', value: location || null, to: a.building_id ? `/buildings/${a.building_id}` : a.plant_id ? `/plants/${a.plant_id}` : undefined },
    {
      label: 'Rack',
      value: a.rack_id ? `${a.rack_name}${a.rack_u ? ` · U${formatRackUnits(a.rack_u, a.rack_height_u)}` : ''}` : null,
      to: a.rack_id ? `/racks/${a.rack_id}` : undefined,
    },
    { label: 'IP address', value: a.ip_address ? <span className="mono">{a.ip_address}</span> : null, copy: a.ip_address ?? undefined, hidden: passive },
    { label: 'Serial number', value: a.serial_number ? <span className="mono">{a.serial_number}</span> : null, copy: a.serial_number ?? undefined, hidden: passive },
    { label: 'Warranty', value: a.warranty_end ? <WarrantyDate value={a.warranty_end} warnDays={ATTENTION_DAYS.warranty} /> : null },
    { label: 'Responsible', value: a.owner },
  ];

  const connections = (
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
        <EmptyState description="No connections documented" />
      ) : (
        <div className="relation-list">
          {a.relations.map((r) => (
            <div key={r.id} className="relation-row">
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
                  <div className="mono muted fs-small">
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
  );

  const overview = (
    <Row gutter={[20, 20]}>
      <Col xs={24} xl={14}>
        <div className="card-stack">
          <Card title="About" extra={<QualityBadge assetId={a.id} />}>
            {aboutRows.length ? (
              <Facts rows={aboutRows} />
            ) : (
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                No details yet. {can('asset.edit') ? (passive ? 'Use “Edit” to add the A and B side, medium, length and more.' : 'Use “Edit” to add IP address, model, serial number and more.') : ''}
              </Typography.Paragraph>
            )}
            <Button type="link" style={{ paddingInline: 0, marginTop: 10, display: 'flex' }} onClick={() => setAllFields((v) => !v)} icon={allFields ? <UpOutlined /> : <DownOutlined />}>
              {allFields ? 'Show less' : 'Show all details'}
            </Button>
          </Card>
          <ImpactCard assetId={a.id} assetName={a.name} />
        </div>
      </Col>
      <Col xs={24} xl={10}>
        <div className="card-stack">
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
          <ExternalRefsCard assetId={a.id} />
        </div>
      </Col>
    </Row>
  );

  const hasPorts = typeDef.physical || (ports.data?.length ?? 0) > 0;
  const tabs = [
    { key: 'overview', label: 'Overview', children: overview },
    {
      key: 'connections',
      label: `${hasPorts ? 'Connections & ports' : 'Connections'}${a.relations.length ? ` (${a.relations.length})` : ''}`,
      children: (
        <div className="card-stack">
          {connections}
          {hasPorts && (
            <Card title={`Ports${ports.data?.length ? ` (${ports.data.length})` : ''}`}>
              <PortsPanel assetId={a.id} assetName={a.name} />
            </Card>
          )}
        </div>
      ),
    },
    {
      key: 'log',
      label: 'Activity log',
      children: (
        <Card>
          <ActivityLog entityType="asset" entityId={a.id} />
        </Card>
      ),
    },
    {
      key: 'files',
      label: 'Files',
      children: (
        <Card>
          <AttachmentsPanel entityType="asset" entityId={a.id} />
        </Card>
      ),
    },
  ];

  const canNote = can('note.write') || can('activity.write');
  const canPhoto = can('attachment.write');

  return (
    <div className="has-quick-actions">
      <DetailHeader
        icon={ASSET_TYPE_ICONS[a.type]}
        color={typeDef.color}
        crumbs={[{ title: 'Devices', to: '/inventory' }, { title: typeDef.plural, to: `/inventory/${typeDef.slug}` }]}
        title={a.name}
        tags={
          <>
            <StatusDot status={a.status} />
            <MonitoringTag status={a.monitoring_status} message={a.monitoring_message} source={a.monitoring_source} at={a.monitoring_checked_at} />
          </>
        }
        subtitle={[typeDef.label, [a.manufacturer, a.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}
        facts={facts}
        actions={
          <>
            {statusButton && <span className="hide-on-phone">{statusButton}</span>}
            {can('asset.edit') && (
              <Button size="large" type="primary" icon={<EditOutlined />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <MoreMenu items={moreItems} />
          </>
        }
      />

      <Tabs className="page-tabs" activeKey={tabs.some((t) => t.key === tab) ? tab : 'overview'} onChange={setTab} items={tabs} />

      {(canNote || canPhoto) && (
        <div className="quick-actions no-print" role="toolbar" aria-label="Quick actions">
          {canNote && (
            <Button size="large" icon={<FormOutlined />} onClick={writeNote}>
              Note
            </Button>
          )}
          {canPhoto && (
            <Button size="large" icon={<CameraOutlined />} loading={uploadingPhoto} onClick={() => photoInput.current?.click()}>
              Photo
            </Button>
          )}
          {statusButton}
        </div>
      )}
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void uploadPhoto(file);
        }}
      />

      <AssetFormModal open={editing} asset={a} onClose={() => setEditing(false)} />
      <RelationFormModal open={relating} asset={a} onClose={() => setRelating(false)} />
    </div>
  );
}
