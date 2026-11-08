import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Card, DatePicker, Input, Result, Select, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import type { AuditEntry, Paged } from '../../../../shared/model';
import { http, type Query } from '../../lib/api';
import { DATE_FORMAT } from '../../lib/format';
import { useUsers } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { FileExcelOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components/PageHeader';
import { download, exportUrl, MoreMenu } from '../../components/PageParts';
import { actionTag, ChangeList } from '../../components/Journal';

const ENTITY_TYPES = ['plant', 'building', 'floor', 'asset', 'user', 'assets', 'plants', 'buildings', 'floors', 'relations', 'notes', 'activities', 'audit', 'users', 'full', 'plant-dossier', 'asset-dossier', 'database'];

function entityLink(e: AuditEntry): string | null {
  if (!e.entity_id || e.action === 'delete') return null;
  switch (e.entity_type) {
    case 'asset':
      return `/assets/${e.entity_id}`;
    case 'plant':
      return `/plants/${e.entity_id}`;
    case 'building':
      return `/buildings/${e.entity_id}`;
    case 'rack':
      return `/racks/${e.entity_id}`;
    default:
      return null;
  }
}

export function AuditPage() {
  const { can } = useSession();
  const allowed = can('audit.read');
  const [params, setParams] = useSearchParams();
  const users = useUsers(can('user.manage'));

  const get = (k: string) => params.get(k) ?? '';
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries({ page: undefined, ...patch })) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const [searchText, setSearchText] = useState(get('q'));
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchText !== get('q')) set({ q: searchText || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [searchText]); // eslint-disable-line react-hooks/exhaustive-deps

  const page = Number(get('page') || 1);
  const pageSize = Number(get('pageSize') || 50);
  const query: Query = {
    q: get('q') || undefined,
    action: get('action') || undefined,
    entityType: get('entityType') || undefined,
    userId: get('userId') || undefined,
    from: get('from') || undefined,
    to: get('to') || undefined,
    page,
    pageSize,
  };

  const log = useQuery({
    queryKey: ['audit', query],
    queryFn: () => http.get<Paged<AuditEntry>>('/api/audit', query),
    enabled: allowed,
    placeholderData: (prev) => prev,
  });
  const actions = useQuery({ queryKey: ['audit-actions'], queryFn: () => http.get<string[]>('/api/audit/actions'), enabled: allowed });

  if (!allowed) {
    return <Result status="403" title="No access" subTitle="The audit log is restricted to administrators." />;
  }

  const range: [dayjs.Dayjs, dayjs.Dayjs] | null = get('from') && get('to') ? [dayjs(get('from')), dayjs(get('to'))] : null;
  const exportQuery: Query = { ...query, page: undefined, pageSize: undefined };

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle="Every change, sign-in, export and import – who did what, when and from where."
        crumbs={[{ title: 'Administration' }, { title: 'Audit log' }]}
        extra={
          <MoreMenu
            items={[
              { key: 'xlsx', icon: <FileExcelOutlined />, label: 'Export this list (Excel)', onClick: () => download(exportUrl('audit', 'xlsx', exportQuery)) },
              { key: 'csv', icon: <FileExcelOutlined />, label: 'Export this list (CSV)', onClick: () => download(exportUrl('audit', 'csv', exportQuery)) },
            ]}
          />
        }
      />
      <Card>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <Input.Search
            allowClear
            placeholder="Search object, user or changed values…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 300 }}
          />
          <Select
            allowClear
            showSearch
            placeholder="Action"
            style={{ width: 170 }}
            value={get('action') || undefined}
            onChange={(v) => set({ action: v })}
            options={(actions.data ?? []).map((a) => ({ value: a, label: a }))}
          />
          <Select
            allowClear
            showSearch
            placeholder="Object type"
            style={{ width: 160 }}
            value={get('entityType') || undefined}
            onChange={(v) => set({ entityType: v })}
            options={ENTITY_TYPES.map((t) => ({ value: t, label: t }))}
          />
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="User"
            style={{ width: 200 }}
            value={get('userId') || undefined}
            onChange={(v) => set({ userId: v })}
            options={(users.data ?? []).map((u) => ({ value: u.id, label: u.display_name }))}
          />
          <DatePicker.RangePicker
            format={DATE_FORMAT}
            value={range}
            onChange={(r) =>
              set({
                from: r?.[0] ? r[0].format('YYYY-MM-DD') : undefined,
                to: r?.[1] ? r[1].format('YYYY-MM-DD') : undefined,
              })
            }
          />
          <div style={{ flex: 1 }} />
          <Typography.Text type="secondary" style={{ alignSelf: 'center' }}>
            {log.data?.total ?? 0} entries
          </Typography.Text>
        </div>

        <Table<AuditEntry>
          rowKey="id"
          loading={log.isFetching}
          dataSource={log.data?.items ?? []}
          scroll={{ x: 900 }}
          expandable={{
            rowExpandable: (e) => !!e.changes && Object.keys(e.changes).length > 0,
            expandedRowRender: (e) => (
              <div style={{ paddingLeft: 8 }}>
                <ChangeList changes={e.changes} action={e.action} />
              </div>
            ),
          }}
          pagination={{
            current: page,
            pageSize,
            total: log.data?.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [50, 100, 250],
            showTotal: (total, r) => `${r[0]}–${r[1]} of ${total}`,
            onChange: (p, size) => set({ page: String(p), pageSize: size !== 50 ? String(size) : undefined }),
          }}
          columns={[
            {
              title: 'Time',
              dataIndex: 'at',
              width: 170,
              render: (v: string) => <span className="mono">{dayjs(v).format('DD.MM.YYYY HH:mm:ss')}</span>,
            },
            { title: 'User', dataIndex: 'user_name', width: 190, ellipsis: true, render: (v: string | null) => v ?? <span className="muted">system</span> },
            { title: 'Action', dataIndex: 'action', width: 170, render: (a: string) => actionTag(a) },
            {
              title: 'Object',
              key: 'object',
              ellipsis: true,
              render: (_, e) => {
                const to = entityLink(e);
                return (
                  <Space size={4}>
                    {e.entity_type && <Tag variant="filled">{e.entity_type}</Tag>}
                    {e.entity_label ? to ? <Link to={to}>{e.entity_label}</Link> : <span>{e.entity_label}</span> : null}
                  </Space>
                );
              },
            },
            { title: 'IP', dataIndex: 'ip', width: 140, render: (v: string | null) => <span className="mono">{v ?? '–'}</span> },
          ]}
        />
      </Card>
    </div>
  );
}
