import { useState } from 'react';
import { App, Form, Input, Modal } from 'antd';
import { errorText, http } from '../lib/api';

interface Values {
  current_password: string;
  new_password: string;
  repeat: string;
}

/** Local accounts (AUTH_MODE=local): change your own password. */
export function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<Values>();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await http.post('/api/me/password', { current_password: v.current_password, new_password: v.new_password });
      message.success('Password changed');
      form.resetFields();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} title="Change password" onCancel={onClose} onOk={submit} okText="Change password" confirmLoading={saving} destroyOnHidden width={440}>
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item name="current_password" label="Current password" rules={[{ required: true, message: 'Enter your current password' }]}>
          <Input.Password autoComplete="current-password" autoFocus />
        </Form.Item>
        <Form.Item
          name="new_password"
          label="New password"
          rules={[{ required: true, message: 'Enter a new password' }, { min: 10, message: 'At least 10 characters' }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="repeat"
          label="Repeat new password"
          dependencies={['new_password']}
          rules={[
            { required: true, message: 'Repeat the new password' },
            ({ getFieldValue }) => ({
              validator: (_, value) => (!value || value === getFieldValue('new_password') ? Promise.resolve() : Promise.reject(new Error('The passwords do not match'))),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
