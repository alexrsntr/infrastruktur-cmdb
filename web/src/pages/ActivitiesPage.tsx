import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Form, Input, Modal, Row, Segmented, Select, Space } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, FileExcelOutlined, PlusOutlined, SearchOutlined, SyncOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { ASSET_TYPES, type AssetType, type EntityType } from '../../../shared/model';
import { http, type Query } from '../lib/api';
import { useActivities, useBuildings, usePlants } from '../lib/queries';
import { useSession } from '../lib/session';
import { PageHeader } from '../components/PageHeader';
import { download, exportUrl, MoreMenu } from '../components/PageParts';
import { StatTile } from '../components/Simple';
import { ActivitiesTable, ActivityFormModal } from '../components/Journal';
import { AssetTypeTag } from '../components/Tags';

interface AssetOption {
  id: string;
  name: string;
  type: AssetType;
  status: string;
  ip_address: string | null;
  plant_code: string | null;
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface PickerOption {
  value: string;
  label: string;
  render?: React.ReactNode;
}

/** Two-step "new activity" flow: choose the object, then fill in the activity form. */
function NewActivityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const plants = usePlants();
  const buildings = useBuildings();
  const [kind, setKind] = useState<EntityType>('asset');
  const [selected, setSelected] = useState<{ id: string; label: string } | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [entity, setEntity] = useState<{ type: EntityType; id: string; label?: string } | null>(null);

  const assetOptions = useQuery({
    queryKey: ['asset-options', q],
    queryFn: () => http.get<AssetOption[]>('/api/assets/options', { q: q || undefined }),
    enabled: open && kind === 'asset',
  });

  useEffect(() => {
    if (open) {
      setSelected(null);
      setSearch('');
      setEntity(null);
    }
  }, [open]);

  const options: PickerOption[] =
    kind === 'plant'
      ? (plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))
      : kind === 'building'
        ? (buildings.data ?? []).map((b) => {
            // GET /api/buildings also returns the plant code
            const plantCode = (b as typeof b & { plant_code?: string }).plant_code;
            return { value: b.id, label: `${plantCode ? `${plantCode} / ` : ''}${b.code} – ${b.name}` };
          })
        : (assetOptions.data ?? []).map((a) => ({
            value: a.id,
            label: a.name,
            render: (
              <Space size={6}>
                <AssetTypeTag type={a.type} short />
                <strong>{a.name}</strong>
                <span className="muted" style={{ fontSize: 12 }}>
                  {[ASSET_TYPES[a.type]?.label, a.ip_address, a.plant_code].filter(Boolean).join(' · ')}
                </span>
              </Space>
            ),
          }));

  return (
    <>
      <Modal
        open={open && !entity}
        title="New activity"
        onCancel={onClose}
        okText="Continue"
        okButtonProps={{ disabled: !selected }}
        onOk={() => selected && setEntity({ type: kind, id: selected.id, label: selected.label })}
        destroyOnHidden
      >
        <Form layout="vertical">
          <Form.Item label="What is it about?">
            <Segmented
              block
              size="large"
              value={kind}
              onChange={(v) => {
                setKind(v as EntityType);
                setSelected(null);
              }}
              options={[
                { value: 'asset', label: 'A device' },
                { value: 'building', label: 'A building' },
                { value: 'plant', label: 'A plant' },
              ]}
            />
          </Form.Item>
          <Form.Item label={kind === 'asset' ? 'Device' : kind === 'building' ? 'Building' : 'Plant'} required>
            <Select<string>
              showSearch
              allowClear
              size="large"
              placeholder={kind === 'asset' ? 'Type a name, IP or serial number…' : 'Choose…'}
              value={selected?.id}
              filterOption={kind === 'asset' ? false : (input, opt) => String(opt?.label ?? '').toLowerCase().includes(input.toLowerCase())}
              onSearch={kind === 'asset' ? setSearch : undefined}
              loading={kind === 'asset' && assetOptions.isFetching}
              notFoundContent={kind === 'asset' && assetOptions.isFetching ? 'Searching…' : undefined}
              onChange={(id) => {
                const opt = options.find((o) => o.value === id);
                setSelected(id && opt ? { id, label: opt.label } : null);
              }}
              options={options}
              optionRender={(opt) => (opt.data as PickerOption).render ?? opt.label}
            />
          </Form.Item>
        </Form>
      </Modal>
      <ActivityFormModal
        open={open && !!entity}
        entity={entity ?? undefined}
        onClose={() => {
          setEntity(null);
          onClose();
        }}
      />
    </>
  );
}

