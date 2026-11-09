import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Empty, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, TeamOutlined, UserAddOutlined, UserOutlined } from '@ant-design/icons';
import { ROLES, ROLE_META, type Role } from '../../../../shared/model';
import { GRAPH_APP_PERMISSIONS, type AppRoleAssignmentDto, type DirectoryGroup, type DirectoryPage, type DirectoryUser, type EntraSettingsDto, type GroupRoleMapping } from '../../../../shared/entra';
import { errorText, http } from '../../lib/api';
import { usePlants } from '../../lib/queries';

const roleOptions = ROLES.map((r) => ({ value: r, label: ROLE_META[r].label }));

function RoleTag({ role }: { role: Role }) {
  return <Tag color={ROLE_META[role].color}>{ROLE_META[role].label}</Tag>;
}

/** Search results with "load more" (Graph paging). */
function usePaged<T>(key: unknown[], url: string | null, q: string) {
  const [extra, setExtra] = useState<{ items: T[]; next: string | null } | null>(null);
  const first = useQuery({
    queryKey: [...key, q],
    queryFn: async () => {
      setExtra(null);
      return http.get<DirectoryPage<T>>(url!, { q });
    },
    enabled: !!url,
    retry: false,
    staleTime: 30_000,
  });
  const items = [...(first.data?.items ?? []), ...(extra?.items ?? [])];
  const next = extra ? extra.next : (first.data?.next ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    if (!next || !url) return;
    setLoadingMore(true);
    try {
      const page = await http.get<DirectoryPage<T>>(url, { q, next });
      setExtra((prev) => ({ items: [...(prev?.items ?? []), ...page.items], next: page.next }));
    } finally {
      setLoadingMore(false);
    }
  };
  return { ...first, items, next, loadMore, loadingMore };
}

