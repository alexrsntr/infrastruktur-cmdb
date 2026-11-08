import { Breadcrumb, Space, Typography } from 'antd';
import { Link } from 'react-router';

export interface Crumb {
  title: React.ReactNode;
  to?: string;
}

/** Page title row: small breadcrumb, big title, one-line explanation, actions on the right. */
export function PageHeader({
  title,
  subtitle,
  crumbs = [],
  extra,
  tags,
  icon,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  crumbs?: Crumb[];
  extra?: React.ReactNode;
  tags?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="page-header">
      <div style={{ minWidth: 0, display: 'flex', gap: 16, alignItems: 'center' }}>
        {icon}
        <div style={{ minWidth: 0 }}>
          {crumbs.length > 0 && (
            <Breadcrumb
              style={{ fontSize: 14 }}
              items={crumbs.map((c) => ({ title: c.to ? <Link to={c.to}>{c.title}</Link> : c.title }))}
            />
          )}
          <Space align="center" wrap size={12}>
            <Typography.Title level={2}>{title}</Typography.Title>
            {tags}
          </Space>
          {subtitle && <div className="page-subtitle">{subtitle}</div>}
        </div>
      </div>
      {extra && (
        <Space wrap size={10} className="no-print">
          {extra}
        </Space>
      )}
    </div>
  );
}
