import { useEffect, useState } from 'react';
import { GeoJSON, TileLayer } from 'react-leaflet';
import type { Feature, FeatureCollection, Position } from 'geojson';
import { useSession } from '../lib/session';

/**
 * Background of the Leaflet maps.
 * - Default: built-in world map (country borders from Natural Earth, public domain), bundled with the app –
 *   the browser does not contact any external map service.
 * - Optional: your own tile server via MAP_TILE_URL (e.g. an internal OpenStreetMap mirror or Azure Maps).
 */

let countries: Promise<FeatureCollection> | null = null;

const ANTARCTICA = '010'; // ISO 3166-1 numeric

/**
 * The data is made for spherical projections; Leaflet draws rings flat. A ring that crosses the date line
 * (Russia, Fiji) would jump from +180° to -180° and draw a line across the whole map – so longitudes are
 * "unwrapped" to stay continuous (e.g. 190° instead of -170°).
 */
function unwrapRing(ring: Position[]): Position[] {
  let offset = 0;
  return ring.map(([lng, lat], i) => {
    if (i > 0) {
      const prev = ring[i - 1][0];
      if (lng - prev > 180) offset -= 360;
      else if (prev - lng > 180) offset += 360;
    }
    return [lng + offset, lat];
  });
}

function unwrapFeature(f: Feature): Feature {
  const g = f.geometry;
  if (g?.type === 'Polygon') return { ...f, geometry: { ...g, coordinates: g.coordinates.map(unwrapRing) } };
  if (g?.type === 'MultiPolygon') return { ...f, geometry: { ...g, coordinates: g.coordinates.map((p) => p.map(unwrapRing)) } };
  return f;
}

function loadCountries(): Promise<FeatureCollection> {
  countries ??= Promise.all([import('topojson-client'), import('world-atlas/countries-50m.json')]).then(([topo, world]) => {
    const topology = (world.default ?? world) as unknown as Parameters<typeof topo.feature>[0];
    const all = topo.feature(topology, topology.objects.countries) as unknown as FeatureCollection;
    return { ...all, features: all.features.filter((f) => String(f.id) !== ANTARCTICA).map(unwrapFeature) };
  });
  return countries;
}

/** Highest useful zoom level of the built-in map (country borders only). */
export const OFFLINE_MAX_ZOOM = 12;

export function useHasTileServer(): boolean {
  return !!useSession().config.mapTileUrl;
}

export function BaseLayer() {
  const { config } = useSession();
  if (config.mapTileUrl) return <TileLayer url={config.mapTileUrl} attribution={config.mapTileAttribution} />;
  return <CountriesLayer />;
}

function CountriesLayer() {
  const [data, setData] = useState<FeatureCollection | null>(null);
  useEffect(() => {
    let active = true;
    loadCountries()
      .then((d) => active && setData(d))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  if (!data) return null;
  // colours come from CSS (.cmdb-country), so they follow the light/dark theme
  return <GeoJSON data={data} interactive={false} style={{ className: 'cmdb-country', weight: 0.7, fillOpacity: 1 }} attribution="Natural Earth" />;
}
