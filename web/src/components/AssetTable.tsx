import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, Empty, Input, Select, Table, Tooltip, Typography, type TableColumnsType } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type { SortOrder } from 'antd/es/table/interface';
import { ASSET_STATUSES, ASSET_STATUS_META, ASSET_TYPES, ASSET_TYPE_KEYS, ATTENTION_DAYS, ATTENTION_KINDS, ATTENTION_META, assetTypeNoun, formatRackUnits, type Asset, type AssetType } from '../../../shared/model';
import type { Query } from '../lib/api';
import { fmtDateTime, fromNow } from '../lib/format';
import { useAssets, usePlants } from '../lib/queries';
import { useSession } from '../lib/session';
import { useAddDevice } from './AddDeviceWizard';
import { ExportMenu } from './ExportMenu';
import { StatusDot, TypeIcon } from './Simple';
import { WarrantyDate } from './Tags';

export interface AssetTableProps {
  /** Filters that cannot be changed by the user (e.g. on a plant page) */
  fixed?: { type?: AssetType; plantId?: string; buildingId?: string; floorId?: string };
  /** Defaults for the "Add device" wizard */
  createDefaults?: Partial<Asset>;
  /** Keep filters in the URL (main device pages) */
  syncUrl?: boolean;
  /** kept for compatibility */
  storageKey?: string;
  pageSize?: number;
}

