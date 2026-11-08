import { useEffect, useState } from 'react';
import { Alert, Button, Card, Divider, Form, Input, Space, Spin, Tag, Typography } from 'antd';
import { LockOutlined, LoginOutlined, MailOutlined, UserOutlined, WindowsFilled } from '@ant-design/icons';
import type { AppConfig } from '../../../shared/model';
import { ROLE_META } from '../../../shared/model';
import { BrandMark } from '../components/BrandMark';
import { HEADER_BG } from '../theme';
import { errorText, http } from '../lib/api';

const DEV_PERSONAS = [
  { key: 'admin', name: 'Anna Admin', role: 'admin' as const, note: 'all plants' },
  { key: 'editor', name: 'Erik Editor', role: 'editor' as const, note: 'all plants' },
  { key: 'local', name: 'Lars Local Admin', role: 'editor' as const, note: 'plant MUC only' },
  { key: 'operator', name: 'Olga Operator', role: 'operator' as const, note: 'plant MUC only' },
  { key: 'viewer', name: 'Viktor Viewer', role: 'viewer' as const, note: 'all plants' },
];

export function LoginPage({ config }: { config?: AppConfig }) {
  const params = new URLSearchParams(window.location.search);
  const returnTo = params.get('returnTo') ?? (window.location.pathname === '/login' ? '/' : window.location.pathname + window.location.search);
  const rt = encodeURIComponent(returnTo);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: `linear-gradient(135deg, ${HEADER_BG} 0%, #134a7c 55%, #e9eef4 55.1%)`,
        padding: 24,
      }}
    >
      <Card style={{ width: 420, boxShadow: '0 12px 40px rgba(11,42,74,.25)' }} styles={{ body: { padding: 32 } }}>
        <Space align="center" size={12} style={{ marginBottom: 24 }}>
          <BrandMark size={40} />
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, letterSpacing: 1, textTransform: 'uppercase' }}>
              {config?.brandName ?? 'Infrastruktur'}
            </Typography.Text>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {config?.appName ?? 'IT CMDB'}
            </Typography.Title>
          </div>
        </Space>
        {config?.authMode === 'local' ? (
          <LocalLogin returnTo={returnTo} />
        ) : config?.authMode !== 'dev' ? (
          <>
            <Typography.Paragraph type="secondary">
              Configuration management for plants, buildings and IT infrastructure. Sign in with your corporate account.
            </Typography.Paragraph>
            <Button type="primary" size="large" block icon={<WindowsFilled />} href={`/auth/login?returnTo=${rt}`}>
              Sign in with Microsoft
            </Button>
          </>
        ) : (
          <>
            <Tag color="orange" style={{ marginBottom: 12 }}>
              Development mode – Entra ID SSO is disabled
            </Tag>
            <Divider plain style={{ margin: '8px 0 16px' }}>
              Sign in as
            </Divider>
            <Space direction="vertical" style={{ width: '100%' }}>
              {DEV_PERSONAS.map((p) => (
                <Button key={p.key} block href={`/auth/dev-login?persona=${p.key}&returnTo=${rt}`} icon={<LoginOutlined />} style={{ justifyContent: 'flex-start' }}>
                  <span style={{ flex: 1, textAlign: 'left' }}>{p.name}</span>
                  <Tag color={ROLE_META[p.role].color} style={{ marginInlineEnd: 0 }}>
                    {ROLE_META[p.role].label}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12, width: 92, textAlign: 'right' }}>
                    {p.note}
                  </Typography.Text>
                </Button>
              ))}
            </Space>
          </>
        )}
      </Card>
    </div>
  );
}

function safeTarget(returnTo: string) {
  return returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
}

/** AUTH_MODE=local: e-mail + password, or – on the very first start – creating the administrator account. */
function LocalLogin({ returnTo }: { returnTo: string }) {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    http
      .get<{ needsSetup: boolean }>('/auth/setup')
      .then((r) => setNeedsSetup(r.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, []);

  const send = async (path: string, body: object) => {
    setBusy(true);
    setError(null);
    try {
      await http.post(path, body);
      window.location.href = safeTarget(returnTo);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  if (needsSetup === null) return <Spin style={{ display: 'block', margin: '24px auto' }} />;

  if (needsSetup) {
    return (
      <>
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          Welcome! Create your administrator account
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          This is the first start. The account you create now is the administrator; you can add more users afterwards under
          <em> Users &amp; permissions</em>.
        </Typography.Paragraph>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form
          layout="vertical"
          requiredMark={false}
          onFinish={(v: { display_name: string; email: string; password: string }) =>
            send('/auth/setup', { display_name: v.display_name, email: v.email, password: v.password })
          }
        >
          <Form.Item name="display_name" label="Your name" rules={[{ required: true, whitespace: true, message: 'Enter your name' }]}>
            <Input prefix={<UserOutlined />} size="large" autoFocus autoComplete="name" />
          </Form.Item>
          <Form.Item name="email" label="E-mail address" rules={[{ required: true, type: 'email', message: 'Enter a valid e-mail address' }]}>
            <Input prefix={<MailOutlined />} size="large" autoComplete="email" />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            extra="At least 10 characters."
            rules={[{ required: true, message: 'Choose a password' }, { min: 10, message: 'At least 10 characters' }]}
          >
            <Input.Password prefix={<LockOutlined />} size="large" autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="repeat"
            label="Repeat password"
            dependencies={['password']}
            rules={[
              { required: true, message: 'Repeat the password' },
              ({ getFieldValue }) => ({
                validator: (_, value) => (!value || value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('The passwords do not match'))),
              }),
            ]}
          >
            <Input.Password prefix={<LockOutlined />} size="large" autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" size="large" block htmlType="submit" loading={busy}>
            Create account and sign in
          </Button>
        </Form>
      </>
    );
  }

  return (
    <>
      <Typography.Paragraph type="secondary">
        Configuration management for plants, buildings and IT infrastructure. Sign in with your e-mail address and password.
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      <Form layout="vertical" requiredMark={false} onFinish={(v: { email: string; password: string }) => send('/auth/local-login', v)}>
        <Form.Item name="email" label="E-mail address" rules={[{ required: true, message: 'Enter your e-mail address' }]}>
          <Input prefix={<MailOutlined />} size="large" autoFocus autoComplete="username" />
        </Form.Item>
        <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter your password' }]}>
          <Input.Password prefix={<LockOutlined />} size="large" autoComplete="current-password" />
        </Form.Item>
        <Button type="primary" size="large" block htmlType="submit" loading={busy} icon={<LoginOutlined />}>
          Sign in
        </Button>
      </Form>
      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
        Forgot your password? Ask a CMDB administrator to set a new one.
      </Typography.Paragraph>
    </>
  );
}
