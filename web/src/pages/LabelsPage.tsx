import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Segmented, Space, Spin, Switch, Typography } from 'antd';
import { ArrowLeftOutlined, PrinterOutlined } from '@ant-design/icons';
import QRCode from 'qrcode';
import { ASSET_TYPES, formatRackUnits, type Asset, type Paged } from '../../../shared/model';
import { http } from '../lib/api';
import { useSession } from '../lib/session';

type Format = 'a4' | 'single';

/** Paper formats: A4 sheet with 3 × 8 labels (70 × 37 mm, e.g. Avery/Zweckform 3475) or one label per page for label printers (62 × 40 mm) */
const FORMATS: Record<Format, { label: string; w: number; h: number }> = {
  a4: { label: 'A4 sheet, 3 × 8 labels (70 × 37 mm)', w: 70, h: 37 },
  single: { label: 'Label printer, 62 × 40 mm', w: 62, h: 40 },
};

const MAX_LABELS = 500;

function useLabelAssets(params: URLSearchParams) {
  const ids = params.get('ids');
  return useQuery({
    queryKey: ['labels', params.toString()],
    queryFn: async (): Promise<Asset[]> => {
      if (ids) {
        const list = ids.split(',').filter(Boolean).slice(0, MAX_LABELS);
        return Promise.all(list.map((id) => http.get<Asset>(`/api/assets/${id}`)));
      }
      const q: Record<string, string> = {};
      for (const k of ['type', 'plantId', 'buildingId', 'floorId', 'status', 'q', 'attention', 'issue', 'sort', 'order']) {
        const v = params.get(k);
        if (v) q[k] = v;
      }
      const res = await http.get<Paged<Asset>>('/api/assets', { ...q, pageSize: MAX_LABELS });
      return res.items;
    },
  });
}

function Label({ asset, origin, details }: { asset: Asset; origin: string; details: boolean }) {
  const [svg, setSvg] = useState('');
  const url = `${origin}/assets/${asset.id}`;
  useEffect(() => {
    QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 }).then(setSvg);
  }, [url]);
  const place = [asset.plant_code, asset.building_code ?? asset.building_name, asset.room, asset.rack_name && `${asset.rack_name}${asset.rack_u ? ` U${formatRackUnits(asset.rack_u, asset.rack_height_u)}` : ''}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="qr-label">
      <div className="qr-code" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="qr-text">
        <div className="qr-name">{asset.name}</div>
        <div className="qr-line">{[ASSET_TYPES[asset.type].label, asset.model].filter(Boolean).join(' · ')}</div>
        {details && asset.asset_tag && <div className="qr-line">Inv. {asset.asset_tag}</div>}
        {details && asset.serial_number && <div className="qr-line">S/N {asset.serial_number}</div>}
        {details && place && <div className="qr-line">{place}</div>}
      </div>
    </div>
  );
}

/** Printable QR labels; the code opens the device page (sign-in required). */
export function LabelsPage() {
  const [params, setParams] = useSearchParams();
  const { me } = useSession();
  const format = (params.get('format') as Format) in FORMATS ? (params.get('format') as Format) : 'a4';
  const [details, setDetails] = useState(true);
  const assets = useLabelAssets(params);
  const origin = window.location.origin;
  const f = FORMATS[format];
  const css = useMemo(
    () => `
      @page { size: ${format === 'a4' ? 'A4' : `${f.w}mm ${f.h}mm`}; margin: 0; }
      .qr-sheet { display: grid; grid-template-columns: repeat(${format === 'a4' ? 3 : 1}, ${f.w}mm); grid-auto-rows: ${f.h}mm; gap: 0; }
      .qr-label { width: ${f.w}mm; height: ${f.h}mm; box-sizing: border-box; padding: 3mm; display: flex; gap: 2.5mm; align-items: center; overflow: hidden; background: #fff; color: #000; break-inside: avoid; }
      .qr-code { width: ${f.h - 8}mm; height: ${f.h - 8}mm; flex: none; }
      .qr-code svg { width: 100%; height: 100%; display: block; }
      .qr-text { min-width: 0; font-family: Arial, sans-serif; line-height: 1.2; }
      .qr-name { font-weight: 700; font-size: 11pt; word-break: break-all; }
      .qr-line { font-size: 7pt; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      @media screen { .qr-sheet { background: #fff; padding: 8px; width: fit-content; box-shadow: 0 1px 4px rgba(0,0,0,.15); } .qr-label { outline: 1px dashed #ccc; } ${format === 'single' ? '.qr-sheet { gap: 6px; }' : ''} }
      @media print { body { background: #fff !important; } .no-print { display: none !important; } .qr-page { padding: 0 !important; } ${format === 'single' ? '.qr-label { break-after: page; }' : ''} }
    `,
    [format, f],
  );

  return (
    <div className="qr-page" style={{ padding: 24, minHeight: '100vh', background: 'var(--cmdb-bg, #f3f5f8)' }}>
      <style>{css}</style>
      <div className="no-print" style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 900 }}>
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => window.history.back()}>
            Back
          </Button>
          <Typography.Title level={3} style={{ margin: 0 }}>
            Device labels
          </Typography.Title>
        </Space>
        <Space wrap size={16}>
          <Segmented
            value={format}
            onChange={(v) => {
              const next = new URLSearchParams(params);
              next.set('format', String(v));
              setParams(next, { replace: true });
            }}
            options={(Object.keys(FORMATS) as Format[]).map((k) => ({ value: k, label: FORMATS[k].label }))}
          />
          <span>
            <Switch checked={details} onChange={setDetails} size="small" /> Serial number, inventory number and location
          </span>
          <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()} disabled={!assets.data?.length}>
            Print {assets.data?.length ?? ''} labels
          </Button>
        </Space>
        <Typography.Text type="secondary">
          The QR code opens the device page in the {me.config.appName} ({origin}). Print at 100 % (“actual size”), without headers and footers.
        </Typography.Text>
        {(assets.data?.length ?? 0) >= MAX_LABELS && <Alert type="warning" showIcon message={`Only the first ${MAX_LABELS} devices – narrow the filter in the device list.`} />}
      </div>
      {assets.isLoading ? (
        <Spin />
      ) : (
        <div className="qr-sheet">
          {(assets.data ?? []).map((a) => (
            <Label key={a.id} asset={a} origin={origin} details={details} />
          ))}
        </div>
      )}
    </div>
  );
}
