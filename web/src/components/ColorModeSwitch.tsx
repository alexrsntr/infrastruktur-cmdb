import { Button, Dropdown, Tooltip, type MenuProps } from 'antd';
import { CheckOutlined, ColumnHeightOutlined, CompressOutlined, DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { DENSITY_META } from '../../../shared/appearance';
import { useColorMode, type ColorModePreference } from '../lib/colorMode';
import { useDensity, type DensityPreference } from '../lib/density';

const OPTIONS: { key: ColorModePreference; label: string; icon: React.ReactNode }[] = [
  { key: 'light', label: 'Light', icon: <SunOutlined /> },
  { key: 'dark', label: 'Dark', icon: <MoonOutlined /> },
  { key: 'system', label: 'Same as system', icon: <DesktopOutlined /> },
];

const DENSITY_OPTIONS: { key: DensityPreference; label: string; icon: React.ReactNode }[] = [
  { key: 'default', label: 'Organisation default', icon: <DesktopOutlined /> },
  { key: 'comfortable', label: DENSITY_META.comfortable.label, icon: <ColumnHeightOutlined /> },
  { key: 'compact', label: DENSITY_META.compact.label, icon: <CompressOutlined /> },
];

const row = (label: React.ReactNode, checked: boolean) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 24, justifyContent: 'space-between', minWidth: 190 }}>
    {label}
    {checked && <CheckOutlined />}
  </span>
);

/** Header button for the display: light, dark or the operating system's colour scheme, and the density. */
export function ColorModeSwitch({ className }: { className?: string }) {
  const { preference, mode, setPreference } = useColorMode();
  const density = useDensity();
  const items: MenuProps['items'] = [
    {
      type: 'group',
      label: 'Colour scheme',
      children: OPTIONS.map((o) => ({ key: `mode:${o.key}`, icon: o.icon, label: row(o.label, preference === o.key) })),
    },
    { type: 'divider' },
    {
      type: 'group',
      label: 'Density',
      children: DENSITY_OPTIONS.map((o) => ({
        key: `density:${o.key}`,
        icon: o.icon,
        label: row(o.key === 'default' ? `${o.label} (${DENSITY_META[density.orgDefault].label.toLowerCase()})` : o.label, density.preference === o.key),
      })),
    },
  ];
  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{
        items,
        onClick: ({ key }) => {
          const [kind, value] = key.split(':');
          if (kind === 'mode') setPreference(value as ColorModePreference);
          else density.setPreference(value as DensityPreference);
        },
      }}
    >
      <Tooltip title="Display: light or dark, density" placement="bottom">
        <Button type="text" className={className} icon={mode === 'dark' ? <MoonOutlined /> : <SunOutlined />} aria-label="Display (light or dark mode, density)" />
      </Tooltip>
    </Dropdown>
  );
}
