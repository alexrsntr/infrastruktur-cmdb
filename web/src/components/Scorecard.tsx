import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, Empty, Input, Modal, Popconfirm, Rate, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, TrophyOutlined } from '@ant-design/icons';
import {
  DEFAULT_SCORECARD_AREAS,
  MAX_SCORECARD_AREAS,
  SCORE_MAX,
  SCORE_META,
  scoreColor,
  scoreLabel,
  type Score,
  type Scorecard,
  type ScorecardInput,
  type ScorecardSummary,
} from '../../../shared/scorecard';
import { errorText, http } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useInvalidate } from '../lib/queries';
import { useSession } from '../lib/session';
import { SectionHead } from './PageParts';

export const useScorecard = (plantId: string) =>
  useQuery({ queryKey: ['scorecard', plantId], queryFn: () => http.get<Scorecard>(`/api/plants/${plantId}/scorecard`) });

export const useScorecardSummaries = () =>
  useQuery({ queryKey: ['scorecards'], queryFn: () => http.get<ScorecardSummary[]>('/api/scorecards'), staleTime: 60_000 });

/** "4/5" in the colour of the score */
export function ScorePoints({ score, size = 22 }: { score: number | null; size?: number }) {
  return (
    <span style={{ fontWeight: 700, fontSize: size, color: scoreColor(score), whiteSpace: 'nowrap' }}>
      {score ?? '–'}
      <span style={{ fontSize: size * 0.65, color: 'var(--cmdb-text-2)', fontWeight: 600 }}>/{SCORE_MAX}</span>
    </span>
  );
}

/** Total of a plant as a small tag ("Score 41/50 · Ø 4.1"), e.g. on the plant cards */
export function ScoreTag({ summary }: { summary: Pick<ScorecardSummary, 'points' | 'max_points' | 'average'> | undefined }) {
  if (!summary || summary.average == null) return null;
  return (
    <Tooltip title={`Scorecard: ${summary.points} of ${summary.max_points} points – ${scoreLabel(summary.average)}`}>
      <Tag icon={<TrophyOutlined />} color={scoreColor(summary.average)} style={{ marginInlineEnd: 0 }}>
        {summary.average.toFixed(1)} / {SCORE_MAX}
      </Tag>
    </Tooltip>
  );
}

function Bar({ score }: { score: number | null }) {
  return (
    <div style={{ display: 'flex', gap: 3, marginTop: 6 }} aria-hidden>
      {Array.from({ length: SCORE_MAX }, (_, i) => (
        <span key={i} style={{ flex: 1, height: 5, borderRadius: 3, background: score != null && i < score ? scoreColor(score) : 'var(--cmdb-border)' }} />
      ))}
    </div>
  );
}

/** Scorecard of a plant: every area with its points out of 5. Created and rated by administrators only. */
export function PlantScorecard({ plantId }: { plantId: string }) {
  const { can } = useSession();
  const q = useScorecard(plantId);
  const [editing, setEditing] = useState(false);
  const manage = can('scorecard.manage');

  if (q.isLoading) return <Skeleton active paragraph={{ rows: 3 }} />;
  const card = q.data;
  if (!card) return null;
  // nothing rated yet: only administrators see the invitation to create it
  if (!card.items.length && !manage) return null;

  return (
    <div>
      <SectionHead
        title={
          <span>
            Scorecard{' '}
            {card.average != null && (
              <Typography.Text type="secondary" style={{ fontSize: 14, fontWeight: 400 }}>
                {card.points} of {card.max_points} points · average {card.average.toFixed(1)} – {scoreLabel(card.average)}
              </Typography.Text>
            )}
          </span>
        }
        extra={
          manage &&
          card.items.length > 0 && (
            <Button icon={<EditOutlined />} onClick={() => setEditing(true)}>
              Rate
            </Button>
          )
        }
      />
      {!card.items.length ? (
        <Card styles={{ body: { padding: 18 } }}>
          <Empty
            image={<TrophyOutlined style={{ fontSize: 40, color: 'var(--cmdb-muted)' }} />}
            styles={{ image: { height: 44 } }}
            description="No scorecard yet. Rate WAN, network, switches, racks and the other areas of this plant with 1–5 points – only administrators can create and change it."
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing(true)}>
              Create scorecard
            </Button>
          </Empty>
        </Card>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {card.items.map((i) => (
              <Card key={i.id} styles={{ body: { padding: 14 } }} style={{ height: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontWeight: 650, fontSize: 15, minWidth: 0, overflowWrap: 'anywhere' }}>{i.category}</span>
                  <ScorePoints score={i.score} />
                </div>
                <Bar score={i.score} />
                <div style={{ fontSize: 12.5, color: scoreColor(i.score), marginTop: 4, fontWeight: 600 }}>{scoreLabel(i.score)}</div>
                {i.comment && (
                  <Typography.Paragraph type="secondary" style={{ fontSize: 13, margin: '6px 0 0', whiteSpace: 'pre-line' }} ellipsis={{ rows: 3, expandable: 'collapsible' }}>
                    {i.comment}
                  </Typography.Paragraph>
                )}
              </Card>
            ))}
          </div>
          {card.updated_at && (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12.5, marginTop: 8 }}>
              Last rated {fmtDateTime(card.updated_at)}
              {card.updated_by_name ? ` by ${card.updated_by_name}` : ''}
            </Typography.Text>
          )}
        </>
      )}
      {manage && <ScorecardEditor open={editing} plantId={plantId} card={card} onClose={() => setEditing(false)} />}
    </div>
  );
}

