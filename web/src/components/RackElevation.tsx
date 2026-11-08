import { Tooltip } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import {
  ASSET_STATUS_META,
  ASSET_TYPES,
  RACK_ITEM_KIND_META,
  formatRackUnits,
  type Rack,
  type RackAsset,
  type RackItem,
  type RackItemKind,
} from '../../../shared/model';

export type RackSelection = { kind: 'asset' | 'item'; id: string } | null;

const ITEM_STYLE: Record<RackItemKind, { bg: string; fg: string; pattern?: string }> = {
  patch_panel: { bg: '#3d4652', fg: '#e8edf2', pattern: 'radial-gradient(circle, #9aa7b4 1.2px, transparent 1.4px) 0 50% / 9px 100% repeat-x' },
  cable_management: { bg: '#d5dbe2', fg: '#3d4652', pattern: 'repeating-linear-gradient(90deg, #c3cad3 0 2px, transparent 2px 10px)' },
  ups: { bg: '#5a6570', fg: '#f1f4f7', pattern: 'repeating-linear-gradient(0deg, #4d5762 0 2px, transparent 2px 6px)' },
  pdu: { bg: '#6b2737', fg: '#fbe9ee' },
  shelf: { bg: '#e8ebef', fg: '#3d4652', pattern: 'linear-gradient(#b8c0c9, #b8c0c9) 0 100% / 100% 3px no-repeat' },
  blank: { bg: '#eef1f4', fg: '#7b8794' },
  other: { bg: '#cfd6dd', fg: '#2b3138' },
};

/**
 * Front view of a rack. Units are drawn from the top of the rack downwards; U1 is at the bottom
 * (or at the top with top-down numbering). Devices get a coloured stripe by type, other equipment
 * (patch panels, UPS …) a neutral look.
 */
