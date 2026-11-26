import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import L from 'leaflet';
import { ImageOverlay, MapContainer, Marker, Popup, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { App, Button, Checkbox, Dropdown, Empty, Input, List, Popconfirm, Space, Switch, Tag, Tooltip as AntTooltip, Typography, Upload } from 'antd';
import { AimOutlined, DeleteOutlined, DragOutlined, HddOutlined, MoreOutlined, PrinterOutlined, UploadOutlined } from '@ant-design/icons';
import { ASSET_TYPES, ASSET_TYPE_KEYS, type Asset, type AssetType, type Floor, type Rack } from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { dash } from '../lib/format';
import { useAssets, useInvalidate, useRacks } from '../lib/queries';
import { useSession } from '../lib/session';
import { AssetStatusTag, AssetTypeTag } from './Tags';
import { RACK_MARKER_COLOR, RACK_MARKER_SIZE, rackMarkerHtml } from './rackMarker';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Legend/filter key of the rack layer (next to the device types) */
const RACKS = '__racks';

type Placing = { kind: 'asset' | 'rack'; id: string };
type Position = { map_x: number | null; map_y: number | null };

const iconCache = new Map<string, L.DivIcon>();

/** Icons only depend on type, status and highlight – cache them so markers are not re-created on every render. */
function assetIcon(a: Asset, highlighted: boolean) {
  const key = `${a.type}|${a.status}|${highlighted}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const def = ASSET_TYPES[a.type];
  const label = def.short;
  const icon = L.divIcon({
    className: '',
    html: `<div class="asset-marker status-${a.status}${highlighted ? ' selected' : ''}" style="background:${def.color};font-size:${label.length > 2 ? 9 : 10}px;font-weight:700">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14],
    tooltipAnchor: [14, 0],
  });
  iconCache.set(key, icon);
  return icon;
}

