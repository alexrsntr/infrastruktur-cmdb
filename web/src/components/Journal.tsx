import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, PushpinFilled, PushpinOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Link } from 'react-router';
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_META,
  ACTIVITY_STATUSES,
  ACTIVITY_STATUS_META,
  type Activity,
  type AuditEntry,
  type EntityType,
  type Note,
} from '../../../shared/model';
import { errorText, http } from '../lib/api';
import { DATE_FORMAT, dash, fieldLabel, fmtDateTime, fromNow } from '../lib/format';
import { useActivities, useHistory, useInvalidate, useNotes } from '../lib/queries';
import { useSession } from '../lib/session';
import { ActivityKindTag, ActivityStatusTag, DueDate } from './Tags';
import { ExportMenu } from './ExportMenu';
import { AttachmentsPanel } from './AttachmentsPanel';
import { ActivityLog } from './ActivityLog';

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function NotesPanel({ entityType, entityId }: { entityType: EntityType; entityId: string }) {
  const { can, me } = useSession();
  const { message } = App.useApp();
  const notes = useNotes(entityType, entityId);
  const invalidate = useInvalidate();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<Note | null>(null);
  const [editText, setEditText] = useState('');

  const isAdmin = can('user.manage');
  const mayChange = (n: Note) => can('note.write') && (n.created_by === me.user.id || isAdmin);

  const add = async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      await http.post('/api/notes', { entity_type: entityType, entity_id: entityId, body: draft });
      setDraft('');
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const update = async (n: Note, patch: Partial<Pick<Note, 'body' | 'pinned'>>) => {
    try {
      await http.put(`/api/notes/${n.id}`, { body: patch.body ?? n.body, pinned: patch.pinned ?? n.pinned });
      setEditing(null);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const remove = async (n: Note) => {
    try {
      await http.del(`/api/notes/${n.id}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <div>
      {can('note.write') && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note – e.g. access instructions, contacts, known issues…"
            autoSize={{ minRows: 2, maxRows: 8 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add();
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Ctrl + Enter to save
            </Typography.Text>
            <Button type="primary" icon={<PlusOutlined />} onClick={add} loading={saving} disabled={!draft.trim()}>
              Add note
            </Button>
          </div>
        </Card>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <ExportMenu dataset="notes" query={{ entityType, entityId }} size="small" />
      </div>
      <List
        loading={notes.isLoading}
        dataSource={notes.data ?? []}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No notes yet" /> }}
        renderItem={(n) => (
          <Card size="small" style={{ marginBottom: 10, borderLeft: n.pinned ? '3px solid #faad14' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <strong>{n.created_by_name ?? 'Unknown'}</strong> · <Tooltip title={fmtDateTime(n.created_at)}>{fromNow(n.created_at)}</Tooltip>
                {n.updated_at !== n.created_at && <span> · edited</span>}
              </Typography.Text>
              {mayChange(n) && (
                <Space size={0}>
                  <Tooltip title={n.pinned ? 'Unpin' : 'Pin to top'}>
                    <Button size="small" type="text" icon={n.pinned ? <PushpinFilled style={{ color: '#faad14' }} /> : <PushpinOutlined />} onClick={() => update(n, { pinned: !n.pinned })} />
                  </Tooltip>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => { setEditing(n); setEditText(n.body); }} />
                  <Popconfirm title="Delete this note?" onConfirm={() => remove(n)} okButtonProps={{ danger: true }}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              )}
            </div>
            {editing?.id === n.id ? (
              <div style={{ marginTop: 8 }}>
                <Input.TextArea value={editText} onChange={(e) => setEditText(e.target.value)} autoSize={{ minRows: 2, maxRows: 10 }} />
                <Space style={{ marginTop: 8 }}>
                  <Button type="primary" size="small" onClick={() => update(n, { body: editText })} disabled={!editText.trim()}>
                    Save
                  </Button>
                  <Button size="small" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </Space>
              </div>
            ) : (
              <div className="note-body" style={{ marginTop: 6 }}>
                {n.body}
              </div>
            )}
          </Card>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

interface ActivityFormValues {
  kind: Activity['kind'];
  status: Activity['status'];
  title: string;
  description?: string;
  assignee?: string;
  due_date?: dayjs.Dayjs | null;
}

export function ActivityFormModal({
  open,
  onClose,
  activity,
  entity,
}: {
  open: boolean;
  onClose: () => void;
  activity?: Activity | null;
  entity?: { type: EntityType; id: string; label?: string };
}) {
  const [form] = Form.useForm<ActivityFormValues>();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = await form.validateFields();
    const body = { ...v, due_date: v.due_date ? v.due_date.format('YYYY-MM-DD') : null };
    setSaving(true);
    try {
      if (activity) await http.put(`/api/activities/${activity.id}`, body);
      else await http.post('/api/activities', { ...body, entity_type: entity!.type, entity_id: entity!.id });
      message.success(activity ? 'Activity updated' : 'Activity created');
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={activity ? 'Edit activity' : `New activity${entity?.label ? ` – ${entity.label}` : ''}`}
      onCancel={onClose}
      onOk={submit}
      okText={activity ? 'Save' : 'Create'}
      confirmLoading={saving}
      destroyOnHidden
      width={620}
      afterOpenChange={(o) => {
        if (o)
          form.setFieldsValue(
            activity
              ? { ...activity, description: activity.description ?? undefined, assignee: activity.assignee ?? undefined, due_date: activity.due_date ? dayjs(activity.due_date) : null }
              : { kind: 'maintenance', status: 'open', title: '', due_date: null },
          );
      }}
    >
      <Form form={form} layout="vertical" requiredMark="optional">
        <Space.Compact block>
          <Form.Item name="kind" label="Kind" rules={[{ required: true }]} style={{ width: '50%' }}>
            <Select options={ACTIVITY_KINDS.map((k) => ({ value: k, label: ACTIVITY_KIND_META[k].label }))} />
          </Form.Item>
          <Form.Item name="status" label="Status" rules={[{ required: true }]} style={{ width: '50%', paddingLeft: 12 }}>
            <Select options={ACTIVITY_STATUSES.map((s) => ({ value: s, label: ACTIVITY_STATUS_META[s].label }))} />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="title" label="Title" rules={[{ required: true, whitespace: true, max: 300 }]}>
          <Input placeholder="e.g. Replace defective PSU" />
        </Form.Item>
        <Space.Compact block>
          <Form.Item name="assignee" label="Assignee" style={{ width: '60%' }}>
            <Input placeholder="Person or team" />
          </Form.Item>
          <Form.Item name="due_date" label="Due date" style={{ width: '40%', paddingLeft: 12 }}>
            <DatePicker format={DATE_FORMAT} style={{ width: '100%' }} />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="description" label="Description">
          <Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

const ENTITY_WORD: Record<string, string> = { asset: 'Device', plant: 'Plant', building: 'Building', floor: 'Floor', rack: 'Rack' };

const entityRoute = (a: Pick<Activity, 'entity_type' | 'entity_id'>) =>
  a.entity_type === 'asset' ? `/assets/${a.entity_id}` : a.entity_type === 'plant' ? `/plants/${a.entity_id}` : a.entity_type === 'building' ? `/buildings/${a.entity_id}` : a.entity_type === 'rack' ? `/racks/${a.entity_id}` : null;

export function ActivitiesTable({
  items,
  loading,
  showEntity = false,
  pagination,
}: {
  items: Activity[];
  loading?: boolean;
  showEntity?: boolean;
  pagination?: false | { current: number; pageSize: number; total: number; onChange: (page: number, size: number) => void };
}) {
  const { can, me } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [editing, setEditing] = useState<Activity | null>(null);

  const quickStatus = async (a: Activity, status: Activity['status']) => {
    try {
      await http.put(`/api/activities/${a.id}`, { kind: a.kind, status, title: a.title, description: a.description, assignee: a.assignee, due_date: a.due_date });
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };
  const remove = async (a: Activity) => {
    try {
      await http.del(`/api/activities/${a.id}`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <>
      <Table<Activity>
        rowKey="id"
        loading={loading}
        dataSource={items}
        pagination={pagination === undefined ? { pageSize: 20, hideOnSinglePage: true } : pagination}
        scroll={{ x: showEntity ? 1250 : 950 }}
        expandable={{
          rowExpandable: (a) => !!a.description,
          expandedRowRender: (a) => <div className="note-body" style={{ paddingLeft: 8 }}>{a.description}</div>,
        }}
        columns={[
          { title: 'Due', dataIndex: 'due_date', width: 130, render: (_, a) => <span style={{ whiteSpace: 'nowrap' }}><DueDate value={a.due_date} status={a.status} /></span> },
          { title: 'Kind', dataIndex: 'kind', width: 120, render: (k) => <ActivityKindTag kind={k} /> },
          { title: 'Title', dataIndex: 'title', ellipsis: true, width: showEntity ? 300 : undefined },
          ...(showEntity
            ? [
                {
                  title: 'Object',
                  key: 'entity',
                  width: 240,
                  ellipsis: true,
                  render: (_: unknown, a: Activity) => {
                    const to = entityRoute(a);
                    return (
                      <Space size={4}>
                        <Tag variant="filled">{ENTITY_WORD[a.entity_type] ?? a.entity_type}</Tag>
                        {to ? <Link to={to}>{dash(a.entity_label)}</Link> : dash(a.entity_label)}
                      </Space>
                    );
                  },
                },
                { title: 'Plant', dataIndex: 'plant_name', width: 160, ellipsis: true, render: (v: string | null) => dash(v) },
              ]
            : []),
          { title: 'Assignee', dataIndex: 'assignee', width: 150, ellipsis: true, render: (v) => dash(v) },
          {
            title: 'Status',
            dataIndex: 'status',
            width: 150,
            render: (_, a) =>
              can('activity.write') ? (
                <Select
                  variant="borderless"
                  value={a.status}
                  onChange={(s) => quickStatus(a, s)}
                  style={{ width: 150 }}
                  options={ACTIVITY_STATUSES.map((s) => ({ value: s, label: <ActivityStatusTag status={s} /> }))}
                />
              ) : (
                <ActivityStatusTag status={a.status} />
              ),
          },
          {
            title: '',
            key: 'actions',
            width: 80,
            render: (_, a) =>
              can('activity.write') && (
                <Space size={0}>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(a)} />
                  {(a.created_by === me.user.id || can('asset.delete')) && (
                    <Popconfirm title="Delete this activity?" onConfirm={() => remove(a)} okButtonProps={{ danger: true }}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  )}
                </Space>
              ),
          },
        ]}
      />
      <ActivityFormModal open={!!editing} activity={editing} onClose={() => setEditing(null)} />
    </>
  );
}

export function ActivitiesPanel({ entityType, entityId, label }: { entityType: EntityType; entityId: string; label?: string }) {
  const { can } = useSession();
  const [showDone, setShowDone] = useState(true);
  const [creating, setCreating] = useState(false);
  const q = { entityType, entityId, pageSize: 500, open: showDone ? undefined : 'true' };
  const acts = useActivities(q);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
        <Checkbox checked={!showDone} onChange={(e) => setShowDone(!e.target.checked)}>
          Only open activities
        </Checkbox>
        <Space>
          <ExportMenu dataset="activities" query={q} size="small" />
          {can('activity.write') && (
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              New activity
            </Button>
          )}
        </Space>
      </div>
      <ActivitiesTable items={acts.data?.items ?? []} loading={acts.isLoading} />
      <ActivityFormModal open={creating} entity={{ type: entityType, id: entityId, label }} onClose={() => setCreating(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Change history
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  create: { label: 'Created', color: 'green' },
  update: { label: 'Changed', color: 'blue' },
  delete: { label: 'Deleted', color: 'red' },
  'relation.add': { label: 'Relation added', color: 'cyan' },
  'relation.remove': { label: 'Relation removed', color: 'orange' },
  'note.add': { label: 'Note added', color: 'gold' },
  'note.update': { label: 'Note edited', color: 'gold' },
  'note.delete': { label: 'Note deleted', color: 'gold' },
  'activity.add': { label: 'Activity added', color: 'purple' },
  'activity.update': { label: 'Activity changed', color: 'purple' },
  'activity.delete': { label: 'Activity deleted', color: 'purple' },
  'attachment.add': { label: 'File added', color: 'geekblue' },
  'attachment.update': { label: 'File changed', color: 'geekblue' },
  'attachment.delete': { label: 'File deleted', color: 'geekblue' },
  'plan.marker.add': { label: 'Placed on picture', color: 'cyan' },
  'plan.marker.move': { label: 'Moved on picture', color: 'cyan' },
  'plan.marker.remove': { label: 'Removed from picture', color: 'cyan' },
  'rack.item.add': { label: 'Rack equipment added', color: 'lime' },
  'rack.item.update': { label: 'Rack equipment changed', color: 'lime' },
  'rack.item.remove': { label: 'Rack equipment removed', color: 'lime' },
};

export function actionTag(action: string) {
  const meta = ACTION_LABELS[action];
  return <Tag color={meta?.color}>{meta?.label ?? action}</Tag>;
}

function renderValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === '') return <span className="muted">empty</span>;
  if (Array.isArray(v)) return v.join(', ') || <span className="muted">empty</span>;
  if (typeof v === 'object') return <span className="mono">{JSON.stringify(v)}</span>;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

export function ChangeList({ changes, action }: { changes: AuditEntry['changes']; action: string }) {
  if (!changes) return null;
  const entries = Object.entries(changes).filter(([k, v]) => !k.startsWith('_') && v !== undefined);
  if (!entries.length) return null;
  const isDiff = entries.every(([, v]) => v && typeof v === 'object' && 'from' in (v as object) && 'to' in (v as object));
  return (
    <div style={{ fontSize: 12.5, marginTop: 4 }}>
      {entries.slice(0, 40).map(([k, v]) => (
        <div key={k}>
          <Typography.Text type="secondary">{fieldLabel(k)}: </Typography.Text>
          {isDiff ? (
            <>
              <span style={{ textDecoration: 'line-through', color: 'var(--cmdb-muted)' }}>{renderValue((v as { from: unknown }).from)}</span>
              {' → '}
              <strong>{renderValue((v as { to: unknown }).to)}</strong>
            </>
          ) : (
            renderValue(v)
          )}
        </div>
      ))}
      {entries.length > 40 && <Typography.Text type="secondary">… {entries.length - 40} more ({action})</Typography.Text>}
    </div>
  );
}

export function HistoryPanel({ entityType, entityId }: { entityType: EntityType; entityId: string }) {
  const history = useHistory(entityType, entityId);
  if (history.isLoading) return <Card loading />;
  if (!history.data?.length) return <Empty description="No changes recorded yet" />;
  return (
    <Timeline
      items={history.data.map((h) => ({
        color: ACTION_LABELS[h.action]?.color ?? 'gray',
        children: (
          <div>
            <Space size={6} wrap>
              {actionTag(h.action)}
              <Typography.Text strong>{h.user_name ?? 'system'}</Typography.Text>
              <Tooltip title={fmtDateTime(h.at)}>
                <Typography.Text type="secondary">{fromNow(h.at)}</Typography.Text>
              </Tooltip>
            </Space>
            <ChangeList changes={h.changes} action={h.action} />
          </div>
        ),
      }))}
    />
  );
}

/** Standard tabs for Activities / Notes / History on detail pages */
/**
 * Standard tabs on detail pages: one activity log (notes, work, changes in one timeline) and files.
 * `label` is kept for API compatibility.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function journalTabs(entityType: EntityType, entityId: string, _label?: string) {
  return [
    { key: 'log', label: 'Activity log', children: <ActivityLog entityType={entityType} entityId={entityId} /> },
    { key: 'files', label: 'Files', children: <AttachmentsPanel entityType={entityType} entityId={entityId} /> },
  ];
}
