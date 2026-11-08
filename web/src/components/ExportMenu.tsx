import { Button, Dropdown, type MenuProps } from 'antd';
import { DownloadOutlined, FileExcelOutlined, FileTextOutlined, CodeOutlined } from '@ant-design/icons';
import { buildUrl, type Query } from '../lib/api';
import { useSession } from '../lib/session';

/**
 * Export dropdown. `dataset` maps to /api/export/<dataset>; the current filters are passed
 * as query so the export always matches what the user sees.
 */
export function ExportMenu({
  dataset,
  query,
  formats = ['xlsx', 'csv', 'json'],
  label = 'Export',
  size,
  type,
}: {
  dataset: string;
  query?: Query;
  formats?: ('xlsx' | 'csv' | 'json')[];
  label?: string;
  size?: 'small' | 'middle';
  type?: 'default' | 'primary';
}) {
  const { can } = useSession();
  if (!can('export')) return null;

  const url = (format: string, extra?: Query) => buildUrl(`/api/export/${dataset}`, { ...query, ...extra, format, page: undefined, pageSize: undefined });
  const download = (href: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const items: MenuProps['items'] = [];
  if (formats.includes('xlsx')) items.push({ key: 'xlsx', icon: <FileExcelOutlined style={{ color: '#217346' }} />, label: 'Excel workbook (.xlsx)', onClick: () => download(url('xlsx')) });
  if (formats.includes('csv')) {
    items.push({ key: 'csv', icon: <FileTextOutlined />, label: 'CSV (semicolon, Excel DE)', onClick: () => download(url('csv')) });
    items.push({ key: 'csv-comma', icon: <FileTextOutlined />, label: 'CSV (comma)', onClick: () => download(url('csv', { sep: 'comma' })) });
  }
  if (formats.includes('json')) items.push({ key: 'json', icon: <CodeOutlined />, label: 'JSON', onClick: () => download(url('json')) });

  return (
    <Dropdown menu={{ items }} trigger={['click']}>
      <Button icon={<DownloadOutlined />} size={size} type={type}>
        {label}
      </Button>
    </Dropdown>
  );
}
