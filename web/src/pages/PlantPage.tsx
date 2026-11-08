import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { App, Button, Card, Col, Empty, Result, Row, Skeleton, Tabs, Tag, Typography } from 'antd';
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
import { ASSET_TYPES, ASSET_TYPE_KEYS, type Building } from '../../../shared/model';
import { AssetTable } from '../components/AssetTable';
import { ASSET_TYPE_ICONS } from '../components/icons';
import { journalTabs } from '../components/Journal';
import { BuildingFormModal, PlantFormModal } from '../components/LocationForms';
import { PageHeader } from '../components/PageHeader';
import { AboutCard, download, exportUrl, MoreMenu, SectionHead } from '../components/PageParts';
import { StatTile } from '../components/Simple';
import { SiteMap } from '../components/WorldMap';
import { PlansGallery } from '../components/PlansGallery';
import { useAddDevice } from '../components/AddDeviceWizard';
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
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {ASSET_TYPE_KEYS.map((t) => (
          <Col xs={12} lg={6} key={t}>
            <StatTile
              to={`/inventory/${ASSET_TYPES[t].slug}?plantId=${p.id}`}
              icon={ASSET_TYPE_ICONS[t]}
              color={ASSET_TYPES[t].color}
              value={p.asset_counts?.[t] ?? 0}
              label={ASSET_TYPES[t].plural}
            />
          </Col>
        ))}
      </Row>

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={16}>
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

          {dcs.length > 0 && (
            <>
              <div style={{ height: 24 }} />
              <SectionHead title={`Data centers (${dcs.length})`} extra={<Link to={`/datacenters?plantId=${p.id}`}>Show all</Link>} />
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
                can('location.write') && (
                  <Button type="link" icon={<EditOutlined />} onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                )
              }
            />
            <Card title="Location" styles={{ body: { padding: 12 } }}>
              <SiteMap plant={p} buildings={p.buildings} height={260} />
            </Card>
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
                { key: 'edit', icon: <EditOutlined />, label: 'Edit plant', onClick: () => setEditing(true), hidden: !can('location.write') },
                { key: 'building', icon: <ClusterOutlined />, label: 'Add building', onClick: () => setBuildingModal(true), hidden: !can('location.write') },
                { key: 'racks', icon: <HddOutlined />, label: 'Racks of this plant', onClick: () => navigate(`/racks?plantId=${p.id}`) },
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
    </div>
  );
}
