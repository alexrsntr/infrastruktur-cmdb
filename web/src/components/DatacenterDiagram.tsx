import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Empty, Switch, Tag, Tooltip, Typography } from 'antd';
import { ApartmentOutlined, ClusterOutlined } from '@ant-design/icons';
import { ASSET_TYPES, RELATION_TYPES, type RelationType } from '../../../shared/model';
import {
  DC_LINK_KIND_META,
  DC_SITE_ROLE_META,
  type DatacenterConnection,
  type DatacenterDetail,
  type DatacenterSiteDetail,
  type DcDevice,
} from '../../../shared/datacenters';
import { ASSET_STATUS_META } from '../../../shared/model';
import { STATUS_COLOR } from './Simple';

/** Line style per relation type */
const REL_STYLE: Record<RelationType, { color: string; dash?: string }> = {
  connected_to: { color: '#1668dc' },
  uplink: { color: '#13a8a8' },
  redundant_with: { color: '#1668dc', dash: '7 5' },
  depends_on: { color: '#722ed1', dash: '2 4' },
  runs_on: { color: '#8c99a6' },
  powered_by: { color: '#c41d7f', dash: '1 4' },
};

interface Path {
  id: string;
  d: string;
  conn: DatacenterConnection;
  cross: boolean;
  labels: { x: number; y: number; text: string; anchor: 'start' | 'end' }[];
  /** lowest point of the line incl. labels (container coordinates) */
  bottom: number;
}

const NARROW = 900;

/**
 * Data center diagram: one column per site (site A | links | site B, a witness as narrow third column),
 * racks with their devices, the fibre/WAN links between the sites and lines for device connections.
 * Lines are drawn from measured DOM positions and recomputed whenever the layout changes.
 */