interface Row {
  key: string;
  category: string;
  score: Score | null;
  comment: string;
}

let rowKey = 0;
const newRow = (category = ''): Row => ({ key: `r${++rowKey}`, category, score: null, comment: '' });

function ScorecardEditor({ open, plantId, card, onClose }: { open: boolean; plantId: string; card: Scorecard; onClose: () => void }) {
  const { message } = App.useApp();
  const invalidate = useInvalidate();
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(
      card.items.length
        ? card.items.map((i) => ({ key: i.id, category: i.category, score: i.score, comment: i.comment ?? '' }))
        : DEFAULT_SCORECARD_AREAS.map((a) => newRow(a)),
    );
  }, [open, card]);

  const update = (key: string, patch: Partial<Row>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const save = async () => {
    const items = rows.filter((r) => r.category.trim());
    const names = items.map((r) => r.category.trim().toLowerCase());
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return message.error(`The area "${dup}" appears twice`);
    setSaving(true);
    try {
      const body: ScorecardInput = { items: items.map((r) => ({ category: r.category.trim(), score: r.score, comment: r.comment.trim() || null })) };
      await http.put(`/api/plants/${plantId}/scorecard`, body);
      message.success('Scorecard saved');
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await http.del(`/api/plants/${plantId}/scorecard`);
      message.success('Scorecard deleted');
      await invalidate();
      onClose();
    } catch (e) {
      message.error(errorText(e));
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={card.items.length ? 'Rate the plant' : 'Create scorecard'}
      width={820}
      destroyOnHidden
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          {card.items.length > 0 && (
            <Popconfirm title="Delete the scorecard of this plant?" description="All ratings and comments are removed." onConfirm={remove} okButtonProps={{ danger: true }}>
              <Button danger icon={<DeleteOutlined />}>
                Delete scorecard
              </Button>
            </Popconfirm>
          )}
          <div style={{ flex: 1 }} />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={saving} onClick={save}>
            Save
          </Button>
        </div>
      }
    >
      <Typography.Paragraph type="secondary">
        Rate every area with 1 to {SCORE_MAX} points ({SCORE_VALUES_TEXT}). Leave the stars empty for areas that are not rated yet. You can rename, remove and add areas.
      </Typography.Paragraph>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
        {rows.map((r) => (
          <div key={r.key} style={{ border: '1px solid var(--cmdb-border-soft)', borderRadius: 8, padding: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <Input
                value={r.category}
                onChange={(e) => update(r.key, { category: e.target.value })}
                placeholder="Area, e.g. WAN"
                maxLength={80}
                style={{ flex: '1 1 200px', fontWeight: 600 }}
                aria-label="Area"
              />
              <Space size={10}>
                <Rate
                  count={SCORE_MAX}
                  value={r.score ?? 0}
                  onChange={(v) => update(r.key, { score: v ? (v as Score) : null })}
                  tooltips={([1, 2, 3, 4, 5] as Score[]).map((s) => `${s}/${SCORE_MAX} – ${SCORE_META[s].label}`)}
                  allowClear
                />
                <span style={{ minWidth: 92 }}>
                  <ScorePoints score={r.score} size={17} />
                </span>
                <Tooltip title="Remove area">
                  <Button type="text" danger icon={<DeleteOutlined />} aria-label={`Remove ${r.category || 'area'}`} onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))} />
                </Tooltip>
              </Space>
            </div>
            <Input.TextArea
              value={r.comment}
              onChange={(e) => update(r.key, { comment: e.target.value })}
              placeholder="Comment (what is good, what is missing …)"
              autoSize={{ minRows: 1, maxRows: 4 }}
              maxLength={2000}
              style={{ marginTop: 8 }}
            />
          </div>
        ))}
      </div>
      <Button
        type="dashed"
        block
        icon={<PlusOutlined />}
        style={{ marginTop: 12 }}
        disabled={rows.length >= MAX_SCORECARD_AREAS}
        onClick={() => setRows((list) => [...list, newRow()])}
      >
        Add area
      </Button>
    </Modal>
  );
}

const SCORE_VALUES_TEXT = ([1, 2, 3, 4, 5] as Score[]).map((s) => `${s} = ${SCORE_META[s].label.toLowerCase()}`).join(', ');