function GraphError({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert type="error" showIcon message="Microsoft Graph" description={errorText(error)} style={{ marginBottom: 12 }} />;
}

/** Graph application permissions missing according to the last connection test (null = not tested yet). */
function missingPermissions(settings?: EntraSettingsDto): string[] | null {
  if (!settings?.connection) return null;
  const granted = settings.connection.grantedPermissions;
  if (granted.includes('Directory.Read.All')) return [];
  return GRAPH_APP_PERMISSIONS.map((p) => p.permission as string).filter((p) => !granted.includes(p));
}

export function EntraDirectoryTab({ settings }: { settings?: EntraSettingsDto }) {
  const missing = missingPermissions(settings);
  const [kind, setKind] = useState<'users' | 'groups'>('users');
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [provisioning, setProvisioning] = useState<DirectoryUser | null>(null);
  const [mapping, setMapping] = useState<{ groupId: string; displayName: string; role?: Role; plantScope?: string[] } | null>(null);

  const can = (permission: string) => !missing?.includes(permission);
  const users = usePaged<DirectoryUser>(['entra', 'users'], kind === 'users' && can('User.Read.All') ? '/api/entra/users' : null, q);
  const groups = usePaged<DirectoryGroup>(['entra', 'groups'], kind === 'groups' && can('GroupMember.Read.All') ? '/api/entra/groups' : null, q);

  return (
    <div>
      {!!missing?.length && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Optional features need Microsoft Graph application permissions"
          description={
            <>
              Missing: {missing.map((p) => <code key={p} style={{ marginInlineEnd: 6 }}>{p}</code>)} – they need admin consent by a Privileged Role
              Administrator or Global Administrator. Without them the sign-in works and roles come from the <b>app roles</b> of the enterprise
              application (assigned in Microsoft Entra ID); searching here and Entra group roles are not available.
            </>
          }
        />
      )}
      <Card
        title="Search Microsoft Entra ID"
        extra={<Typography.Text type="secondary">read-only · Microsoft Graph</Typography.Text>}
        style={{ marginBottom: 16 }}
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <Segmented
            size="large"
            value={kind}
            onChange={(v) => setKind(v as 'users' | 'groups')}
            options={[
              { value: 'users', label: 'Users', icon: <UserOutlined /> },
              { value: 'groups', label: 'Groups', icon: <TeamOutlined /> },
            ]}
          />
          <Input.Search
            size="large"
            allowClear
            placeholder={kind === 'users' ? 'Name, user principal name or e-mail' : 'Group name or e-mail'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onSearch={(v) => setQ(v.trim())}
            style={{ width: 360 }}
          />
        </Space>
        {kind === 'users' ? (
          <>
            <GraphError error={users.error} />
            <Table<DirectoryUser>
              rowKey="id"
              loading={users.isFetching}
              dataSource={users.items}
              pagination={false}
              scroll={{ x: 760 }}
              locale={{ emptyText: <Empty description={q ? 'No users found' : 'Search for a user'} /> }}
              columns={[
                {
                  title: 'User',
                  key: 'user',
                  render: (_, u) => (
                    <div>
                      <Typography.Text strong>{u.displayName}</Typography.Text>
                      {u.accountEnabled === false && <Tag style={{ marginLeft: 6 }}>disabled</Tag>}
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {u.userPrincipalName}
                          {u.mail && u.mail !== u.userPrincipalName ? ` · ${u.mail}` : ''}
                        </Typography.Text>
                      </div>
                    </div>
                  ),
                },
                { title: 'Job title', key: 'job', width: 200, render: (_, u) => [u.jobTitle, u.department].filter(Boolean).join(' · ') || '–' },
                {
                  title: 'CMDB',
                  key: 'cmdb',
                  width: 220,
                  render: (_, u) =>
                    u.cmdbRole ? (
                      <RoleTag role={u.cmdbRole} />
                    ) : (
                      <Button size="small" icon={<UserAddOutlined />} onClick={() => setProvisioning(u)}>
                        Add to CMDB
                      </Button>
                    ),
                },
              ]}
            />
            {users.next && (
              <Button style={{ marginTop: 12 }} loading={users.loadingMore} onClick={users.loadMore}>
                Load more
              </Button>
            )}
          </>
        ) : (
          <>
            <GraphError error={groups.error} />
            <Table<DirectoryGroup>
              rowKey="id"
              loading={groups.isFetching}
              dataSource={groups.items}
              pagination={false}
              scroll={{ x: 760 }}
              locale={{ emptyText: <Empty description={q ? 'No groups found' : 'Search for a group'} /> }}
              expandable={{ expandedRowRender: (g) => <GroupMembers groupId={g.id} onProvision={setProvisioning} />, rowExpandable: () => true }}
              columns={[
                {
                  title: 'Group',
                  key: 'group',
                  render: (_, g) => (
                    <div>
                      <Typography.Text strong>{g.displayName}</Typography.Text>
                      <div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {g.description ?? g.mail ?? ''}
                        </Typography.Text>
                      </div>
                    </div>
                  ),
                },
                {
                  title: 'CMDB role',
                  key: 'role',
                  width: 240,
                  render: (_, g) => (
                    <Space>
                      {g.mappedRole && <RoleTag role={g.mappedRole} />}
                      <Button size="small" icon={<EditOutlined />} onClick={() => setMapping({ groupId: g.id, displayName: g.displayName, role: g.mappedRole ?? undefined })}>
                        {g.mappedRole ? 'Change' : 'Assign role'}
                      </Button>
                    </Space>
                  ),
                },
              ]}
            />
            {groups.next && (
              <Button style={{ marginTop: 12 }} loading={groups.loadingMore} onClick={groups.loadMore}>
                Load more
              </Button>
            )}
          </>
        )}
      </Card>

      <GroupRoleTable onEdit={setMapping} groupPermissionMissing={!!missing?.includes('GroupMember.Read.All')} />
      <AppRoleAssignments enabled={can('Application.Read.All')} />

      <ProvisionModal user={provisioning} onClose={() => setProvisioning(null)} />
      <GroupRoleModal value={mapping} onClose={() => setMapping(null)} />
    </div>
  );
}

function GroupMembers({ groupId, onProvision }: { groupId: string; onProvision: (u: DirectoryUser) => void }) {
  const members = usePaged<DirectoryUser>(['entra', 'members', groupId], `/api/entra/groups/${groupId}/members`, '');
  return (
    <div>
      <GraphError error={members.error} />
      <Table<DirectoryUser>
        size="small"
        rowKey="id"
        loading={members.isFetching}
        dataSource={members.items}
        pagination={false}
        locale={{ emptyText: 'No users in this group' }}
        columns={[
          { title: 'Member (including nested groups)', key: 'n', render: (_, u) => `${u.displayName} · ${u.userPrincipalName ?? u.mail ?? ''}` },
          {
            title: 'CMDB',
            key: 'c',
            width: 200,
            render: (_, u) =>
              u.cmdbRole ? (
                <RoleTag role={u.cmdbRole} />
              ) : (
                <Button size="small" type="link" onClick={() => onProvision(u)}>
                  Add to CMDB
                </Button>
              ),
          },
        ]}
      />
      {members.next && (
        <Button size="small" style={{ marginTop: 8 }} loading={members.loadingMore} onClick={members.loadMore}>
          Load more
        </Button>
      )}
    </div>
  );
}

function PlantScopeSelect(props: { value?: string[]; onChange?: (v: string[]) => void; disabled?: boolean }) {
  const plants = usePlants();
  return (
    <Select
      mode="multiple"
      allowClear
      optionFilterProp="label"
      placeholder="All plants"
      disabled={props.disabled}
      value={props.value}
      onChange={props.onChange}
      options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
    />
  );
}

function ProvisionModal({ user, onClose }: { user: DirectoryUser | null; onClose: () => void }) {
  const [form] = Form.useForm<{ role: Role; plant_scope: string[] }>();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const role = Form.useWatch('role', form);

  const submit = async () => {
    if (!user) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await http.post(`/api/entra/users/${user.id}/provision`, { role: v.role, plant_scope: v.role === 'admin' ? [] : (v.plant_scope ?? []) });
      message.success(`${user.displayName} added – the account is used at the first sign-in with Microsoft`);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['entra'] }), queryClient.invalidateQueries({ queryKey: ['users'] })]);
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={!!user} title={user ? `Add ${user.displayName} to the CMDB` : ''} onCancel={onClose} onOk={submit} okText="Add" confirmLoading={saving} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        {user?.userPrincipalName} – the role set here applies unless the person has an app role or a mapped Entra group (those take precedence).
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ role: 'viewer', plant_scope: [] }}>
        <Form.Item name="role" label="Role" rules={[{ required: true }]}>
          <Select options={roleOptions} />
        </Form.Item>
        <Form.Item name="plant_scope" label="Plant scope" extra={role === 'admin' ? 'Administrators always see all plants.' : 'Leave empty to grant access to all plants.'}>
          <PlantScopeSelect disabled={role === 'admin'} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function GroupRoleModal({ value, onClose }: { value: { groupId: string; displayName: string; role?: Role; plantScope?: string[] } | null; onClose: () => void }) {
  const [form] = Form.useForm<{ role: Role; plant_scope: string[] }>();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const role = Form.useWatch('role', form);

  const submit = async () => {
    if (!value) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await http.put(`/api/entra/group-roles/${value.groupId}`, { display_name: value.displayName, role: v.role, plant_scope: v.role === 'admin' ? [] : (v.plant_scope ?? []) });
      message.success('Group mapping saved – it applies at the next sign-in of each member');
      await queryClient.invalidateQueries({ queryKey: ['entra'] });
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!value}
      title={value ? `CMDB role for the group “${value.displayName}”` : ''}
      onCancel={onClose}
      onOk={submit}
      okText="Save"
      confirmLoading={saving}
      destroyOnHidden
      afterOpenChange={(open) => open && value && form.setFieldsValue({ role: value.role ?? 'viewer', plant_scope: value.plantScope ?? [] })}
    >
      <Typography.Paragraph type="secondary">
        Members (including nested groups) get this role at sign-in, unless an app role is assigned to them – app roles take precedence. If a person is in
        several mapped groups, the highest role wins.
      </Typography.Paragraph>
      <Form form={form} layout="vertical">
        <Form.Item name="role" label="Role" rules={[{ required: true }]}>
          <Select options={roleOptions} />
        </Form.Item>
        <Form.Item name="plant_scope" label="Plant scope" extra={role === 'admin' ? 'Administrators always see all plants.' : 'Leave empty to grant access to all plants.'}>
          <PlantScopeSelect disabled={role === 'admin'} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function GroupRoleTable({
  onEdit,
  groupPermissionMissing,
}: {
  onEdit: (v: { groupId: string; displayName: string; role?: Role; plantScope?: string[] }) => void;
  groupPermissionMissing: boolean;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const plants = usePlants();
  const mappings = useQuery({ queryKey: ['entra', 'group-roles'], queryFn: () => http.get<GroupRoleMapping[]>('/api/entra/group-roles') });
  const code = (id: string) => plants.data?.find((p) => p.id === id)?.code ?? '?';

  const remove = async (m: GroupRoleMapping) => {
    try {
      await http.del(`/api/entra/group-roles/${m.groupId}`);
      message.success('Group mapping removed');
      await queryClient.invalidateQueries({ queryKey: ['entra'] });
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <Card title="Entra groups → CMDB roles" style={{ marginBottom: 16 }} extra={<Typography.Text type="secondary">search a group above to add one</Typography.Text>}>
      {groupPermissionMissing && !!mappings.data?.length && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Group roles cannot be evaluated"
          description="Without the application permission GroupMember.Read.All the group memberships cannot be read at sign-in – members of these groups without an app role are refused."
        />
      )}
      <Table<GroupRoleMapping>
        rowKey="groupId"
        loading={mappings.isLoading}
        dataSource={mappings.data ?? []}
        pagination={false}
        locale={{ emptyText: 'No groups mapped – roles come from app roles or are set per user.' }}
        columns={[
          { title: 'Group', dataIndex: 'displayName' },
          { title: 'Role', key: 'role', width: 140, render: (_, m) => <RoleTag role={m.role} /> },
          {
            title: 'Plant scope',
            key: 'scope',
            width: 240,
            render: (_, m) => (m.role === 'admin' || !m.plantScope.length ? <Typography.Text type="secondary">All plants</Typography.Text> : m.plantScope.map((id) => <Tag key={id}>{code(id)}</Tag>)),
          },
          {
            title: '',
            key: 'actions',
            width: 100,
            render: (_, m) => (
              <Space>
                <Button type="text" icon={<EditOutlined />} aria-label="Edit" onClick={() => onEdit({ groupId: m.groupId, displayName: m.displayName, role: m.role, plantScope: m.plantScope })} />
                <Popconfirm title={`Remove the mapping of “${m.displayName}”?`} description="Members keep their role until their next sign-in." onConfirm={() => remove(m)}>
                  <Button type="text" danger icon={<DeleteOutlined />} aria-label="Remove" />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}

function AppRoleAssignments({ enabled }: { enabled: boolean }) {
  const assignments = useQuery({
    queryKey: ['entra', 'app-role-assignments'],
    queryFn: () => http.get<AppRoleAssignmentDto[]>('/api/entra/app-role-assignments'),
    retry: false,
    enabled,
  });
  return (
    <Card title="App role assignments of the enterprise application" extra={<Typography.Text type="secondary">read-only · managed in Microsoft Entra ID</Typography.Text>}>
      <GraphError error={assignments.error} />
      <Table<AppRoleAssignmentDto>
        rowKey={(a) => `${a.principalId}-${a.appRoleValue}`}
        loading={assignments.isLoading}
        dataSource={assignments.data ?? []}
        pagination={{ pageSize: 25, hideOnSinglePage: true }}
        locale={{ emptyText: enabled ? 'No users or groups are assigned to an app role.' : 'Needs the application permission Application.Read.All – see the Enterprise application in Microsoft Entra ID.' }}
        columns={[
          {
            title: 'Assigned to',
            key: 'p',
            render: (_, a) => (
              <Space>
                {a.principalType === 'Group' ? <TeamOutlined /> : <UserOutlined />}
                {a.principalDisplayName}
              </Space>
            ),
          },
          { title: 'Type', dataIndex: 'principalType', width: 140 },
          {
            title: 'App role',
            key: 'r',
            width: 220,
            render: (_, a) =>
              a.role ? (
                <Space>
                  <RoleTag role={a.role} />
                  <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
                    {a.appRoleValue}
                  </Typography.Text>
                </Space>
              ) : (
                <Tooltip title="Not a CMDB role value (CMDB.Admin/Editor/Operator/Viewer)">
                  <Tag>{a.appRoleValue ?? 'default access'}</Tag>
                </Tooltip>
              ),
          },
        ]}
      />
    </Card>
  );
}
