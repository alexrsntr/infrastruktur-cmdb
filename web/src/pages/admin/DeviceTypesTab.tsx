import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Form, Input, Modal, Row, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { ASSET_CATEGORIES, ASSET_TYPES, ASSET_TYPE_KEYS, type AssetType, type AssetTypeSettings, type FieldDef } from '../../../../shared/model';
import { errorText, http } from '../../lib/api';
import { useAssetTypes } from '../../lib/queries';
import { TypeIcon } from '../../components/Simple';

const FIELD_TYPES: { value: FieldDef['type']; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes / no' },
  { value: 'select', label: 'List' },
];

/** Administrators choose which device types are offered and add their own fields per type. */
export function DeviceTypesTab() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { settings } = useAssetTypes();
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<AssetType | null>(null);

  const save = async (next: AssetTypeSettings) => {
    setSaving(true);
    try {
      const saved = await http.put<AssetTypeSettings>('/api/settings/asset-types', next);
      qc.setQueryData(['asset-types'], saved);
      message.success('Device types saved');
      return true;
    } catch (e) {
      message.error(errorText(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const toggle = (t: AssetType, offered: boolean) =>
    save({ ...settings, hidden: offered ? settings.hidden.filter((h) => h !== t) : [...settings.hidden, t] });

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="Choose which kinds of devices your team documents"
        description="Hidden types are no longer offered when adding a device. Existing devices of a hidden type stay visible and can still be edited. Additional fields appear in the forms, on the device page, in exports and in the import template."
      />
      <Card>
        <Table
          rowKey={(t) => t}
          dataSource={ASSET_TYPE_KEYS}
          pagination={false}
          size="middle"
          columns={[
            {
              title: 'Device type',
              key: 'type',
              render: (_, t) => (
                <Space>
                  <TypeIcon type={t} />
                  <span>
                    <Typography.Text strong>{ASSET_TYPES[t].label}</Typography.Text>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {ASSET_TYPES[t].hint}
                    </div>
                  </span>
                </Space>
              ),
            },
            { title: 'Category', key: 'category', width: 160, responsive: ['md'], render: (_, t) => ASSET_CATEGORIES[ASSET_TYPES[t].category].label },
            {
              title: 'Fields',
              key: 'fields',
              render: (_, t) => (
                <Space size={[4, 4]} wrap>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {ASSET_TYPES[t].fields.length} built-in
                  </Typography.Text>
                  {(settings.customFields[t] ?? []).map((f) => (
                    <Tag key={f.key} color="blue">
                      {f.label}
                    </Tag>
                  ))}
                  <Button size="small" type="link" icon={<EditOutlined />} onClick={() => setEditing(t)}>
                    Own fields
                  </Button>
                </Space>
              ),
            },
            {
              title: 'Offered',
              key: 'offered',
              width: 100,
              align: 'center',
              render: (_, t) => (
                <Switch
                  checked={!settings.hidden.includes(t)}
                  disabled={saving}
                  aria-label={`Offer ${ASSET_TYPES[t].plural}`}
                  onChange={(on) => toggle(t, on)}
                />
              ),
            },
          ]}
        />
      </Card>
      {editing && (
        <CustomFieldsModal
          type={editing}
          fields={settings.customFields[editing] ?? []}
          saving={saving}
          onClose={() => setEditing(null)}
          onSave={async (fields) => {
            const ok = await save({ ...settings, customFields: { ...settings.customFields, [editing]: fields } });
            if (ok) setEditing(null);
          }}
        />
      )}
    </Space>
  );
}

function CustomFieldsModal({
  type,
  fields,
  saving,
  onClose,
  onSave,
}: {
  type: AssetType;
  fields: FieldDef[];
  saving: boolean;
  onClose: () => void;
  onSave: (fields: FieldDef[]) => void;
}) {
  const [form] = Form.useForm<{ fields: FieldDef[] }>();
  const def = ASSET_TYPES[type];
  return (
    <Modal
      open
      title={`Own fields for ${def.plural}`}
      onCancel={onClose}
      okText="Save fields"
      confirmLoading={saving}
      onOk={async () => {
        const v = await form.validateFields();
        onSave((v.fields ?? []).map((f) => ({ ...f, options: f.type === 'select' ? f.options : undefined })));
      }}
      width={760}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        Built-in: {def.fields.map((f) => f.label).join(', ')}. Removing a field here hides it in the forms; values already stored stay in the database
        until the device is saved again.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ fields }}>
        <Form.List name="fields">
          {(items, { add, remove }) => (
            <>
              {items.map(({ key, name }) => (
                <Card size="small" key={key} style={{ marginBottom: 10 }}>
                  <Form.Item name={[name, 'key']} hidden>
                    <Input />
                  </Form.Item>
                  <Row gutter={12} align="bottom">
                    <Col xs={24} md={9}>
                      <Form.Item name={[name, 'label']} label="Label" rules={[{ required: true, whitespace: true, max: 60 }]} style={{ marginBottom: 8 }}>
                        <Input placeholder="e.g. Contract number" />
                      </Form.Item>
                    </Col>
                    <Col xs={12} md={6}>
                      <Form.Item name={[name, 'type']} label="Kind" initialValue="text" style={{ marginBottom: 8 }}>
                        <Select options={FIELD_TYPES} />
                      </Form.Item>
                    </Col>
                    <Col xs={10} md={7}>
                      <Form.Item noStyle shouldUpdate>
                        {() =>
                          form.getFieldValue(['fields', name, 'type']) === 'number' ? (
                            <Form.Item name={[name, 'unit']} label="Unit" style={{ marginBottom: 8 }}>
                              <Input placeholder="e.g. kW" maxLength={20} />
                            </Form.Item>
                          ) : null
                        }
                      </Form.Item>
                    </Col>
                    <Col xs={2} md={2} style={{ textAlign: 'right' }}>
                      <Button danger type="text" icon={<DeleteOutlined />} aria-label="Remove field" onClick={() => remove(name)} style={{ marginBottom: 8 }} />
                    </Col>
                    <Form.Item noStyle shouldUpdate>
                      {() =>
                        form.getFieldValue(['fields', name, 'type']) === 'select' ? (
                          <Col span={24}>
                            <Form.Item
                              name={[name, 'options']}
                              label="Options"
                              rules={[{ required: true, type: 'array', min: 1, message: 'Add at least one option' }]}
                              style={{ marginBottom: 8 }}
                            >
                              <Select mode="tags" tokenSeparators={[',', ';']} placeholder="Type an option and press Enter" open={false} />
                            </Form.Item>
                          </Col>
                        ) : null
                      }
                    </Form.Item>
                  </Row>
                </Card>
              ))}
              <Button type="dashed" icon={<PlusOutlined />} block onClick={() => add({ type: 'text' })} disabled={items.length >= 30}>
                Add field
              </Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
