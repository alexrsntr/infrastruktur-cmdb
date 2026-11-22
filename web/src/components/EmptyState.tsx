import { Empty, Skeleton } from 'antd';

/** "Nothing here yet" – the same small picture everywhere, with an optional action (e.g. "Add device"). */
export function EmptyState({ description, action }: { description: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="muted">{description}</span>} className="empty-state">
      {action}
    </Empty>
  );
}

/** Placeholder while a card or list is loading */
export function LoadingState({ rows = 4 }: { rows?: number }) {
  return <Skeleton active title={false} paragraph={{ rows }} className="loading-state" />;
}
