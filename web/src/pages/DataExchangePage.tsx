import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Divider,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
  type UploadFile,
} from 'antd';
import {
  ApartmentOutlined,
  AuditOutlined,
  BankOutlined,
  BranchesOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  DatabaseOutlined,
  ThunderboltOutlined,
  FileExcelOutlined,
  FileSearchOutlined,
  InboxOutlined,
  ClusterOutlined,
  AppstoreOutlined,
  ScheduleOutlined,
  SnippetsOutlined,
  TeamOutlined,
  WifiOutlined,
  BuildOutlined,
  DownloadOutlined,
} from '@ant-design/icons';
import {
  ASSET_TYPES,
  ASSET_TYPE_KEYS,
  type AssetType,
  type FieldDef,
  type ImportReport,
} from '../../../shared/model';
import { buildUrl, errorText, http, type Query } from '../lib/api';
import { useInvalidate, usePlants } from '../lib/queries';
import { useSession } from '../lib/session';
import { PageHeader } from '../components/PageHeader';
import { SectionHead } from '../components/PageParts';
import { ExportMenu } from '../components/ExportMenu';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface DatasetCard {
  key: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  dataset: string;
  query?: Query;
  visible?: boolean;
}

const TYPE_ICONS: Record<AssetType, React.ReactNode> = {
  switch: <ApartmentOutlined />,
  access_point: <WifiOutlined />,
  server: <DatabaseOutlined />,
  ups: <ThunderboltOutlined />,
  vm: <CloudServerOutlined />,
};

function DatasetGrid({ cards }: { cards: DatasetCard[] }) {
  return (
    <Row gutter={[16, 16]}>
      {cards
        .filter((c) => c.visible !== false)
        .map((c) => (
          <Col key={c.key} xs={24} sm={12} lg={8} xxl={6}>
            <Card style={{ height: '100%' }} styles={{ body: { display: 'flex', flexDirection: 'column', height: '100%' } }}>
              <Space align="start" size={12} style={{ flex: 1 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 6,
                    display: 'grid',
                    placeItems: 'center',
                    background: 'var(--cmdb-primary-soft)',
                    color: 'var(--ant-color-primary, #2563eb)',
                    fontSize: 18,
                  }}
                >
                  {c.icon}
                </div>
                <div>
                  <Typography.Text strong>{c.title}</Typography.Text>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      {c.description}
                    </Typography.Text>
                  </div>
                </div>
              </Space>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                <ExportMenu dataset={c.dataset} query={c.query} />
              </div>
            </Card>
          </Col>
        ))}
    </Row>
  );
}

