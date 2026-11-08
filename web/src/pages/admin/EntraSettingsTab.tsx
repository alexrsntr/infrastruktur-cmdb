import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Form, Input, Popconfirm, Radio, Row, Space, Spin, Steps, Switch, Tag, Tooltip, Typography } from 'antd';
import { ApiOutlined, CheckCircleFilled, CloseCircleFilled, LoginOutlined, PoweroffOutlined, SaveOutlined, WindowsFilled } from '@ant-design/icons';
import { GRAPH_APP_PERMISSIONS, type EntraCredential, type EntraSettingsDto, type EntraSettingsInput, type EntraTestResult, type LocalLoginMode } from '../../../../shared/entra';
import { errorText, http } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';

interface FormValues {
  tenantId: string;
  clientId: string;
  credential: EntraCredential;
  managedIdentityClientId: string;
  clientSecret: string;
  requireAppRole: boolean;
}

const GUID_RULE = { pattern: /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/, message: 'Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' };

function EnvTag({ show, name }: { show?: boolean; name: string }) {
  if (!show) return null;
  return (
    <Tooltip title={`Set by the environment variable ${name} – change it there (e.g. App Service configuration).`}>
      <Tag color="purple" style={{ marginInlineStart: 8 }}>
        set by environment
      </Tag>
    </Tooltip>
  );
}

