import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Result,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { CheckOutlined, EditOutlined, UserAddOutlined, FileExcelOutlined } from '@ant-design/icons';
import {
  PERMISSIONS,
  ROLES,
  ROLE_META,
  ROLE_PERMISSIONS,
  type AppUser,
  type Permission,
  type Role,
} from '../../../../shared/model';
import { errorText, http } from '../../lib/api';
import { fmtDateTime, fromNow } from '../../lib/format';
import { useInvalidate, usePlants, useUsers } from '../../lib/queries';
import { useSession } from '../../lib/session';
import { PageHeader } from '../../components/PageHeader';
import { download, exportUrl, MoreMenu } from '../../components/PageParts';
import { RoleTag } from '../../components/Tags';
import { EntraDirectoryTab } from './EntraDirectoryTab';
import type { EntraSettingsDto } from '../../../../shared/entra';

const PERMISSION_LABELS: Record<Permission, string> = {
  read: 'Read',
  export: 'Export',
  'note.write': 'Write notes',
  'activity.write': 'Manage activities',
  'asset.status': 'Change asset status',
  'asset.write': 'Create / edit assets',
  'asset.delete': 'Delete assets',
  'location.write': 'Manage locations & floor plans',
  'location.delete': 'Delete plants',
  import: 'Import',
  'audit.read': 'Audit log',
  'user.manage': 'User management',
  'settings.manage': 'Settings & e-mail notifications',
  'attachment.write': 'Upload files & photos',
};

const roleOptions = ROLES.map((r) => ({ value: r, label: ROLE_META[r].label }));

function PlantScopeTags({ scope, plantCodes }: { scope: string[]; plantCodes: Map<string, string> }) {
  if (!scope.length) return <Typography.Text type="secondary">All plants</Typography.Text>;
  return (
    <Space size={[4, 4]} wrap>
      {scope.map((id) => (
        <Tag key={id} color="gold" style={{ marginInlineEnd: 0 }}>
          {plantCodes.get(id) ?? 'unknown'}
        </Tag>
      ))}
    </Space>
  );
}

interface EditValues {
  role: Role;
  plant_scope: string[];
  active: boolean;
  new_password?: string;
}

