import { useState } from 'react';
import { Link } from 'react-router';
import { App, Button, Checkbox, DatePicker, Dropdown, Empty, Input, Segmented, Skeleton, Tag, Tooltip, Typography } from 'antd';
import {
  CheckOutlined,
  CommentOutlined,
  EditOutlined,
  EnvironmentOutlined,
  FileOutlined,
  MoreOutlined,
  PlusCircleOutlined,
  ToolOutlined,
  WarningOutlined,
  SwapOutlined,
  SearchOutlined,
  SyncOutlined,
  PushpinFilled,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  ACTIVITY_KIND_META,
  ACTIVITY_STATUS_META,
  type ActivityKind,
  type EntityType,
  type TimelineItem,
} from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { DATE_FORMAT, fieldLabel, fmtDate, fmtDateTime, fromNow } from '../lib/format';
import { useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';

type EntryKind = 'note' | ActivityKind;

const ENTRY_KINDS: { value: EntryKind; label: string; icon: React.ReactNode }[] = [
  { value: 'note', label: 'Note', icon: <CommentOutlined /> },
  { value: 'maintenance', label: 'Maintenance', icon: <ToolOutlined /> },
  { value: 'incident', label: 'Incident', icon: <WarningOutlined /> },
  { value: 'change', label: 'Change', icon: <SwapOutlined /> },
  { value: 'replacement', label: 'Replacement', icon: <SyncOutlined /> },
  { value: 'inspection', label: 'Inspection', icon: <SearchOutlined /> },
];

const KIND_STYLE: Record<string, { bg: string; fg: string; icon: React.ReactNode }> = {
  note: { bg: '#fff4d6', fg: '#a86a00', icon: <CommentOutlined /> },
  maintenance: { bg: '#fff1d9', fg: '#b26a00', icon: <ToolOutlined /> },
  incident: { bg: '#fde3e4', fg: '#c4262e', icon: <WarningOutlined /> },
  change: { bg: '#e2edfb', fg: '#1a5fb4', icon: <SwapOutlined /> },
  installation: { bg: '#def3e6', fg: '#1e7a46', icon: <PlusCircleOutlined /> },
  inspection: { bg: '#dff4f4', fg: '#127a7a', icon: <SearchOutlined /> },
  replacement: { bg: '#efe5fb', fg: '#6b35b5', icon: <SyncOutlined /> },
  other: { bg: '#eef1f4', fg: '#4a5a6c', icon: <CommentOutlined /> },
  changeLog: { bg: '#eef1f4', fg: '#4a5a6c', icon: <EditOutlined /> },
  file: { bg: '#e6ecfa', fg: '#3b55a8', icon: <FileOutlined /> },
  placement: { bg: '#dff4f4', fg: '#127a7a', icon: <EnvironmentOutlined /> },
  created: { bg: '#def3e6', fg: '#1e7a46', icon: <PlusCircleOutlined /> },
};

const ACTION_TEXT: Record<string, string> = {
  create: 'added this to the CMDB',
  update: 'changed',
  delete: 'deleted',
  'relation.add': 'added a connection',
  'relation.remove': 'removed a connection',
  'activity.update': 'updated an activity',
  'attachment.add': 'uploaded a file',
  'attachment.update': 'changed a file',
  'attachment.delete': 'deleted a file',
  'plan.marker.add': 'placed it on a picture',
  'plan.marker.move': 'moved it on a picture',
  'plan.marker.remove': 'removed it from a picture',
  'rack.item.add': 'added rack equipment',
  'rack.item.update': 'changed rack equipment',
  'rack.item.remove': 'removed rack equipment',
};

function val(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'empty';
  if (Array.isArray(v)) return v.join(', ') || 'empty';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Human readable lines for an audit entry */
function changeLines(item: TimelineItem): string[] {
  const c = item.changes ?? {};
  const entries = Object.entries(c).filter(([k]) => !k.startsWith('_'));
  if (item.action === 'update' || item.action === 'activity.update') {
    return entries
      .filter(([, v]) => v && typeof v === 'object' && 'from' in (v as object))
      .map(([k, v]) => `${fieldLabel(k)}: ${val((v as { from: unknown }).from)} → ${val((v as { to: unknown }).to)}`);
  }
  if (item.action === 'attachment.add' || item.action === 'attachment.delete') return [String(c.file ?? '')].filter(Boolean);
  if (item.action?.startsWith('plan.marker')) return [`${c.plan ?? ''}`].filter(Boolean);
  if (item.action?.startsWith('relation')) return [[c.relation, c.target ?? c.source].filter(Boolean).join(' · ')];
  if (item.action?.startsWith('rack.item')) return [[c.item, c.units ? `U${c.units}` : null].filter(Boolean).join(' · ')];
  return [];
}

export function ActivityLog({ entityType, entityId, compact = false }: { entityType: EntityType; entityId: string; compact?: boolean }) {
  const { can, me } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [limit, setLimit] = useState(30);
  const [filter, setFilter] = useState<'all' | 'log' | 'changes'>('all');
  const [kind, setKind] = useState<EntryKind>('note');
  const [text, setText] = useState('');
  const [planned, setPlanned] = useState(false);
  const [due, setDue] = useState<dayjs.Dayjs | null>(null);
  const [saving, setSaving] = useState(false);

  const log = useQuery({
    queryKey: ['timeline', entityType, entityId, limit],
    queryFn: () => http.get<TimelineItem[]>('/api/timeline', { entityType, entityId, limit }),
    placeholderData: (prev) => prev,
  });

  const canWrite = kind === 'note' ? can('note.write') : can('activity.write');
  const showComposer = can('note.write') || can('activity.write');

  const add = async () => {
    const t = text.trim();
    if (!t) return;
    setSaving(true);
    try {
      if (kind === 'note') {
        await http.post('/api/notes', { entity_type: entityType, entity_id: entityId, body: t });
      } else {
        const [first, ...rest] = t.split('\n');
        await http.post('/api/activities', {
          entity_type: entityType,
          entity_id: entityId,
          kind,
          status: planned ? 'planned' : 'done',
          title: first.slice(0, 300),
          description: rest.join('\n').trim() || null,
          due_date: planned && due ? due.format('YYYY-MM-DD') : null,
        });
      }
      setText('');
      setPlanned(false);
      setDue(null);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const setActivityStatus = async (item: TimelineItem, status: 'done' | 'cancelled') => {
    try {
      await http.put(`/api/activities/${item.id}`, { kind: item.activity_kind, status, title: item.title, description: item.body, due_date: item.due_date });
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const deleteNote = async (item: TimelineItem) => {
    try {
      await http.del(`/api/notes/${item.id}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const items = (log.data ?? []).filter((i) => (filter === 'all' ? true : filter === 'log' ? i.kind === 'note' || i.kind === 'activity' : i.kind !== 'note' && i.kind !== 'activity'));

  return (
    <div>
      {showComposer && (
        <div style={{ background: '#f6f8fa', border: '1px solid #dfe4ea', borderRadius: 12, padding: 16, marginBottom: 20 }}>
          <Segmented
            value={kind}
            onChange={(v) => setKind(v as EntryKind)}
            options={ENTRY_KINDS.filter((k) => (k.value === 'note' ? can('note.write') : can('activity.write'))).map((k) => ({
              value: k.value,
              label: (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', padding: '2px 4px' }}>
                  {k.icon}
                  {compact ? null : k.label}
                </span>
              ),
              title: k.label,
            }))}
            style={{ marginBottom: 12, flexWrap: 'wrap' }}
          />
          <Input.TextArea
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoSize={{ minRows: 2, maxRows: 8 }}
            placeholder={kind === 'note' ? 'Write a note – e.g. where the key is, who to call, known issues…' : 'What happened? e.g. "Replaced power supply 2" – first line becomes the title'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add();
            }}
            style={{ fontSize: 15.5 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
            {kind !== 'note' && (
              <>
                <Checkbox checked={planned} onChange={(e) => setPlanned(e.target.checked)}>
                  Still to do (plan it)
                </Checkbox>
                {planned && <DatePicker value={due} onChange={setDue} format={DATE_FORMAT} placeholder="Due date" />}
              </>
            )}
            <div style={{ flex: 1 }} />
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              Ctrl + Enter
            </Typography.Text>
            <Button type="primary" size="large" onClick={add} loading={saving} disabled={!text.trim() || !canWrite}>
              Add to log
            </Button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as typeof filter)}
          options={[
            { value: 'all', label: 'Everything' },
            { value: 'log', label: 'Notes & work' },
            { value: 'changes', label: 'Changes & files' },
          ]}
        />
      </div>

      {log.isLoading ? (
        <Skeleton active />
      ) : !items.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing logged yet" style={{ margin: '32px 0' }} />
      ) : (
        <div>
          {items.map((item) => {
            const style =
              item.kind === 'note'
                ? KIND_STYLE.note
                : item.kind === 'activity'
                  ? KIND_STYLE[item.activity_kind ?? 'other']
                  : item.kind === 'file'
                    ? KIND_STYLE.file
                    : item.kind === 'placement'
                      ? KIND_STYLE.placement
                      : item.action === 'create'
                        ? KIND_STYLE.created
                        : KIND_STYLE.changeLog;
            const lines = item.kind === 'change' || item.kind === 'file' || item.kind === 'placement' ? changeLines(item) : [];
            const open = item.kind === 'activity' && item.activity_status && ['planned', 'open', 'in_progress'].includes(item.activity_status);
            const mine = item.user_id === me.user.id;
            return (
              <div className="timeline-item" key={`${item.kind}:${item.id}`}>
                <span className="timeline-icon" style={{ background: style.bg, color: style.fg }}>
                  {style.icon}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                    <Typography.Text strong>{item.user_name ?? 'System'}</Typography.Text>
                    <Typography.Text type="secondary">
                      {item.kind === 'note'
                        ? 'wrote a note'
                        : item.kind === 'activity'
                          ? `logged ${ACTIVITY_KIND_META[item.activity_kind ?? 'other'].label.toLowerCase()}`
                          : ACTION_TEXT[item.action ?? ''] ?? item.action}
                    </Typography.Text>
                    <Tooltip title={fmtDateTime(item.at)}>
                      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                        · {fromNow(item.at)}
                      </Typography.Text>
                    </Tooltip>
                    {item.pinned && <PushpinFilled style={{ color: '#d98a00' }} />}
                    {item.kind === 'activity' && item.activity_status && item.activity_status !== 'done' && (
                      <Tag color={ACTIVITY_STATUS_META[item.activity_status].color}>
                        {ACTIVITY_STATUS_META[item.activity_status].label}
                        {item.due_date ? ` · due ${fmtDate(item.due_date)}` : ''}
                      </Tag>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                    {open && can('activity.write') && (
                      <Button size="small" icon={<CheckOutlined />} onClick={() => setActivityStatus(item, 'done')}>
                        Mark done
                      </Button>
                    )}
                    {item.kind === 'note' && (mine || can('user.manage')) && can('note.write') && (
                      <Dropdown trigger={['click']} menu={{ items: [{ key: 'del', label: 'Delete note', danger: true }], onClick: () => deleteNote(item) }}>
                        <Button size="small" type="text" icon={<MoreOutlined />} aria-label="More" />
                      </Dropdown>
                    )}
                  </div>
                  </div>
                  {item.title && <div style={{ fontSize: 15.5, fontWeight: 600, marginTop: 2 }}>{item.title}</div>}
                  {item.body && (
                    <div className="note-body" style={{ marginTop: 2 }}>
                      {item.body}
                    </div>
                  )}
                  {lines.length > 0 && (
                    <div style={{ marginTop: 2, color: '#4a5a6c', fontSize: 14 }}>
                      {lines.slice(0, 5).map((l) => (
                        <div key={l}>{l}</div>
                      ))}
                      {lines.length > 5 && <div className="muted">+ {lines.length - 5} more</div>}
                    </div>
                  )}
                  {item.entity_label && item.entity_type && item.entity_id && (
                    <div style={{ marginTop: 4 }}>
                      <EntityLink type={item.entity_type} id={item.entity_id} label={item.entity_label} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {(log.data?.length ?? 0) >= limit && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <Button onClick={() => setLimit((l) => l + 50)}>Show older entries</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ROUTE: Record<string, (id: string) => string> = {
  asset: (id) => `/assets/${id}`,
  plant: (id) => `/plants/${id}`,
  building: (id) => `/buildings/${id}`,
  rack: (id) => `/racks/${id}`,
};

export function EntityLink({ type, id, label }: { type: string; id: string; label: string }) {
  const to = ROUTE[type]?.(id);
  return to ? <Link to={to}>{label}</Link> : <span>{label}</span>;
}

/** Recent activity across all sites the user can see (home page) */
export function RecentActivityFeed({ limit = 15 }: { limit?: number }) {
  const feed = useQuery({ queryKey: ['timeline', 'global', limit], queryFn: () => http.get<TimelineItem[]>('/api/timeline', { limit }) });
  if (feed.isLoading) return <Skeleton active />;
  if (!feed.data?.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing happened yet" />;
  return (
    <div>
      {feed.data.map((item) => {
        const style =
          item.kind === 'note' ? KIND_STYLE.note : item.kind === 'activity' ? KIND_STYLE[item.activity_kind ?? 'other'] : item.kind === 'file' ? KIND_STYLE.file : item.action === 'create' ? KIND_STYLE.created : KIND_STYLE.changeLog;
        const what =
          item.kind === 'note'
            ? item.body
            : item.kind === 'activity'
              ? `${ACTIVITY_KIND_META[item.activity_kind ?? 'other'].label}: ${item.title}`
              : `${ACTION_TEXT[item.action ?? ''] ?? item.action}${item.action === 'update' ? ' ' + changeLines(item).slice(0, 2).join('; ') : ''}`;
        return (
          <div className="timeline-item" key={`${item.kind}:${item.id}`} style={{ padding: '12px 0' }}>
            <span className="timeline-icon" style={{ background: style.bg, color: style.fg }}>
              {style.icon}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                {item.entity_type && item.entity_id && item.entity_label && (
                  <span style={{ fontWeight: 600 }}>
                    <EntityLink type={item.entity_type} id={item.entity_id} label={item.entity_label} />
                  </span>
                )}
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  {item.user_name ?? 'System'} · <Tooltip title={fmtDateTime(item.at)}>{fromNow(item.at)}</Tooltip>
                </Typography.Text>
              </div>
              <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ margin: 0, color: '#4a5a6c' }}>
                {what}
              </Typography.Paragraph>
            </div>
          </div>
        );
      })}
    </div>
  );
}

