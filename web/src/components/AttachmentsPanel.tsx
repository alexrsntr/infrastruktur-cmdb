import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Form,
  Image,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  CodeOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EnvironmentOutlined,
  FileExcelOutlined,
  FileImageOutlined,
  FileOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileWordOutlined,
  FileZipOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import {
  ATTACHMENT_CATEGORIES,
  ATTACHMENT_CATEGORY_META,
  PLAN_IMAGE_TYPES,
  formatBytes,
  type Attachment,
  type AttachmentCategory,
} from '../../../shared/attachments';
import type { EntityType } from '../../../shared/model';
import { api, buildUrl, errorText, http } from '../lib/api';
import { fmtDateTime, fromNow } from '../lib/format';
import { useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';
import { ExportMenu } from './ExportMenu';

const GALLERY_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const fileUrl = (a: Attachment, download = false) => `/api/attachments/${a.id}/file${download ? '?download=1' : ''}`;
const isPlanCapable = (a: Attachment) => (PLAN_IMAGE_TYPES as readonly string[]).includes(a.content_type);

function fileIcon(a: Attachment) {
  const ct = a.content_type;
  const name = a.file_name.toLowerCase();
  if (ct === 'application/pdf') return <FilePdfOutlined style={{ color: '#cf1322' }} />;
  if (ct.startsWith('image/')) return <FileImageOutlined style={{ color: '#13a8a8' }} />;
  if (/\.(xlsx?|csv)$/.test(name)) return <FileExcelOutlined style={{ color: '#217346' }} />;
  if (/\.docx?$/.test(name)) return <FileWordOutlined style={{ color: '#2b579a' }} />;
  if (/\.zip$/.test(name)) return <FileZipOutlined />;
  if (/\.(cfg|conf|json|ya?ml|xml|ini)$/.test(name)) return <CodeOutlined style={{ color: '#722ed1' }} />;
  if (ct.startsWith('text/')) return <FileTextOutlined />;
  return <FileOutlined />;
}

function CategoryTag({ value }: { value: AttachmentCategory }) {
  const meta = ATTACHMENT_CATEGORY_META[value] ?? ATTACHMENT_CATEGORY_META.other;
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

function EditAttachmentModal({ attachment, onClose }: { attachment: Attachment | null; onClose: () => void }) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!attachment) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await http.put(`/api/attachments/${attachment.id}`, { title: v.title ?? null, description: v.description ?? null, category: v.category, is_plan: !!v.is_plan });
      message.success('File details saved');
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!attachment}
      title={attachment ? `Edit ${attachment.file_name}` : ''}
      onCancel={onClose}
      onOk={submit}
      okText="Save"
      confirmLoading={saving}
      destroyOnHidden
      afterOpenChange={(open) => {
        if (open && attachment) form.setFieldsValue({ title: attachment.title, description: attachment.description, category: attachment.category, is_plan: attachment.is_plan });
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="title" label="Title">
          <Input placeholder={attachment?.file_name} maxLength={200} />
        </Form.Item>
        <Form.Item name="category" label="Category" rules={[{ required: true }]}>
          <Select options={ATTACHMENT_CATEGORIES.map((c) => ({ value: c, label: ATTACHMENT_CATEGORY_META[c].label }))} />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} maxLength={4000} />
        </Form.Item>
        <Form.Item
          name="is_plan"
          label="Use as plan"
          valuePropName="checked"
          extra={
            attachment && isPlanCapable(attachment)
              ? 'Plans can be opened to place access points, switches and other devices on the picture. Switching it off removes the placed markers.'
              : 'Only PNG, JPEG or WebP pictures can be used as a plan.'
          }
        >
          <Switch disabled={!attachment || !isPlanCapable(attachment)} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function AttachmentsPanel({ entityType, entityId }: { entityType: EntityType; entityId: string }) {
  const { can, me } = useSession();
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [category, setCategory] = useState<AttachmentCategory | 'auto'>('auto');
  const [asPlan, setAsPlan] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [editing, setEditing] = useState<Attachment | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());

  const list = useQuery({
    queryKey: ['attachments', entityType, entityId],
    queryFn: () => http.get<Attachment[]>('/api/attachments', { entityType, entityId }),
  });
  const items = list.data ?? [];
  const images = items.filter((a) => GALLERY_TYPES.includes(a.content_type));
  const documents = items.filter((a) => !GALLERY_TYPES.includes(a.content_type));

  const mayDelete = (a: Attachment) => can('asset.delete') || (a.created_by === me.user.id && can('attachment.write'));

  /** Files are uploaded one after another so large batches do not overload the server */
  const enqueue = (file: File) => {
    setUploading((n) => n + 1);
    chain.current = chain.current.then(async () => {
      const fd = new FormData();
      fd.append('entityType', entityType);
      fd.append('entityId', entityId);
      fd.append('category', category);
      const picture = file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp';
      fd.append('isPlan', asPlan && picture ? 'true' : 'false');
      fd.append('file', file);
      try {
        await api('/api/attachments', { method: 'POST', formData: fd });
        message.success(`${file.name} uploaded`);
      } catch (e) {
        message.error(`${file.name}: ${errorText(e)}`);
      } finally {
        setUploading((n) => n - 1);
        await invalidate();
      }
    });
  };

  const remove = async (a: Attachment) => {
    try {
      await http.del(`/api/attachments/${a.id}`);
      message.success(`${a.file_name} deleted`);
      await invalidate();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const actions = (a: Attachment) => [
    <Tooltip key="dl" title="Download">
      <Button type="text" icon={<DownloadOutlined />} href={fileUrl(a, true)} />
    </Tooltip>,
    ...(can('attachment.write')
      ? [
          <Tooltip key="edit" title="Edit details">
            <Button type="text" icon={<EditOutlined />} onClick={() => setEditing(a)} />
          </Tooltip>,
        ]
      : []),
    ...(mayDelete(a)
      ? [
          <Popconfirm key="del" title={`Delete ${a.file_name}?`} onConfirm={() => remove(a)} okText="Delete" okButtonProps={{ danger: true }}>
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>,
        ]
      : []),
  ];

  return (
    <div>
      {can('attachment.write') && (
        <Card style={{ marginBottom: 16 }}>
          <Upload.Dragger
            multiple
            showUploadList={false}
            customRequest={({ file, onSuccess }) => {
              enqueue(file as File);
              onSuccess?.({});
            }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">Drop files here or click to upload</p>
            <p className="ant-upload-hint">Photos of the site, rack or device, data sheets, contracts, configuration backups … (executables and web pages are not allowed)</p>
          </Upload.Dragger>
          <Space wrap style={{ marginTop: 12 }}>
            <span>Category</span>
            <Select
              style={{ width: 200 }}
              value={category}
              onChange={setCategory}
              options={[{ value: 'auto', label: 'Detect automatically' }, ...ATTACHMENT_CATEGORIES.map((c) => ({ value: c, label: ATTACHMENT_CATEGORY_META[c].label }))]}
            />
            <Checkbox checked={asPlan} onChange={(e) => setAsPlan(e.target.checked)}>
              Use pictures as plan (place devices on them)
            </Checkbox>
            {uploading > 0 && <Typography.Text type="secondary">Uploading {uploading} file(s)…</Typography.Text>}
          </Space>
        </Card>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <Typography.Text type="secondary">
          {items.length} file(s) · {formatBytes(items.reduce((s, a) => s + Number(a.size_bytes), 0))}
        </Typography.Text>
        <Space wrap>
          <Button icon={<FileZipOutlined />} href={buildUrl('/api/export/files.zip', { entityType, entityId })} disabled={!items.length}>
            Download all (ZIP)
          </Button>
          <ExportMenu dataset="attachments" query={{ entityType, entityId }} label="Export list" />
        </Space>
      </div>

      {!list.isLoading && !items.length && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              No files yet. Upload photos of the site, the rack or the device, data sheets, contracts or configuration backups.
              <br />
              Pictures marked as plan can be used to place access points, switches and other devices.
            </span>
          }
        />
      )}

      {images.length > 0 && (
        <>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            Pictures
          </Typography.Title>
          <Image.PreviewGroup>
            <Row gutter={[12, 12]} style={{ marginBottom: 20 }}>
              {images.map((a) => (
                <Col key={a.id} xs={12} md={8} xl={6}>
                  <Card
                    hoverable
                    styles={{ body: { padding: 10 } }}
                    cover={
                      <Image
                        src={fileUrl(a)}
                        alt={a.title ?? a.file_name}
                        height={150}
                        width="100%"
                        style={{ objectFit: 'cover' }}
                        rootClassName="attachment-thumb"
                        preview={{ mask: 'Preview' }}
                      />
                    }
                    actions={actions(a)}
                  >
                    <Typography.Text strong ellipsis style={{ display: 'block' }} title={a.title ?? a.file_name}>
                      {a.title ?? a.file_name}
                    </Typography.Text>
                    <Space size={4} wrap style={{ marginTop: 4 }}>
                      <CategoryTag value={a.category} />
                      {a.is_plan && <Tag color="geekblue">Plan</Tag>}
                    </Space>
                    <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                      {a.created_by_name ?? 'Unknown'} · <Tooltip title={fmtDateTime(a.created_at)}>{fromNow(a.created_at)}</Tooltip>
                    </Typography.Text>
                    {a.is_plan && (
                      <Link to={`/plans/${a.id}`}>
                        <Button type="primary" ghost icon={<EnvironmentOutlined />} style={{ marginTop: 8 }} block>
                          Open plan
                        </Button>
                      </Link>
                    )}
                  </Card>
                </Col>
              ))}
            </Row>
          </Image.PreviewGroup>
        </>
      )}

      {documents.length > 0 && (
        <>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            Documents
          </Typography.Title>
          <Table<Attachment>
            rowKey="id"
            dataSource={documents}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            scroll={{ x: 760 }}
            columns={[
              {
                title: 'Name',
                key: 'name',
                ellipsis: true,
                render: (_, a) => (
                  <Space>
                    {fileIcon(a)}
                    <a href={fileUrl(a)} target="_blank" rel="noopener noreferrer">
                      {a.title ?? a.file_name}
                    </a>
                    {a.title && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{a.file_name}</Typography.Text>}
                  </Space>
                ),
              },
              { title: 'Category', dataIndex: 'category', width: 170, render: (c) => <CategoryTag value={c} /> },
              { title: 'Size', dataIndex: 'size_bytes', width: 90, render: (v) => formatBytes(Number(v)) },
              {
                title: 'Uploaded',
                key: 'uploaded',
                width: 220,
                render: (_, a) => (
                  <span>
                    {a.created_by_name ?? 'Unknown'} · <Tooltip title={fmtDateTime(a.created_at)}>{fromNow(a.created_at)}</Tooltip>
                  </span>
                ),
              },
              { title: '', key: 'actions', width: 110, render: (_, a) => <Space size={0}>{actions(a)}</Space> },
            ]}
            expandable={{ rowExpandable: (a) => !!a.description, expandedRowRender: (a) => <div className="note-body">{a.description}</div> }}
          />
        </>
      )}

      <EditAttachmentModal attachment={editing} onClose={() => setEditing(null)} />
      <style>{'.attachment-thumb { width: 100%; display: block; }'}</style>
    </div>
  );
}
