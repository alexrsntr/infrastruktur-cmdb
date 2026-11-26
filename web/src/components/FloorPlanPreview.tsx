import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Tooltip } from 'antd';
import { ASSET_TYPES, type Asset, type Rack } from '../../../shared/model';
import { RackGlyph } from './rackMarker';

/** Static floor plan image with an optional marker on top, linking to the interactive plan (no Leaflet). */
function PlanPreview({
  to,
  floorId,
  floorName,
  planUpdatedAt,
  tooltip,
  marker,
}: {
  to: string;
  floorId: string;
  floorName?: string | null;
  planUpdatedAt?: string | null;
  tooltip: string;
  marker: ReactNode;
}) {
  return (
    <Link to={to}>
      <div style={{ position: 'relative', border: '1px solid var(--cmdb-border)', borderRadius: 6, overflow: 'hidden', background: '#fff' }}>
        <img
          src={`/api/floors/${floorId}/plan${planUpdatedAt ? `?v=${encodeURIComponent(planUpdatedAt)}` : ''}`}
          alt={`Floor plan ${floorName ?? ''}`}
          style={{ display: 'block', width: '100%' }}
          onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')}
        />
        {marker && <Tooltip title={tooltip}>{marker}</Tooltip>}
      </div>
    </Link>
  );
}

/** Lightweight static preview of an asset's position on its floor plan. */
export function FloorPlanPreview({ asset, planUpdatedAt }: { asset: Asset; planUpdatedAt?: string | null }) {
  if (!asset.floor_id) return null;
  const placed = asset.map_x !== null && asset.map_y !== null;
  return (
    <PlanPreview
      to={`/buildings/${asset.building_id}?floor=${asset.floor_id}`}
      floorId={asset.floor_id}
      floorName={asset.floor_name}
      planUpdatedAt={planUpdatedAt}
      tooltip={`${asset.name} – open floor plan`}
      marker={
        placed && (
          <span
            className="asset-marker selected"
            style={{
              position: 'absolute',
              left: `${asset.map_x! * 100}%`,
              top: `${asset.map_y! * 100}%`,
              transform: 'translate(-50%, -50%)',
              background: ASSET_TYPES[asset.type].color,
              width: 18,
              height: 18,
            }}
          />
        )
      }
    />
  );
}

/** Static preview of a rack's position on the floor plan of its floor (rack page). */
export function RackFloorPlanPreview({ rack }: { rack: Rack }) {
  if (!rack.floor_id || !rack.floor_has_plan) return null;
  const placed = rack.map_x !== null && rack.map_y !== null;
  return (
    <PlanPreview
      to={`/buildings/${rack.building_id}?floor=${rack.floor_id}${placed ? `&rack=${rack.id}` : ''}`}
      floorId={rack.floor_id}
      floorName={rack.floor_name}
      planUpdatedAt={rack.floor_plan_updated_at}
      tooltip={`Rack ${rack.name} – open floor plan`}
      marker={
        placed && (
          <span
            className="rack-marker selected"
            style={{ position: 'absolute', left: `${rack.map_x! * 100}%`, top: `${rack.map_y! * 100}%`, transform: 'translate(-50%, -50%)' }}
          >
            <RackGlyph />
          </span>
        )
      }
    />
  );
}
