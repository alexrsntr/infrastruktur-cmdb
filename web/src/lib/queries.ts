import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Activity,
  AppUser,
  AssetDetail,
  AuditEntry,
  Building,
  DashboardData,
  EntityType,
  Note,
  Paged,
  Plant,
  Asset,
  Rack,
  RackDetail,
} from '../../../shared/model';
import type { Attachment, PlanDetail } from '../../../shared/attachments';
import { http, type Query } from './api';

export const keys = {
  plants: ['plants'] as const,
  plant: (id: string) => ['plant', id] as const,
  buildings: ['buildings'] as const,
  building: (id: string) => ['building', id] as const,
  assets: (q: Query) => ['assets', q] as const,
  asset: (id: string) => ['asset', id] as const,
  notes: (type: EntityType, id: string) => ['notes', type, id] as const,
  activities: (q: Query) => ['activities', q] as const,
  history: (type: EntityType, id: string) => ['history', type, id] as const,
  dashboard: ['dashboard'] as const,
  users: ['users'] as const,
  audit: (q: Query) => ['audit', q] as const,
  racks: (q: Query) => ['racks', q] as const,
  rack: (id: string) => ['rack', id] as const,
  plans: (q: Query) => ['plans', q] as const,
  plan: (id: string) => ['plan', id] as const,
};

export interface PlantDetail extends Plant {
  buildings: Building[];
}

export const usePlants = () => useQuery({ queryKey: keys.plants, queryFn: () => http.get<Plant[]>('/api/plants') });
export const usePlant = (id: string | undefined) =>
  useQuery({ queryKey: keys.plant(id ?? ''), queryFn: () => http.get<PlantDetail>(`/api/plants/${id}`), enabled: !!id });
export const useBuildings = () => useQuery({ queryKey: keys.buildings, queryFn: () => http.get<Building[]>('/api/buildings') });
export const useBuilding = (id: string | undefined) =>
  useQuery({ queryKey: keys.building(id ?? ''), queryFn: () => http.get<Building>(`/api/buildings/${id}`), enabled: !!id });
export const useAssets = (q: Query, enabled = true) =>
  useQuery({ queryKey: keys.assets(q), queryFn: () => http.get<Paged<Asset>>('/api/assets', q), enabled, placeholderData: (prev) => prev });
export const useAsset = (id: string | undefined) =>
  useQuery({ queryKey: keys.asset(id ?? ''), queryFn: () => http.get<AssetDetail>(`/api/assets/${id}`), enabled: !!id });
export const useNotes = (type: EntityType, id: string) =>
  useQuery({ queryKey: keys.notes(type, id), queryFn: () => http.get<Note[]>('/api/notes', { entityType: type, entityId: id }) });
export const useActivities = (q: Query) =>
  useQuery({ queryKey: keys.activities(q), queryFn: () => http.get<Paged<Activity>>('/api/activities', q), placeholderData: (prev) => prev });
export const useHistory = (type: EntityType, id: string) =>
  useQuery({ queryKey: keys.history(type, id), queryFn: () => http.get<AuditEntry[]>('/api/history', { entityType: type, entityId: id }) });
export const useDashboard = () => useQuery({ queryKey: keys.dashboard, queryFn: () => http.get<DashboardData>('/api/dashboard') });
export const useUsers = (enabled = true) => useQuery({ queryKey: keys.users, queryFn: () => http.get<AppUser[]>('/api/users'), enabled });

export const useRacks = (q: Query, enabled = true) =>
  useQuery({ queryKey: keys.racks(q), queryFn: () => http.get<Rack[]>('/api/racks', q), enabled });
export const useRack = (id: string | undefined) =>
  useQuery({ queryKey: keys.rack(id ?? ''), queryFn: () => http.get<RackDetail>(`/api/racks/${id}`), enabled: !!id });

export const usePlans = (q: Query, enabled = true) =>
  useQuery({ queryKey: keys.plans(q), queryFn: () => http.get<Attachment[]>('/api/plans', q), enabled });
export const usePlan = (id: string | undefined) =>
  useQuery({ queryKey: keys.plan(id ?? ''), queryFn: () => http.get<PlanDetail>(`/api/plans/${id}`), enabled: !!id });

/** After any mutation we simply refresh everything that is cached – cheap at CMDB scale and always consistent. */
export function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}
