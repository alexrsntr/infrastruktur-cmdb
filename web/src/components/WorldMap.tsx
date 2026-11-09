import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router';
import L from 'leaflet';
import { MapContainer, Marker, Popup, Tooltip, useMap } from 'react-leaflet';
import { Space, Tag, Typography } from 'antd';
import { ASSET_TYPES, ASSET_TYPE_KEYS, type Building, type Plant } from '../../../shared/model';
import { BaseLayer, OFFLINE_MAX_ZOOM, useHasTileServer } from './BaseMap';

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const DEFAULT_CENTER: L.LatLngTuple = [35, 15];
const DEFAULT_ZOOM = 2;

const hasCoords = (p: { latitude: number | null; longitude: number | null }) =>
  typeof p.latitude === 'number' && typeof p.longitude === 'number';

function plantIcon(p: Plant, selected: boolean) {
  const count = p.asset_count ?? 0;
  return L.divIcon({
    className: '',
    html: `<div class="plant-marker" style="${selected ? 'background:#13c2c2;transform:scale(1.15);' : ''}">${escapeHtml(p.code)}<span style="opacity:.75;font-weight:400;margin-left:5px">${escapeHtml(count)}</span></div>`,
    iconSize: [60, 24],
    iconAnchor: [30, 12],
    popupAnchor: [0, -12],
  });
}

/** Fits the map to the given points once per distinct set of points. */
function FitToPoints({ points, singleZoom = 11, maxZoom = 12 }: { points: L.LatLngTuple[]; singleZoom?: number; maxZoom?: number }) {
  const map = useMap();
  const signature = points.map((p) => p.join(',')).join('|');
  useEffect(() => {
    if (!points.length) {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    } else if (points.length === 1) {
      map.setView(points[0], singleZoom);
    } else {
      map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return null;
}

/** Re-measures the map when its container is resized (e.g. responsive layouts, tabs). */
function InvalidateOnResize() {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

function SelectionController({ plants, selectedId, markers }: { plants: Plant[]; selectedId?: string; markers: React.RefObject<Map<string, L.Marker>> }) {
  const map = useMap();
  useEffect(() => {
    if (!selectedId) return;
    const p = plants.find((x) => x.id === selectedId);
    if (!p || !hasCoords(p)) return;
    map.flyTo([p.latitude!, p.longitude!], Math.max(map.getZoom(), 6), { duration: 0.8 });
    const marker = markers.current?.get(selectedId);
    if (marker) setTimeout(() => marker.openPopup(), 850);
  }, [selectedId, plants, map, markers]);
  return null;
}

export function PlantPopupContent({ plant }: { plant: Plant }) {
  return (
    <div style={{ minWidth: 200 }}>
      <Space size={6} align="center">
        <Tag color="blue" style={{ marginInlineEnd: 0 }}>
          {plant.code}
        </Tag>
        <Typography.Text strong>{plant.name}</Typography.Text>
      </Space>
      <div className="muted" style={{ fontSize: 12, margin: '4px 0 8px' }}>
        {[plant.city, plant.country].filter(Boolean).join(', ') || '–'}
      </div>
      <table style={{ fontSize: 12, width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          <tr>
            <td className="muted">Buildings</td>
            <td style={{ textAlign: 'right' }}>{plant.building_count ?? 0}</td>
          </tr>
          {ASSET_TYPE_KEYS.filter((t) => (plant.asset_counts?.[t] ?? 0) > 0).map((t) => (
            <tr key={t}>
              <td className="muted">{ASSET_TYPES[t].plural}</td>
              <td style={{ textAlign: 'right' }}>{plant.asset_counts?.[t] ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 8 }}>
        <Link to={`/plants/${plant.id}`}>Open plant →</Link>
      </div>
    </div>
  );
}

export function WorldMap({
  plants,
  height = 400,
  selectedId,
  onSelect,
}: {
  plants: Plant[];
  height?: number | string;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const tiles = useHasTileServer();
  const located = useMemo(() => plants.filter(hasCoords), [plants]);
  const points = useMemo(() => located.map((p) => [p.latitude!, p.longitude!] as L.LatLngTuple), [located]);
  const markers = useRef(new Map<string, L.Marker>());

  return (
    <div className="map-container" style={{ height }}>
      <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} minZoom={2} maxZoom={tiles ? 19 : OFFLINE_MAX_ZOOM} worldCopyJump className="world-map" style={{ height: '100%', width: '100%' }}>
        <BaseLayer />
        <FitToPoints points={points} singleZoom={tiles ? 8 : 5} maxZoom={tiles ? 12 : 6} />
        <InvalidateOnResize />
        <SelectionController plants={located} selectedId={selectedId} markers={markers} />
        {located.map((p) => (
          <Marker
            key={p.id}
            position={[p.latitude!, p.longitude!]}
            icon={plantIcon(p, p.id === selectedId)}
            ref={(m) => {
              if (m) markers.current.set(p.id, m);
              else markers.current.delete(p.id);
            }}
            eventHandlers={{ click: () => onSelect?.(p.id) }}
          >
            <Popup>
              <PlantPopupContent plant={p} />
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}

/** Small map of one plant with its buildings (buildings without coordinates are skipped). */
export function SiteMap({ plant, buildings, height = 260 }: { plant: Plant; buildings: Building[]; height?: number | string }) {
  const tiles = useHasTileServer();
  const located = buildings.filter(hasCoords);
  const points: L.LatLngTuple[] = located.length
    ? located.map((b) => [b.latitude!, b.longitude!])
    : hasCoords(plant)
      ? [[plant.latitude!, plant.longitude!]]
      : [];

  if (!points.length) {
    return (
      <div className="map-container" style={{ height, display: 'grid', placeItems: 'center' }}>
        <Typography.Text type="secondary">No coordinates maintained for this plant.</Typography.Text>
      </div>
    );
  }

  return (
    <div className="map-container" style={{ height }}>
      <MapContainer center={points[0]} zoom={tiles ? 15 : 6} maxZoom={tiles ? 19 : OFFLINE_MAX_ZOOM} className="world-map" style={{ height: '100%', width: '100%' }} scrollWheelZoom={false}>
        <BaseLayer />
        <FitToPoints points={points} singleZoom={tiles ? 15 : 6} maxZoom={tiles ? 17 : OFFLINE_MAX_ZOOM} />
        <InvalidateOnResize />
        {located.length
          ? located.map((b) => (
              <Marker
                key={b.id}
                position={[b.latitude!, b.longitude!]}
                icon={L.divIcon({
                  className: '',
                  html: `<div class="plant-marker" style="background:#134a7c">${escapeHtml(b.code)}</div>`,
                  iconSize: [48, 24],
                  iconAnchor: [24, 12],
                })}
              >
                <Tooltip direction="top" offset={[0, -12]}>
                  {b.name}
                </Tooltip>
                <Popup>
                  <Typography.Text strong>{b.name}</Typography.Text>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {b.asset_count ?? 0} assets · {b.floor_count ?? 0} floors
                  </div>
                  <Link to={`/buildings/${b.id}`}>Open building →</Link>
                </Popup>
              </Marker>
            ))
          : (
              <Marker position={points[0]} icon={plantIcon(plant, false)}>
                <Popup>
                  <PlantPopupContent plant={plant} />
                </Popup>
              </Marker>
            )}
      </MapContainer>
    </div>
  );
}
