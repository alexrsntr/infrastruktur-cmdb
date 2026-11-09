import { useEffect, useMemo } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider, Result, Spin, Button } from 'antd';
import enGB from 'antd/locale/en_GB';
import type { AppConfig, MeResponse, Permission } from '../../shared/model';
import { ApiError, http, setCsrfToken } from './lib/api';
import { SessionContext, type SessionValue } from './lib/session';
import { buildTheme } from './theme';
import { ColorModeProvider, useColorModeState } from './lib/colorMode';
import { AppLayout } from './layout/AppLayout';
import { AddDeviceProvider } from './components/AddDeviceWizard';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { MapPage } from './pages/MapPage';
import { PlantsPage } from './pages/PlantsPage';
import { PlantPage } from './pages/PlantPage';
import { BuildingPage } from './pages/BuildingPage';
import { AssetsPage } from './pages/AssetsPage';
import { AssetPage } from './pages/AssetPage';
import { ApplicationPage, ApplicationsPage } from './pages/ApplicationsPage';
import { DiscoveryPage } from './pages/DiscoveryPage';
import { LabelsPage } from './pages/LabelsPage';
import { DataQualityPage } from './pages/DataQualityPage';
import { ActivitiesPage } from './pages/ActivitiesPage';
import { DataExchangePage } from './pages/DataExchangePage';
import { UsersPage } from './pages/admin/UsersPage';
import { AuditPage } from './pages/admin/AuditPage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { RackPage } from './pages/RackPage';
import { RacksPage } from './pages/RacksPage';
import { PlanPage } from './pages/PlanPage';
import { DatacenterPage } from './pages/DatacenterPage';
import { DatacentersPage } from './pages/DatacentersPage';
import { NotFoundPage } from './pages/NotFoundPage';

function useBootstrap() {
  const config = useQuery({ queryKey: ['public-config'], queryFn: () => http.get<AppConfig>('/api/public-config'), staleTime: Infinity });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => http.get<MeResponse>('/api/me'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (me.data) setCsrfToken(me.data.csrfToken);
  }, [me.data]);
  return { config, me };
}

export function Root() {
  const { config, me } = useBootstrap();
  const location = useLocation();
  const colorMode = useColorModeState();
  const theme = useMemo(() => buildTheme(config.data?.primaryColor ?? '#2563eb', colorMode.mode), [config.data?.primaryColor, colorMode.mode]);

  useEffect(() => {
    if (config.data) document.title = `${config.data.appName} · ${config.data.brandName}`;
  }, [config.data]);

  const session: SessionValue | null = useMemo(() => {
    if (!me.data) return null;
    const perms = new Set<Permission>(me.data.permissions);
    return {
      me: me.data,
      config: me.data.config,
      can: (p) => perms.has(p),
      scoped: me.data.user.role !== 'admin' && me.data.user.plantScope.length > 0,
      logout: async () => {
        const res = await http.post<{ logoutUrl: string }>('/auth/logout');
        window.location.href = res.logoutUrl || '/';
      },
    };
  }, [me.data]);

  let content: React.ReactNode;
  if (config.isLoading || me.isLoading) {
    content = (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
        <Spin size="large" />
      </div>
    );
  } else if (!session) {
    const unauthorised = me.error instanceof ApiError && me.error.status === 401;
    content = unauthorised || location.pathname === '/login' ? (
      <LoginPage config={config.data} />
    ) : (
      <Result
        status="error"
        title="The CMDB is currently not reachable"
        subTitle={me.error instanceof Error ? me.error.message : undefined}
        extra={<Button onClick={() => window.location.reload()}>Retry</Button>}
      />
    );
  } else {
    content = (
      <SessionContext.Provider value={session}>
        <AddDeviceProvider>
        <Routes>
          <Route path="labels" element={<LabelsPage />} />
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="map" element={<MapPage />} />
            <Route path="plants" element={<PlantsPage />} />
            <Route path="plants/:plantId" element={<PlantPage />} />
            <Route path="buildings/:buildingId" element={<BuildingPage />} />
            <Route path="inventory" element={<AssetsPage />} />
            <Route path="inventory/:typeSlug" element={<AssetsPage />} />
            <Route path="assets/:assetId" element={<AssetPage />} />
            <Route path="activities" element={<ActivitiesPage />} />
            <Route path="applications" element={<ApplicationsPage />} />
            <Route path="applications/:applicationId" element={<ApplicationPage />} />
            <Route path="data" element={<DataExchangePage />} />
            <Route path="discovery" element={<DiscoveryPage />} />
            <Route path="data-quality" element={<DataQualityPage />} />
            <Route path="admin/users" element={<UsersPage />} />
            <Route path="admin/audit" element={<AuditPage />} />
            <Route path="admin/settings" element={<SettingsPage />} />
            <Route path="racks" element={<RacksPage />} />
            <Route path="racks/:rackId" element={<RackPage />} />
            <Route path="plans/:planId" element={<PlanPage />} />
            <Route path="datacenters" element={<DatacentersPage />} />
            <Route path="datacenters/:datacenterId" element={<DatacenterPage />} />
            <Route path="login" element={<DashboardPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        </AddDeviceProvider>
      </SessionContext.Provider>
    );
  }

  return (
    <ColorModeProvider value={colorMode}>
      <ConfigProvider theme={theme} locale={enGB}>
        <AntApp>{content}</AntApp>
      </ConfigProvider>
    </ColorModeProvider>
  );
}
