// Shared pieces for the simple page layout: "More" menu, About card, file downloads.
import { App, Button, Card, Dropdown, type MenuProps } from 'antd';
import { MoreOutlined } from '@ant-design/icons';
import { buildUrl, type Query } from '../lib/api';

/** Starts a browser download for a same-origin URL (cookie session is sent along). */
export function download(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function exportUrl(dataset: string, format: string, query?: Query) {
  return buildUrl(`/api/export/${dataset}`, { ...query, format });
}

export interface MoreItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  /** Ask before running onClick */
  confirm?: { title: string; content?: React.ReactNode; okText?: string };
  hidden?: boolean;
  divider?: boolean;
}

/** One "More" button collecting all secondary page actions. Dangerous actions ask first. */
export function MoreMenu({ items, label = 'More' }: { items: MoreItem[]; label?: string }) {
  const { modal } = App.useApp();
  const visible = items.filter((i) => !i.hidden);
  if (!visible.length) return null;
  const menuItems: MenuProps['items'] = [];
  visible.forEach((i, idx) => {
    if (i.divider && idx > 0) menuItems.push({ type: 'divider', key: `d-${i.key}` });
    menuItems.push({ key: i.key, label: i.label, icon: i.icon, danger: i.danger });
  });
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: menuItems,
        style: { minWidth: 240 },
        onClick: ({ key }) => {
          const item = visible.find((i) => i.key === key);
          if (!item?.onClick) return;
          if (item.confirm) {
            modal.confirm({
              title: item.confirm.title,
              content: item.confirm.content,
              okText: item.confirm.okText ?? 'Delete',
              okButtonProps: { danger: item.danger },
              cancelText: 'Cancel',
              onOk: item.onClick,
            });
          } else item.onClick();
        },
      }}
    >
      <Button size="large" icon={<MoreOutlined />}>
        {label}
      </Button>
    </Dropdown>
  );
}

/** Compact "About" card: shows only fields that have a value, two columns on wide screens. */
export function AboutCard({ title = 'About', rows, extra, empty = 'No details yet' }: { title?: React.ReactNode; rows: [string, React.ReactNode][]; extra?: React.ReactNode; empty?: string }) {
  const filled = rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);
  return (
    <Card title={title} extra={extra}>
      {filled.length ? (
        <div className="about-grid">
          {filled.map(([label, value]) => (
            <div key={label} className="about-row">
              <div className="about-label">{label}</div>
              <div className="about-value">{value}</div>
            </div>
          ))}
        </div>
      ) : (
        <span className="muted">{empty}</span>
      )}
    </Card>
  );
}

/** Section heading inside a page with an optional action on the right */
export function SectionHead({ title, extra }: { title: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="section-head">
      <div className="section-title">{title}</div>
      {extra}
    </div>
  );
}