function EditUserModal({ user, onClose }: { user: AppUser | null; onClose: () => void }) {
  const [form] = Form.useForm<EditValues>();
  const { message } = App.useApp();
  const { me, config } = useSession();
  const plants = usePlants();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const role = Form.useWatch('role', form);
  const localAccounts = config.authMode === 'local';

  useEffect(() => {
    if (user) form.setFieldsValue({ role: user.role, plant_scope: user.plant_scope ?? [], active: user.active });
  }, [user, form]);

  const submit = async () => {
    if (!user) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await http.put(`/api/users/${user.id}`, { role: v.role, plant_scope: v.plant_scope ?? [], active: v.active });
      if (v.new_password) await http.put(`/api/users/${user.id}/password`, { password: v.new_password });
      message.success(v.new_password ? 'User updated, new password set' : 'User updated');
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const isSelf = user?.id === me.user.id;
  const entraManaged = user?.role_source === 'entra';
  const groupManaged = user?.role_source === 'group';

  return (
    <Modal open={!!user} title={user ? `Edit ${user.display_name}` : ''} onCancel={onClose} onOk={submit} okText="Save" confirmLoading={saving} destroyOnHidden width={560}>
      {user && (
        <Form form={form} layout="vertical">
          <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
            {user.email ?? 'no e-mail'} {user.oid ? '' : '· not signed in yet'}
          </Typography.Paragraph>
          <Form.Item
            name="role"
            label="Role"
            extra={
              entraManaged
                ? 'This role is assigned via an Entra ID app role and is updated at every sign-in. Change it in the Entra admin center (Enterprise applications → Users and groups).'
                : groupManaged
                  ? `This role comes from the Entra group mapping (${user.role_detail ?? 'group'}) and is updated at every sign-in. Change the mapping on the tab “Microsoft Entra ID”.`
                  : role
                  ? ROLE_META[role as Role]?.description
                  : undefined
            }
          >
            <Select options={roleOptions} disabled={entraManaged || groupManaged || isSelf} />
          </Form.Item>
          <Form.Item
            name="plant_scope"
            label="Plant scope"
            extra={
              role === 'admin' ? 'Administrators always see all plants.' : groupManaged ? 'Set by the Entra group mapping.' : 'Leave empty to grant access to all plants.'
            }
          >
            <Select
              mode="multiple"
              allowClear
              optionFilterProp="label"
              placeholder="All plants"
              disabled={role === 'admin' || groupManaged}
              options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
            />
          </Form.Item>
          <Form.Item
            name="active"
            label="Active"
            valuePropName="checked"
            extra={isSelf ? 'You cannot deactivate yourself.' : 'Deactivated users are signed out immediately and cannot sign in.'}
          >
            <Switch disabled={isSelf} />
          </Form.Item>
          {localAccounts && !isSelf && (
            <Form.Item
              name="new_password"
              label={user.has_password ? 'New password' : 'Password'}
              rules={[{ min: 10, message: 'At least 10 characters' }]}
              extra={
                user.has_password
                  ? 'Leave empty to keep the current password. Setting a new one signs the user out.'
                  : 'This user has no password yet and cannot sign in until you set one.'
              }
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}
        </Form>
      )}
    </Modal>
  );
}

interface CreateValues {
  email: string;
  display_name: string;
  role: Role;
  plant_scope: string[];
  password?: string;
}

function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<CreateValues>();
  const { message } = App.useApp();
  const { config } = useSession();
  const plants = usePlants();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);
  const localAccounts = config.authMode === 'local';

  useEffect(() => {
    if (open) form.setFieldsValue({ email: '', display_name: '', role: 'viewer', plant_scope: [], password: '' });
  }, [open, form]);

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await http.post('/api/users', { ...v, plant_scope: v.plant_scope ?? [], password: localAccounts ? v.password : undefined });
      message.success(localAccounts ? 'User created' : 'User pre-provisioned');
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} title={localAccounts ? 'Add user' : 'Pre-provision user'} onCancel={onClose} onOk={submit} okText="Create" confirmLoading={saving} destroyOnHidden width={560}>
      <Typography.Paragraph type="secondary">
        {localAccounts
          ? 'The person signs in with this e-mail address and the password you set here. Ask them to change it after the first sign-in (user menu → Change password).'
          : 'Create a user before the first sign-in to assign a role and plant scope in advance. The account is linked automatically when the person signs in with this e-mail address (UPN). An Entra ID app role, if assigned, takes precedence over the role set here.'}
      </Typography.Paragraph>
      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="email" label="E-mail / UPN" rules={[{ required: true, type: 'email', message: 'Enter a valid e-mail address' }]}>
          <Input placeholder="firstname.lastname@company.com" />
        </Form.Item>
        <Form.Item name="display_name" label="Display name" rules={[{ required: true, whitespace: true }]}>
          <Input />
        </Form.Item>
        {localAccounts && (
          <Form.Item name="password" label="Initial password" rules={[{ required: true, message: 'Enter a password' }, { min: 10, message: 'At least 10 characters' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        )}
        <Form.Item name="role" label="Role" rules={[{ required: true }]}>
          <Select options={roleOptions} />
        </Form.Item>
        <Form.Item name="plant_scope" label="Plant scope" extra="Leave empty to grant access to all plants.">
          <Select
            mode="multiple"
            allowClear
            optionFilterProp="label"
            placeholder="All plants"
            options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function PermissionMatrix() {
  const rows = PERMISSIONS.map((p) => ({ key: p, permission: p }));
  return (
    <Table
      pagination={false}
      dataSource={rows}
      scroll={{ x: 560 }}
      columns={[
        { title: 'Permission', dataIndex: 'permission', render: (p: Permission) => PERMISSION_LABELS[p] },
        ...ROLES.map((r) => ({
          title: <RoleTag role={r} />,
          key: r,
          width: 120,
          align: 'center' as const,
          render: (_: unknown, row: { permission: Permission }) =>
            ROLE_PERMISSIONS[r].includes(row.permission) ? <CheckOutlined style={{ color: '#389e0d' }} /> : <span className="muted">–</span>,
        })),
      ]}
    />
  );
}

export function UsersPage() {
  const { can, me } = useSession();
  const allowed = can('user.manage');
  const users = useUsers(allowed);
  const plants = usePlants();
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | undefined>();
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'users';
  const entraSettings = useQuery({
    queryKey: ['settings', 'entra'],
    queryFn: () => http.get<EntraSettingsDto>('/api/settings/entra'),
    enabled: allowed && me.user.role === 'admin',
    retry: false,
  });
  const entraConfigured = !!entraSettings.data?.configured;

  const plantCodes = useMemo(() => new Map((plants.data ?? []).map((p) => [p.id, p.code])), [plants.data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (users.data ?? []).filter(
      (u) =>
        (!roleFilter || u.role === roleFilter) &&
        (!q || u.display_name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q)),
    );
  }, [users.data, search, roleFilter]);

  if (!allowed) {
    return <Result status="403" title="No access" subTitle="User management is restricted to administrators." />;
  }

  const usersContent = (
    <>
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="How permissions work"
          description={
            <>
              With sign-in by Microsoft, the role is taken in this order at every sign-in: an <strong>Entra ID app role</strong> (CMDB.Admin, CMDB.Editor,
              CMDB.Operator, CMDB.Viewer – assigned under <em>Enterprise applications → Users and groups</em>), otherwise a <strong>mapped Entra group</strong>{' '}
              (tab “Microsoft Entra ID”, including its plant scope), otherwise the role set here, otherwise the default role. Accounts with e-mail and
              password are managed only here. The <strong>plant scope</strong> is managed here (except for group-managed users) – an empty scope means
              access to all plants.
            </>
          }
        />

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <Input.Search allowClear size="large" placeholder="Search name or e-mail" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 320 }} />
            <Select allowClear size="large" placeholder="All roles" style={{ width: 200 }} value={roleFilter} onChange={setRoleFilter} options={roleOptions} />
            <div style={{ flex: 1 }} />
            <Typography.Text type="secondary" style={{ alignSelf: 'center' }}>
              {filtered.length} of {users.data?.length ?? 0} users
            </Typography.Text>
          </div>
          <Table<AppUser>
            rowKey="id"
            loading={users.isLoading}
            dataSource={filtered}
            pagination={{ pageSize: 50, hideOnSinglePage: true }}
            scroll={{ x: 900 }}
            columns={[
              {
                title: 'User',
                key: 'user',
                sorter: (a, b) => a.display_name.localeCompare(b.display_name),
                render: (_, u) => (
                  <div>
                    <Typography.Text strong>{u.display_name}</Typography.Text>
                    {u.id === me.user.id && <Tag style={{ marginLeft: 6 }}>you</Tag>}
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {u.email ?? '–'}
                      </Typography.Text>
                    </div>
                  </div>
                ),
              },
              {
                title: 'Role',
                key: 'role',
                width: 220,
                sorter: (a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role),
                render: (_, u) => (
                  <Space size={4}>
                    <RoleTag role={u.role} />
                    {u.role_source === 'entra' ? (
                      <Tooltip title="Assigned via Entra ID app role">
                        <Tag color="blue" variant="filled">
                          Entra ID
                        </Tag>
                      </Tooltip>
                    ) : u.role_source === 'group' ? (
                      <Tooltip title={`From the Entra group mapping: ${u.role_detail ?? ''}`}>
                        <Tag color="geekblue" variant="filled">
                          Entra group
                        </Tag>
                      </Tooltip>
                    ) : (
                      <Tag variant="filled">local</Tag>
                    )}
                  </Space>
                ),
              },
              {
                title: 'Plant scope',
                key: 'scope',
                width: 220,
                render: (_, u) => (u.role === 'admin' ? <Typography.Text type="secondary">All plants</Typography.Text> : <PlantScopeTags scope={u.plant_scope} plantCodes={plantCodes} />),
              },
              {
                title: 'Status',
                key: 'active',
                width: 130,
                filters: [
                  { text: 'Active', value: true },
                  { text: 'Deactivated', value: false },
                ],
                onFilter: (v, u) => u.active === v,
                render: (_, u) =>
                  u.active ? (
                    u.oid || u.has_password ? <Badge status="success" text="Active" /> : <Badge status="processing" text="Pre-provisioned" />
                  ) : (
                    <Badge status="default" text="Deactivated" />
                  ),
              },
              {
                title: 'Last sign-in',
                dataIndex: 'last_login_at',
                width: 150,
                sorter: (a, b) => (a.last_login_at ?? '').localeCompare(b.last_login_at ?? ''),
                render: (v: string | null) =>
                  v ? (
                    <Tooltip title={fmtDateTime(v)}>
                      <span>{fromNow(v)}</span>
                    </Tooltip>
                  ) : (
                    <span className="muted">never</span>
                  ),
              },
              {
                title: '',
                key: 'actions',
                width: 60,
                render: (_, u) => <Button type="text" icon={<EditOutlined />} onClick={() => setEditing(u)} aria-label="Edit user" />,
              },
            ]}
          />
        </Card>

        <Card title="Role permissions">
          <PermissionMatrix />
        </Card>
    </>
  );

  return (
    <div>
      <PageHeader
        title="Users & permissions"
        subtitle="Roles, plant scope and account status of everyone who has signed in to the CMDB."
        crumbs={[{ title: 'Administration' }, { title: 'Users & permissions' }]}
        extra={
          <>
            <Button type="primary" size="large" icon={<UserAddOutlined />} onClick={() => setCreating(true)}>
              Add user
            </Button>
            <MoreMenu
              items={[
                { key: 'xlsx', icon: <FileExcelOutlined />, label: 'Export users (Excel)', onClick: () => download(exportUrl('users', 'xlsx')) },
                { key: 'csv', icon: <FileExcelOutlined />, label: 'Export users (CSV)', onClick: () => download(exportUrl('users', 'csv')) },
              ]}
            />
          </>
        }
      />

      {entraConfigured ? (
        <Tabs
          activeKey={tab}
          onChange={(key) => {
            const next = new URLSearchParams(params);
            if (key === 'users') next.delete('tab');
            else next.set('tab', key);
            setParams(next, { replace: true });
          }}
          items={[
            { key: 'users', label: 'CMDB users', children: usersContent },
            { key: 'entra', label: 'Microsoft Entra ID', children: <EntraDirectoryTab /> },
          ]}
        />
      ) : (
        usersContent
      )}

      <EditUserModal user={editing} onClose={() => setEditing(null)} />
      <CreateUserModal open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
