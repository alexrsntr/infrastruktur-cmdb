import { Button, Dropdown, Tooltip } from 'antd';
import { CheckOutlined, DesktopOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { useColorMode, type ColorModePreference } from '../lib/colorMode';

const OPTIONS: { key: ColorModePreference; label: string; icon: React.ReactNode }[] = [
  { key: 'light', label: 'Light', icon: <SunOutlined /> },
  { key: 'dark', label: 'Dark', icon: <MoonOutlined /> },
  { key: 'system', label: 'Same as system', icon: <DesktopOutlined /> },
];

/** Header button to switch between light, dark and the operating system's colour scheme. */
export function ColorModeSwitch({ className }: { className?: string }) {
  const { preference, mode, setPreference } = useColorMode();
  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{
        selectable: true,
        selectedKeys: [preference],
        items: OPTIONS.map((o) => ({
          key: o.key,
          icon: o.icon,
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 24, justifyContent: 'space-between', minWidth: 150 }}>
              {o.label}
              {preference === o.key && <CheckOutlined />}
            </span>
          ),
        })),
        onClick: ({ key }) => setPreference(key as ColorModePreference),
      }}
    >
      <Tooltip title="Appearance: light or dark" placement="bottom">
        <Button type="text" className={className} icon={mode === 'dark' ? <MoonOutlined /> : <SunOutlined />} aria-label="Appearance (light or dark mode)" />
      </Tooltip>
    </Dropdown>
  );
}
