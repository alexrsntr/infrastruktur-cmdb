import { createContext, useContext } from 'react';
import type { AppConfig, MeResponse, Permission } from '../../../shared/model';

export interface SessionValue {
  me: MeResponse;
  config: AppConfig;
  can: (permission: Permission) => boolean;
  /** True if the user is restricted to a subset of plants */
  scoped: boolean;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionContext');
  return value;
}

export function useCan() {
  return useSession().can;
}