export function EntraSettingsTab() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const settings = useQuery({ queryKey: ['settings', 'entra'], queryFn: () => http.get<EntraSettingsDto>('/api/settings/entra') });
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<EntraTestResult | null>(null);
  const credential = Form.useWatch('credential', form);
  const s = settings.data;
  const readOnly = s?.source === 'env';

  useEffect(() => {
    if (!s) return;
    form.setFieldsValue({
      tenantId: s.tenantId,
      clientId: s.clientId,
      credential: s.credential,
      managedIdentityClientId: s.managedIdentityClientId,
      clientSecret: '',
      requireAppRole: s.requireAppRole,
    });
  }, [s, form]);

  const refresh = async (next?: EntraSettingsDto) => {
    if (next) queryClient.setQueryData(['settings', 'entra'], next);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['settings', 'entra'] }),
      queryClient.invalidateQueries({ queryKey: ['public-config'] }),
      queryClient.invalidateQueries({ queryKey: ['entra'] }),
    ]);
  };

  const run = async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(key);
    try {
      const result = await fn();
      if (success) message.success(success);
      return result;
    } catch (e) {
      message.error(errorText(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const save = async (patch: Partial<EntraSettingsInput> = {}) => {
    const v = await form.validateFields();
    const body: EntraSettingsInput = {
      tenantId: v.tenantId?.trim() ?? '',
      clientId: v.clientId?.trim() ?? '',
      credential: v.credential,
      managedIdentityClientId: v.managedIdentityClientId?.trim() ?? '',
      clientSecret: v.clientSecret ? v.clientSecret : undefined,
      requireAppRole: v.requireAppRole,
      ...patch,
    };
    for (const k of Object.keys(s?.locked ?? {}) as (keyof EntraSettingsInput)[]) if (s?.locked[k as keyof EntraSettingsDto['locked']]) delete body[k];
    const next = await run('save', () => http.put<EntraSettingsDto>('/api/settings/entra', body), 'Saved');
    if (next) {
      setTest(null);
      form.setFieldValue('clientSecret', '');
      await refresh(next);
    }
  };

  const testConnection = async () => {
    const result = await run('test', () => http.post<EntraTestResult>('/api/settings/entra/test'));
    if (result) {
      setTest(result);
      await refresh();
    }
  };

  const activate = async () => {
    const next = await run('activate', () => http.post<EntraSettingsDto>('/api/settings/entra/activate'), 'Sign-in with Microsoft is active');
    if (next) await refresh(next);
  };
  const deactivate = async () => {
    const next = await run('deactivate', () => http.post<EntraSettingsDto>('/api/settings/entra/deactivate'), 'Sign-in with Microsoft is turned off');
    if (next) await refresh(next);
  };
  const setLocalLogin = async (mode: LocalLoginMode) => {
    const next = await run('local', () => http.put<EntraSettingsDto>('/api/settings/entra/local-login', { mode }), 'Password sign-in updated');
    if (next) await refresh(next);
  };

  if (settings.isLoading || !s) return <Spin style={{ display: 'block', margin: 40 }} />;

  const step = s.enabled ? 4 : !s.configured ? 0 : !s.connection ? 1 : !s.login?.ok ? 2 : 3;

  return (
    <div style={{ paddingTop: 16 }}>
      {readOnly ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 20 }}
          message="Configured by environment variables (AUTH_MODE=entra)"
          description="The values below come from the App Service configuration (e.g. Terraform) and cannot be changed here. The directory features under Users & permissions use the same configuration."
        />
      ) : (
        <Steps
          size="small"
          current={step}
          style={{ marginBottom: 24 }}
          items={[
            { title: 'App registration', description: 'IDs and credential' },
            { title: 'Test connection', description: 'token + Microsoft Graph' },
            { title: 'Test sign-in', description: 'with your Microsoft account' },
            { title: 'Activate', description: 'without restart' },
            { title: 'Active', description: s.enabled ? 'Microsoft sign-in is on' : '' },
          ]}
        />
      )}

      <Row gutter={[24, 24]}>
        <Col xs={24} xl={14}>
          <Card
            title={
              <Space>
                <WindowsFilled /> App registration in Microsoft Entra ID
              </Space>
            }
            extra={s.enabled ? <Tag color="success">Active</Tag> : s.configured ? <Tag color="processing">Not active yet</Tag> : <Tag>Not configured</Tag>}
          >
            <Form form={form} layout="vertical" disabled={readOnly} requiredMark={false}>
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="tenantId"
                    label={
                      <>
                        Tenant ID (Directory ID) <EnvTag show={s.locked.tenantId} name="ENTRA_TENANT_ID" />
                      </>
                    }
                    rules={[GUID_RULE]}
                  >
                    <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" disabled={s.locked.tenantId || s.enabled} className="mono" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="clientId"
                    label={
                      <>
                        Application (client) ID <EnvTag show={s.locked.clientId} name="ENTRA_CLIENT_ID" />
                      </>
                    }
                    rules={[GUID_RULE]}
                  >
                    <Input placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" disabled={s.locked.clientId || s.enabled} className="mono" />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item
                name="credential"
                label={
                  <>
                    Credential of the app <EnvTag show={s.locked.credential} name="ENTRA_USE_MANAGED_IDENTITY" />
                  </>
                }
              >
                <Radio.Group disabled={s.locked.credential || s.enabled}>
                  <Radio value="secret">Client secret</Radio>
                  <Radio value="managedIdentity">Managed identity of the App Service (no secret)</Radio>
                </Radio.Group>
              </Form.Item>
              {credential === 'managedIdentity' ? (
                <Form.Item
                  name="managedIdentityClientId"
                  label={
                    <>
                      Client ID of the user-assigned managed identity (optional) <EnvTag show={s.locked.managedIdentityClientId} name="AZURE_CLIENT_ID" />
                    </>
                  }
                  rules={[GUID_RULE]}
                  extra="Empty = system-assigned identity. The identity must be added to the app registration as federated credential (Certificates & secrets → Federated credentials)."
                >
                  <Input disabled={s.locked.managedIdentityClientId || s.enabled} className="mono" />
                </Form.Item>
              ) : (
                <Form.Item
                  name="clientSecret"
                  label={
                    <>
                      Client secret <EnvTag show={s.locked.clientSecret} name="ENTRA_CLIENT_SECRET" />
                    </>
                  }
                  extra={
                    s.locked.clientSecret ? (
                      'The secret comes from the environment.'
                    ) : s.clientSecretSet ? (
                      <span>
                        Stored encrypted{s.clientSecretSetAt ? ` since ${fmtDateTime(s.clientSecretSetAt)}` : ''} – never shown again. Leave empty to keep it; enter a new
                        value to replace it.
                        {!s.enabled && (
                          <>
                            {' '}
                            <Popconfirm title="Remove the stored client secret?" onConfirm={() => save({ clientSecret: null })}>
                              <Typography.Link>Remove</Typography.Link>
                            </Popconfirm>
                          </>
                        )}
                      </span>
                    ) : (
                      'Use the secret’s “Value” (not the “Secret ID”). Note its expiry date – a new secret must be entered here before it expires.'
                    )
                  }
                >
                  <Input.Password autoComplete="new-password" disabled={s.locked.clientSecret} placeholder={s.clientSecretSet ? '•••••• (stored)' : ''} />
                </Form.Item>
              )}
              <Form.Item
                name="requireAppRole"
                valuePropName="checked"
                label={
                  <>
                    Only users with a role may sign in <EnvTag show={s.locked.requireAppRole} name="ENTRA_REQUIRE_APP_ROLE" />
                  </>
                }
                extra="On: only users with an app role (CMDB.Admin/Editor/Operator/Viewer) or a mapped Entra group can sign in. Off: everybody in the tenant can sign in with the default role."
              >
                <Switch disabled={s.locked.requireAppRole} />
              </Form.Item>
            </Form>
            {!readOnly && (
              <Space wrap>
                <Button type="primary" icon={<SaveOutlined />} loading={busy === 'save'} onClick={() => save()}>
                  Save
                </Button>
                <Button icon={<ApiOutlined />} loading={busy === 'test'} disabled={!s.configured} onClick={testConnection}>
                  Test connection
                </Button>
                <Tooltip title={!s.configured ? 'Save the configuration first' : 'Opens the Microsoft sign-in; you stay signed in to the CMDB'}>
                  <Button icon={<LoginOutlined />} disabled={!s.configured || s.enabled} href={s.configured && !s.enabled ? '/auth/entra/test-login' : undefined}>
                    Test sign-in with Microsoft
                  </Button>
                </Tooltip>
              </Space>
            )}
            {readOnly && (
              <Button icon={<ApiOutlined />} loading={busy === 'test'} onClick={testConnection}>
                Test connection
              </Button>
            )}

            {test && <TestResult result={test} />}
            {!test && s.connection && (
              <Alert
                style={{ marginTop: 16 }}
                type="success"
                showIcon
                message={`Connection OK${s.connection.tenantName ? ` – tenant "${s.connection.tenantName}"` : ''}`}
                description={`Tested ${fmtDateTime(s.connection.at)}. Granted Graph permissions: ${s.connection.grantedPermissions.join(', ') || 'none'}`}
              />
            )}
            {s.login && !s.enabled && (
              <Alert
                style={{ marginTop: 12 }}
                type={s.login.ok ? 'success' : 'error'}
                showIcon
                message={s.login.ok ? `Test sign-in OK – ${s.login.account ?? ''} signs in as administrator` : 'Test sign-in failed'}
                description={
                  <>
                    {s.login.message && <div>{s.login.message}</div>}
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      {s.login.userName}, {fmtDateTime(s.login.at)}
                    </Typography.Text>
                  </>
                }
              />
            )}
          </Card>

          {!readOnly && (
            <Card title="Activation" style={{ marginTop: 24 }}>
              {s.enabled ? (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Alert type="success" showIcon message="Sign-in with Microsoft is active" description="The login page shows “Sign in with Microsoft”. Changes take effect without restart." />
                  <Popconfirm
                    title="Turn off the sign-in with Microsoft?"
                    description="Everybody then signs in with e-mail and password again (password sign-in is switched on for all users)."
                    okButtonProps={{ danger: true }}
                    onConfirm={deactivate}
                  >
                    <Button danger icon={<PoweroffOutlined />} loading={busy === 'deactivate'}>
                      Deactivate
                    </Button>
                  </Popconfirm>
                </Space>
              ) : (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {s.activationBlockers.length > 0 && (
                    <Alert
                      type="info"
                      showIcon
                      message="Before activating"
                      description={
                        <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                          {s.activationBlockers.map((b) => (
                            <li key={b}>{b}</li>
                          ))}
                        </ul>
                      }
                    />
                  )}
                  <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
                    Password sign-in stays available for everybody after activation. You can restrict it afterwards.
                  </Typography.Paragraph>
                  <Button type="primary" icon={<WindowsFilled />} disabled={!s.canActivate} loading={busy === 'activate'} onClick={activate}>
                    Activate sign-in with Microsoft
                  </Button>
                </Space>
              )}
            </Card>
          )}

          {s.authMode === 'local' && s.enabled && <LocalLoginCard s={s} busy={busy === 'local'} onChange={setLocalLogin} />}
        </Col>

        <Col xs={24} xl={10}>
          <Card title="Redirect URIs (platform “Web”)">
            <Typography.Paragraph type="secondary">Enter both in the app registration under Authentication → Add a platform → Web:</Typography.Paragraph>
            {s.redirectUris.map((u) => (
              <Typography.Paragraph key={u} copyable={{ text: u }} className="mono" style={{ marginBottom: 6 }}>
                {u}
              </Typography.Paragraph>
            ))}
            <Typography.Paragraph type="secondary" style={{ fontSize: 12.5, marginTop: 8, marginBottom: 0 }}>
              The first one receives the sign-in, the second one is where Microsoft returns after signing out – both must be registered. They are built from APP_BASE_URL.
            </Typography.Paragraph>
          </Card>
          <Card title="Checklist for the app registration" style={{ marginTop: 24 }}>
            <ol style={{ paddingInlineStart: 18, margin: 0, lineHeight: 1.6 }}>
              <li>
                <b>Microsoft Entra ID → App registrations → New registration</b>, single tenant. Copy the <i>Directory (tenant) ID</i> and the{' '}
                <i>Application (client) ID</i> into the form.
              </li>
              <li>
                <b>Authentication</b>: platform <i>Web</i> with the redirect URIs shown above.
              </li>
              <li>
                <b>Certificates &amp; secrets</b>: a new client secret (copy the <i>Value</i>) – or a federated credential for the App Service&apos;s managed identity.
              </li>
              <li>
                <b>App roles</b> (allowed member types: users/groups), values exactly <code>CMDB.Admin</code>, <code>CMDB.Editor</code>, <code>CMDB.Operator</code>,{' '}
                <code>CMDB.Viewer</code> – optional if you map Entra groups to roles instead.
              </li>
              <li>
                <b>API permissions → Microsoft Graph</b>:
                <ul style={{ paddingInlineStart: 18 }}>
                  <li>
                    delegated for the sign-in: <code>openid</code>, <code>profile</code>, <code>email</code>, <code>User.Read</code>
                  </li>
                  <li>
                    application (read-only, for the directory features):{' '}
                    {GRAPH_APP_PERMISSIONS.map((p) => (
                      <Tooltip key={p.permission} title={p.purpose}>
                        <code style={{ marginInlineEnd: 6 }}>{p.permission}</code>
                      </Tooltip>
                    ))}
                  </li>
                </ul>
              </li>
              <li>
                <b>Grant admin consent</b> for the tenant (button on the API permissions page).
              </li>
              <li>
                Enterprise application → <b>Users and groups</b>: assign people or groups to the app roles (and set <i>Assignment required</i> if only assigned users may sign in).
              </li>
              <li>
                Network: the app needs outbound HTTPS to <code>login.microsoftonline.com</code> and <code>graph.microsoft.com</code> (allow both in the firewall if all
                outbound traffic is routed through it).
              </li>
            </ol>
          </Card>
        </Col>
      </Row>
    </div>
  );
}

