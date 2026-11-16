import { Button, Card, Typography } from 'antd';
import { EnvironmentOutlined, ExportOutlined } from '@ant-design/icons';
import type { Plant } from '../../../shared/model';

type Place = Pick<Plant, 'address' | 'city' | 'country' | 'latitude' | 'longitude'>;

/** What Google Maps searches for: the coordinates if maintained, otherwise the postal address. */
export function mapsQuery(p: Place): string | null {
  if (p.latitude != null && p.longitude != null) return `${p.latitude},${p.longitude}`;
  const parts = [p.address, p.city, p.country].map((s) => s?.trim()).filter(Boolean);
  // a country alone would only show the whole country
  return parts.length && (p.address || p.city) ? parts.join(', ') : null;
}

export function googleMapsUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/** Location of a plant on Google Maps (embedded map without API key, plus a link to open it in Google Maps). */
export function PlantLocationCard({ plant, height = 280 }: { plant: Place; height?: number }) {
  const query = mapsQuery(plant);
  return (
    <Card
      title="Location"
      styles={{ body: { padding: query ? 0 : 18, overflow: 'hidden' } }}
      extra={
        query && (
          <Button type="link" href={googleMapsUrl(query)} target="_blank" rel="noopener noreferrer" icon={<ExportOutlined />} style={{ paddingInline: 0 }}>
            Open in Google Maps
          </Button>
        )
      }
    >
      {query ? (
        <iframe
          title="Plant location on Google Maps"
          src={`https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=15&output=embed`}
          width="100%"
          height={height}
          style={{ border: 0, display: 'block' }}
          loading="lazy"
          referrerPolicy="no-referrer"
          allowFullScreen
        />
      ) : (
        <Typography.Text type="secondary">
          <EnvironmentOutlined /> No address maintained. Add the address of the plant (Edit) to show it on Google Maps.
        </Typography.Text>
      )}
    </Card>
  );
}