function download(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function ExportSection() {
  const { can, scoped } = useSession();
  const plants = usePlants();
  const [plantId, setPlantId] = useState<string | undefined>();

  const cards: DatasetCard[] = [
    { key: 'plants', title: 'Plants', description: 'Plants with address, coordinates, contacts and counts.', icon: <BankOutlined />, dataset: 'plants' },
    { key: 'buildings', title: 'Buildings', description: 'Buildings per plant with floor and device counts.', icon: <BuildOutlined />, dataset: 'buildings' },
    { key: 'floors', title: 'Floors', description: 'Floors per building, incl. floor plan availability.', icon: <ClusterOutlined />, dataset: 'floors' },
    { key: 'assets', title: 'All devices', description: 'Complete list of all devices with all details.', icon: <AppstoreOutlined />, dataset: 'assets' },
    ...ASSET_TYPE_KEYS.map((t) => ({
      key: `assets-${t}`,
      title: ASSET_TYPES[t].plural,
      description: `${ASSET_TYPES[t].plural} with type-specific columns (${ASSET_TYPES[t].fields
        .slice(0, 3)
        .map((f) => f.label)
        .join(', ')} …).`,
      icon: TYPE_ICONS[t],
      dataset: 'assets',
      query: { type: t },
    })),
    { key: 'relations', title: 'Relations', description: 'Uplinks, VM hosts, dependencies and redundancy, incl. ports.', icon: <BranchesOutlined />, dataset: 'relations' },
    { key: 'activities', title: 'Activities', description: 'Maintenance, incidents, changes and inspections.', icon: <ScheduleOutlined />, dataset: 'activities' },
    { key: 'notes', title: 'Notes', description: 'All notes on plants, buildings, floors and assets.', icon: <SnippetsOutlined />, dataset: 'notes' },
    { key: 'audit', title: 'Audit log', description: 'Every change, login, export and import (up to 100 000 entries).', icon: <AuditOutlined />, dataset: 'audit', visible: can('audit.read') },
    { key: 'users', title: 'Users', description: 'Users with role, role source and plant scope.', icon: <TeamOutlined />, dataset: 'users', visible: can('user.manage') },
  ];

  return (
    <>
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} xl={14}>
          <Card
            style={{ height: '100%', background: 'linear-gradient(120deg, #0b2a4a 0%, #134a7c 100%)', border: 0 }}
            styles={{ body: { color: '#fff' } }}
          >
            <Space align="start" size={16}>
              <FileExcelOutlined style={{ fontSize: 36, color: '#7fd1ff' }} />
              <div>
                <Typography.Title level={4} style={{ color: '#fff', marginTop: 0 }}>
                  Complete CMDB export
                </Typography.Title>
                <Typography.Paragraph style={{ color: 'rgba(255,255,255,.85)', marginBottom: 12 }}>
                  One workbook with a sheet each for plants, buildings, floors, all devices plus one sheet per device type (switches, access points,
                  servers, virtual machines), relations, activities and notes{can('user.manage') ? ' – and users (administrators only)' : ''}.
                </Typography.Paragraph>
                <Typography.Paragraph style={{ color: 'rgba(255,255,255,.65)', fontSize: 12.5 }}>
                  {scoped
                    ? 'The export contains only the plants you have access to. '
                    : 'Exports always respect the plant scope of the user. '}
                  Every export is recorded in the audit log.
                </Typography.Paragraph>
                <Space wrap>
                  <Button type="primary" size="large" icon={<FileExcelOutlined />} onClick={() => download(buildUrl('/api/export/full', { format: 'xlsx' }))}>
                    Excel workbook
                  </Button>
                  <Button size="large" ghost icon={<CodeOutlined />} onClick={() => download(buildUrl('/api/export/full', { format: 'json' }))}>
                    JSON
                  </Button>
                </Space>
              </div>
            </Space>
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title={<Space><BankOutlined /> Plant dossier</Space>} style={{ height: '100%' }}>
            <Typography.Paragraph type="secondary">
              Everything about one plant in a single file: master data, buildings, floors, all devices by type, connections, activities and notes.
            </Typography.Paragraph>
            <Space.Compact block>
              <Select
                showSearch
                allowClear
                optionFilterProp="label"
                placeholder="Select a plant"
                style={{ flex: 1 }}
                value={plantId}
                onChange={setPlantId}
                options={(plants.data ?? []).map((p) => ({ value: p.id, label: `${p.code} – ${p.name}` }))}
              />
            </Space.Compact>
            <div style={{ marginTop: 12 }}>
              {plantId ? (
                <ExportMenu dataset="full" query={{ plantId }} formats={['xlsx', 'json']} label="Export dossier" type="primary" />
              ) : (
                <Button icon={<DownloadOutlined />} disabled>
                  Export dossier
                </Button>
              )}
            </div>
          </Card>
        </Col>
      </Row>

      <Divider titlePlacement="start" plain>
        Individual datasets
      </Divider>
      <DatasetGrid cards={cards} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const BASE_HEADERS = [
  'Type',
  'Name',
  'Status',
  'Criticality',
  'Plant',
  'Building',
  'Floor',
  'Room',
  'Rack',
  'Rack unit',
  'Manufacturer',
  'Model',
  'Serial number',
  'Asset tag',
  'IP address',
  'MAC address',
  'FQDN',
  'OS / firmware',
  'Owner',
  'Cost center',
  'Purchase date',
  'Warranty end',
  'Tags',
  'Description',
];

function templateFields(type?: AssetType): FieldDef[] {
  const seen = new Map<string, FieldDef>();
  for (const t of type ? [type] : ASSET_TYPE_KEYS) {
    for (const f of ASSET_TYPES[t].fields as readonly FieldDef[]) if (!seen.has(f.key)) seen.set(f.key, f);
  }
  return [...seen.values()];
}

const EXAMPLES: Record<AssetType, Record<string, string>> = {
  switch: { Name: 'muc-b01-sw10', Model: 'Catalyst 9300-48P', Manufacturer: 'Cisco', 'IP address': '10.10.0.50', Ports: '48', PoE: 'yes', Layer: 'L2', 'Network role': 'Access' },
  access_point: { Name: 'muc-ap-200', Model: 'MR46', Manufacturer: 'Cisco Meraki', 'IP address': '10.10.20.200', 'Wi-Fi standard': 'Wi-Fi 6 (ax)', Mounting: 'Ceiling' },
  server: { Name: 'muc-esx10', Model: 'PowerEdge R760', Manufacturer: 'Dell', 'IP address': '10.10.1.50', 'RAM (GB)': '512', Hypervisor: 'VMware ESXi', 'Form factor': 'Rack' },
  ups: { Name: 'muc-ups02', Model: 'Smart-UPS SRT 6000', Manufacturer: 'APC', 'IP address': '10.10.1.20', 'Form factor': 'Rack', 'Capacity (VA)': '6000', 'Real power (W)': '6000', Phases: '1-phase', 'Battery replacement due': '30.06.2028' },
  vm: { Name: 'muc-app10', 'IP address': '10.10.5.50', 'OS / firmware': 'Windows Server 2022', vCPU: '4', 'RAM (GB)': '16', Environment: 'Production', 'Backup enabled': 'yes' },
};

function csvCell(v: string): string {
  return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function downloadTemplate(type?: AssetType) {
  const attrHeaders = templateFields(type).map((f) => (f.unit ? `${f.label} (${f.unit})` : f.label));
  const headers = [...BASE_HEADERS, ...attrHeaders.filter((h) => !BASE_HEADERS.includes(h))];
  const exampleType: AssetType = type ?? 'switch';
  const example: Record<string, string> = {
    Type: ASSET_TYPES[exampleType].label,
    Status: 'Active',
    Criticality: 'Medium',
    Plant: 'MUC',
    Building: exampleType === 'vm' ? '' : 'B01',
    Floor: exampleType === 'vm' ? '' : 'Ground floor',
    'Warranty end': '31.12.2029',
    Tags: 'example, import',
    Description: 'Example row – delete before importing',
    ...EXAMPLES[exampleType],
  };
  const lines = [headers.map(csvCell).join(';'), headers.map((h) => csvCell(example[h] ?? '')).join(';')];
  const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cmdb_import_template_${type ?? 'all_types'}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReportView({ report }: { report: ImportReport }) {
  const ok = report.errors.length === 0;
  return (
    <div style={{ marginTop: 16 }}>
      <Alert
        type={ok ? 'success' : 'warning'}
        showIcon
        title={
          report.dryRun
            ? ok
              ? 'Validation successful – the file can be imported.'
              : `Validation finished with ${report.errors.length} error(s). Rows with errors will be skipped on import.`
            : `Import finished: ${report.created} created, ${report.updated} updated${report.errors.length ? `, ${report.errors.length} row(s) skipped` : ''}.`
        }
        style={{ marginBottom: 16 }}
      />
      <Row gutter={[16, 16]}>
        <Col xs={12} md={4}>
          <Statistic title="Rows" value={report.total} />
        </Col>
        <Col xs={12} md={5}>
          <Statistic title={report.dryRun ? 'Would create' : 'Created'} value={report.created} styles={{ content: { color: '#389e0d' } }} />
        </Col>
        <Col xs={12} md={5}>
          <Statistic title={report.dryRun ? 'Would update' : 'Updated'} value={report.updated} styles={{ content: { color: '#1677ff' } }} />
        </Col>
        <Col xs={12} md={5}>
          <Statistic title="Unchanged" value={report.skipped} />
        </Col>
        <Col xs={12} md={5}>
          <Statistic title="Errors" value={report.errors.length} styles={{ content: { color: report.errors.length ? '#cf1322' : undefined } }} />
        </Col>
      </Row>
      {report.errors.length > 0 && (
        <Table
          style={{ marginTop: 16 }}
          rowKey={(e) => `${e.row}-${e.message}`}
          dataSource={report.errors}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          columns={[
            { title: 'Row', dataIndex: 'row', width: 80 },
            { title: 'Error', dataIndex: 'message', render: (m: string) => <Typography.Text type="danger">{m}</Typography.Text> },
          ]}
        />
      )}
    </div>
  );
}

function ImportSection() {
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [file, setFile] = useState<File | null>(null);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [defaultType, setDefaultType] = useState<AssetType | undefined>();
  const [templateType, setTemplateType] = useState<AssetType | undefined>();
  const [report, setReport] = useState<ImportReport | null>(null);
  const [validatedFor, setValidatedFor] = useState<File | null>(null);
  const [busy, setBusy] = useState<'dry' | 'import' | null>(null);

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(dryRun ? 'dry' : 'import');
    try {
      const result = await http.upload<ImportReport>('/api/import/assets', file, { dryRun: dryRun ? 'true' : 'false', type: defaultType });
      setReport(result);
      if (dryRun) setValidatedFor(file);
      else {
        setValidatedFor(null);
        message.success(`Import finished: ${result.created} created, ${result.updated} updated`);
        await invalidate();
      }
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const canImport = !!file && validatedFor === file && !!report?.dryRun && report.created + report.updated > 0;

  const rules = useMemo(
    () => [
      'Excel (.xlsx – first worksheet) or CSV (comma or semicolon, UTF-8). Column headers as in the device export.',
      'Existing devices are matched by ID, otherwise by type + name, and updated. All other rows create new devices.',
      'Plant and building are referenced by their code (or name), the floor by its name.',
      'Status/criticality/type accept labels or keys (e.g. "Active" or "active"). Dates as YYYY-MM-DD or DD.MM.YYYY.',
      'Tags are separated by commas. Type-specific columns use the field labels, e.g. "Ports", "RAM (GB)", "Wi-Fi standard".',
      'Always validate first: the dry run shows exactly what would change without saving anything.',
    ],
    [],
  );

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={9}>
        <Card title={<Space><FileSearchOutlined /> How the import works</Space>} style={{ height: '100%' }}>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {rules.map((r) => (
              <li key={r} style={{ marginBottom: 6 }}>
                <Typography.Text style={{ fontSize: 13 }}>{r}</Typography.Text>
              </li>
            ))}
          </ul>
          <Divider style={{ margin: '16px 0' }} />
          <Typography.Text strong>Template</Typography.Text>
          <Space.Compact block style={{ marginTop: 8 }}>
            <Select
              allowClear
              placeholder="All device types"
              style={{ flex: 1 }}
              value={templateType}
              onChange={setTemplateType}
              options={ASSET_TYPE_KEYS.map((t) => ({ value: t, label: ASSET_TYPES[t].plural }))}
            />
            <Button icon={<DownloadOutlined />} onClick={() => downloadTemplate(templateType)}>
              Download template
            </Button>
          </Space.Compact>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            Tip: export the current inventory, edit it in Excel and import it again to update many devices at once.
          </Typography.Paragraph>
        </Card>
      </Col>
      <Col xs={24} lg={15}>
        <Card title={<Space><CloudUploadOutlined /> Import devices</Space>}>
          <Upload.Dragger
            accept=".xlsx,.csv"
            maxCount={1}
            fileList={fileList}
            beforeUpload={(f) => {
              setFile(f);
              setFileList([{ uid: f.uid, name: f.name, size: f.size, status: 'done' }]);
              setReport(null);
              setValidatedFor(null);
              return false;
            }}
            onRemove={() => {
              setFile(null);
              setFileList([]);
              setReport(null);
              setValidatedFor(null);
            }}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">Click or drop an Excel or CSV file here</p>
            <p className="ant-upload-hint">Max. 10 000 rows / 20 MB per file</p>
          </Upload.Dragger>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 16 }}>
            <Typography.Text type="secondary">Default type (for files without a "Type" column):</Typography.Text>
            <Select
              allowClear
              placeholder="none"
              style={{ width: 200 }}
              value={defaultType}
              onChange={(v) => {
                setDefaultType(v);
                setValidatedFor(null);
              }}
              options={ASSET_TYPE_KEYS.map((t) => ({ value: t, label: ASSET_TYPES[t].label }))}
            />
            <div style={{ flex: 1 }} />
            <Button icon={<FileSearchOutlined />} disabled={!file} loading={busy === 'dry'} onClick={() => run(true)}>
              Validate (dry run)
            </Button>
            <Button type="primary" icon={<CheckCircleOutlined />} disabled={!canImport} loading={busy === 'import'} onClick={() => run(false)}>
              Import now
            </Button>
          </div>
          {file && validatedFor !== file && !report && (
            <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
              Run a validation first – the import is enabled afterwards.
            </Typography.Text>
          )}
          {report && <ReportView report={report} />}
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------

export function DataExchangePage() {
  const { can } = useSession();
  return (
    <div>
      <PageHeader
        title="Export & import"
        subtitle="Download any part of the CMDB as Excel, CSV or JSON – or add many devices at once from a spreadsheet."
      />
      {can('export') && (
        <>
          <SectionHead title={<><DownloadOutlined /> Export</>} />
          <ExportSection />
        </>
      )}
      {can('import') ? (
        <>
          <div style={{ height: 24 }} />
          <SectionHead title={<><CloudUploadOutlined /> Import devices <Tag style={{ marginLeft: 6 }}>Editors & administrators</Tag></>} />
          <ImportSection />
        </>
      ) : null}
    </div>
  );
}
