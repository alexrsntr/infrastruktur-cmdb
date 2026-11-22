import { Grid, Modal, type ModalProps } from 'antd';

/**
 * A dialog that becomes a full-screen page on phones: the form gets the whole screen, the buttons stay at the
 * bottom. On larger screens it is an ordinary dialog with the given width.
 */
export function ResponsiveModal({ className, width, centered, ...props }: ModalProps) {
  const screens = Grid.useBreakpoint();
  const phone = !screens.md;
  return (
    <Modal
      {...props}
      width={phone ? '100%' : width}
      centered={phone ? false : centered}
      className={[className, phone ? 'modal-fullscreen' : ''].filter(Boolean).join(' ') || undefined}
    />
  );
}
