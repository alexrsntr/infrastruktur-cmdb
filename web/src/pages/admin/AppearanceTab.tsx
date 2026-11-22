import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, ColorPicker, Form, Input, Popconfirm, Radio, Row, Segmented, Space, Tag, Tooltip, Typography, Upload } from 'antd';
import { CheckOutlined, DeleteOutlined, LockOutlined, UndoOutlined, UploadOutlined } from '@ant-design/icons';
import {
  COLOR_PRESETS,
  DEFAULT_APP_NAME,
  DEFAULT_BRAND_NAME,
  DEFAULT_PRIMARY_COLOR,
  DENSITIES,
  DENSITY_META,
  HEADER_STYLES,
  HEADER_STYLE_META,
  LOGO_MAX_BYTES,
  type AppearanceSettings,
  type AppearanceStatus,
  type HeaderStyle,
  type LogoVariant,
} from '../../../../shared/appearance';
import { errorText, http } from '../../lib/api';
import { HEADER_BG, readablePrimary } from '../../theme';
import { BrandMark } from '../../components/BrandMark';

const ENV_HINT = 'Set by an environment variable of the server – it wins over this setting. Remove the variable to manage it here.';

/** Navigation bar colours of a header style, for the preview (the real values live in styles.css) */
function headerLook(style: HeaderStyle, primary: string) {
  if (style === 'light') return { bg: '#ffffff', fg: '#14202e', fg2: '#4a5a6c', border: '1px solid #dfe4ea', accent: primary };
  if (style === 'primary') return { bg: `color-mix(in srgb, ${primary} 82%, #000)`, fg: '#ffffff', fg2: 'rgba(255,255,255,.78)', border: 'none', accent: '#ffffff' };
  return { bg: HEADER_BG, fg: '#ffffff', fg2: 'rgba(255,255,255,.78)', border: 'none', accent: '#4cc3ff' };
}

/** A small navigation bar with the chosen settings */
function HeaderPreview({ style, primary, brandName, appName, logo }: { style: HeaderStyle; primary: string; brandName: string; appName: string; logo: string | null }) {
  const look = headerLook(style, primary);
  return (
    <div className="appearance-preview" style={{ background: look.bg, borderBottom: look.border, color: look.fg }}>
      {logo ? <img src={logo} alt="" style={{ height: 26, maxWidth: 120, objectFit: 'contain' }} /> : <BrandMark size={26} inverted={style !== 'light'} />}
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15, minWidth: 0 }}>
        {!logo && <span style={{ fontSize: 9, letterSpacing: 1.2, textTransform: 'uppercase', color: look.fg2 }}>{brandName}</span>}
        <span style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap' }}>{appName}</span>
      </span>
      <span className="appearance-preview-nav" style={{ color: look.fg, borderBottomColor: look.accent }}>
        Plants
      </span>
      <span className="appearance-preview-nav muted-nav" style={{ color: look.fg2 }}>
        Devices
      </span>
      <span style={{ flex: 1 }} />
      <span
        className="appearance-preview-button"
        style={style === 'primary' ? { background: '#ffffff', color: readablePrimary(primary, 'light') } : { background: readablePrimary(primary, 'light') }}
      >
        + Add device
      </span>
    </div>
  );
}