type View = 'open' | 'overdue' | 'in_progress' | 'done' | 'all';

export function ActivitiesPage() {
  const { can } = useSession();
  const plants = usePlants();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);

  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ page: undefined, ...patch })) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const [searchText, setSearchText] = useState(get('q'));
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchText !== get('q')) set({ q: searchText || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = ((get('view') as View) || 'open') as View;
  const page = Number(get('page') || 1);
  const pageSize = Number(get('pageSize') || 50);
  const plantFilter = get('plantId') || undefined;

  const viewQuery: Query =
    view === 'open' ? { open: 'true' } : view === 'overdue' ? { overdue: 'true' } : view === 'in_progress' ? { status: 'in_progress' } : view === 'done' ? { status: 'done' } : {};
  const query: Query = { q: get('q') || undefined, plantId: plantFilter, ...viewQuery, page, pageSize };
  const acts = useActivities(query);

  const kpiOpen = useActivities({ plantId: plantFilter, open: 'true', pageSize: 1 });
  const kpiOverdue = useActivities({ plantId: plantFilter, overdue: 'true', pageSize: 1 });
  const kpiProgress = useActivities({ plantId: plantFilter, status: 'in_progress', pageSize: 1 });
  const kpiDone = useActivities({ plantId: plantFilter, status: 'done', pageSize: 1 });

  const exportQuery: Query = { ...query, page: undefined, pageSize: undefined };
  const setView = (v: View) => set({ view: v === 'open' ? undefined : v });

  return (
    <div>
      <PageHeader
        title="Activities"
        subtitle="Maintenance, incidents, changes and inspections of all your plants – what is open and what was done."
        extra={
          <>
            {can('activity.write') && (
              <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
                New activity
              </Button>
            )}
            <MoreMenu
              items={[
                { key: 'xlsx', icon: <FileExcelOutlined />, label: 'Export this list (Excel)', onClick: () => download(exportUrl('activities', 'xlsx', exportQuery)), hidden: !can('export') },
                { key: 'csv', icon: <UnorderedListOutlined />, label: 'Export this list (CSV)', onClick: () => download(exportUrl('activities', 'csv', exportQuery)), hidden: !can('export') },
              ]}
            />
          </>
        }
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} lg={6}>
          <StatTile icon={<ClockCircleOutlined />} value={kpiOpen.data?.total ?? '–'} label="Open" color="#1a5fb4" active={view === 'open'} onClick={() => setView('open')} />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile icon={<ExclamationCircleOutlined />} value={kpiOverdue.data?.total ?? '–'} label="Overdue" color="#d9363e" active={view === 'overdue'} onClick={() => setView('overdue')} />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile icon={<SyncOutlined />} value={kpiProgress.data?.total ?? '–'} label="In progress" color="#d98a00" active={view === 'in_progress'} onClick={() => setView('in_progress')} />
        </Col>
        <Col xs={12} lg={6}>
          <StatTile icon={<CheckCircleOutlined />} value={kpiDone.data?.total ?? '–'} label="Done" color="#1e9e5a" active={view === 'done'} onClick={() => setView('done')} />
        </Col>
      </Row>

      <Card>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          <Input
            allowClear
            size="large"
            prefix={<SearchOutlined className="muted" />}
            placeholder="Search title, description or person"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ maxWidth: 340 }}
          />
          <Segmented
            size="large"
            value={view}
            onChange={(v) => setView(v as View)}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'overdue', label: 'Overdue' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'done', label: 'Done' },
              { value: 'all', label: 'All' },
            ]}
          />
          <Select
            allowClear
            showSearch
            size="large"
            optionFilterProp="label"
            placeholder="All plants"
            style={{ width: 230 }}
            value={plantFilter}
            onChange={(v) => set({ plantId: v })}
            options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
          />
        </div>

        <ActivitiesTable
          items={acts.data?.items ?? []}
          loading={acts.isFetching}
          showEntity
          pagination={{
            current: page,
            pageSize,
            total: acts.data?.total ?? 0,
            onChange: (p, size) => set({ page: String(p), pageSize: size !== 50 ? String(size) : undefined }),
          }}
        />
      </Card>

      <NewActivityDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
