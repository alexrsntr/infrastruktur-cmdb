import { Link } from 'react-router';
import { Tooltip } from 'antd';
import { ASSET_TYPES, type Asset } from '../../../shared/model';

/** Lightweight static preview of an asset's position on its floor plan (no Leaflet). */
export function FloorPlanPreview({ asset, planUpdatedAt }: { asset: Asset; planUpdatedAt?: string | null }) {
  if (!asset.floor_id) return null;
  const placed = asset.map_x !== null && asset.map_y !== null;
  return (
    <Link to={`/buildings/${asset.building_id}?floor=${asset.floor_id}`}>
      <div style={{ position: 'relative', border: '1px solid #e5e9ef', borderRadius: 6, overflow: 'hidden', background: '#fff' }}>
        <img
          src={`/api/floors/${asset.floor_id}/plan${planUpdatedAt ? `?v=${encodeURIComponent(planUpdatedAt)}` : ''}`}
          alt={`Floor plan ${asset.floor_name ?? ''}`}
          style={{ display: 'block', width: '100%' }}
          onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')}
        />
        {placed && (
          <Tooltip title={`${asset.name} – open floor plan`}>
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
          </Tooltip>
        )}
      </div>
    </Link>
  );
}
