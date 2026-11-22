import { useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { Avatar, Button, Drawer, Dropdown, Grid, Layout, Tag, Tooltip, Typography, type MenuProps } from 'antd';
import {
  AppstoreOutlined,
  AuditOutlined,
  EnvironmentOutlined,
  HomeOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuOutlined,
  PlusOutlined,
  ScheduleOutlined,
  SettingOutlined,
  SwapOutlined,
  TeamOutlined,
  UserOutlined,
  BlockOutlined,
  RadarChartOutlined,
  SafetyCertificateOutlined,
  FileProtectOutlined,
} from '@ant-design/icons';
import { firstName, ROLE_META } from '../../../shared/model';
import { useSession } from '../lib/session';
import { usePlants } from '../lib/queries';
import { BrandMark } from '../components/BrandMark';
import { GlobalSearch } from '../components/GlobalSearch';
import { useAddDevice } from '../components/AddDeviceWizard';
import { ChangePasswordModal } from '../components/ChangePasswordModal';
import { ColorModeSwitch } from '../components/ColorModeSwitch';
import { DbStorageBanner } from '../components/DbStorageBanner';

interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  to: string;
  match: (path: string) => boolean;
}

const NAV: NavItem[] = [
  { key: 'home', label: 'Home', icon: <HomeOutlined />, to: '/', match: (p) => p === '/' },
  // Racks have no entry of their own: they are reached through the plant (and its buildings)
  { key: 'sites', label: 'Plants', icon: <EnvironmentOutlined />, to: '/plants', match: (p) => /^\/(plants|buildings|map|plans|datacenters|racks)/.test(p) },
  { key: 'devices', label: 'Devices', icon: <AppstoreOutlined />, to: '/inventory', match: (p) => /^\/(inventory|assets)/.test(p) },
  { key: 'apps', label: 'Applications', icon: <BlockOutlined />, to: '/applications', match: (p) => p.startsWith('/applications') },
  { key: 'certs', label: 'Certificates', icon: <FileProtectOutlined />, to: '/certificates', match: (p) => p.startsWith('/certificates') },
  { key: 'activities', label: 'Activities', icon: <ScheduleOutlined />, to: '/activities', match: (p) => p.startsWith('/activities') },
];

