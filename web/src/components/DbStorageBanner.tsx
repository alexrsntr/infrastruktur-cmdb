import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button } from 'antd';
import { READ_ONLY_PERCENT, formatStorage, type DbStorageStatus } from '../../../shared/dbStorage';
import { http } from '../lib/api';
import { useSession } from '../lib/session';

const DISMISS_KEY = 'db-storage-banner-dismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * Warns administrators on every page when the database is filling up. The warning can be hidden for the browser
 * session, the critical level cannot.
 */
export function DbStorageBanner() {
  const { can } = useSession();
  const navigate = useNavigate();
  const allowed = can('settings.manage');
  const status = useQuery({
    queryKey: ['system', 'db-storage'],
    queryFn: () => http.get<DbStorageStatus>('/api/system/db-storage'),
    enabled: allowed,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });
  const [dismissed, setDismissed] = useState(readDismissed);

  const s = status.data;
  if (!allowed || !s || (s.level !== 'warning' && s.level !== 'critical')) return null;
  const critical = s.level === 'critical';
  if (!critical && dismissed === 'warning') return null;

  const dismiss = () => {
    setDismissed('warning');
    try {
      sessionStorage.setItem(DISMISS_KEY, 'warning');
    } catch {
      // private window: hidden until the next reload
    }
  };

  return (
    <Alert
      className="db-storage-banner"
      type={critical ? 'error' : 'warning'}
      showIcon
      title={`Database storage ${s.percent} % full (${formatStorage(s.usedBytes)} of ${s.limitBytes ? formatStorage(s.limitBytes) : '–'})`}
      description={`Increase the storage of the PostgreSQL server in Azure (server → Compute + storage) or enable storage auto-grow, then enter the new size in the settings. At ${READ_ONLY_PERCENT} % Azure switches the database to read-only and nothing can be saved anymore.`}
      action={
        <Button size="small" onClick={() => navigate('/admin/settings?tab=storage')}>
          Details
        </Button>
      }
      closable={critical ? false : { onClose: dismiss }}
    />
  );
}