function TestResult({ result }: { result: EntraTestResult }) {
  if (!result.ok) {
    return <Alert style={{ marginTop: 16 }} type="error" showIcon message={result.error} description={result.hint} />;
  }
  const missing = result.missingPermissions ?? [];
  return (
    <Alert
      style={{ marginTop: 16 }}
      type={missing.length ? 'warning' : 'success'}
      showIcon
      message={`Connection OK${result.tenantName ? ` – tenant "${result.tenantName}"` : ''}`}
      description={
        <Space direction="vertical" size={6}>
          <span>
            {GRAPH_APP_PERMISSIONS.map((p) => {
              const granted = (result.grantedPermissions ?? []).includes(p.permission) || (result.grantedPermissions ?? []).includes('Directory.Read.All');
              return (
                <Tag key={p.permission} icon={granted ? <CheckCircleFilled /> : <CloseCircleFilled />} color={granted ? 'success' : 'warning'}>
                  {p.permission}
                </Tag>
              );
            })}
          </span>
          {result.hint && <span>{result.hint}</span>}
        </Space>
      }
    />
  );
}

function LocalLoginCard({ s, busy, onChange }: { s: EntraSettingsDto; busy: boolean; onChange: (mode: LocalLoginMode) => void }) {
  const noEntraAdmin = s.entraAdminCount === 0;
  return (
    <Card title="Sign-in with e-mail and password" style={{ marginTop: 24 }}>
      {s.emergencyLocalLogin && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="LOCAL_LOGIN_EMERGENCY is set"
          description="Administrators can sign in with their password regardless of the setting below. Remove the environment variable once the problem is solved."
        />
      )}
      <Radio.Group value={s.localLogin} onChange={(e) => onChange(e.target.value)} disabled={busy}>
        <Space direction="vertical">
          <Radio value="all">For all users (Microsoft and password sign-in side by side)</Radio>
          <Tooltip title={noEntraAdmin ? 'An administrator must have signed in with Microsoft first' : undefined}>
            <Radio value="admins" disabled={noEntraAdmin}>
              Administrators only (emergency access)
            </Radio>
          </Tooltip>
          <Tooltip title={noEntraAdmin ? 'An administrator must have signed in with Microsoft first' : undefined}>
            <Radio value="off" disabled={noEntraAdmin}>
              Off – Microsoft only
            </Radio>
          </Tooltip>
        </Space>
      </Radio.Group>
      {s.localLogin === 'off' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16 }}
          message="If Microsoft sign-in fails, nobody can sign in"
          description="Emergency access: set the environment variable LOCAL_LOGIN_EMERGENCY=true (App Service → Configuration) and restart – administrators can then sign in with their password."
        />
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12.5 }}>
        Administrators linked to Microsoft: {s.entraAdminCount} · administrators with a password: {s.localAdminCount}
      </Typography.Paragraph>
    </Card>
  );
}
