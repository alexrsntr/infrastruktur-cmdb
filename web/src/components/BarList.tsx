import { Tooltip, Typography } from 'antd';
import { Link } from 'react-router';

export interface BarItem {
  key: string;
  label: React.ReactNode;
  /** Plain text used in the hover tooltip */
  text: string;
  value: number;
  to?: string;
}

/**
 * Horizontal single-series bar list (magnitude). One hue, value at the bar tip,
 * 4px rounded data end, square at the baseline, hover tooltip per row.
 */
export function BarList({ items, color = 'var(--ant-color-primary, #2563eb)', unit = '' }: { items: BarItem[]; color?: string; unit?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((s, i) => s + i.value, 0);
  return (
    <div role="table" aria-label="bar list">
      {items.map((item) => {
        const pct = (item.value / max) * 100;
        const share = total ? Math.round((item.value / total) * 100) : 0;
        const row = (
          <div
            role="row"
            style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 38%) 1fr', alignItems: 'center', gap: 12, padding: '5px 4px', borderRadius: 4 }}
            className="barlist-row"
          >
            <div role="cell" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.to ? <Link to={item.to}>{item.label}</Link> : item.label}
            </div>
            <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: `0 0 calc(${pct}% - ${pct > 0 ? 40 : 0}px)`, height: 10, background: color, borderRadius: '0 4px 4px 0', minWidth: item.value > 0 ? 3 : 0 }} />
              <Typography.Text style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12.5 }}>
                {item.value.toLocaleString()}
                {unit}
              </Typography.Text>
            </div>
          </div>
        );
        return (
          <Tooltip key={item.key} title={`${item.text}: ${item.value.toLocaleString()}${unit} (${share}%)`} placement="right" mouseEnterDelay={0.15}>
            {row}
          </Tooltip>
        );
      })}
      <style>{`.barlist-row:hover { background: var(--cmdb-hover); }`}</style>
    </div>
  );
}
