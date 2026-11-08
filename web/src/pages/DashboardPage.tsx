import { Link } from 'react-router';
import { Card, Col, Empty, Row, Skeleton, Tag, Typography } from 'antd';
import { BankOutlined, SafetyCertificateOutlined, ScheduleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { ACTIVITY_KIND_META, ASSET_TYPES, ASSET_TYPE_KEYS } from '../../../shared/model';
import { useDashboard } from '../lib/queries';
import { useSession } from '../lib/session';
import { daysUntil, fmtDate } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { StatTile, TypeIcon } from '../components/Simple';
import { ASSET_TYPE_ICONS } from '../components/icons';
import { EntityLink, RecentActivityFeed } from '../components/ActivityLog';

function greeting() {
  const h = dayjs().hour();
  return h < 11 ? 'Good morning' : h < 18 ? 'Hello' : 'Good evening';
}

export function DashboardPage() {
  const { me, scoped } = useSession();
  const { data, isLoading } = useDashboard();
  const byType = Object.fromEntries((data?.byType ?? []).map((t) => [t.type, t.count])) as Record<string, number>;
  const firstName = me.user.displayName.split(' ')[0];

  return (
    <div>
      <PageHeader
        title={`${greeting()}, ${firstName}`}
        subtitle={scoped ? 'This is what is going on in your plants.' : 'This is what is going on in all plants.'}
      />

      {isLoading || !data ? (
        <Skeleton active paragraph={{ rows: 10 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="tile-grid">
            {ASSET_TYPE_KEYS.map((t) => (
              <StatTile key={t} to={`/inventory/${ASSET_TYPES[t].slug}`} icon={ASSET_TYPE_ICONS[t]} color={ASSET_TYPES[t].color} value={byType[t] ?? 0} label={ASSET_TYPES[t].plural} />
            ))}
            <StatTile to="/activities" icon={<ScheduleOutlined />} color="#b26a00" value={data.totals.openActivities} label="Open activities" />
            <StatTile
              to="/inventory?sort=warranty_end&order=asc"
              icon={<SafetyCertificateOutlined />}
              color={data.warrantyExpiring.length ? '#c4262e' : '#1e9e5a'}
              value={data.warrantyExpiring.length}
              label="Warranty ends soon"
            />
          </div>

          <Row gutter={[20, 20]}>
            <Col xs={24} xl={15}>
              <Card title="Latest activity" extra={<Link to="/activities">All activities</Link>}>
                <RecentActivityFeed limit={14} />
              </Card>
            </Col>
            <Col xs={24} xl={9}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <Card title="Needs attention">
                  {!data.upcomingActivities.length && !data.warrantyExpiring.length ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="All good – nothing open" />
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {data.upcomingActivities.slice(0, 5).map((act) => {
                        const d = daysUntil(act.due_date);
                        return (
                          <div key={act.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                            <Tag color={ACTIVITY_KIND_META[act.kind].color} style={{ marginTop: 2 }}>
                              {ACTIVITY_KIND_META[act.kind].label}
                            </Tag>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontWeight: 600 }}>{act.title}</div>
                              <div className="muted" style={{ fontSize: 13.5 }}>
                                {act.entity_label && <EntityLink type={act.entity_type} id={act.entity_id} label={act.entity_label} />}
                                {act.due_date && (
                                  <span style={{ color: d !== null && d < 0 ? '#c4262e' : undefined, fontWeight: d !== null && d < 0 ? 600 : undefined }}>
                                    {' '}
                                    · {d !== null && d < 0 ? `overdue since ${fmtDate(act.due_date)}` : `due ${fmtDate(act.due_date)}`}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {data.warrantyExpiring.slice(0, 5).map((w) => {
                        const d = daysUntil(w.warranty_end);
                        return (
                          <div key={w.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                            <TypeIcon type={w.type} />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <Link to={`/assets/${w.id}`} style={{ fontWeight: 600 }}>
                                {w.name}
                              </Link>
                              <div className="muted" style={{ fontSize: 13.5 }}>
                                Warranty {d !== null && d < 0 ? 'ended' : 'ends'} {fmtDate(w.warranty_end)} · {w.plant_name}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Card>

                <Card title={scoped ? 'Your plants' : 'Plants'} extra={<Link to="/plants">Show all</Link>}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {data.byPlant.slice(0, 8).map((p) => (
                      <Link key={p.plant_id} to={`/plants/${p.plant_id}`} className="plant-row">
                        <span className="stat-icon" style={{ width: 40, height: 40, fontSize: 18, background: '#2563eb14', color: '#2563eb' }}>
                          <BankOutlined />
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <Typography.Text strong>{p.plant_code}</Typography.Text> <span>{p.plant_name}</span>
                        </span>
                        <span className="muted">{p.count} devices</span>
                      </Link>
                    ))}
                  </div>
                  <style>{`.plant-row { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 10px; color: inherit; }
                    .plant-row:hover { background: #eef4fb; }`}</style>
                </Card>
              </div>
            </Col>
          </Row>
        </div>
      )}
    </div>
  );
}
