import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Progress, Tooltip } from 'antd';
import { QUALITY_META, type QualityIssue } from '../../../shared/quality';
import { http } from '../lib/api';

const color = (score: number) => (score >= 90 ? '#1e9e5a' : score >= 70 ? '#d48806' : '#cf1322');

/** Small data quality indicator of one device with the gaps as tooltip */
export function QualityBadge({ assetId }: { assetId: string }) {
  const q = useQuery({ queryKey: ['quality', assetId], queryFn: () => http.get<{ score: number; issues: QualityIssue[] }>(`/api/assets/${assetId}/quality`) });
  if (!q.data) return null;
  const { score, issues } = q.data;
  return (
    <Tooltip
      title={
        issues.length ? (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Data quality {score} / 100</div>
            {issues.map((i) => (
              <div key={i}>• {QUALITY_META[i].label}</div>
            ))}
          </div>
        ) : (
          'All important fields are filled'
        )
      }
    >
      <Link to="/data-quality" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }} aria-label={`Data quality ${score} of 100`}>
        <Progress type="circle" percent={score} size={22} strokeColor={color(score)} showInfo={false} />
        <span style={{ color: color(score), fontWeight: 600 }}>{score}%</span>
      </Link>
    </Tooltip>
  );
}