export function DatacenterDiagram({ dc }: { dc: DatacenterDetail }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<Path[]>([]);
  const [narrow, setNarrow] = useState(false);
  const [hoverConn, setHoverConn] = useState<string | null>(null);
  const [hoverDevice, setHoverDevice] = useState<string | null>(null);
  const [showInternal, setShowInternal] = useState(false);
  /** The link list in the middle band starts below the lines between the sites so text and lines never overlap */
  const [bandTop, setBandTop] = useState<number | null>(null);

  const mainSites = dc.sites.filter((s) => s.role !== 'witness');
  const witness = dc.sites.find((s) => s.role === 'witness');
  const siteIndex = useMemo(() => new Map(dc.sites.map((s, i) => [s.id, i])), [dc.sites]);
  const stretchedMembers = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of dc.clusters) if (c.stretched) for (const ids of Object.values(c.sites)) for (const id of ids) m.set(id, c.name);
    return m;
  }, [dc.clusters]);

  const visibleConnections = useMemo(
    () => dc.connections.filter((c) => showInternal || c.source_site_id !== c.target_site_id),
    [dc.connections, showInternal],
  );

  const setRowRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) rowRefs.current.set(id, el);
      else rowRefs.current.delete(id);
    },
    [],
  );

  const recompute = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const isNarrow = container.clientWidth < NARROW;
    setNarrow(isNarrow);
    if (isNarrow) {
      setPaths([]);
      setBandTop(null);
      return;
    }
    const base = container.getBoundingClientRect();
    const next: Path[] = [];
    // Several lines between the same rows are fanned out a little so they stay distinguishable
    const pairTotal = new Map<string, number>();
    for (const c of visibleConnections) {
      const k = [c.source_id, c.target_id].sort().join('|');
      pairTotal.set(k, (pairTotal.get(k) ?? 0) + 1);
    }
    const pairCount = new Map<string, number>();
    for (const conn of visibleConnections) {
      const a = rowRefs.current.get(conn.source_id);
      const b = rowRefs.current.get(conn.target_id);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const pairKey = [conn.source_id, conn.target_id].sort().join('|');
      const n = pairCount.get(pairKey) ?? 0;
      pairCount.set(pairKey, n + 1);
      const offset = (n - ((pairTotal.get(pairKey) ?? 1) - 1) / 2) * 9;
      const cross = conn.source_site_id !== conn.target_site_id;
      if (cross) {
        const leftFirst = (siteIndex.get(conn.source_site_id) ?? 0) <= (siteIndex.get(conn.target_site_id) ?? 0);
        const [l, r, lPort, rPort] = leftFirst ? [ra, rb, conn.source_port, conn.target_port] : [rb, ra, conn.target_port, conn.source_port];
        const x1 = l.right - base.left;
        const y1 = l.top + l.height / 2 - base.top + offset;
        const x2 = r.left - base.left;
        const y2 = r.top + r.height / 2 - base.top + offset;
        const dx = Math.max(60, (x2 - x1) * 0.45);
        next.push({
          id: conn.id,
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
          conn,
          cross,
          bottom: Math.max(y1, y2) + 18,
          labels: [
            ...(lPort ? [{ x: x1 + 6, y: offset > 0 ? y1 + 14 : y1 - 5, text: lPort, anchor: 'start' as const }] : []),
            ...(rPort ? [{ x: x2 - 6, y: offset > 0 ? y2 + 14 : y2 - 5, text: rPort, anchor: 'end' as const }] : []),
          ],
        });
      } else {
        // inside one site: a bracket on the right edge of the rack column
        const x = Math.max(ra.right, rb.right) - base.left;
        const y1 = ra.top + ra.height / 2 - base.top;
        const y2 = rb.top + rb.height / 2 - base.top;
        const bulge = 22 + Math.abs(offset);
        next.push({ id: conn.id, d: `M ${x} ${y1} C ${x + bulge} ${y1}, ${x + bulge} ${y2}, ${x} ${y2}`, conn, cross, labels: [], bottom: Math.max(y1, y2) });
      }
    }
    setPaths(next);
    const crossBottoms = next.filter((p) => p.cross).map((p) => p.bottom);
    setBandTop(crossBottoms.length ? Math.round(Math.max(...crossBottoms) + 20) : null);
  }, [visibleConnections, siteIndex]);

  useLayoutEffect(() => {
    recompute();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(container);
    window.addEventListener('resize', recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [recompute, dc]);

  const highlighted = (deviceId: string) =>
    hoverDevice === deviceId || (!!hoverConn && visibleConnections.some((c) => c.id === hoverConn && (c.source_id === deviceId || c.target_id === deviceId)));
  const connActive = (c: DatacenterConnection) => hoverConn === c.id || (!!hoverDevice && (c.source_id === hoverDevice || c.target_id === hoverDevice));
  const crossCount = dc.connections.filter((c) => c.source_site_id !== c.target_site_id).length;

  const siteColumn = (site: DatacenterSiteDetail, compact = false) => (
    <div className={`dc-site${compact ? ' witness' : ''}`} key={site.id}>
      <div className="dc-site-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="dc-site-name">{site.name}</span>
          <Tag color={DC_SITE_ROLE_META[site.role].color} style={{ marginInlineEnd: 0 }}>
            {DC_SITE_ROLE_META[site.role].label}
          </Tag>
        </div>
        <Link to={`/buildings/${site.building_id}?tab=racks`} className="dc-site-building">
          {site.building_code} – {site.building_name}
        </Link>
        {site.room && <div className="dc-site-room">{site.room}</div>}
        <div className="dc-site-counts">
          {site.rack_count} racks · {site.device_count} devices
        </div>
      </div>
      {site.racks.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={site.role === 'witness' ? 'Witness – no racks documented' : 'No racks in this room yet'}
          style={{ margin: '16px 0' }}
        />
      ) : (
        site.racks.map((rack) => (
          <div className="dc-rack" key={rack.id ?? `loose-${site.id}`}>
            <div className="dc-rack-head">
              {rack.id ? (
                <Link to={`/racks/${rack.id}`} className="dc-rack-name">
                  Rack {rack.name}
                </Link>
              ) : (
                <span className="dc-rack-name muted">{rack.name}</span>
              )}
              {rack.height_u ? (
                <span className="dc-rack-usage">
                  <span className="dc-rack-bar">
                    <span style={{ width: `${Math.min(100, Math.round((Number(rack.used_u ?? 0) / rack.height_u) * 100))}%` }} />
                  </span>
                  {rack.used_u}/{rack.height_u} U
                </span>
              ) : null}
            </div>
            {rack.devices.length === 0 ? (
              <div className="dc-device empty">No devices mounted</div>
            ) : (
              rack.devices.map((d: DcDevice) => {
                const cluster = stretchedMembers.get(d.id);
                return (
                  <div
                    key={d.id}
                    ref={setRowRef(d.id)}
                    className={`dc-device${highlighted(d.id) ? ' hl' : ''}`}
                    onMouseEnter={() => setHoverDevice(d.id)}
                    onMouseLeave={() => setHoverDevice(null)}
                  >
                    <span className="dc-type" style={{ background: ASSET_TYPES[d.type].color }} title={ASSET_TYPES[d.type].label} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span className="dc-dot" style={{ background: STATUS_COLOR[d.status] }} title={ASSET_STATUS_META[d.status].label} />
                        <Link to={`/assets/${d.id}`} className="dc-device-name">
                          {d.name}
                        </Link>
                        {cluster && (
                          <Tooltip title={`Member of the stretched cluster ${cluster}`}>
                            <Tag color="purple" variant="filled" style={{ marginInlineEnd: 0, fontSize: 12 }}>
                              {cluster}
                            </Tag>
                          </Tooltip>
                        )}
                      </span>
                      {!compact && <span className="dc-device-sub">{[d.model, d.ip_address].filter(Boolean).join(' · ') || ASSET_TYPES[d.type].label}</span>}
                    </span>
                    {d.status !== 'active' && <Tag color={d.status === 'defective' ? 'error' : d.status === 'maintenance' ? 'warning' : 'default'} style={{ marginInlineEnd: 0 }}>{ASSET_STATUS_META[d.status].label}</Tag>}
                    {d.rack_u ? <span className="dc-device-u">U{d.rack_u}</span> : null}
                  </div>
                );
              })
            )}
          </div>
        ))
      )}
    </div>
  );

  const linkBand =
    mainSites.length === 2 ? (
      <div className="dc-band" style={bandTop != null ? { justifyContent: 'flex-start', paddingTop: bandTop } : undefined}>
        <div className="dc-band-title">Site links</div>
        {dc.links.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 13, textAlign: 'center', display: 'block', padding: '0 8px' }}>
            No links documented yet
          </Typography.Text>
        ) : (
          dc.links.map((l) => (
            <Tooltip key={l.id} title={l.note ?? undefined}>
              <div className="dc-link">
                <div className="dc-link-label">{l.label}</div>
                <div className="dc-link-bar" style={{ background: DC_LINK_KIND_META[l.kind].color }} />
                <div className="dc-link-sub">{[DC_LINK_KIND_META[l.kind].label, l.capacity, l.length_m != null ? `${l.length_m} m` : null].filter(Boolean).join(' · ')}</div>
              </div>
            </Tooltip>
          ))
        )}
        {crossCount > 0 && <div className="dc-band-foot">{crossCount} device connection{crossCount === 1 ? '' : 's'} between the sites</div>}
      </div>
    ) : null;

  return (
    <div>
      {dc.clusters.length > 0 && (
        <div className="dc-clusters">
          {dc.clusters.map((c) => {
            const parts = dc.sites.filter((s) => c.sites[s.id]?.length).map((s) => `${c.sites[s.id].length} host${c.sites[s.id].length === 1 ? '' : 's'} in ${s.name}`);
            return (
              <div key={c.name} className={`dc-cluster${c.stretched ? ' stretched' : ''}`}>
                <ClusterOutlined />
                <span>
                  <strong>{c.stretched ? 'Stretched cluster' : 'Cluster'} {c.name}</strong>
                  <span className="muted">: {parts.join(', ')}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="dc-legend">
          {(['connected_to', 'redundant_with', 'uplink'] as RelationType[]).map((r) => (
            <span key={r}>
              <svg width="34" height="10" aria-hidden>
                <line x1="2" y1="5" x2="32" y2="5" stroke={REL_STYLE[r].color} strokeWidth="2.5" strokeDasharray={REL_STYLE[r].dash} />
              </svg>
              {RELATION_TYPES[r].label}
            </span>
          ))}
          <span>
            <svg width="34" height="10" aria-hidden>
              <line x1="2" y1="5" x2="32" y2="5" stroke={DC_LINK_KIND_META.fiber.color} strokeWidth="6" />
            </svg>
            Fibre link between sites
          </span>
        </div>
        {!narrow && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
            <Switch size="small" checked={showInternal} onChange={setShowInternal} />
            Show connections inside a site
          </label>
        )}
      </div>

      <div ref={containerRef} className={`dc-diagram${narrow ? ' narrow' : ''}`}>
        {mainSites[0] && siteColumn(mainSites[0])}
        {linkBand}
        {mainSites[1] && siteColumn(mainSites[1])}
        {witness && siteColumn(witness, true)}

        {!narrow && (
          <svg className="dc-lines" aria-hidden>
            {paths.map((p) => {
              const st = REL_STYLE[p.conn.relation] ?? REL_STYLE.connected_to;
              const active = connActive(p.conn);
              return (
                <g key={p.id} opacity={hoverConn || hoverDevice ? (active ? 1 : 0.18) : p.cross ? 0.95 : 0.6}>
                  <path d={p.d} fill="none" style={{ stroke: 'var(--cmdb-surface)' }} strokeWidth={active ? 7 : 5} />
                  <path d={p.d} fill="none" stroke={st.color} strokeWidth={active ? 3.5 : 2.5} strokeDasharray={st.dash} />
                  <path
                    d={p.d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={14}
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onMouseEnter={() => setHoverConn(p.id)}
                    onMouseLeave={() => setHoverConn(null)}
                  >
                    <title>{`${RELATION_TYPES[p.conn.relation]?.label ?? p.conn.relation}${p.conn.source_port || p.conn.target_port ? ` (${p.conn.source_port ?? '?'} ↔ ${p.conn.target_port ?? '?'})` : ''}`}</title>
                  </path>
                  {(active || !(hoverConn || hoverDevice)) &&
                    p.labels.map((l, i) => (
                      <text key={i} x={l.x} y={l.y} textAnchor={l.anchor} className="dc-port">
                        {l.text}
                      </text>
                    ))}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {mainSites.length === 2 && dc.connections.length === 0 && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          <ApartmentOutlined /> No connections between devices of the two sites are documented yet. Add them on the device page (“Connections”), e.g. core switch A ↔ core switch B.
        </Typography.Paragraph>
      )}

      <style>{`
        .dc-diagram { position: relative; display: flex; gap: 0; align-items: flex-start; }
        .dc-diagram.narrow { flex-direction: column; gap: 16px; }
        .dc-lines { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 1; }
        .dc-dot { flex: 0 0 auto; width: 9px; height: 9px; border-radius: 50%; }
        .dc-site { position: relative; z-index: 0; flex: 1 1 0; min-width: 0; background: var(--cmdb-surface-2); border: 1px solid var(--cmdb-border); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
        .dc-site.witness { flex: 0 0 230px; margin-left: 24px; background: var(--cmdb-surface-2); border-style: dashed; }
        .dc-diagram.narrow .dc-site.witness { flex: 1 1 auto; margin-left: 0; }
        .dc-site-head { display: flex; flex-direction: column; gap: 2px; padding: 2px 4px 6px; border-bottom: 1px solid var(--cmdb-border); }
        .dc-site-name { font-size: 19px; font-weight: 700; color: var(--cmdb-text); }
        .dc-site-building { font-size: 15px; font-weight: 600; }
        .dc-site-room { font-size: 14px; color: var(--cmdb-text-2); }
        .dc-site-counts { font-size: 13px; color: var(--cmdb-muted); margin-top: 2px; }
        .dc-rack { background: var(--cmdb-surface); border: 1px solid var(--cmdb-border); border-radius: 10px; overflow: hidden; }
        .dc-rack-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 9px 12px; background: #2f3740; }
        .dc-rack-name { color: #fff !important; font-weight: 700; font-size: 15px; }
        .dc-rack-name.muted { color: #cfd6de !important; }
        .dc-rack-usage { display: inline-flex; align-items: center; gap: 8px; color: #cfd6de; font-size: 12.5px; white-space: nowrap; }
        .dc-rack-bar { display: inline-block; width: 54px; height: 6px; background: #4a5561; border-radius: 3px; overflow: hidden; }
        .dc-rack-bar span { display: block; height: 100%; background: #69b1ff; }
        .dc-device { position: relative; display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-top: 1px solid var(--cmdb-border-soft); transition: background .12s; }
        .dc-rack-head + .dc-device { border-top: 0; }
        .dc-device.hl { background: var(--cmdb-primary-soft); }
        .dc-device.empty { color: var(--cmdb-muted); font-size: 14px; }
        .dc-type { flex: 0 0 auto; width: 6px; align-self: stretch; border-radius: 3px; }
        .dc-device-name { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dc-device-sub { display: block; color: var(--cmdb-muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dc-device-u { font-family: 'Cascadia Mono', Consolas, monospace; font-size: 12px; color: var(--cmdb-muted); background: var(--cmdb-surface-3); border-radius: 4px; padding: 1px 6px; }
        .dc-band { position: relative; z-index: 2; flex: 0 0 210px; align-self: stretch; display: flex; flex-direction: column; justify-content: center; gap: 18px; padding: 16px 0; pointer-events: none; }
        .dc-band > * { pointer-events: auto; }
        .dc-diagram.narrow .dc-band { flex: 1 1 auto; padding: 0; }
        .dc-band-title { align-self: center; font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--cmdb-muted); background: var(--cmdb-surface); padding: 1px 8px; border-radius: 6px; }
        .dc-band-foot { align-self: center; text-align: center; font-size: 13px; color: var(--cmdb-muted); padding: 1px 8px; background: var(--cmdb-surface); border-radius: 6px; }
        .dc-link { display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: default; }
        .dc-link-label { font-weight: 700; font-size: 14px; color: var(--cmdb-text); text-align: center; padding: 1px 8px; background: var(--cmdb-surface); border-radius: 6px; }
        .dc-link-bar { width: 100%; height: 7px; border-radius: 4px; box-shadow: 0 1px 0 rgba(0,0,0,.1); }
        .dc-link-sub { font-size: 12.5px; color: var(--cmdb-text-2); text-align: center; padding: 1px 8px; background: var(--cmdb-surface); border-radius: 6px; }
        .dc-port { font-size: 11.5px; font-family: 'Cascadia Mono', Consolas, monospace; fill: var(--cmdb-text); paint-order: stroke; stroke: var(--cmdb-surface); stroke-width: 3px; }
        .dc-clusters { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
        .dc-cluster { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 10px; background: var(--cmdb-surface-2); border: 1px solid var(--cmdb-border); font-size: 15px; }
        .dc-cluster.stretched { background: color-mix(in srgb, #722ed1 var(--cmdb-tint-bg), var(--cmdb-surface)); border-color: color-mix(in srgb, #722ed1 40%, var(--cmdb-border)); color: color-mix(in srgb, #391085 var(--cmdb-tint-fg), var(--cmdb-text)); }
        .dc-legend { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13.5px; color: var(--cmdb-text-2); align-items: center; }
        .dc-legend span { display: inline-flex; align-items: center; gap: 6px; }
      `}</style>
    </div>
  );
}
