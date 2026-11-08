# Infrastruktur CMDB

**Open-source IT Configuration Management Database for sites, buildings and network/compute infrastructure.**

A web-based CMDB for documenting **plants, buildings, floors and network/compute infrastructure**
(switches, access points, servers, virtual machines), with **maps & floor plans**, **notes**,
**activities**, a complete **change history**, **role-based permissions with Microsoft Entra ID SSO**
and **exports of everything** (Excel, CSV, JSON).

Built for Azure: **Azure App Service (Node.js 22)** + **Azure Database for PostgreSQL Flexible
Server** with **managed identity** authentication (no database passwords), deployed with **Terraform**.

---

## Features

| Area | What you get |
|---|---|
| **Navigation** | Sidebar tree *Plants → Buildings*, plus inventory views *All assets / Switches / Access Points / Servers / VMs*, global search (hostname, IP, serial, MAC, plant …) |
| **Maps** | World map of all plants (OpenStreetMap or any tile server) · per-floor **floor plans** (PNG/JPEG/WebP upload) with drag-and-drop placement of assets, type filter, legend, print view |
| **Site plans & pictures** | Upload pictures of a plant (site plan, aerial photo, hall or office photos) and place **access points, switches and other devices, buildings and text labels** on them by click & drag. Every image in *Files* can be turned into such a plan; the device page lists the pictures it is shown on |
| **Infrastructure** | Switches, APs, servers, VMs with common master data (IP, MAC, FQDN, serial, model, owner, cost center, warranty …) and type-specific fields (ports/PoE/VLAN, SSIDs/Wi-Fi standard, CPU/RAM/hypervisor, vCPU/RAM/environment). Extensible type registry in `shared/model.ts` |
| **Racks** | Racks and wall cabinets per building (height in U, numbering direction). **Front view** with devices at their units, plus patch panels, cable management, UPS, PDUs and shelves. Click a free unit to mount a device, click a device to move/unmount it; collision check (no two things in the same U). Building tab with all racks side by side, rack list with free capacity, rack export incl. unit-by-unit elevation |
| **Data centers (stretched)** | Group server rooms into data centers. A **stretched** data center spans two buildings (site A / site B, optional witness): the diagram shows both rooms side by side with their racks and devices, the fibre/WAN links between the rooms, the device connections across the sites (e.g. core switch A ↔ core switch B with ports) and clusters whose hosts run in both rooms. Racks are assigned automatically by building and room; export as Excel/CSV/JSON |
| **Relations** | Uplink, runs on, connected to, depends on, redundant with – including port documentation (e.g. AP `eth0` → switch `Gi1/0/12`, VM → ESX host) |
| **Attachments** | Files on plants, buildings, floors, racks and devices: photos (gallery with preview), data sheets, contracts, configuration backups. Pictures can be marked as **plan** to place devices on them. Type detection from the file content, executables/scripts/web pages blocked, plant scope enforced, files served with safe headers. Download all files of an object or a plant as **ZIP**. Stored in **Azure Blob Storage** (managed identity, versioning + soft delete) or the database for development |
| **Notes** | Free-text notes on plants, buildings, floors and assets; pinning; author-only editing |
| **Activities** | Maintenance, incidents, changes, installations, inspections, replacements with status, assignee and due date; overdue highlighting; global activity board |
| **History & audit** | Field-level change history for every object (who/what/when, old → new). Global audit log (incl. logins & exports) for administrators |
| **Permissions** | 4 roles (Admin, Editor, Operator, Viewer) from **Entra ID app roles**, plus optional **plant scoping** per user (e.g. a technician only sees plant MUC) |
| **Export** | Every list exports to **Excel / CSV / JSON** with the current filters. Complete workbook (one sheet per entity & asset type), plant dossier, asset dossier, audit log, users. CSV with `;` (Excel DE) or `,`, formula-injection safe |
| **Import** | Excel/CSV import of assets (same columns as the export) with **dry run** validation, upsert by ID or type+name, per-row error report |
| **Warranty e-mails** | Daily digest e-mail of devices whose warranty/support ends in e.g. 90/30/7 days (and once when expired). Global recipients plus recipients per plant. Each device is reported once per stage; safe with several app instances. SMTP server configured in the app (*Administration → Settings*), password stored encrypted. Preview, "send now", test e-mail and send history |
| **Dashboard** | KPIs, assets per type/plant/lifecycle status, warranty expiring in 90 days, upcoming activities, recent changes |

## Roles & permissions

