import { useNavigate, useParams } from 'react-router';
import { Button, Card, Result, Skeleton, Tag } from 'antd';
import { DownloadOutlined, FileImageOutlined } from '@ant-design/icons';
import { ApiError, errorText } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { usePlan } from '../lib/queries';
import { PageHeader, type Crumb } from '../components/PageHeader';
import { PlanMap } from '../components/PlanMap';

const ROUTES: Record<string, (id: string) => string> = {
  plant: (id) => `/plants/${id}?tab=plans`,
  building: (id) => `/buildings/${id}`,
  rack: (id) => `/racks/${id}`,
  asset: (id) => `/assets/${id}`,
};

export function PlanPage() {
  const { planId } = useParams();
  const navigate = useNavigate();
  const plan = usePlan(planId);

  if (plan.isLoading) return <Skeleton active paragraph={{ rows: 12 }} />;
  if (plan.error || !plan.data) {
    const status = plan.error instanceof ApiError ? plan.error.status : 500;
    return (
      <Result
        status={status === 403 ? '403' : status === 404 ? '404' : 'error'}
        title={status === 404 ? 'Picture not found' : 'Could not load the picture'}
        subTitle={errorText(plan.error)}
        extra={<Button onClick={() => navigate(-1)}>Back</Button>}
      />
    );
  }

  const p = plan.data;
  const ownerRoute = ROUTES[p.entity_type]?.(p.entity_id);
  const crumbs: Crumb[] = [
    ...(p.plant_id && p.entity_type !== 'plant' ? [{ title: 'Plant', to: `/plants/${p.plant_id}?tab=plans` }] : []),
    { title: p.entity_label ?? p.entity_type, to: ownerRoute },
    { title: 'Pictures & plans' },
  ];

  return (
    <div>
      <PageHeader
        crumbs={crumbs}
        title={p.title ?? p.file_name}
        tags={<Tag icon={<FileImageOutlined />}>{p.image_width} × {p.image_height}</Tag>}
        subtitle={[p.description, `Uploaded ${fmtDateTime(p.created_at)}${p.created_by_name ? ` by ${p.created_by_name}` : ''}`].filter(Boolean).join(' · ')}
        extra={
          <Button size="large" icon={<DownloadOutlined />} href={`/api/attachments/${p.id}/file?download=1`}>
            Download original
          </Button>
        }
      />
      <Card>
        <PlanMap plan={p} height="calc(100vh - 290px)" />
      </Card>
    </div>
  );
}
