import { ApartmentOutlined, CloudServerOutlined, DatabaseOutlined, ThunderboltOutlined, WifiOutlined } from '@ant-design/icons';
import type { AssetType } from '../../../shared/model';

export const ASSET_TYPE_ICONS: Record<AssetType, React.ReactNode> = {
  switch: <ApartmentOutlined />,
  access_point: <WifiOutlined />,
  server: <DatabaseOutlined />,
  ups: <ThunderboltOutlined />,
  vm: <CloudServerOutlined />,
};
