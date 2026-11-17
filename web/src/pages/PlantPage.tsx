import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { App, Button, Card, Col, Empty, Progress, Result, Row, Skeleton, Tabs, Tag, Typography } from 'antd';
import {
  BankOutlined,
  ClusterOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  FileExcelOutlined,
  FileZipOutlined,
  HddOutlined,
  PlusOutlined,
  CodeOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { ASSET_TYPES, ASSET_TYPE_KEYS, type Building, type Rack } from '../../../shared/model';
import { AssetTable } from '../components/AssetTable';
import { ASSET_TYPE_ICONS } from '../components/icons';
import { journalTabs } from '../components/Journal';
import { NetworkTab } from '../components/NetworkTab';
import { BuildingFormModal, PlantFormModal } from '../components/LocationForms';
import { PageHeader } from '../components/PageHeader';
import { AboutCard, download, exportUrl, MoreMenu, SectionHead } from '../components/PageParts';
import { StatTile } from '../components/Simple';
import { PlantLocationCard } from '../components/GoogleMap';
import { PlantScorecard } from '../components/Scorecard';
import { PlansGallery } from '../components/PlansGallery';
import { useAddDevice } from '../components/AddDeviceWizard';
import { DatacenterFormModal } from '../components/DatacenterForms';
import { RackFormModal } from '../components/RackForms';
import { ApiError, errorText, http } from '../lib/api';
import { useInvalidate, usePlans, usePlant, useRacks } from '../lib/queries';
import { useSession } from '../lib/session';
import { tintBg, tintFg } from '../lib/palette';

interface DatacenterSummary {
  id: string;
  name: string;
  kind: 'single' | 'stretched';
  sites: { id: string; name: string; role: string; building_name: string; room: string | null; rack_count?: number; device_count?: number }[];
  link_count?: number;
}

function localTime(timezone: string | null): string | null {
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat('de-DE', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date());
  } catch {
    return null;
  }
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

function BuildingCard({ b, racks, onOpen }: { b: Building; racks: number; onOpen: () => void }) {
  return (
    <Card hoverable onClick={onOpen} styles={{ body: { padding: 18 } }} style={{ height: '100%' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span className="stat-icon" style={{ background: tintBg('#127a7a'), color: tintFg('#127a7a'), width: 46, height: 46, fontSize: 20 }}>
          <ClusterOutlined />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16.5, fontWeight: 700 }}>{b.name}</div>
          <Typography.Text type="secondary">{b.code}</Typography.Text>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 14, color: 'var(--cmdb-text-2)', flexWrap: 'wrap' }}>
        <span>
          <strong>{b.asset_count ?? 0}</strong> {plural(b.asset_count ?? 0, 'device')}
        </span>
        <span>
          <strong>{b.floor_count ?? 0}</strong> {plural(b.floor_count ?? 0, 'floor')}
        </span>
        <span>
          <strong>{racks}</strong> {plural(racks, 'rack')}
        </span>
      </div>
    </Card>
  );
}

/** How many racks the overview shows before pointing to the full rack list */
const RACK_PREVIEW = 6;