export function AppLayout() {
  const { me, config, logout, scoped, can } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const plants = usePlants();
  const { open: openAddDevice } = useAddDevice();
  const [drawer, setDrawer] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const wide = !!screens.lg;
  const role = ROLE_META[me.user.role];
  // the logo for the navigation bar's background (light bar: logo for light backgrounds, else the one for dark)
  const darkHeader = config.headerStyle !== 'light';
  const logo = darkHeader ? (config.logoUrl?.dark ?? config.logoUrl?.light) : (config.logoUrl?.light ?? config.logoUrl?.dark);

  const scopeCodes = useMemo(() => {
    if (!scoped) return null;
    const codes = (plants.data ?? []).filter((p) => me.user.plantScope.includes(p.id)).map((p) => p.code);
    return codes.length ? codes.join(', ') : null;
  }, [scoped, plants.data, me.user.plantScope]);

  const adminItems: MenuProps['items'] = [
    ...(can('export') ? [{ key: '/data', icon: <SwapOutlined />, label: 'Export & import' }] : []),
    { key: '/data-quality', icon: <SafetyCertificateOutlined />, label: 'Data quality' },
    ...(can('asset.write') ? [{ key: '/discovery', icon: <RadarChartOutlined />, label: 'Discovered devices' }] : []),
    ...(can('user.manage') ? [{ key: '/admin/users', icon: <TeamOutlined />, label: 'Users & permissions' }] : []),
    ...(can('audit.read') ? [{ key: '/admin/audit', icon: <AuditOutlined />, label: 'Audit log' }] : []),
    ...(can('settings.manage') ? [{ key: '/admin/settings', icon: <SettingOutlined />, label: 'Settings & e-mail' }] : []),
  ];

  const userMenu: MenuProps = {
    items: [
      {
        key: 'info',
        disabled: true,
        label: (
          <div style={{ minWidth: 240, padding: '4px 0' }}>
            <Typography.Text strong style={{ fontSize: 15 }}>
              {me.user.displayName}
            </Typography.Text>
            <br />
            <Typography.Text type="secondary" className="fs-small">
              {me.user.email}
            </Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Tag color={role.color}>{role.label}</Tag>
              {scopeCodes && <Tag color="gold">Plants: {scopeCodes}</Tag>}
            </div>
          </div>
        ),
      },
      { type: 'divider' },
      ...(adminItems.length ? [...adminItems, { type: 'divider' as const }] : []),
      // only for password sign-ins – Microsoft accounts change their password in Microsoft
      ...(me.canChangePassword ? [{ key: 'password', icon: <KeyOutlined />, label: 'Change password' }] : []),
      { key: 'logout', icon: <LogoutOutlined />, label: 'Sign out', danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'logout') void logout();
      else if (key === 'password') setChangingPassword(true);
      else if (key.startsWith('/')) navigate(key);
    },
  };

  const navLinks = (vertical: boolean) =>
    NAV.map((n) => {
      const active = n.match(location.pathname);
      return (
        <Link
          key={n.key}
          to={n.to}
          className={`top-nav-item${active ? ' active' : ''}${vertical ? ' vertical' : ''}`}
          onClick={() => setDrawer(false)}
          // on laptop screens only the icons are shown (styles.css) – the label stays as tooltip and for screen readers
          title={vertical ? undefined : n.label}
          aria-label={n.label}
        >
          <span className="top-nav-icon">{n.icon}</span>
          <span className="top-nav-label">{n.label}</span>
        </Link>
      );
    });

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Header className="app-header">
        {!wide && <Button type="text" className="header-icon-btn" icon={<MenuOutlined />} onClick={() => setDrawer(true)} aria-label="Menu" />}
        <Link to="/" className="brand" aria-label={`${config.appName} – home`}>
          {logo ? <img src={logo} alt={config.brandName} className="brand-logo" /> : <BrandMark size={34} inverted={darkHeader} />}
          <span className="brand-text">
            {!logo && <span className="brand-name">{config.brandName}</span>}
            <span className="brand-app">{config.appName}</span>
          </span>
        </Link>
        {wide && <nav className="top-nav">{navLinks(false)}</nav>}
        <div style={{ flex: 1 }} />
        {screens.md && (
          <div className="header-search">
            <GlobalSearch />
          </div>
        )}
        {can('asset.write') && (
          <Tooltip title="Add device">
            <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => openAddDevice()} className="header-add" aria-label="Add device">
              {screens.sm ? <span className="header-add-text">Add device</span> : null}
            </Button>
          </Tooltip>
        )}
        {scopeCodes && wide && (
          <Tooltip title="You see and edit the devices of these plants">
            <Tag color="gold" className="header-scope">
              {scopeCodes}
            </Tag>
          </Tooltip>
        )}
        <ColorModeSwitch className="header-icon-btn" />
        <Dropdown menu={userMenu} placement="bottomRight" trigger={['click']}>
          <Button type="text" className="header-user" aria-label="User menu">
            <Avatar size={34} icon={<UserOutlined />} className="header-avatar" />
            {screens.xl && <span className="header-user-name">{firstName(me.user.displayName) || me.user.displayName}</span>}
          </Button>
        </Dropdown>
      </Layout.Header>

      <Drawer open={drawer} onClose={() => setDrawer(false)} placement="left" width={300} title={config.appName} styles={{ body: { padding: 12 } }}>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{navLinks(true)}</nav>
        {!screens.md && (
          <div style={{ marginTop: 16 }}>
            <GlobalSearch />
          </div>
        )}
      </Drawer>

      <Layout.Content className="app-content">
        <div className="app-content-inner">
          <DbStorageBanner />
          <Outlet />
        </div>
      </Layout.Content>
      <ChangePasswordModal open={changingPassword} onClose={() => setChangingPassword(false)} />
    </Layout>
  );
}