export function RackElevation({
  rack,
  assets,
  items,
  unitHeight = 22,
  compact = false,
  selected,
  onSelect,
  onEmptyClick,
  width = 340,
}: {
  rack: Pick<Rack, 'height_u' | 'numbering'>;
  assets: RackAsset[];
  items: RackItem[];
  unitHeight?: number;
  compact?: boolean;
  selected?: RackSelection;
  onSelect?: (s: RackSelection) => void;
  onEmptyClick?: (u: number) => void;
  width?: number | string;
}) {
  const H = rack.height_u;
  const label = (u: number) => (rack.numbering === 'top_down' ? H - u + 1 : u);
  const occupied = new Set<number>();
  const positioned = assets.filter((a) => a.rack_u);
  for (const a of positioned) for (let u = a.rack_u!; u < a.rack_u! + a.rack_height_u; u++) occupied.add(u);
  for (const i of items) for (let u = i.position_u; u < i.position_u + i.height_u; u++) occupied.add(u);
  const top = (u: number, h: number) => (H - (u + h - 1)) * unitHeight;
  const railW = compact ? 22 : 34;
  const fs = compact ? 9.5 : 12;

  return (
    <div
      style={{
        width,
        maxWidth: '100%',
        background: '#2f3740',
        borderRadius: 6,
        padding: compact ? '6px 0' : '10px 0',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.4)',
      }}
    >
      <div style={{ position: 'relative', height: H * unitHeight, margin: `0 ${railW}px` }}>
        {/* unit grid + rails */}
        {Array.from({ length: H }, (_, k) => H - k).map((u) => {
          const free = !occupied.has(u);
          return (
            <div key={u} style={{ position: 'absolute', top: (H - u) * unitHeight, left: -railW, right: -railW, height: unitHeight, display: 'flex' }}>
              <span className="rack-rail" style={{ width: railW, fontSize: compact ? 8 : 10.5 }}>{!compact || u % 5 === 0 || u === 1 ? label(u) : ''}</span>
              <div
                className={`rack-slot${free && onEmptyClick ? ' clickable' : ''}`}
                style={{ flex: 1 }}
                onClick={free && onEmptyClick ? () => onEmptyClick(u) : undefined}
                title={free && onEmptyClick ? `Mount at U${label(u)}` : undefined}
              >
                {free && onEmptyClick && !compact && (
                  <span className="rack-slot-add">
                    <PlusOutlined /> U{label(u)}
                  </span>
                )}
              </div>
              <span className="rack-rail" style={{ width: railW, fontSize: compact ? 8 : 10.5 }}>{!compact ? label(u) : ''}</span>
            </div>
          );
        })}

        {/* other equipment */}
        {items.map((i) => {
          const st = ITEM_STYLE[i.kind] ?? ITEM_STYLE.other;
          const isSel = selected?.kind === 'item' && selected.id === i.id;
          return (
            <Tooltip key={i.id} title={`${i.label} · ${RACK_ITEM_KIND_META[i.kind]?.label} · U${formatRackUnits(i.position_u, i.height_u)}`} mouseEnterDelay={0.2}>
              <div
                className={`rack-block${isSel ? ' selected' : ''}`}
                onClick={onSelect ? () => onSelect({ kind: 'item', id: i.id }) : undefined}
                style={{
                  top: top(i.position_u, i.height_u),
                  height: i.height_u * unitHeight - 1,
                  background: st.pattern ? `${st.pattern}, ${st.bg}` : st.bg,
                  color: st.fg,
                  fontSize: fs,
                  cursor: onSelect ? 'pointer' : 'default',
                }}
              >
                {!compact && <span className="rack-block-label" style={{ background: st.bg, padding: '0 4px', borderRadius: 2 }}>{i.label}</span>}
              </div>
            </Tooltip>
          );
        })}

        {/* devices */}
        {positioned.map((a) => {
          const t = ASSET_TYPES[a.type];
          const isSel = selected?.kind === 'asset' && selected.id === a.id;
          const tall = a.rack_height_u * unitHeight >= 34;
          return (
            <Tooltip key={a.id} title={`${a.name} · ${t.label} · ${a.model ?? ''} · U${formatRackUnits(a.rack_u, a.rack_height_u)}`} mouseEnterDelay={0.2}>
              <div
                className={`rack-block device${isSel ? ' selected' : ''}`}
                onClick={onSelect ? () => onSelect({ kind: 'asset', id: a.id }) : undefined}
                style={{
                  top: top(a.rack_u!, a.rack_height_u),
                  height: a.rack_height_u * unitHeight - 1,
                  borderLeft: `${compact ? 3 : 5}px solid ${t.color}`,
                  background: `linear-gradient(90deg, ${t.color}26, ${t.color}0d 60%), #fbfcfd`,
                  fontSize: fs,
                  cursor: onSelect ? 'pointer' : 'default',
                  flexDirection: tall ? 'column' : 'row',
                  alignItems: tall ? 'flex-start' : 'center',
                  justifyContent: 'center',
                }}
              >
                <span className="rack-block-label" style={{ fontWeight: 600, color: '#14202e' }}>
                  {a.status !== 'active' && (
                    <span
                      title={ASSET_STATUS_META[a.status].label}
                      style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 5, background: a.status === 'defective' ? '#ff4d4f' : a.status === 'maintenance' ? '#faad14' : '#bfbfbf' }}
                    />
                  )}
                  {a.name}
                </span>
                {!compact && (
                  <span className="rack-block-label" style={{ color: '#4a5a6c', fontSize: fs - 1, marginLeft: tall ? 0 : 8 }}>
                    {[a.model, a.ip_address].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            </Tooltip>
          );
        })}
      </div>
      <style>{`
        .rack-rail { display: flex; align-items: center; justify-content: center; color: #c7d0d9;
          font-family: 'Cascadia Mono', Consolas, monospace; background: #3a434d; border-bottom: 1px solid #2f3740; user-select: none; }
        .rack-slot { background: #1f262d; border-bottom: 1px solid #2a323a; position: relative; }
        .rack-slot.clickable { cursor: pointer; }
        .rack-slot.clickable:hover { background: #2c4a66; }
        .rack-slot-add { display: none; position: absolute; inset: 0; align-items: center; justify-content: center; color: #d6e8f8; font-size: 11px; gap: 4px; }
        .rack-slot.clickable:hover .rack-slot-add { display: flex; }
        .rack-block { position: absolute; left: 1px; right: 1px; border-radius: 2px; display: flex; align-items: center;
          padding: 0 8px; overflow: hidden; box-shadow: 0 0 0 1px rgba(0,0,0,.35); transition: box-shadow .12s; }
        .rack-block:hover { box-shadow: 0 0 0 2px #91caff; z-index: 2; }
        .rack-block.selected { box-shadow: 0 0 0 3px #36cfc9; z-index: 3; }
        .rack-block-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; line-height: 1.25; }
      `}</style>
    </div>
  );
}

export function RackLegend() {
  const sw = (bg: string, extra?: React.CSSProperties) => (
    <span style={{ display: 'inline-block', width: 14, height: 10, borderRadius: 2, background: bg, marginRight: 6, verticalAlign: 'middle', border: '1px solid rgba(0,0,0,.2)', ...extra }} />
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12.5, color: 'var(--cmdb-text-2)' }}>
      {(['switch', 'access_point', 'server', 'ups'] as const).map((t) => (
        <span key={t}>
          {sw('#fbfcfd', { borderLeft: `4px solid ${ASSET_TYPES[t].color}` })}
          {ASSET_TYPES[t].label}
        </span>
      ))}
      <span>{sw(ITEM_STYLE.patch_panel.bg)}Patch panel</span>
      <span>{sw(ITEM_STYLE.cable_management.bg)}Cable mgmt.</span>
      <span>{sw(ITEM_STYLE.ups.bg)}UPS (rack item)</span>
      <span>{sw('#1f262d')}Free</span>
    </div>
  );
}
