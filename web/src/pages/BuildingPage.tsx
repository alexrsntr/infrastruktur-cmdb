import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { App, Button, Card, Empty, Result, Segmented, Skeleton, Space, Tabs, Tooltip, Typography } from 'antd';
import { ClusterOutlined, DeleteOutlined, EditOutlined, FileExcelOutlined, HddOutlined, PictureOutlined, PlusOutlined } from '@ant-design/icons';
import type { Floor, RackDetail } from '../../../shared/model';
import { AssetTable } from '../components/AssetTable';
import { FloorPlanMap } from '../components/FloorPlanMap';
import { journalTabs } from '../components/Journal';
import { BuildingFormModal, FloorFormModal } from '../components/LocationForms';
import { PageHeader } from '../components/PageHeader';
import { download, exportUrl, MoreMenu } from '../components/PageParts';
import { useAddDevice } from '../components/AddDeviceWizard';
import { ApiError, errorText, http } from '../lib/api';
import { useBuilding, useInvalidate, useRacks } from '../lib/queries';
import { RackRow } from '../components/RackRow';
import { RackFormModal } from '../components/RackForms';
import { useSession } from '../lib/session';

export function BuildingPage() {
  const { buildingId = '' } = useParams();
  const { can } = useSession();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [params, setParams] = useSearchParams();
  const building = useBuilding(buildingId);
  const racks = useRacks({ buildingId, include: 'contents' }, !!buildingId);
  const { open: openAddDevice } = useAddDevice();
  const [rackModal, setRackModal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [floorModal, setFloorModal] = useState<{ open: boolean; floor?: Floor | null }>({ open: false });

  if (building.isLoading) return <Skeleton active paragraph={{ rows: 10 }} />;
  if (building.error || !building.data) {
    const status = building.error instanceof ApiError ? building.error.status : 500;
    return (
      <Result
        status={status === 403 ? '403' : status === 404 ? '404' : 'error'}
        title={status === 403 ? 'No access to this building' : status === 404 ? 'Building not found' : 'Could not load building'}
        subTitle={errorText(building.error)}
        extra={<Link to="/plants">Back to plants</Link>}
      />
    );
  }

  const b = building.data;
  const floors = [...(b.floors ?? [])].sort((x, y) => x.level - y.level || x.name.localeCompare(y.name));
  const tab = params.get('tab') ?? 'plans';
  const floor = floors.find((f) => f.id === params.get('floor')) ?? floors[0];
  const plantCode = b.plant_code;
  const label = `${plantCode ?? b.plant_name ?? ''} / ${b.name}`;

  const setParam = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const deleteBuilding = async () => {
    try {
      await http.del(`/api/buildings/${b.id}`);
      message.success('Building deleted');
      await invalidate();
      navigate(`/plants/${b.plant_id}`);
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const deleteFloor = async (f: Floor) => {
    try {
      await http.del(`/api/floors/${f.id}`);
      message.success(`Floor ${f.name} deleted`);
      setParam({ floor: undefined });
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const plans = !floors.length ? (
    <Empty description="This building has no floors yet. Add a floor, then upload its floor plan to place access points and other devices on it." style={{ padding: '40px 0' }}>
      {can('location.write') && (
        <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setFloorModal({ open: true })}>
          Add floor
        </Button>
      )}
    </Empty>
  ) : (
    <div>
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Segmented
          size="large"
          value={floor?.id}
          onChange={(v) => setParam({ floor: String(v) })}
          options={floors.map((f) => ({
            value: f.id,
            label: (
              <Tooltip title={`${f.asset_count ?? 0} devices${f.has_plan ? '' : ' · no floor plan yet'}`}>
                <Space size={6}>
                  {f.name}
                  {!f.has_plan && <PictureOutlined style={{ color: '#bfbfbf' }} />}
                </Space>
              </Tooltip>
            ),
          }))}
        />
        <div style={{ flex: 1 }} />
        {can('location.write') && floor && (
          <MoreMenu
            label="Floor"
            items={[
              { key: 'add', icon: <PlusOutlined />, label: 'Add floor', onClick: () => setFloorModal({ open: true }) },
              { key: 'edit', icon: <EditOutlined />, label: `Rename ${floor.name}`, onClick: () => setFloorModal({ open: true, floor }) },
              {
                key: 'del',
                icon: <DeleteOutlined />,
                label: `Delete ${floor.name}`,
                danger: true,
                divider: true,
                onClick: () => deleteFloor(floor),
                confirm: { title: `Delete floor ${floor.name}?`, content: 'The floor plan, notes and activities of this floor are deleted. Devices stay in the building.' },
              },
            ]}
          />
        )}
      </div>
      {floor && (
        <>
          <style>{'.print-only-title{display:none}@media print{.print-only-title{display:block}}'}</style>
          <Typography.Title level={5} className="print-only-title" style={{ marginTop: 0 }}>
            {b.name} – {floor.name}
          </Typography.Title>
          <FloorPlanMap floor={floor} buildingId={b.id} height={620} />
        </>
      )}
    </div>
  );

  const racksTab = (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Typography.Text type="secondary" style={{ fontSize: 15 }}>
          Front view of every rack in this building. Click a rack to mount devices and document patch panels.
        </Typography.Text>
        {can('location.write') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setRackModal(true)}>
            New rack
          </Button>
        )}
      </div>
      <RackRow racks={racks.data as RackDetail[] | undefined} loading={racks.isLoading} />
    </div>
  );

  return (
    <div>
      <PageHeader
        title={b.name}
        crumbs={[{ title: 'Plants', to: '/plants' }, { title: plantCode ?? b.plant_name ?? 'Plant', to: `/plants/${b.plant_id}` }, { title: b.name }]}
        icon={
          <span className="stat-icon" style={{ background: '#127a7a18', color: '#127a7a', width: 60, height: 60, fontSize: 28 }}>
            <ClusterOutlined />
          </span>
        }
        subtitle={[
          b.plant_name,
          `${floors.length} floor${floors.length === 1 ? '' : 's'}`,
          `${racks.data?.length ?? 0} rack${racks.data?.length === 1 ? '' : 's'}`,
          `${b.asset_count ?? 0} devices`,
          b.description,
        ]
          .filter(Boolean)
          .join(' · ')}
        extra={
          <>
            {can('asset.write') && (
              <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => openAddDevice({ plant_id: b.plant_id, building_id: b.id })}>
                Add device
              </Button>
            )}
            <MoreMenu
              items={[
                { key: 'edit', icon: <EditOutlined />, label: 'Edit building', onClick: () => setEditing(true), hidden: !can('location.write') },
                { key: 'floor', icon: <PlusOutlined />, label: 'Add floor', onClick: () => setFloorModal({ open: true }), hidden: !can('location.write') },
                { key: 'rack', icon: <HddOutlined />, label: 'New rack', onClick: () => setRackModal(true), hidden: !can('location.write') },
                {
                  key: 'plan',
                  icon: <PictureOutlined />,
                  label: 'Upload floor plan',
                  hidden: !can('location.write') || !floor,
                  onClick: () => setParam({ tab: undefined, floor: floor?.id }),
                },
                { key: 'export', icon: <FileExcelOutlined />, label: 'Export devices (Excel)', onClick: () => download(exportUrl('assets', 'xlsx', { buildingId: b.id })), hidden: !can('export'), divider: true },
                { key: 'export-racks', icon: <FileExcelOutlined />, label: 'Export rack contents (Excel)', onClick: () => download(exportUrl('rack-contents', 'xlsx', { buildingId: b.id })), hidden: !can('export') },
                {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  label: 'Delete building',
                  danger: true,
                  divider: true,
                  hidden: !can('location.write'),
                  onClick: deleteBuilding,
                  confirm: { title: `Delete building ${b.name}?`, content: 'Floors, floor plans, racks, notes and activities are deleted. Devices stay in the plant without building.' },
                },
              ]}
            />
          </>
        }
      />
      <Tabs
        activeKey={tab}
        onChange={(key) => setParam({ tab: key === 'plans' ? undefined : key })}
        destroyOnHidden
        items={[
          { key: 'plans', label: 'Floor plans', children: <Card>{plans}</Card> },
          { key: 'racks', label: `Racks (${racks.data?.length ?? 0})`, children: <Card>{racksTab}</Card> },
          {
            key: 'assets',
            label: `Devices (${b.asset_count ?? 0})`,
            children: (
              <Card>
                <AssetTable fixed={{ buildingId: b.id }} createDefaults={{ plant_id: b.plant_id, building_id: b.id }} storageKey="building" />
              </Card>
            ),
          },
          ...journalTabs('building', b.id, label).map((t) => ({ ...t, children: <Card>{t.children}</Card> })),
        ]}
      />
      <BuildingFormModal open={editing} building={b} plantId={b.plant_id} onClose={() => setEditing(false)} />
      <FloorFormModal
        open={floorModal.open}
        floor={floorModal.floor}
        buildingId={b.id}
        onClose={() => setFloorModal({ open: false })}
        onSaved={(f) => {
          if (!floorModal.floor) setParam({ floor: f.id, tab: undefined });
        }}
      />
      <RackFormModal open={rackModal} buildingId={b.id} onClose={() => setRackModal(false)} onSaved={(r) => navigate(`/racks/${r.id}`)} />
    </div>
  );
}
