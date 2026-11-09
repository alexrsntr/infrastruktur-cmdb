import {
  ApartmentOutlined,
  ApiOutlined,
  CloudServerOutlined,
  ClusterOutlined,
  ControlOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  GlobalOutlined,
  HddOutlined,
  PrinterOutlined,
  SafetyOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import type { AssetType } from '../../../shared/model';

export const ASSET_TYPE_ICONS: Record<AssetType, React.ReactNode> = {
  switch: <ApartmentOutlined />,
  router: <GlobalOutlined />,
  firewall: <SafetyOutlined />,
  access_point: <WifiOutlined />,
  wlan_controller: <ClusterOutlined />,
  server: <DatabaseOutlined />,
  storage: <HddOutlined />,
  vm: <CloudServerOutlined />,
  ups: <ThunderboltOutlined />,
  pdu: <ApiOutlined />,
  ot_device: <ControlOutlined />,
  printer: <PrinterOutlined />,
  camera: <VideoCameraOutlined />,
  other: <DeploymentUnitOutlined />,
};