function RackCard({ r }: { r: Rack }) {
  const used = Number(r.used_u ?? 0);
  return (
    <Link to={`/racks/${r.id}`} style={{ color: 'inherit', display: 'block', height: '100%' }}>
      <Card hoverable styles={{ body: { padding: 16 } }} style={{ height: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
          <Typography.Text strong style={{ fontSize: 16 }} ellipsis>
            {r.name}
          </Typography.Text>
          <Typography.Text type="secondary">{r.height_u} U</Typography.Text>
        </div>
        <Typography.Text type="secondary" style={{ display: 'block' }} ellipsis>
          {[r.building_name, r.room].filter(Boolean).join(' · ')}
        </Typography.Text>
        <Progress percent={Math.round((used / r.height_u) * 100)} showInfo={false} strokeWidth={8} status={r.height_u - used <= 2 ? 'exception' : 'normal'} style={{ margin: '6px 0 2px' }} />
        <div style={{ color: 'var(--cmdb-text-2)' }}>
          <strong>{r.height_u - used} U</strong> free · <strong>{Number(r.asset_count ?? 0)}</strong> {plural(Number(r.asset_count ?? 0), 'device')}
        </div>
      </Card>
    </Link>
  );
}

export function PlantPage() {
  const { plantId = '' } = useParams();
  const { can } = useSession();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [params, setParams] = useSearchParams();
  const plant = usePlant(plantId);
  const plans = usePlans({ plantId }, !!plantId);
  const racks = useRacks({ plantId }, !!plantId);
  const datacenters = useQuery({
    queryKey: ['datacenters', { plantId }],
    queryFn: () => http.get<DatacenterSummary[]>('/api/datacenters', { plantId }),
    enabled: !!plantId,
    retry: false,
  });
  const { open: openAddDevice } = useAddDevice();
  const [editing, setEditing] = useState(false);
  const [buildingModal, setBuildingModal] = useState(false);
  const [dcModal, setDcModal] = useState(false);
  const [rackModal, setRackModal] = useState(false);

  if (plant.isLoading) return <Skeleton active paragraph={{ rows: 10 }} />;
  if (plant.error || !plant.data) {
    const status = plant.error instanceof ApiError ? plant.error.status : 500;
    return (
      <Result
        status={status === 403 ? '403' : status === 404 ? '404' : 'error'}
        title={status === 403 ? 'No access to this plant' : status === 404 ? 'Plant not found' : 'Could not load plant'}
        subTitle={errorText(plant.error)}
        extra={<Link to="/plants">Back to plants</Link>}
      />
    );
  }

  const p = plant.data;
  const label = `${p.code} – ${p.name}`;
  const tab = params.get('tab') ?? 'overview';
  const time = localTime(p.timezone);
  const rackCount = (buildingId: string) => (racks.data ?? []).filter((r) => r.building_id === buildingId).length;
  const dcs = datacenters.data ?? [];
  const allRacks = racks.data ?? [];
  const racksLink = `/racks?plantId=${p.id}`;
  const canAddRack = can('location.write') && p.buildings.length > 0;

  const deletePlant = async () => {
    try {
      await http.del(`/api/plants/${p.id}`);
      message.success('Plant deleted');
      await invalidate();
      navigate('/plants');
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const overview = (
    <div>
      {/* all device types in one row on wide screens, two per row on phones */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 16, marginBottom: 24 }}>
        {/* only the types that exist in this plant */}
        {ASSET_TYPE_KEYS.filter((t) => (p.asset_counts?.[t] ?? 0) > 0).map((t) => (
          <StatTile
            key={t}
            to={`/inventory/${ASSET_TYPES[t].slug}?plantId=${p.id}`}
            icon={ASSET_TYPE_ICONS[t]}
            color={ASSET_TYPES[t].color}
            value={p.asset_counts?.[t] ?? 0}
            label={ASSET_TYPES[t].plural}
          />
        ))}
        {/* racks are no device type, but belong to the plant's inventory all the same */}
        <StatTile to={racksLink} icon={<HddOutlined />} color="#5b6b7c" value={racks.isLoading ? '–' : allRacks.length} label="Racks" />
      </div>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={16}>
          <PlantScorecard plantId={p.id} />
          <div style={{ height: 8 }} />
          <SectionHead
            title={`Buildings (${p.buildings.length})`}
            extra={
              can('location.write') && (
                <Button icon={<PlusOutlined />} onClick={() => setBuildingModal(true)}>
                  Add building
                </Button>
              )
            }
          />
          {p.buildings.length ? (
            <Row gutter={[16, 16]}>
              {p.buildings.map((b) => (
                <Col key={b.id} xs={24} md={12}>
                  <BuildingCard b={b} racks={rackCount(b.id)} onOpen={() => navigate(`/buildings/${b.id}`)} />
                </Col>
              ))}
            </Row>
          ) : (
            <Card>
              <Empty description="No buildings yet. Add the buildings of this plant to place racks and devices in them.">
                {can('location.write') && (
                  <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setBuildingModal(true)}>
                    Add building
                  </Button>
                )}
              </Empty>
            </Card>
          )}

          <div style={{ height: 24 }} />
          <SectionHead
            title={`Racks (${racks.isLoading ? '–' : allRacks.length})`}
            extra={
              <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
                {allRacks.length > 0 && <Link to={racksLink}>Show all</Link>}
                {canAddRack && (
                  <Button icon={<PlusOutlined />} onClick={() => setRackModal(true)}>
                    Add rack
                  </Button>
                )}
              </span>
            }
          />
          {racks.isLoading ? (
            <Skeleton active paragraph={{ rows: 2 }} />
          ) : allRacks.length === 0 ? (
            <Card styles={{ body: { padding: 18 } }}>
              <Typography.Text type="secondary">
                {p.buildings.length === 0
                  ? 'No racks yet. Racks stand in a building – add a building first, then add its racks here.'
                  : 'No racks documented yet. Add the racks and wall cabinets of this plant to see their free space and mount devices in them.'}
              </Typography.Text>
            </Card>
          ) : (
            <>
              <Row gutter={[16, 16]}>
                {allRacks.slice(0, RACK_PREVIEW).map((r) => (
                  <Col key={r.id} xs={24} sm={12} lg={8}>
                    <RackCard r={r} />
                  </Col>
                ))}
              </Row>
              {allRacks.length > RACK_PREVIEW && (
                <div style={{ marginTop: 12 }}>
                  <Link to={racksLink}>Show all {allRacks.length} racks</Link>
                </div>
              )}
            </>
          )}

          {(dcs.length > 0 || can('location.write')) && (
            <>
              <div style={{ height: 24 }} />
              <SectionHead
                title={`Server rooms / data centers (${dcs.length})`}
                extra={
                  <span style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
                    {dcs.length > 0 && <Link to={`/datacenters?plantId=${p.id}`}>Show all</Link>}
                    {can('location.write') && (
                      <Button icon={<PlusOutlined />} onClick={() => setDcModal(true)}>
                        Add server room
                      </Button>
                    )}
                  </span>
                }
              />
              {dcs.length === 0 && (
                <Card styles={{ body: { padding: 18 } }}>
                  <Typography.Text type="secondary">
                    No server room documented yet. Add it in one step – choose the building and room, done. The racks in that room are added
                    automatically. Two rooms that work together (e.g. a cluster across two buildings) form one data center.
                  </Typography.Text>
                </Card>
              )}
              <Row gutter={[16, 16]}>
                {dcs.map((dc) => (
                  <Col key={dc.id} xs={24} md={12}>
                    <Card hoverable onClick={() => navigate(`/datacenters/${dc.id}`)} styles={{ body: { padding: 18 } }} style={{ height: '100%' }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
                        <span className="stat-icon" style={{ background: tintBg('#6b35b5'), color: tintFg('#6b35b5'), width: 46, height: 46, fontSize: 20 }}>
                          <DatabaseOutlined />
                        </span>
                        <div>
                          <div style={{ fontSize: 16.5, fontWeight: 700 }}>{dc.name}</div>
                          <Tag color={dc.kind === 'stretched' ? 'purple' : 'default'}>{dc.kind === 'stretched' ? `Stretched across ${dc.sites.length} buildings` : 'Single site'}</Tag>
                        </div>
                      </div>
                      {dc.sites.map((s) => (
                        <div key={s.id} style={{ color: 'var(--cmdb-text-2)' }}>
                          <strong>{s.name}</strong> · {s.building_name}
                          {s.room ? ` · ${s.room}` : ''}
                        </div>
                      ))}
                    </Card>
                  </Col>
                ))}
              </Row>
            </>
          )}
        </Col>

        <Col xs={24} xl={8}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <AboutCard
              rows={[
                ['Address', p.address],
                ['City', p.city],
                ['Country', p.country],
                ['Time zone', p.timezone ? `${p.timezone}${time ? ` (now ${time})` : ''}` : null],
                ['Contact', p.contact],
                ['Description', p.description],
              ]}
              extra={
                can('location.edit') && (
                  <Button type="link" icon={<EditOutlined />} onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                )
              }
            />
            <PlantLocationCard plant={p} />
          </div>
        </Col>
      </Row>
    </div>
  );

  return (
    <div>
      <PageHeader
        title={label}
        crumbs={[{ title: 'Plants', to: '/plants' }, { title: p.code }]}
        icon={
          <span className="stat-icon" style={{ background: tintBg('#2563eb'), color: tintFg('#2563eb'), width: 60, height: 60, fontSize: 28 }}>
            <BankOutlined />
          </span>
        }
        subtitle={[[p.city, p.country].filter(Boolean).join(', '), p.timezone, `${p.asset_count ?? 0} devices`].filter(Boolean).join(' · ')}
        extra={
          <>
            {can('asset.write') && (
              <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => openAddDevice({ plant_id: p.id })}>
                Add device
              </Button>
            )}
            <MoreMenu
              items={[
                { key: 'edit', icon: <EditOutlined />, label: 'Edit plant', onClick: () => setEditing(true), hidden: !can('location.edit') },
                { key: 'building', icon: <ClusterOutlined />, label: 'Add building', onClick: () => setBuildingModal(true), hidden: !can('location.write') },
                { key: 'datacenter', icon: <DatabaseOutlined />, label: 'Add server room / data center', onClick: () => setDcModal(true), hidden: !can('location.write') },
                { key: 'rack', icon: <HddOutlined />, label: 'Add rack', onClick: () => setRackModal(true), hidden: !canAddRack },
                { key: 'racks', icon: <HddOutlined />, label: 'Racks of this plant', onClick: () => navigate(racksLink) },
                { key: 'xlsx', icon: <FileExcelOutlined />, label: 'Export plant (Excel)', onClick: () => download(exportUrl('full', 'xlsx', { plantId: p.id })), hidden: !can('export'), divider: true },
                { key: 'json', icon: <CodeOutlined />, label: 'Export plant (JSON)', onClick: () => download(exportUrl('full', 'json', { plantId: p.id })), hidden: !can('export') },
                { key: 'zip', icon: <FileZipOutlined />, label: 'Download all files (ZIP)', onClick: () => download(`/api/export/files.zip?plantId=${p.id}`), hidden: !can('export') },
                {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  label: 'Delete plant',
                  danger: true,
                  divider: true,
                  hidden: !can('location.delete'),
                  onClick: deletePlant,
                  confirm: { title: `Delete plant ${p.code}?`, content: 'Only possible when no devices are assigned. Buildings, floors, notes and activities are deleted as well.' },
                },
              ]}
            />
          </>
        }
      />
      <Tabs
        activeKey={tab}
        onChange={(key) => {
          const next = new URLSearchParams(params);
          if (key === 'overview') next.delete('tab');
          else next.set('tab', key);
          // device list filters live in the URL too – reset them when switching tabs
          for (const k of ['q', 'page', 'pageSize', 'status', 'criticality', 'type', 'sort', 'order']) next.delete(k);
          setParams(next, { replace: true });
        }}
        destroyOnHidden
        items={[
          { key: 'overview', label: 'Overview', children: overview },
          {
            key: 'assets',
            label: `Devices (${p.asset_count ?? 0})`,
            children: (
              <Card>
                <AssetTable fixed={{ plantId: p.id }} createDefaults={{ plant_id: p.id }} storageKey="plant" />
              </Card>
            ),
          },
          {
            key: 'network',
            label: 'Network',
            children: <NetworkTab plantId={p.id} />,
          },
          {
            key: 'plans',
            label: `Pictures & plans (${plans.data?.length ?? 0})`,
            children: (
              <Card>
                <PlansGallery plantId={p.id} entityType="plant" entityId={p.id} />
              </Card>
            ),
          },
          ...journalTabs('plant', p.id, label).map((t) => ({ ...t, children: <Card>{t.children}</Card> })),
        ]}
      />
      <PlantFormModal open={editing} plant={p} onClose={() => setEditing(false)} />
      <BuildingFormModal open={buildingModal} plantId={p.id} onClose={() => setBuildingModal(false)} onSaved={(b) => navigate(`/buildings/${b.id}`)} />
      <RackFormModal open={rackModal} buildings={p.buildings} onClose={() => setRackModal(false)} onSaved={(r) => navigate(`/racks/${r.id}`)} />
      <DatacenterFormModal open={dcModal} defaultPlantId={p.id} onClose={() => setDcModal(false)} onSaved={(dc) => navigate(`/datacenters/${dc.id}`)} />
    </div>
  );
}