function LogoSlot({
  variant,
  status,
  onChange,
}: {
  variant: LogoVariant;
  status: AppearanceStatus;
  onChange: (next: AppearanceStatus) => void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const info = status.logos[variant];
  const url = status.effective.logoUrl[variant];
  const onDark = variant === 'dark';

  const upload = async (file: File) => {
    if (file.size > LOGO_MAX_BYTES) {
      message.error(`The logo is too large – at most ${LOGO_MAX_BYTES / 1024} KB.`);
      return;
    }
    setBusy(true);
    try {
      onChange(await http.upload<AppearanceStatus>(`/api/settings/appearance/logo/${variant}`, file, undefined, 'PUT'));
      message.success('Logo saved');
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      onChange(await http.del<AppearanceStatus>(`/api/settings/appearance/logo/${variant}`));
      message.success('Logo removed');
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="logo-slot">
      <div className="logo-slot-preview" style={{ background: onDark ? HEADER_BG : '#ffffff' }}>
        {url ? <img src={url} alt="" /> : <span style={{ color: onDark ? 'rgba(255,255,255,.6)' : '#5f6e81' }}>No logo – the built-in mark is shown</span>}
      </div>
      <div className="logo-slot-meta">
        <div>
          <Typography.Text strong>{onDark ? 'For dark backgrounds' : 'For light backgrounds'}</Typography.Text>
          <div className="caption">{onDark ? 'Dark or coloured navigation bar' : 'Sign-in page and light navigation bar'}</div>
          {info && (
            <div className="caption">
              {info.width} × {info.height} px · {Math.max(1, Math.round(info.bytes / 1024))} KB
            </div>
          )}
        </div>
        <Space wrap>
          <Upload
            accept="image/png,image/jpeg,image/webp"
            showUploadList={false}
            beforeUpload={(file) => {
              void upload(file);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={busy}>
              {info ? 'Replace' : 'Upload'}
            </Button>
          </Upload>
          {info && (
            <Popconfirm title="Remove this logo?" okText="Remove" okButtonProps={{ danger: true }} onConfirm={remove}>
              <Button danger icon={<DeleteOutlined />} disabled={busy} aria-label="Remove logo" />
            </Popconfirm>
          )}
        </Space>
      </div>
    </div>
  );
}

/** Settings → Appearance: company and app name, primary colour, navigation bar, density and logo */
export function AppearanceTab() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<AppearanceSettings>();
  const [saving, setSaving] = useState(false);
  const status = useQuery({ queryKey: ['settings', 'appearance'], queryFn: () => http.get<AppearanceStatus>('/api/settings/appearance') });
  const s = status.data;

  const values = Form.useWatch([], form) as AppearanceSettings | undefined;
  const color = (s?.env.primaryColor ? s.effective.primaryColor : values?.primaryColor) || DEFAULT_PRIMARY_COLOR;
  const headerStyle = values?.headerStyle ?? 'dark';
  const brandName = (s?.env.brandName ? s.effective.brandName : values?.brandName) || DEFAULT_BRAND_NAME;
  const appName = (s?.env.appName ? s.effective.appName : values?.appName) || DEFAULT_APP_NAME;
  const previewLogo = s ? (headerStyle === 'light' ? (s.effective.logoUrl.light ?? s.effective.logoUrl.dark) : (s.effective.logoUrl.dark ?? s.effective.logoUrl.light)) : null;
  const shownLight = readablePrimary(color, 'light');
  const shownDark = readablePrimary(color, 'dark');

  useEffect(() => {
    if (s) form.setFieldsValue(s.settings);
  }, [s, form]);

  /** New settings: this tab, the theme of the whole app (public config) and the session */
  const apply = (next: AppearanceStatus) => {
    queryClient.setQueryData(['settings', 'appearance'], next);
    void queryClient.invalidateQueries({ queryKey: ['public-config'] });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      apply(await http.put<AppearanceStatus>('/api/settings/appearance', { ...v, brandName: v.brandName || null, appName: v.appName || null, primaryColor: v.primaryColor || null }));
      message.success('Appearance saved – visible to everyone after reloading the page');
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const lock = (env: boolean | undefined) => (env ? <Tooltip title={ENV_HINT}><LockOutlined /></Tooltip> : null);

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      {s && (s.env.brandName || s.env.appName || s.env.primaryColor) && (
        <Alert type="info" showIcon title="Some values are set by environment variables" description={ENV_HINT} />
      )}
      <Card title="Preview" size="small">
        <HeaderPreview style={headerStyle} primary={color} brandName={brandName} appName={appName} logo={previewLogo} />
      </Card>
      <Form form={form} layout="vertical" disabled={!s} requiredMark={false}>
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={12}>
            <Card title="Names and colour" style={{ height: '100%' }} loading={status.isLoading}>
              <Form.Item name="brandName" label={<Space size={6}>Company name {lock(s?.env.brandName)}</Space>} extra="Small text above the app name and in e-mails.">
                <Input placeholder={s?.env.brandName ? s.effective.brandName : DEFAULT_BRAND_NAME} maxLength={60} disabled={s?.env.brandName} allowClear />
              </Form.Item>
              <Form.Item name="appName" label={<Space size={6}>App name {lock(s?.env.appName)}</Space>} extra="Shown in the navigation bar, the browser tab, e-mails and exports.">
                <Input placeholder={s?.env.appName ? s.effective.appName : DEFAULT_APP_NAME} maxLength={60} disabled={s?.env.appName} allowClear />
              </Form.Item>
              <Form.Item name="primaryColor" label={<Space size={6}>Primary colour {lock(s?.env.primaryColor)}</Space>} extra="Buttons, links, the selected navigation item and highlights.">
                <ColorChoice disabled={!!s?.env.primaryColor} />
              </Form.Item>
              {(shownLight.toLowerCase() !== color.toLowerCase() || shownDark.toLowerCase() !== color.toLowerCase()) && (
                <Alert
                  type="info"
                  showIcon
                  title="Adjusted for readability"
                  description={
                    <span>
                      To keep text and buttons readable, the colour is shown as <ColorDot color={shownLight} /> {shownLight} in the light and{' '}
                      <ColorDot color={shownDark} /> {shownDark} in the dark scheme.
                    </span>
                  }
                />
              )}
            </Card>
          </Col>
          <Col xs={24} xl={12}>
            <Card title="Navigation bar and density" style={{ height: '100%' }} loading={status.isLoading}>
              <Form.Item name="headerStyle" label="Navigation bar">
                <Radio.Group className="header-style-choice">
                  {HEADER_STYLES.map((h) => {
                    const look = headerLook(h, color);
                    return (
                      <Radio.Button key={h} value={h}>
                        <span className="header-style-swatch" style={{ background: look.bg, border: look.border === 'none' ? undefined : look.border }}>
                          <span style={{ background: look.accent }} />
                        </span>
                        <span>
                          <strong>{HEADER_STYLE_META[h].label}</strong>
                          <span className="caption" style={{ display: 'block' }}>
                            {HEADER_STYLE_META[h].hint}
                          </span>
                        </span>
                      </Radio.Button>
                    );
                  })}
                </Radio.Group>
              </Form.Item>
              <Form.Item
                name="density"
                label="Density"
                extra="The default for everyone. Each person can choose differently in the display menu (sun / moon button) of the navigation bar."
              >
                <Segmented block options={DENSITIES.map((d) => ({ value: d, label: DENSITY_META[d].label }))} />
              </Form.Item>
            </Card>
          </Col>
        </Row>
      </Form>
      <Card title="Logo" loading={status.isLoading}>
        <Typography.Paragraph type="secondary">
          PNG, JPEG or WebP, at most {LOGO_MAX_BYTES / 1024} KB. A wide logo with a transparent background works best (about 4:1, at least 64 px high). It
          replaces the built-in mark and the company name in the navigation bar and on the sign-in page.
        </Typography.Paragraph>
        {s && (
          <Row gutter={[16, 16]}>
            {(['light', 'dark'] as const).map((v) => (
              <Col xs={24} lg={12} key={v}>
                <LogoSlot variant={v} status={s} onChange={apply} />
              </Col>
            ))}
          </Row>
        )}
      </Card>
      <Space wrap>
        <Button type="primary" size="large" onClick={save} loading={saving} disabled={!s}>
          Save appearance
        </Button>
        <Button
          size="large"
          icon={<UndoOutlined />}
          disabled={!s}
          onClick={() => form.setFieldsValue({ brandName: null, appName: null, primaryColor: null, headerStyle: 'dark', density: 'comfortable' })}
        >
          Back to defaults
        </Button>
        {s?.updatedAt && <span className="caption">Last changed {new Date(s.updatedAt).toLocaleString()}</span>}
      </Space>
    </Space>
  );
}

function ColorDot({ color }: { color: string }) {
  return <span className="color-dot" style={{ background: color }} />;
}

/** Colour presets plus a free colour (antd Form control: value / onChange) */
function ColorChoice({ value, onChange, disabled }: { value?: string | null; onChange?: (v: string | null) => void; disabled?: boolean }) {
  const current = (value || DEFAULT_PRIMARY_COLOR).toLowerCase();
  const isPreset = COLOR_PRESETS.some((p) => p.color === current);
  return (
    <div className="color-choice">
      {COLOR_PRESETS.map((p) => {
        const selected = p.color === current;
        return (
          <Tooltip key={p.key} title={p.label}>
            <button
              type="button"
              className={`color-swatch${selected ? ' selected' : ''}`}
              style={{ background: p.color }}
              aria-label={`${p.label}${selected ? ' (selected)' : ''}`}
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange?.(p.key === 'blue' ? null : p.color)}
            >
              {selected && <CheckOutlined />}
            </button>
          </Tooltip>
        );
      })}
      <ColorPicker
        disabled={disabled}
        disabledAlpha
        value={current}
        onChangeComplete={(c) => onChange?.(c.toHexString().toLowerCase())}
        showText={() => (isPreset ? 'Own colour…' : current)}
      />
      {!isPreset && <Tag>Own colour</Tag>}
    </div>
  );
}
