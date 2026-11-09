// API tokens, webhooks, external references and monitoring status. Shared by API and web client.

import type { Role } from './model';

export interface ApiTokenDto {
  id: string;
  name: string;
  role: Role;
  plant_scope: string[];
  token_prefix: string;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
  created_at: string;
  created_by_name: string | null;
}

/** Only returned once, right after creation */
export interface ApiTokenCreated extends ApiTokenDto {
  token: string;
}

/** Event filters a webhook can subscribe to ("*" = everything, "asset.*" = all device events …) */
export const WEBHOOK_EVENT_GROUPS = [
  { value: '*', label: 'All events' },
  { value: 'asset.*', label: 'Devices (created, changed, deleted, relations, ports, monitoring)' },
  { value: 'asset.create', label: 'Device created' },
  { value: 'asset.update', label: 'Device changed' },
  { value: 'asset.delete', label: 'Device deleted' },
  { value: 'asset.monitoring', label: 'Monitoring status changed' },
  { value: 'activity.*', label: 'Activities (maintenance, incidents …)' },
  { value: 'application.*', label: 'Applications' },
  { value: 'plant.*', label: 'Plants' },
  { value: 'building.*', label: 'Buildings' },
  { value: 'rack.*', label: 'Racks' },
  { value: 'subnet.*', label: 'Subnets' },
  { value: 'vlan.*', label: 'VLANs' },
  { value: 'discovery.*', label: 'Discovery runs' },
] as const;

export function eventMatches(patterns: string[], event: string): boolean {
  return patterns.some((p) => p === '*' || p === event || (p.endsWith('.*') && event.startsWith(p.slice(0, -1))));
}

export interface WebhookDto {
  id: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  last_delivery_at: string | null;
  last_status: string | null;
  created_at: string;
  pending: number;
  failed: number;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: 'pending' | 'ok' | 'failed';
  attempts: number;
  response_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
  next_attempt_at: string;
}

export interface ExternalRef {
  id: string;
  asset_id: string;
  system: string;
  ref: string;
  url: string | null;
  title: string | null;
  status: string | null;
  created_at: string;
  updated_at: string;
}

export const MONITORING_STATUSES = ['up', 'warning', 'down', 'unknown'] as const;
export type MonitoringStatus = (typeof MONITORING_STATUSES)[number];
export const MONITORING_META: Record<MonitoringStatus, { label: string; color: string }> = {
  up: { label: 'Up', color: 'success' },
  warning: { label: 'Warning', color: 'warning' },
  down: { label: 'Down', color: 'error' },
  unknown: { label: 'Unknown', color: 'default' },
};
