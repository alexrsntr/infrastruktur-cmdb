import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import L from 'leaflet';
import { ImageOverlay, MapContainer, Marker, Popup, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import { App, Alert, Button, Card, Checkbox, Empty, Input, Popconfirm, Segmented, Select, Space, Spin, Switch, Tag, Typography } from 'antd';
import { AimOutlined, DeleteOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { ASSET_TYPES, ASSET_TYPE_KEYS, type AssetType } from '../../../shared/model';
import type { PlanDetail, PlanMarker } from '../../../shared/attachments';
import { errorText, http } from '../lib/api';
import { dash } from '../lib/format';
import { useBuildings, useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';
import { AssetStatusTag, AssetTypeTag } from './Tags';

const SHORT: Record<AssetType, string> = { switch: 'SW', access_point: 'AP', server: 'SRV', ups: 'UPS', vm: 'VM' };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function markerIcon(m: PlanMarker): L.DivIcon {
  if (m.asset_id && m.asset_type) {
    const label = SHORT[m.asset_type];
    return L.divIcon({
      className: '',
      html: `<div class="asset-marker status-${m.asset_status ?? 'active'}" style="background:${ASSET_TYPES[m.asset_type].color};font-size:${label.length > 2 ? 9 : 10}px;font-weight:700">${label}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -14],
      tooltipAnchor: [14, 0],
    });
  }
  if (m.building_id) {
    return L.divIcon({
      className: '',
      html: `<div class="plant-marker" style="transform:translate(-50%,-50%);display:inline-flex">${esc(m.building_code ?? m.building_name ?? 'B')}</div>`,
      iconSize: [0, 0],
      popupAnchor: [0, -14],
      tooltipAnchor: [16, 0],
    });
  }
  return L.divIcon({
    className: '',
    html: `<div class="plan-label-marker">${esc(m.label ?? '')}</div>`,
    iconSize: [0, 0],
    popupAnchor: [0, -12],
    tooltipAnchor: [12, 0],
  });
}

function FitImage({ bounds }: { bounds: L.LatLngBoundsLiteral }) {
  const map = useMap();
  useEffect(() => {
    const b = L.latLngBounds(bounds);
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
  return null;
}

function ClickToPlace({ active, onPlace }: { active: boolean; onPlace: (ll: L.LatLng) => void }) {
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

interface AssetOption {
  id: string;
  name: string;
  type: AssetType;
  building_name: string | null;
}

type Kind = 'device' | 'building' | 'label';
type Pending = { kind: 'device'; id: string; name: string } | { kind: 'building'; id: string; name: string } | { kind: 'label'; text: string } | null;

/**
 * A picture (site plan, aerial photo, hall photo …) with devices, buildings and text labels placed on it.
 * Editors switch on "Edit" to drag markers or place new ones.
 */
export function PlanMap({ plan, height = 640 }: { plan: PlanDetail; height?: number | string }) {
  const { can } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const buildings = useBuildings();
  const canEdit = can('asset.write');
  const [edit, setEdit] = useState(false);
  const [kind, setKind] = useState<Kind>('device');
  const [pending, setPending] = useState<Pending>(null);
  const [labelText, setLabelText] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    if (!edit) setPending(null);
  }, [edit]);

  const W = plan.image_width ?? 1000;
  const H = plan.image_height ?? 700;
  const bounds: L.LatLngBoundsLiteral = [
    [0, 0],
    [H, W],
  ];
  const toLatLng = (x: number, y: number): L.LatLngTuple => [H * (1 - y), W * x];
  const fromLatLng = (ll: L.LatLng) => ({ x: clamp01(ll.lng / W), y: clamp01(1 - ll.lat / H) });

  const placedAssets = useMemo(() => new Set(plan.markers.filter((m) => m.asset_id).map((m) => m.asset_id!)), [plan.markers]);
  const placedBuildings = useMemo(() => new Set(plan.markers.filter((m) => m.building_id).map((m) => m.building_id!)), [plan.markers]);

  const options = useQuery({
    queryKey: ['plan-asset-options', plan.plant_id, debounced],
    queryFn: () => http.get<AssetOption[]>('/api/assets/options', { plantId: plan.plant_id ?? undefined, q: debounced || undefined }),
    enabled: edit && kind === 'device',
  });

  const groupOf = (m: PlanMarker) => (m.asset_type ? m.asset_type : m.building_id ? 'building' : 'label');
  const counts = plan.markers.reduce<Record<string, number>>((acc, m) => ({ ...acc, [groupOf(m)]: (acc[groupOf(m)] ?? 0) + 1 }), {});
  const visible = plan.markers.filter((m) => !hidden.has(groupOf(m)));

  const place = async (ll: L.LatLng) => {
    if (!pending) return;
    const pos = fromLatLng(ll);
    const body =
      pending.kind === 'device' ? { asset_id: pending.id, ...pos } : pending.kind === 'building' ? { building_id: pending.id, ...pos } : { label: pending.text, ...pos };
    try {
      await http.post(`/api/plans/${plan.id}/markers`, body);
      message.success(`${pending.kind === 'label' ? pending.text : pending.name} placed`);
      setPending(null);
      setLabelText('');
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const move = async (m: PlanMarker, ll: L.LatLng) => {
    try {
      await http.patch(`/api/plan-markers/${m.id}`, fromLatLng(ll));
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
      await invalidate();
    }
  };

  const remove = async (m: PlanMarker) => {
    try {
      await http.del(`/api/plan-markers/${m.id}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const filterItems: { key: string; label: React.ReactNode }[] = [
    ...ASSET_TYPE_KEYS.filter((t) => counts[t]).map((t) => ({
      key: t,
      label: (
        <span>
          <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: ASSET_TYPES[t].color, marginRight: 5 }} />
          {ASSET_TYPES[t].plural} <Tag style={{ marginInlineStart: 2 }}>{counts[t]}</Tag>
        </span>
      ),
    })),
    ...(counts.building ? [{ key: 'building', label: <span>Buildings <Tag>{counts.building}</Tag></span> }] : []),
    ...(counts.label ? [{ key: 'label', label: <span>Labels <Tag>{counts.label}</Tag></span> }] : []),
  ];

  const plantBuildings = (buildings.data ?? []).filter((b) => b.plant_id === plan.plant_id);

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 600px', minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          {filterItems.length ? (
            filterItems.map((f) => (
              <Checkbox
                key={f.key}
                checked={!hidden.has(f.key)}
                onChange={(e) =>
                  setHidden((h) => {
                    const n = new Set(h);
                    if (e.target.checked) n.delete(f.key);
                    else n.add(f.key);
                    return n;
                  })
                }
              >
                {f.label}
              </Checkbox>
            ))
          ) : (
            <Typography.Text type="secondary">Nothing placed on this picture yet.</Typography.Text>
          )}
          <div style={{ flex: 1 }} />
          {canEdit && (
            <Space>
              <Typography.Text>Edit</Typography.Text>
              <Switch checked={edit} onChange={setEdit} />
            </Space>
          )}
        </div>
        {pending && (
          <Alert
            type="info"
            showIcon
            icon={<AimOutlined />}
            style={{ marginBottom: 10 }}
            message={
              <span>
                Click on the picture to place <strong>{pending.kind === 'label' ? pending.text : pending.name}</strong>.
              </span>
            }
            action={
              <Button size="small" onClick={() => setPending(null)}>
                Cancel
              </Button>
            }
          />
        )}
        <div className="map-container" style={{ height }}>
          <MapContainer
            key={plan.id}
            crs={L.CRS.Simple}
            bounds={bounds}
            style={{ height: '100%', width: '100%', background: '#fff' }}
            zoomSnap={0.25}
            minZoom={-5}
            maxZoom={4}
            attributionControl={false}
          >
            <FitImage bounds={bounds} />
            <ImageOverlay url={`/api/attachments/${plan.id}/file?v=${encodeURIComponent(plan.updated_at)}`} bounds={bounds} />
            <ClickToPlace active={!!pending} onPlace={place} />
            {visible.map((m) => (
              <Marker
                key={`${m.id}:${m.x}:${m.y}`}
                position={toLatLng(m.x, m.y)}
                icon={markerIcon(m)}
                draggable={edit}
                eventHandlers={{ dragend: (e) => move(m, (e.target as L.Marker).getLatLng()) }}
              >
                <Tooltip direction="right">{m.asset_name ?? m.building_name ?? m.label}</Tooltip>
                <Popup>
                  <div style={{ minWidth: 200 }}>
                    {m.asset_id ? (
                      <>
                        <Link to={`/assets/${m.asset_id}`} style={{ fontWeight: 600, fontSize: 14 }}>
                          {m.asset_name}
                        </Link>
                        <div style={{ margin: '6px 0' }}>
                          {m.asset_type && <AssetTypeTag type={m.asset_type} />}
                          {m.asset_status && <AssetStatusTag status={m.asset_status} />}
                        </div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {[m.asset_model, m.asset_ip].filter(Boolean).join(' · ') || '–'}
                        </div>
                      </>
                    ) : m.building_id ? (
                      <Link to={`/buildings/${m.building_id}`} style={{ fontWeight: 600, fontSize: 14 }}>
                        {m.building_code} – {m.building_name}
                      </Link>
                    ) : (
                      <Typography.Text strong>{m.label}</Typography.Text>
                    )}
                    {edit && (
                      <div style={{ marginTop: 8 }}>
                        <Popconfirm title="Remove from this picture?" onConfirm={() => remove(m)}>
                          <Button size="small" danger icon={<DeleteOutlined />}>
                            Remove from picture
                          </Button>
                        </Popconfirm>
                      </div>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Scroll to zoom, drag to pan. {canEdit ? 'Switch on “Edit” to move markers or add new ones.' : ''}
        </Typography.Text>
      </div>

      {edit && (
        <Card size="small" title="Add to the picture" style={{ flex: '0 1 300px', width: 300 }}>
          <Segmented
            block
            value={kind}
            onChange={(k) => {
              setKind(k as Kind);
              setPending(null);
            }}
            options={[
              { value: 'device', label: 'Device' },
              { value: 'building', label: 'Building' },
              { value: 'label', label: 'Text' },
            ]}
            style={{ marginBottom: 12 }}
          />
          {kind === 'device' && (
            <>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                Choose an access point, switch, server … of this plant, then click on the picture.
              </Typography.Paragraph>
              <Select
                showSearch
                filterOption={false}
                onSearch={setSearch}
                style={{ width: '100%' }}
                placeholder="Search device…"
                value={pending?.kind === 'device' ? pending.id : undefined}
                notFoundContent={options.isFetching ? <Spin size="small" /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No devices" />}
                onChange={(id) => {
                  const o = options.data?.find((x) => x.id === id);
                  if (o) setPending({ kind: 'device', id: o.id, name: o.name });
                }}
                options={(options.data ?? [])
                  .filter((o) => !placedAssets.has(o.id))
                  .map((o) => ({
                    value: o.id,
                    label: (
                      <Space size={6}>
                        <AssetTypeTag type={o.type} short />
                        {o.name}
                        <span className="muted" style={{ fontSize: 12 }}>
                          {dash(o.building_name)}
                        </span>
                      </Space>
                    ),
                  }))}
              />
            </>
          )}
          {kind === 'building' && (
            <>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                Mark where a building is on a site plan or aerial photo. Clicking it opens the building.
              </Typography.Paragraph>
              <Select
                style={{ width: '100%' }}
                placeholder="Select building…"
                value={pending?.kind === 'building' ? pending.id : undefined}
                onChange={(id) => {
                  const b = plantBuildings.find((x) => x.id === id);
                  if (b) setPending({ kind: 'building', id: b.id, name: b.name });
                }}
                options={plantBuildings.filter((b) => !placedBuildings.has(b.id)).map((b) => ({ value: b.id, label: `${b.code} – ${b.name}` }))}
              />
            </>
          )}
          {kind === 'label' && (
            <>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12.5 }}>
                Free text such as “Gate 2”, “Fibre entry”, “Outdoor cabinet”.
              </Typography.Paragraph>
              <Space.Compact style={{ width: '100%' }}>
                <Input value={labelText} onChange={(e) => setLabelText(e.target.value)} maxLength={80} placeholder="Text" onPressEnter={() => labelText.trim() && setPending({ kind: 'label', text: labelText.trim() })} />
                <Button type="primary" disabled={!labelText.trim()} onClick={() => setPending({ kind: 'label', text: labelText.trim() })}>
                  Place
                </Button>
              </Space.Compact>
            </>
          )}
        </Card>
      )}
      <style>{`.plan-label-marker { transform: translate(-50%, -50%); display: inline-block; white-space: nowrap; background: #fff; color: #14202e;
        border: 1px solid #14202e; border-radius: 4px; padding: 1px 6px; font-size: 12px; font-weight: 600; box-shadow: 0 1px 4px rgba(0,0,0,.3); }`}</style>
    </div>
  );
}
