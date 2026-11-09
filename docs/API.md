# REST API

Everything the web interface does goes through the same JSON API under `/api`. Scripts and other
systems (monitoring, ticket system, inventory scanners, automation) use it with an **API token**.

- [Authentication](#authentication)
- [Conventions](#conventions)
- [Devices](#devices)
- [Ports, VLANs and subnets](#ports-vlans-and-subnets)
- [Applications and impact](#applications-and-impact)
- [Monitoring status](#monitoring-status)
- [Tickets and other external references](#tickets-and-other-external-references)
- [Webhooks](#webhooks)
- [Discovery](#discovery)
- [Examples](#examples)

## Authentication

1. An administrator creates a token under **Administration → Settings & e-mail → API & webhooks → New token**:
   name, permissions (Viewer, Operator, Editor or Administrator), optionally limited to some plants and
   with an expiry date.
2. The token (`cmdb_…`) is shown **once**. Store it in the secret store of the calling system.
3. Send it with every request:

```http
GET /api/assets HTTP/1.1
Host: cmdb.example.com
Authorization: Bearer cmdb_3q2Xf…
```

- Each token acts as its own service user (`API: <name>`) – changes appear under that name in the
  activity log and the audit log.
- The role and plant scope of the token apply exactly as for a person. An Operator token may report
  monitoring status and add notes, but not change devices.
- Tokens are stored as SHA-256 hashes only. A revoked or expired token is rejected with `401`.
- With a token no CSRF header is needed. API tokens cannot create or revoke API tokens or manage
  webhooks – that requires a signed-in administrator.

## Conventions

| | |
|---|---|
| Format | JSON (`Content-Type: application/json`), UTF-8 |
| IDs | UUIDs |
| Dates | `YYYY-MM-DD`; timestamps ISO 8601 in UTC |
| Lists | `GET` lists return arrays; device lists return `{ "items": [...], "total": n }` with `page` / `pageSize` (max. 1000) |
| Errors | `{ "error": "message", "details": [...] }` with 400 (validation), 401, 403, 404, 409 (duplicate), 500 |
| Changes | every change is written to the audit log and – if webhooks are set up – sent as an event |

## Devices

| Method | Path | Permission | |
|---|---|---|---|
| GET | `/api/assets` | read | Filter: `type`, `status`, `criticality` (comma separated), `plantId`, `buildingId`, `floorId`, `q` (search), `tag`, `attention` (see below), `sort`, `order`, `page`, `pageSize` |
| GET | `/api/assets/{id}` | read | Device with relations |
| POST | `/api/assets` | asset.write (Editor) | Create |
| PUT | `/api/assets/{id}` | asset.write | Replace all fields |
| PATCH | `/api/assets/{id}/status` | asset.status (Operator) | `{ "status": "maintenance" }` |
| DELETE | `/api/assets/{id}` | asset.delete | |
| POST | `/api/relations` | asset.write | `{ "source_id", "target_id", "relation", "source_port", "target_port" }` |
| DELETE | `/api/relations/{id}` | asset.write | |
| GET | `/api/asset-types` | read | Hidden types and administrator fields per type |
| GET | `/api/attention` | read | Devices that need attention, counts per reason (`plantId`, `limit`) |
| GET | `/api/export/assets?format=xlsx\|csv\|json` | export | Same filters as `/api/assets` |
| POST | `/api/import/assets?dryRun=true` | import | Multipart upload (`file`), Excel or CSV |

Device fields (`POST`/`PUT`):

```json
{
  "type": "switch",
  "name": "muc-b01-sw03",
  "status": "active",
  "criticality": "high",
  "plant_id": "…", "building_id": "…", "floor_id": "…", "room": "Floor distributor",
  "rack_id": "…", "rack_u": 20, "rack_height_u": 1,
  "manufacturer": "Cisco", "model": "Catalyst 9300-48P", "serial_number": "FOC1234X0AB",
  "asset_tag": "IT-4711", "ip_address": "10.10.0.13", "mac_address": "00:11:22:33:44:55",
  "fqdn": "muc-b01-sw03.example.local", "os": "IOS-XE 17.9",
  "owner": "Network Team", "cost_center": "4000",
  "purchase_date": "2024-02-01", "warranty_end": "2029-01-31",
  "support_end": "2030-12-31", "end_of_life": "2032-06-30", "support_contract": "SmartNet 8x5xNBD",
  "tags": ["office"],
  "attributes": { "port_count": 48, "poe": true, "custom_contract_number": "C-4711" }
}
```

Types: `switch`, `router`, `firewall`, `access_point`, `wlan_controller`, `server`, `storage`, `vm`, `ups`,
`pdu`, `ot_device`, `printer`, `camera`, `other`. The allowed `attributes` per type are in
`shared/model.ts` (`ASSET_TYPES`) plus the fields an administrator added (`GET /api/asset-types`); unknown
attributes are dropped.

`attention` filter values: `warranty_expiring`, `warranty_expired`, `support_ending`, `support_ended`,
`eol`, `not_seen`.

## Ports, VLANs and subnets

| Method | Path | Permission | |
|---|---|---|---|
| GET | `/api/assets/{id}/ports` | read | Ports with the far end of the cable |
| POST | `/api/assets/{id}/ports` | asset.write | `{ "names": "Gi1/0/1-48, Te1/1/1-4", "kind": "ethernet", "speed": "1G" }` – ranges are expanded |
| PUT | `/api/ports/{id}` | asset.write | Name, kind, speed, description, enabled, mode, `untagged_vlan`, `tagged_vlans`, MAC, cable label |
| DELETE | `/api/ports/{id}` | asset.write | |
| POST | `/api/ports/{id}/connect` | asset.write | `{ "port_id": "…", "cable_label": "K-0815" }` – both ends are set; existing cables are replaced |
| POST | `/api/ports/{id}/disconnect` | asset.write | |
| GET | `/api/cables?label=K-0815` | read | Find both ends of a cable |
| GET | `/api/plants/{id}/network` | read | VLANs, subnets with usage, duplicate IPs, addresses outside of all subnets |
| GET / POST / PUT / DELETE | `/api/vlans`, `/api/vlans/{id}` | asset.write for changes | `{ "plant_id", "vid", "name", "description" }` |
| GET / POST / PUT / DELETE | `/api/subnets`, `/api/subnets/{id}` | asset.write for changes | `{ "plant_id", "cidr", "name", "vlan_id", "gateway", "dhcp_range" }` |
| GET | `/api/subnets/{id}` | read | Used addresses, free ranges, next free address |
| GET | `/api/ipam/duplicates` | read | IP addresses used by more than one device (per plant) |

## Applications and impact

| Method | Path | Permission | |
|---|---|---|---|
| GET | `/api/applications` | read | Filter `q`, `plantId`, `assetId` |
| GET | `/api/applications/{id}` | read | Devices and the infrastructure they need |
| POST / PUT / DELETE | `/api/applications`, `/api/applications/{id}` | asset.write / asset.delete | `{ "name", "status", "criticality", "plant_id", "owner", "url", "description" }` |
| POST | `/api/applications/{id}/assets` | asset.write | `{ "asset_id", "role" }` |
| DELETE | `/api/applications/{id}/assets/{assetId}` | asset.write | |
| GET | `/api/assets/{id}/impact` | read | Devices and applications that fail with this device |

The impact analysis follows the relations `uplink`, `runs_on`, `powered_by` and `depends_on` (the
source depends on the target) recursively. Redundancy partners (`redundant_with`) are listed separately.

## Monitoring status

Monitoring systems report the state of devices; it is shown on the device page and `up`/`warning` also
update “last seen”. Only changes of the state are written to the activity log (and sent to webhooks as
`asset.monitoring`).

```http
PUT /api/assets/{id}/monitoring
{ "status": "down", "message": "ICMP timeout", "source": "Zabbix" }
```

Many devices at once, matched by `id`, `name` (or FQDN) or `ip`:

```http
POST /api/monitoring
{
  "source": "zabbix-prod",
  "items": [
    { "name": "muc-core-sw01", "status": "up" },
    { "ip": "10.10.1.11", "status": "warning", "message": "CPU 92 %" }
  ]
}
→ { "updated": 2, "unmatched": [], "ambiguous": [] }
```

`status`: `up`, `warning`, `down`, `unknown`. Permission: `asset.status` (Operator token is enough).

## Tickets and other external references

| Method | Path | Permission | |
|---|---|---|---|
| GET | `/api/assets/{id}/refs` | read | |
| POST | `/api/assets/{id}/refs` | note.write (Operator) | `{ "system": "ServiceNow", "ref": "INC0012345", "url": "https://…", "title": "…", "status": "Open" }` – same system + ref updates the entry |
| DELETE | `/api/refs/{id}` | note.write | |
| GET | `/api/refs?system=ServiceNow&ref=INC0012345` | read | Which devices does a ticket refer to? |

## Webhooks

Set up under **API & webhooks → New webhook**: URL, events and active/inactive. Events are written in the
same database transaction as the change (outbox), so nothing is lost when the receiver is down.

Event names are `<entity>.<action>`, for example `asset.create`, `asset.update`, `asset.delete`,
`asset.relation.add`, `asset.port.connect`, `asset.monitoring`, `activity.create`, `application.update`,
`subnet.create`, `discovery.run`. Filters: `*` (all), `asset.*`, or exact names.

Request:

```http
POST https://receiver.example.com/cmdb
Content-Type: application/json
X-CMDB-Event: asset.update
X-CMDB-Delivery: 1842
X-CMDB-Timestamp: 1762680000
X-CMDB-Signature: sha256=5f0c…

{
  "event": "asset.update",
  "action": "update",
  "entity_type": "asset",
  "entity_id": "1b0c…",
  "entity_label": "muc-b01-sw03",
  "plant_id": "…",
  "changes": { "status": { "from": "active", "to": "maintenance" } },
  "user": "Anna Admin",
  "at": "2026-11-09T09:20:00.000Z",
  "delivery_id": "1842"
}
```

Check the signature with the secret shown when the webhook was created:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
// compare with crypto.timingSafeEqual and reject requests with an old timestamp (e.g. older than 5 minutes)
```

```python
expected = "sha256=" + hmac.new(secret.encode(), f"{timestamp}.{raw_body}".encode(), hashlib.sha256).hexdigest()
```

Delivery: any `2xx` answer within 10 seconds counts as delivered. Otherwise the CMDB retries after 30 s,
1, 2, 4 and 8 minutes (6 attempts), then marks the delivery as failed; failed deliveries can be retried in
the delivery log. Receivers should be idempotent (`X-CMDB-Delivery`). History is kept for 14 days.

## Discovery

See [SETUP.md](SETUP.md#auto-discovery). The API for discovery sources and the inbox:

| Method | Path | Permission | |
|---|---|---|---|
| GET / POST / PUT / DELETE | `/api/discovery/sources`, `/api/discovery/sources/{id}` | settings.manage | SNMP and Active Directory sources |
| POST | `/api/discovery/sources/{id}/run` | settings.manage | Start a run now |
| GET | `/api/discovery/runs` | settings.manage | Recent runs |
| GET | `/api/discovery/items?state=new` | asset.write | Inbox of discovered devices |
| POST | `/api/discovery/items/{id}/create` | asset.write | Create a device from it |
| POST | `/api/discovery/items/{id}/link` | asset.write | `{ "asset_id" }` – link with an existing device |
| POST | `/api/discovery/items/{id}/ignore` | asset.write | |

## Examples

PowerShell:

```powershell
$h = @{ Authorization = "Bearer $env:CMDB_TOKEN" }
Invoke-RestMethod -Headers $h "https://cmdb.example.com/api/assets?type=server&attention=support_ended"
```

curl:

```bash
curl -s -H "Authorization: Bearer $CMDB_TOKEN" -H 'Content-Type: application/json' \
  -X POST https://cmdb.example.com/api/monitoring \
  -d '{"source":"checkmk","items":[{"name":"muc-core-sw01","status":"up"}]}'
```

Python:

```python
import requests
s = requests.Session()
s.headers["Authorization"] = f"Bearer {token}"
devices = s.get("https://cmdb.example.com/api/assets", params={"plantId": plant_id, "pageSize": 1000}).json()["items"]
```
