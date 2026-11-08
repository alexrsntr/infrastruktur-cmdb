import { Button, Card, Divider, Space, Tag, Typography } from 'antd';
import { LoginOutlined, WindowsFilled } from '@ant-design/icons';
import type { AppConfig } from '../../../shared/model';
import { ROLE_META } from '../../../shared/model';
import { BrandMark } from '../components/BrandMark';
import { HEADER_BG } from '../theme';

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
        <Typography.Paragraph type="secondary">
          Configuration management for plants, buildings and IT infrastructure. Sign in with your corporate account.
        </Typography.Paragraph>

        {config?.authMode !== 'dev' ? (
          <Button type="primary" size="large" block icon={<WindowsFilled />} href={`/auth/login?returnTo=${rt}`}>
            Sign in with Microsoft
          </Button>
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
