import { useState } from 'react';
import { Badge, Button, Drawer, Grid } from 'antd';
import { FilterOutlined } from '@ant-design/icons';

/**
 * Toolbar above every list: search, filters and actions (export, labels …) in one consistent row.
 * On phones the search takes the full width and the filters move into a panel that slides up from the bottom
 * ("Filter (2)" shows how many are active), so nothing overflows the screen.
 */
export function ListToolbar({
  search,
  filters,
  activeFilters = 0,
  actions,
  onReset,
}: {
  search?: React.ReactNode;
  filters?: React.ReactNode;
  /** Number of filters that are set (shown on the phone button) */
  activeFilters?: number;
  actions?: React.ReactNode;
  /** Offered in the phone panel when filters are set */
  onReset?: () => void;
}) {
  const screens = Grid.useBreakpoint();
  const [open, setOpen] = useState(false);
  const phone = !screens.md;

  if (!phone)
    return (
      <div className="list-toolbar">
        {search && <div className="list-toolbar-search">{search}</div>}
        {filters}
        {actions && <div className="list-toolbar-actions">{actions}</div>}
      </div>
    );

  return (
    <div className="list-toolbar phone">
      {search && <div className="list-toolbar-search">{search}</div>}
      <div className="list-toolbar-phone-row">
        {filters && (
          <Badge count={activeFilters} size="small" offset={[-4, 4]}>
            <Button icon={<FilterOutlined />} onClick={() => setOpen(true)}>
              Filter
            </Button>
          </Badge>
        )}
        {actions && <div className="list-toolbar-actions">{actions}</div>}
      </div>
      {filters && (
        <Drawer
          open={open}
          onClose={() => setOpen(false)}
          placement="bottom"
          title="Filter"
          size="auto"
          className="list-toolbar-drawer"
          extra={
            onReset && activeFilters > 0 ? (
              <Button type="link" onClick={onReset}>
                Reset
              </Button>
            ) : undefined
          }
          footer={
            <Button type="primary" block size="large" onClick={() => setOpen(false)}>
              Show results
            </Button>
          }
        >
          <div className="list-toolbar-drawer-body">{filters}</div>
        </Drawer>
      )}
    </div>
  );
}
