import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { App, Button, Card, Col, Empty, Form, Input, Modal, Row, Skeleton, Tag, Typography, Upload } from 'antd';
import { EnvironmentOutlined, InboxOutlined, PlusOutlined } from '@ant-design/icons';
import type { EntityType } from '../../../shared/model';
import type { Attachment } from '../../../shared/attachments';
import { api, errorText } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useInvalidate, usePlans } from '../lib/queries';
import { useSession } from '../lib/session';

/** Upload a picture (site plan, aerial photo, hall photo) that devices can be placed on. */
export function PlanUploadModal({ open, onClose, entityType, entityId }: { open: boolean; onClose: () => void; entityType: EntityType; entityId: string }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const v = await form.validateFields();
    if (!file) {
      message.error('Choose a picture first');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('entityType', entityType);
    fd.append('entityId', entityId);
    fd.append('category', 'plan');
    fd.append('isPlan', 'true');
    if (v.title) fd.append('title', v.title);
    if (v.description) fd.append('description', v.description);
    setSaving(true);
    try {
      const created = await api<Attachment>('/api/attachments', { method: 'POST', formData: fd });
      message.success('Picture uploaded – now place your devices on it');
      await invalidate();
      onClose();
      navigate(`/plans/${created.id}`);
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="Upload and place devices"
      confirmLoading={saving}
      title="Upload a picture"
      destroyOnHidden
      afterOpenChange={(o) => {
        if (!o) {
          setFile(null);
          form.resetFields();
        }
      }}
    >
      <Form form={form} layout="vertical">
        <Upload.Dragger
          accept="image/png,image/jpeg,image/webp"
          maxCount={1}
          beforeUpload={(f) => {
            setFile(f);
            if (!form.getFieldValue('title')) form.setFieldValue('title', f.name.replace(/\.[^.]+$/, ''));
            return false;
          }}
          onRemove={() => setFile(null)}
          fileList={file ? [{ uid: '1', name: file.name, status: 'done' }] : []}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">Drop a picture here or click to choose</p>
          <p className="ant-upload-hint">Site plan, aerial photo, hall or office photo – PNG, JPEG or WebP</p>
        </Upload.Dragger>
        <Form.Item name="title" label="Title" style={{ marginTop: 16 }} rules={[{ max: 200 }]}>
          <Input placeholder="e.g. Aerial view 2026, Hall 1 north side" />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Cards of all pictures with placed devices in a plant (or of one object). */
export function PlansGallery({ plantId, entityType, entityId }: { plantId: string; entityType: EntityType; entityId: string }) {
  const { can } = useSession();
  const plans = usePlans({ plantId });
  const [uploading, setUploading] = useState(false);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Typography.Text type="secondary">
          Pictures of the plant – site plans, aerial photos, halls – with access points, switches and other devices placed on them. Any photo in “Files” can also be turned into a plan.
        </Typography.Text>
        {can('attachment.write') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setUploading(true)}>
            Upload picture
          </Button>
        )}
      </div>
      {plans.isLoading ? (
        <Skeleton active />
      ) : !plans.data?.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No pictures yet. Upload a site plan or an aerial photo of the plant to place your access points and other devices on it." />
      ) : (
        <Row gutter={[16, 16]}>
          {plans.data.map((p) => (
            <Col key={p.id} xs={24} sm={12} lg={8} xxl={6}>
              <Link to={`/plans/${p.id}`}>
                <Card
                  hoverable
                  cover={
                    <div style={{ height: 170, background: '#f3f5f8', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
                      <img src={`/api/attachments/${p.id}/file?v=${encodeURIComponent(p.updated_at)}`} alt={p.title ?? p.file_name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                    </div>
                  }
                >
                  <Card.Meta
                    title={p.title ?? p.file_name}
                    description={
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12 }}>
                        <span>
                          <Tag variant="filled">{p.entity_type}</Tag>
                          {p.entity_type !== 'plant' && p.entity_label}
                        </span>
                        <span style={{ whiteSpace: 'nowrap' }}>
                          <EnvironmentOutlined /> {p.marker_count} · {fmtDate(p.created_at)}
                        </span>
                      </div>
                    }
                  />
                </Card>
              </Link>
            </Col>
          ))}
        </Row>
      )}
      <PlanUploadModal open={uploading} onClose={() => setUploading(false)} entityType={entityType} entityId={entityId} />
    </div>
  );
}