/** Simple device list: one search box, status (and plant) filter, five columns, rows open the device. */
export function AssetTable({ fixed = {}, createDefaults, syncUrl = false, pageSize: initialPageSize = 25 }: AssetTableProps) {
  const { can, scoped, me } = useSession();
  const navigate = useNavigate();
  const plants = usePlants();
  const { open: openAddDevice } = useAddDevice();
  const [params, setParams] = useSearchParams();
  const [local, setLocal] = useState<Record<string, string>>({});

  const get = (k: string) => (syncUrl ? params.get(k) : local[k]) ?? '';
  const set = (patch: Record<string, string | undefined>) => {
    const all = 'page' in patch ? patch : { ...patch, page: undefined };
    if (syncUrl) {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(all)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      setParams(next, { replace: true });
    } else {
      setLocal((s) => {
        const next = { ...s };
        for (const [k, v] of Object.entries(all)) {
          if (v) next[k] = v;
          else delete next[k];
        }
        return next;
      });
    }
  };

  const [search, setSearch] = useState(get('q'));
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== get('q')) set({ q: search || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const page = Number(get('page') || 1);
  const pageSize = Number(get('pageSize') || initialPageSize);
  const typeFilter = fixed.type ?? ((get('type') || undefined) as AssetType | undefined);
  const query: Query = {
    type: typeFilter,
    plantId: fixed.plantId ?? (get('plantId') || undefined),
    buildingId: fixed.buildingId,
    floorId: fixed.floorId,
    status: get('status') || undefined,
    attention: get('attention') || undefined,
    q: get('q') || undefined,
    sort: get('sort') || 'name',
    order: get('order') || 'asc',
    page,
    pageSize,
  };
  const assets = useAssets(query);
  const attentionOn = !!get('attention');
  const sortOrder = (key: string): SortOrder => (query.sort === key ? (query.order === 'desc' ? 'descend' : 'ascend') : null);
  const showPlant = !fixed.plantId && !fixed.buildingId && !(scoped && me.user.plantScope.length === 1);

  const columns: TableColumnsType<Asset> = [
    {
      key: 'name',
      title: 'Device',
      sorter: true,
      sortOrder: sortOrder('name'),
      render: (_, a) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
          <TypeIcon type={a.type} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 15.5 }}>{a.name}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {[ASSET_TYPES[a.type].label, [a.manufacturer, a.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'status', title: 'Status', width: 150, sorter: true, sortOrder: sortOrder('status'), render: (_, a) => <StatusDot status={a.status} /> },
    {
      key: 'location',
      title: 'Location',
      render: (_, a) => {
        const place = [a.room, a.rack_name && `Rack ${a.rack_name}${a.rack_u ? ` U${formatRackUnits(a.rack_u, a.rack_height_u)}` : ''}`].filter(Boolean).join(' · ');
        return (
          <div style={{ minWidth: 160 }}>
            <div>{[showPlant ? a.plant_code : null, a.building_name].filter(Boolean).join(' · ') || <span className="muted">–</span>}</div>
            {place && (
              <div className="muted" style={{ fontSize: 13 }}>
                {place}
              </div>
            )}
          </div>
        );
      },
    },
    ...(attentionOn
      ? ([
          {
            key: 'lifecycle',
            title: 'Lifecycle',
            width: 230,
            render: (_, a) => (
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                {a.warranty_end && (
                  <div>
                    Warranty <WarrantyDate value={a.warranty_end} warnDays={ATTENTION_DAYS.warranty} />
                  </div>
                )}
                {a.support_end && (
                  <div>
                    Support <WarrantyDate value={a.support_end} warnDays={ATTENTION_DAYS.support} />
                  </div>
                )}
                {a.end_of_life && (
                  <div>
                    End of life <WarrantyDate value={a.end_of_life} warnDays={ATTENTION_DAYS.eol} />
                  </div>
                )}
                {a.last_seen_at && <div className="muted">Seen {fromNow(a.last_seen_at)}</div>}
              </div>
            ),
          },
        ] as TableColumnsType<Asset>)
      : []),
    { key: 'ip_address', title: 'IP address', width: 150, render: (_, a) => (a.ip_address ? <span className="mono">{a.ip_address}</span> : <span className="muted">–</span>) },
    {
      key: 'last_activity',
      title: 'Last activity',
      width: 300,
      sorter: true,
      sortOrder: sortOrder('last_activity'),
      render: (_, a) =>
        a.last_activity_at ? (
          <div style={{ minWidth: 0 }}>
            <Typography.Text ellipsis style={{ display: 'block', maxWidth: 280 }}>
              {a.last_activity}
            </Typography.Text>
            <Tooltip title={fmtDateTime(a.last_activity_at)}>
              <span className="muted" style={{ fontSize: 13 }}>
                {fromNow(a.last_activity_at)}
                {a.last_activity_by ? ` · ${a.last_activity_by}` : ''}
              </span>
            </Tooltip>
          </div>
        ) : (
          <div>
            <div>Added to the CMDB</div>
            <span className="muted" style={{ fontSize: 13 }}>
              {fromNow(a.created_at)}
            </span>
          </div>
        ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <Input
          allowClear
          prefix={<SearchOutlined className="muted" />}
          placeholder="Search name, IP, serial number, model…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 340 }}
        />
        {!fixed.type && !syncUrl && (
          <Select
            allowClear
            placeholder="All types"
            style={{ width: 180 }}
            value={get('type') || undefined}
            onChange={(v) => set({ type: v })}
            options={ASSET_TYPE_KEYS.map((t) => ({ value: t, label: ASSET_TYPES[t].plural }))}
          />
        )}
        <Select
          allowClear
          placeholder="Any status"
          style={{ width: 170 }}
          value={get('status') || undefined}
          onChange={(v) => set({ status: v })}
          options={ASSET_STATUSES.map((s) => ({ value: s, label: ASSET_STATUS_META[s].label }))}
        />
        <Select
          allowClear
          mode="multiple"
          maxTagCount="responsive"
          placeholder="Needs attention"
          style={{ minWidth: 190, maxWidth: 360 }}
          value={get('attention') ? get('attention').split(',') : []}
          onChange={(v: string[]) => set({ attention: v.length ? v.join(',') : undefined })}
          options={ATTENTION_KINDS.map((k) => ({ value: k, label: ATTENTION_META[k].label, title: ATTENTION_META[k].description }))}
        />
        {showPlant && (plants.data?.length ?? 0) > 1 && (
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="All plants"
            style={{ width: 220 }}
            value={get('plantId') || undefined}
            onChange={(v) => set({ plantId: v })}
            options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
          />
        )}
        <div style={{ flex: 1 }} />
        <ExportMenu dataset="assets" query={{ ...query, page: undefined, pageSize: undefined }} />
        {can('asset.write') && !syncUrl && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() =>
              openAddDevice({
                type: fixed.type ?? typeFilter,
                plant_id: (createDefaults?.plant_id ?? fixed.plantId ?? (get('plantId') || undefined)) as string | undefined,
                building_id: (createDefaults?.building_id ?? fixed.buildingId) as string | undefined,
              })
            }
          >
            Add {fixed.type ? assetTypeNoun(fixed.type) : 'device'}
          </Button>
        )}
      </div>

      <Table<Asset>
        rowKey="id"
        className="clickable-rows"
        loading={assets.isFetching}
        columns={columns}
        dataSource={assets.data?.items ?? []}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={query.q || query.status ? 'No devices match your search' : 'No devices yet'}
              style={{ margin: '24px 0' }}
            >
              {can('asset.write') && !query.q && (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => openAddDevice({ type: fixed.type, plant_id: fixed.plantId, building_id: fixed.buildingId })}>
                  Add the first device
                </Button>
              )}
            </Empty>
          ),
        }}
        onRow={(a) => ({ onClick: () => navigate(`/assets/${a.id}`) })}
        pagination={{
          current: page,
          pageSize,
          total: assets.data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [25, 50, 100],
          showTotal: (total) => `${total} devices`,
          hideOnSinglePage: false,
        }}
        onChange={(pagination, _f, sorter) => {
          const s = Array.isArray(sorter) ? sorter[0] : sorter;
          const sortKey = s?.order ? String(s.columnKey) : undefined;
          set({
            page: String(pagination.current ?? 1),
            pageSize: pagination.pageSize && pagination.pageSize !== initialPageSize ? String(pagination.pageSize) : undefined,
            sort: sortKey,
            order: sortKey ? (s.order === 'descend' ? 'desc' : 'asc') : undefined,
          });
        }}
      />
    </div>
  );
}
