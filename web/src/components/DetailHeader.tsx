import { Breadcrumb, Typography } from 'antd';
import { Link } from 'react-router';
import { C } from '../theme';
import { tintBg, tintFg } from '../lib/palette';
import type { Crumb } from './PageHeader';

/** One key fact in the header of a detail page (location, IP address, model …) */
export interface Fact {
  label: string;
  value: React.ReactNode;
  /** Text copied by the copy button (e.g. the IP address); no button without it */
  copy?: string;
  /** Makes the value a link */
  to?: string;
  /** Hidden when empty – facts without a value are left out */
  hidden?: boolean;
}

/**
 * Head of every detail page (plant, building, rack, device, data center …): breadcrumb, icon, title with status
 * tags, one-line description, the actions on the right and a row of key facts below. On phones the actions move
 * below the title and the facts wrap.
 */
export function DetailHeader({
  crumbs = [],
  icon,
  color = C.primary,
  title,
  tags,
  subtitle,
  facts = [],
  actions,
}: {
  crumbs?: Crumb[];
  icon?: React.ReactNode;
  /** Accent colour of the icon (an asset type colour, C.teal …) */
  color?: string;
  title: React.ReactNode;
  tags?: React.ReactNode;
  subtitle?: React.ReactNode;
  facts?: Fact[];
  /** Primary action(s) and the MoreMenu */
  actions?: React.ReactNode;
}) {
  const shown = facts.filter((f) => !f.hidden && f.value !== null && f.value !== undefined && f.value !== '');
  return (
    <div className="detail-header">
      {crumbs.length > 0 && (
        <Breadcrumb className="detail-crumbs" items={crumbs.map((c) => ({ title: c.to ? <Link to={c.to}>{c.title}</Link> : c.title }))} />
      )}
      <div className="detail-header-main">
        {icon && (
          <span className="detail-icon" style={{ background: tintBg(color), color: tintFg(color) }} aria-hidden>
            {icon}
          </span>
        )}
        <div className="detail-header-text">
          <div className="detail-title-row">
            <Typography.Title level={2} className="detail-title">
              {title}
            </Typography.Title>
            {tags}
          </div>
          {subtitle && <div className="page-subtitle">{subtitle}</div>}
        </div>
        {actions && <div className="detail-actions no-print">{actions}</div>}
      </div>
      {shown.length > 0 && (
        <dl className="fact-row">
          {shown.map((f) => (
            <div key={f.label} className="fact">
              <dt className="fact-label">{f.label}</dt>
              <dd className="fact-value">
                {f.copy ? (
                  <Typography.Text copyable={{ text: f.copy, tooltips: [`Copy ${f.label.toLowerCase()}`, 'Copied'] }}>
                    {f.to ? <Link to={f.to}>{f.value}</Link> : f.value}
                  </Typography.Text>
                ) : f.to ? (
                  <Link to={f.to}>{f.value}</Link>
                ) : (
                  f.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