| Permission | Viewer | Operator | Editor | Admin |
|---|:-:|:-:|:-:|:-:|
| Read everything in scope, export | ✔ | ✔ | ✔ | ✔ |
| Notes & activities, change asset status | | ✔ | ✔ | ✔ |
| Create / edit / delete assets & relations, place on floor plans | | | ✔ | ✔ |
| Manage buildings, floors, floor plans; import | | | ✔ | ✔ |
| Create plants (only users without plant restriction) | | | ✔ | ✔ |
| Delete plants, user management, global audit log, settings & e-mail notifications | | | | ✔ |

* Roles come from the Entra ID **app roles** `CMDB.Admin`, `CMDB.Editor`, `CMDB.Operator`, `CMDB.Viewer`
  (assigned to users or groups in *Enterprise applications*). Users without an app role get
  `DEFAULT_ROLE` and can be managed in the app.
* **Plant scope** is managed in the app (*Administration → Users & permissions*). Empty scope = all plants.
  Scoped users only see, search, export and change objects of their plants.
* Every permission is enforced **server side**; the UI only hides what you cannot do.

## Architecture

```
Browser (React 19 + Ant Design 6 + Leaflet)
   │  HTTPS, session cookie (HttpOnly, SameSite=Lax) + CSRF header
   ▼
Azure App Service (Linux, Node 22) ── Express 5 API + static SPA
   │   • OIDC auth-code + PKCE via MSAL (client secret OR managed identity as federated credential)
   │   • sessions stored in PostgreSQL (scale-out ready)
   │   • Entra token for PostgreSQL acquired via managed identity, refreshed automatically
   ▼
Azure Database for PostgreSQL Flexible Server (Entra-only auth)
```

* `server/` – Express API (TypeScript, bundled with esbuild), SQL migrations (`server/db/migrations.ts`)
* `web/` – React SPA (Vite)
* `shared/model.ts` – domain model shared by API and UI: roles/permissions, asset types & fields, enums, DTOs
* `tests/` – API tests (Vitest + Supertest against a real PostgreSQL)
* `infra/terraform/`, `scripts/`, `.github/workflows/`, `docs/AZURE.md` – Azure infrastructure (Terraform), Entra setup, CI/CD

## Quick start

The [setup guide](docs/SETUP.md) walks you through a local installation (about 10 minutes) and a
production rollout on Azure. The short version for local development:

### Local development

Prerequisites: Node.js 22+, PostgreSQL 14+ (16 recommended).

```bash
# 1. database
createuser -P cmdb            # password: cmdb
createdb -O cmdb cmdb
createdb -O cmdb cmdb_test    # for the tests

# 2. app
cp .env.example .env          # AUTH_MODE=dev → login picker with demo personas
npm install
npm run seed                  # schema + demo data (6 fictitious plants, floor plans, ~160 CIs)
npm run dev                   # API on :3000, UI on http://localhost:5173
```

In **dev mode** the login page offers four personas (Admin, Editor, Operator restricted to plant MUC,
Viewer). Dev mode is refused when `NODE_ENV=production`.

| Command | |
|---|---|
| `npm run dev` | API (tsx watch) + Vite dev server with proxy |
| `npm test` | API test suite (uses `TEST_DATABASE_URL`, default `postgres://cmdb:cmdb@localhost:5432/cmdb_test`) |
| `npm run typecheck` | TypeScript for server and web |
| `npm run build` | `dist/server.mjs` + `dist/public/` |
| `npm start` | production server |
| `npm run migrate` | apply DB migrations (also done automatically on start) |
| `npm run seed [-- --force]` | demo data (`--force` wipes CMDB tables first – never in production) |

## Configuration

All settings are environment variables – see [`.env.example`](.env.example) for the full, commented list.
The most important ones for Azure:

| Variable | Example | |
|---|---|---|
| `NODE_ENV` | `production` | |
| `APP_BASE_URL` | `https://cmdb-prod.azurewebsites.net` | used for the OIDC redirect URI `…/auth/callback` |
| `SESSION_SECRET` | Key Vault reference | ≥ 32 characters |
| `AUTH_MODE` | `entra` | |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` | | app registration |
| `ENTRA_USE_MANAGED_IDENTITY` | `true` | secretless: managed identity as federated credential (else `ENTRA_CLIENT_SECRET`) |
| `ENTRA_REQUIRE_APP_ROLE` | `true` | reject users without a CMDB app role |
| `BOOTSTRAP_ADMINS` | `admin@yourdomain.com` | UPNs that are always admin |
| `DB_AUTH` | `entra` | PostgreSQL password = Entra token of the managed identity |
| `PGHOST`, `PGDATABASE`, `PGUSER` | `…postgres.database.azure.com`, `cmdb`, `<identity name>` | |
| `PGSSLMODE` | `require` | |
| `AZURE_CLIENT_ID` | | client ID of the user-assigned managed identity |
| `STORAGE_DRIVER` | `azure-blob` | where attachment files are stored (`database` for development) |
| `AZURE_STORAGE_ACCOUNT_URL`, `AZURE_STORAGE_CONTAINER` | `https://<account>.blob.core.windows.net/`, `attachments` | Blob Storage via managed identity (`AZURE_STORAGE_CONNECTION_STRING` for Azurite) |
| `ATTACHMENT_MAX_MB` | `50` | maximum size of one uploaded file |
| `SETTINGS_ENCRYPTION_KEY` | Key Vault reference | encrypts secrets stored in the app settings (SMTP password) |
| `NOTIFICATIONS_SCHEDULER` | `true` | daily warranty e-mails (App Service *Always On* must be enabled) |
| `MAP_TILE_URL` | OSM / Azure Maps / internal | map tiles (allowed automatically in the CSP) |
| `BRAND_NAME`, `APP_NAME`, `BRAND_PRIMARY_COLOR` | `Example Corp`, `IT CMDB`, `#2563eb` | your corporate look (defaults: `Infrastruktur`, `IT CMDB`, `#2563eb`) |

**New here? Start with the [setup guide](docs/SETUP.md)** ([Deutsch](docs/SETUP.de.md)). Deployment step by step (Terraform, app registration, database grants, GitHub Actions): **[docs/AZURE.md](docs/AZURE.md)**. E-mail notifications: **[docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)**. Backlog: **[docs/BACKLOG.md](docs/BACKLOG.md)**.

## Exports & import

* `GET /api/export/<dataset>?format=xlsx|csv|json[&filters]` – datasets: `assets`, `plants`, `buildings`,
  `floors`, `relations`, `notes`, `activities`, `audit` (admin), `users` (admin). Asset filters are the same
  as in the list (`type`, `plantId`, `buildingId`, `status`, `criticality`, `q`, …). CSV uses `;` by default, `&sep=comma` for `,`.
* `GET /api/export/full?format=xlsx|json[&plantId=…]` – complete workbook or plant dossier.
* `GET /api/export/asset/<id>?format=xlsx|json` – asset dossier incl. relations, notes, activities, history.
* `GET /api/export/racks`, `/api/export/rack-contents` (filters `plantId`, `buildingId`, `rackId`) and
  `GET /api/export/rack/<id>?format=xlsx|json` – one rack with a unit-by-unit elevation sheet (for the rack door).
* `GET /api/export/attachments?format=…[&plantId|&entityType&entityId]` – list of files with download links;
  `GET /api/export/files.zip?entityType=…&entityId=…` or `?plantId=…` – the files themselves as ZIP (one folder per object).
  The full export, plant dossier and asset dossier contain an *Attachments* sheet.
* `POST /api/import/assets?dryRun=true|false` (multipart `file`, `.xlsx`/`.csv`) – columns as in the export;
  plants/buildings by code, floors and racks by name, rack unit as `12` or `12-13`; dates `YYYY-MM-DD` or `DD.MM.YYYY`.

All exports respect the user's plant scope and are written to the audit log.

## Security notes

* Server-side RBAC + plant scoping on every endpoint; field validation with zod; parameterised SQL only.
* OIDC authorization code flow with PKCE, state & nonce validation, tenant check; session fixation protection.
* CSRF token required for all state-changing API calls; strict CSP (Helmet), HSTS in production.
* Floor plans are validated by magic bytes (PNG/JPEG/WebP only) and served with a sandboxing CSP.
* CSV exports neutralise spreadsheet formulas.
* No secrets in code: PostgreSQL via managed identity; Entra client credential via managed identity (FIC) or Key Vault.

## Extending

* **New asset type** (e.g. firewall, printer, UPS): add it to `ASSET_TYPES` in `shared/model.ts` and extend the
  `type` CHECK constraint with a new migration in `server/db/migrations.ts`. Forms, tables, exports and import pick it up automatically.
* **New fields for a type**: add them to the type's `fields` – they are stored in the `attributes` JSONB column, no migration needed.

## Contributing

Issues and pull requests are welcome. Please run `npm run typecheck` and `npm test` before opening a pull
request and describe the change and its motivation. Report security problems privately (see the repository's
*Security* tab) instead of opening a public issue.

## License

[MIT](LICENSE)