/** Racks are a square icon centred exactly on their position; the name is shown in the tooltip. */
function rackIcon(highlighted: boolean) {
  const key = `rack|${highlighted}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const half = RACK_MARKER_SIZE / 2;
  const icon = L.divIcon({
    className: '',
    html: rackMarkerHtml(highlighted),
    iconSize: [RACK_MARKER_SIZE, RACK_MARKER_SIZE],
    iconAnchor: [half, half],
    popupAnchor: [0, -half - 2],
    tooltipAnchor: [0, -half - 2],
  });
  iconCache.set(key, icon);
  return icon;
}

/** Fits the plan into the viewport once and restricts panning/zooming to sensible limits. */
function FitPlan({ bounds, focus }: { bounds: L.LatLngBoundsExpression; focus?: L.LatLngTuple | null }) {
  const map = useMap();
  const focused = useRef(false);
  useEffect(() => {
    const b = L.latLngBounds(bounds as L.LatLngBoundsLiteral);
    map.invalidateSize();
    map.fitBounds(b, { padding: [10, 10] });
    const fitZoom = map.getBoundsZoom(b, false, L.point(10, 10));
    map.setMinZoom(fitZoom - 1);
    map.setMaxBounds(b.pad(0.3));
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
  // zoom to the highlighted marker once – it may only be known after the markers have loaded
  const [fy, fx] = focus ?? [];
  useEffect(() => {
    if (fy === undefined || fx === undefined || focused.current) return;
    focused.current = true;
    const fitZoom = map.getBoundsZoom(L.latLngBounds(bounds as L.LatLngBoundsLiteral), false, L.point(10, 10));
    map.setView([fy, fx], Math.min(fitZoom + 1.5, map.getMaxZoom()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fy, fx]);
  return null;
}

function PlacementHandler({ active, onPlace }: { active: boolean; onPlace: (latlng: L.LatLng) => void }) {
  const map = useMapEvents({
    click(e) {
      if (active) onPlace(e.latlng);
    },
  });
  useEffect(() => {
    map.getContainer().style.cursor = active ? 'crosshair' : '';
  }, [active, map]);
  return null;
}

export function FloorPlanMap({
  floor,
  buildingId,
  height = 560,
  highlightAssetId,
  highlightRackId,
  readOnly = false,
}: {
  floor: Floor;
  buildingId: string;
  height?: number;
  /** Optional: emphasise and center one asset (e.g. on the asset detail page) */
  highlightAssetId?: string;
  /** Optional: emphasise and center one rack (link from the rack page) */
  highlightRackId?: string;
  /** Hide editing and plan management controls */
  readOnly?: boolean;
}) {
  const { can } = useSession();
  const { message, modal } = App.useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const invalidate = useInvalidate();
  // placing moves existing devices and racks (local administrators too)
  const canPlace = can('asset.edit') && !readOnly;
  const canPlaceRacks = can('location.edit') && !readOnly;
  const canEdit = canPlace || canPlaceRacks;
  const canManagePlan = can('location.write') && !readOnly;

  const [editMode, setEditMode] = useState(false);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [visibleTypes, setVisibleTypes] = useState<AssetType[]>([...ASSET_TYPE_KEYS]);
  const [showRacks, setShowRacks] = useState(true);
  const [unplacedFilter, setUnplacedFilter] = useState('');
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setEditMode(false);
    setPlacing(null);
  }, [floor.id]);

  const floorAssets = useAssets({ floorId: floor.id, pageSize: 1000 });
  const candidates = useAssets({ buildingId, placed: 'no', pageSize: 500 }, canPlace && editMode);
  const buildingRacks = useRacks({ buildingId });

  const w = floor.plan_width ?? 1000;
  const h = floor.plan_height ?? 1000;
  const bounds: L.LatLngBoundsLiteral = [
    [0, 0],
    [h, w],
  ];
  const toLatLng = (a: Pick<Asset, 'map_x' | 'map_y'>): L.LatLngTuple => [h * (1 - (a.map_y ?? 0)), w * (a.map_x ?? 0)];
  const fromLatLng = (ll: L.LatLng) => ({ map_x: +clamp01(ll.lng / w).toFixed(5), map_y: +clamp01(1 - ll.lat / h).toFixed(5) });

  const onFloor = useMemo(() => (floorAssets.data?.items ?? []).filter((a) => a.floor_id === floor.id), [floorAssets.data, floor.id]);
  const placed = onFloor.filter((a) => a.map_x !== null && a.map_y !== null);
  const visible = placed.filter((a) => visibleTypes.includes(a.type));
  const unplaced = useMemo(() => {
    const list = (candidates.data?.items ?? []).filter((a) => a.floor_id === null || a.floor_id === floor.id);
    const q = unplacedFilter.trim().toLowerCase();
    return q ? list.filter((a) => a.name.toLowerCase().includes(q) || (a.ip_address ?? '').includes(q)) : list;
  }, [candidates.data, floor.id, unplacedFilter]);

  const floorRacks = useMemo(() => (buildingRacks.data ?? []).filter((r) => r.floor_id === floor.id), [buildingRacks.data, floor.id]);
  const placedRacks = floorRacks.filter((r) => r.map_x !== null && r.map_y !== null);
  const visibleRacks = showRacks ? placedRacks : [];
  // racks of this floor or without a floor that have no position yet
  const unplacedRacks = useMemo(() => {
    if (!canPlaceRacks || !editMode) return [];
    const list = (buildingRacks.data ?? []).filter((r) => (r.map_x === null || r.map_y === null) && (r.floor_id === null || r.floor_id === floor.id));
    const q = unplacedFilter.trim().toLowerCase();
    return q ? list.filter((r) => r.name.toLowerCase().includes(q) || (r.room ?? '').toLowerCase().includes(q)) : list;
  }, [buildingRacks.data, canPlaceRacks, editMode, floor.id, unplacedFilter]);

  const highlighted = placed.find((a) => a.id === highlightAssetId);
  const highlightedRack = placedRacks.find((r) => r.id === highlightRackId);
  const countByType = (t: AssetType) => placed.filter((a) => a.type === t).length;

  const savePosition = async (assetId: string, pos: Position, successText?: string) => {
    try {
      await http.patch(`/api/assets/${assetId}/position`, { floor_id: floor.id, ...pos });
      if (successText) message.success(successText);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
      await invalidate();
    }
  };

  const saveRackPosition = async (rackId: string, pos: Position, successText?: string) => {
    try {
      await http.patch(`/api/racks/${rackId}/position`, { floor_id: floor.id, ...pos });
      if (successText) message.success(successText);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
      await invalidate();
    }
  };

  const uploadPlan = async (file: File) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      message.error('Please upload a PNG, JPEG or WebP image.');
      return;
    }
    setUploading(true);
    try {
      await http.upload(`/api/floors/${floor.id}/plan`, file, undefined, 'PUT');
      message.success('Floor plan uploaded');
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setUploading(false);
    }
  };

  const removePlan = async () => {
    try {
      await http.del(`/api/floors/${floor.id}/plan`);
      message.success('Floor plan removed');
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const uploadButton = (label: string, primary = false) => (
    <Upload
      accept="image/png,image/jpeg,image/webp"
      showUploadList={false}
      beforeUpload={(file) => {
        void uploadPlan(file);
        return false;
      }}
    >
      <Button icon={<UploadOutlined />} loading={uploading} type={primary ? 'primary' : 'default'}>
        {label}
      </Button>
    </Upload>
  );

  if (!floor.has_plan || !floor.plan_width || !floor.plan_height) {
    return (
      <div className="map-container" style={{ height: Math.min(height, 360), display: 'grid', placeItems: 'center' }}>
        <Empty
          description={
            <span>
              No floor plan uploaded for <strong>{floor.name}</strong>.
              {(onFloor.length > 0 || floorRacks.length > 0) && (
                <div className="muted">
                  {[
                    onFloor.length ? `${onFloor.length} device${onFloor.length === 1 ? '' : 's'}` : null,
                    floorRacks.length ? `${floorRacks.length} rack${floorRacks.length === 1 ? '' : 's'}` : null,
                  ]
                    .filter(Boolean)
                    .join(' and ')}{' '}
                  assigned to this floor.
                </div>
              )}
            </span>
          }
        >
          {canManagePlan && (
            <Space direction="vertical" align="center">
              {uploadButton('Upload floor plan', true)}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                PNG, JPEG or WebP · max. 15 MB · export PDF/CAD plans as image first
              </Typography.Text>
            </Space>
          )}
        </Empty>
      </div>
    );
  }

  const placingName =
    placing?.kind === 'rack'
      ? unplacedRacks.find((r) => r.id === placing.id)?.name
      : placing
        ? unplaced.find((a) => a.id === placing.id)?.name
        : undefined;
  const placingActive = !!placing && !!placingName;
  const togglePlacing = (next: Placing) => setPlacing(placing?.kind === next.kind && placing.id === next.id ? null : next);

  return (
    <div>
      <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <Checkbox.Group<string>
          value={[...(showRacks ? [RACKS] : []), ...visibleTypes]}
          onChange={(v) => {
            setShowRacks(v.includes(RACKS));
            setVisibleTypes(v.filter((x) => x !== RACKS) as AssetType[]);
          }}
          options={[
            {
              value: RACKS,
              label: (
                <Space size={4}>
                  <span style={{ display: 'inline-block', width: 12, height: 10, borderRadius: 2, background: RACK_MARKER_COLOR }} />
                  Racks
                  <span className="muted">({placedRacks.length})</span>
                </Space>
              ),
            },
            ...ASSET_TYPE_KEYS.map((t) => ({
              value: t as string,
              label: (
                <Space size={4}>
                  <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: ASSET_TYPES[t].color }} />
                  {ASSET_TYPES[t].plural}
                  <span className="muted">({countByType(t)})</span>
                </Space>
              ),
            })),
          ]}
        />
        <div style={{ flex: 1 }} />
        {canEdit && (
          <AntTooltip title="Drag markers to move devices and racks. Place items without a position by selecting them in the list and clicking on the plan.">
            <Space size={8} style={{ fontSize: 15 }}>
              <DragOutlined className="muted" />
              <span>Edit positions</span>
              <Switch
                checked={editMode}
                onChange={(v) => {
                  setEditMode(v);
                  setPlacing(null);
                }}
              />
            </Space>
          </AntTooltip>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadPlan(f);
            e.target.value = '';
          }}
        />
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              ...(canManagePlan ? [{ key: 'replace', icon: <UploadOutlined />, label: 'Replace floor plan' }] : []),
              { key: 'print', icon: <PrinterOutlined />, label: 'Print' },
              ...(canManagePlan ? [{ type: 'divider' as const }, { key: 'remove', icon: <DeleteOutlined />, label: 'Remove floor plan', danger: true }] : []),
            ],
            onClick: ({ key }) => {
              if (key === 'replace') fileRef.current?.click();
              if (key === 'print') window.print();
              if (key === 'remove')
                modal.confirm({
                  title: 'Remove the floor plan image?',
                  content: 'Device positions are kept and come back when you upload a new plan.',
                  okText: 'Remove',
                  okButtonProps: { danger: true },
                  onOk: removePlan,
                });
            },
          }}
        >
          <Button icon={<MoreOutlined />} loading={uploading}>
            Plan
          </Button>
        </Dropdown>
      </div>

      {placingActive && (
        <div className="no-print" style={{ marginBottom: 8 }}>
          <Tag color="cyan" icon={<AimOutlined />} closable onClose={() => setPlacing(null)}>
            Click on the plan to place {placing.kind === 'rack' ? 'rack ' : ''}
            <strong>{placingName}</strong>
          </Tag>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div className="map-container" style={{ height, flex: '1 1 480px', minWidth: 0 }}>
          <MapContainer
            key={`${floor.id}-${floor.plan_updated_at ?? ''}`}
            crs={L.CRS.Simple}
            bounds={bounds}
            minZoom={-5}
            maxZoom={3}
            zoomSnap={0.25}
            zoomDelta={0.5}
            attributionControl={false}
            className="floorplan-container"
            style={{ height: '100%', width: '100%' }}
          >
            <ImageOverlay url={`/api/floors/${floor.id}/plan?v=${encodeURIComponent(floor.plan_updated_at ?? '')}`} bounds={bounds} />
            <FitPlan bounds={bounds} focus={highlighted ? toLatLng(highlighted) : highlightedRack ? toLatLng(highlightedRack) : null} />
            <PlacementHandler
              active={placingActive}
              onPlace={(ll) => {
                const target = placing!;
                setPlacing(null);
                if (target.kind === 'rack') void saveRackPosition(target.id, fromLatLng(ll), 'Rack placed');
                else void savePosition(target.id, fromLatLng(ll), 'Asset placed');
              }}
            />
            {visibleRacks.map((r) => (
              <Marker
                key={`rack-${r.id}`}
                position={toLatLng(r)}
                icon={rackIcon(r.id === highlightRackId)}
                draggable={canPlaceRacks && editMode}
                // below the device markers, so devices placed on top of a rack stay clickable
                zIndexOffset={r.id === highlightRackId ? 1000 : -500}
                eventHandlers={{
                  dragend: (e) => {
                    const ll = (e.target as L.Marker).getLatLng();
                    void saveRackPosition(r.id, fromLatLng(ll));
                  },
                }}
              >
                <Tooltip direction="top">
                  <strong>Rack {r.name}</strong>
                  {r.room && <span style={{ marginLeft: 6 }}>{r.room}</span>}
                </Tooltip>
                <Popup>
                  <div style={{ minWidth: 200 }}>
                    <Link to={`/racks/${r.id}`}>
                      <strong>Rack {r.name}</strong>
                    </Link>
                    <div style={{ fontSize: 12, marginTop: 6 }}>
                      <div>
                        <span className="muted">Room: </span>
                        {dash(r.room)}
                      </div>
                      <div>
                        <span className="muted">Capacity: </span>
                        {r.used_u ?? 0} of {r.height_u} U used
                      </div>
                      <div>
                        <span className="muted">Devices: </span>
                        {r.asset_count ?? 0}
                      </div>
                      <div>
                        <span className="muted">Model: </span>
                        {dash([r.manufacturer, r.model].filter(Boolean).join(' '))}
                      </div>
                    </div>
                    {canPlaceRacks && (
                      <Popconfirm title="Remove this rack from the plan?" onConfirm={() => saveRackPosition(r.id, { map_x: null, map_y: null }, 'Removed from plan')}>
                        <Button danger type="link" style={{ paddingLeft: 0, marginTop: 4 }}>
                          Remove from plan
                        </Button>
                      </Popconfirm>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
            {visible.map((a) => (
              <Marker
                key={a.id}
                position={toLatLng(a)}
                icon={assetIcon(a, a.id === highlightAssetId)}
                draggable={canPlace && editMode}
                zIndexOffset={a.id === highlightAssetId ? 1000 : 0}
                eventHandlers={{
                  dragend: (e) => {
                    const ll = (e.target as L.Marker).getLatLng();
                    void savePosition(a.id, fromLatLng(ll));
                  },
                }}
              >
                <Tooltip direction="right">
                  <strong>{a.name}</strong>
                  {a.ip_address && <span className="mono" style={{ marginLeft: 6 }}>{a.ip_address}</span>}
                </Tooltip>
                <Popup>
                  <div style={{ minWidth: 200 }}>
                    <Link to={`/assets/${a.id}`}>
                      <strong>{a.name}</strong>
                    </Link>
                    <div style={{ margin: '6px 0' }}>
                      <AssetTypeTag type={a.type} />
                      <AssetStatusTag status={a.status} />
                    </div>
                    <div style={{ fontSize: 12 }}>
                      <div>
                        <span className="muted">IP: </span>
                        <span className="mono">{dash(a.ip_address)}</span>
                      </div>
                      <div>
                        <span className="muted">Room: </span>
                        {dash(a.room)}
                      </div>
                      <div>
                        <span className="muted">Model: </span>
                        {dash([a.manufacturer, a.model].filter(Boolean).join(' '))}
                      </div>
                    </div>
                    {canPlace && (
                      <Popconfirm title="Remove this asset from the plan?" onConfirm={() => savePosition(a.id, { map_x: null, map_y: null }, 'Removed from plan')}>
                        <Button danger type="link" style={{ paddingLeft: 0, marginTop: 4 }}>
                          Remove from plan
                        </Button>
                      </Popconfirm>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>

        {canEdit && editMode && (
          <div className="no-print" style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', height, border: '1px solid var(--cmdb-border)', borderRadius: 6, background: 'var(--cmdb-surface)' }}>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--cmdb-border-soft)' }}>
              <Typography.Text strong>Not placed yet</Typography.Text>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '2px 0 8px' }}>
                Racks and devices of this building without a position. Select one, then click on the plan.
              </Typography.Paragraph>
              <Input.Search allowClear placeholder="Filter…" value={unplacedFilter} onChange={(e) => setUnplacedFilter(e.target.value)} />
            </div>
            <div style={{ flex: 1, overflow: 'auto' }}>
              <List<{ kind: 'rack'; rack: Rack } | { kind: 'asset'; asset: Asset }>
                loading={(canPlace && candidates.isLoading) || buildingRacks.isLoading}
                dataSource={[...unplacedRacks.map((rack) => ({ kind: 'rack' as const, rack })), ...unplaced.map((asset) => ({ kind: 'asset' as const, asset }))]}
                rowKey={(x) => (x.kind === 'rack' ? `rack-${x.rack.id}` : x.asset.id)}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Everything is placed" /> }}
                renderItem={(x) => {
                  const id = x.kind === 'rack' ? x.rack.id : x.asset.id;
                  const selected = placing?.kind === x.kind && placing.id === id;
                  return (
                    <List.Item
                      onClick={() => togglePlacing({ kind: x.kind, id })}
                      style={{ cursor: 'pointer', paddingInline: 12, background: selected ? 'var(--cmdb-primary-soft)' : undefined }}
                    >
                      <Space size={6} style={{ minWidth: 0 }}>
                        {x.kind === 'rack' ? (
                          <Tag icon={<HddOutlined />} style={{ marginInlineEnd: 0, background: RACK_MARKER_COLOR, color: '#fff', borderColor: RACK_MARKER_COLOR }}>
                            Rack
                          </Tag>
                        ) : (
                          <AssetTypeTag type={x.asset.type} short />
                        )}
                        <span style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.kind === 'rack' ? x.rack.name : x.asset.name}</div>
                          <div className="muted" style={{ fontSize: 11 }}>
                            {x.kind === 'rack' ? (
                              <>
                                {x.rack.floor_id ? 'on this floor' : 'no floor assigned'}
                                {x.rack.room ? ` · ${x.rack.room}` : ''}
                                {` · ${x.rack.height_u} U`}
                              </>
                            ) : (
                              <>
                                {x.asset.floor_id ? 'on this floor' : 'no floor assigned'}
                                {x.asset.ip_address ? ` · ${x.asset.ip_address}` : ''}
                              </>
                            )}
                          </div>
                        </span>
                      </Space>
                    </List.Item>
                  );
                }}
              />
            </div>
          </div>
        )}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
        {placed.length} of {onFloor.length} devices
        {floorRacks.length > 0 ? ` and ${placedRacks.length} of ${floorRacks.length} racks` : ''} on this floor are positioned on the plan
        {(onFloor.length > placed.length || floorRacks.length > placedRacks.length) && canEdit && !editMode ? ' – switch on "Edit positions" to place the rest.' : '.'}
      </Typography.Text>
    </div>
  );
}
