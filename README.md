# Infrastruktur CMDB

**Open-source IT Configuration Management Database for sites, buildings and network/compute infrastructure.**

A web-based CMDB for documenting **plants, buildings, floors and network/compute infrastructure**
(switches, access points, servers, virtual machines), with **maps & floor plans**, **notes**,
**activities**, a complete **change history**, **role-based permissions** (local accounts or
**Microsoft Entra ID SSO**) and **exports of everything** (Excel, CSV, JSON).

Runs anywhere with **Docker**, on **Azure** with one click, or as a hardened enterprise setup on Azure with
**Terraform** (managed identities, no passwords at all).

**🇩🇪 Deutsche Anleitung: [docs/SETUP.de.md](docs/SETUP.de.md)**

---

## Installation

Pick **one** of the three ways. You do not need to know how to program for way 1 or 2.

| | Way | Good for | Sign-in | Effort |
|---|---|---|---|---|
| 1 | [**Docker**](#way-1-docker-on-your-own-computer-or-server) | trying it out, small companies, your own server | e-mail + password | ≈ 10 minutes |
| 2 | [**Azure in a few clicks**](#way-2-microsoft-azure-in-a-few-clicks) | running it in the cloud without IT knowledge | e-mail + password | ≈ 20 minutes, ≈ 30–45 €/month |
| 3 | [**Azure with Terraform**](#way-3-azure-with-terraform-for-it-teams) | companies with Microsoft 365 / Entra ID | Microsoft account (SSO) | ≈ 1–2 hours, for IT staff |

With way 1 and 2 the **first person who opens the CMDB creates the administrator account**, so open it right
after the installation. You can switch to Microsoft sign-in later.

### Way 1: Docker on your own computer or server

1. **Install Docker Desktop** from <https://www.docker.com/products/docker-desktop/> and start it
   (on a Linux server: install [Docker Engine](https://docs.docker.com/engine/install/)).
2. **Create a folder**, for example `cmdb` on your desktop.
3. **Download the file** [`docker-compose.yml`](https://raw.githubusercontent.com/alexrsntr/infrastruktur-cmdb/main/docker-compose.yml)
   (right-click the link → *Save link as…*) and save it in that folder.
4. **Open a terminal in that folder:**
   - *Windows:* open the folder in Explorer, click into the address bar, type `cmd` and press Enter.
   - *Mac:* open the *Terminal* app, type `cd ` (with a space), drag the folder into the window and press Enter.
5. **Start the CMDB** – type this and press Enter:
   ```bash
   docker compose up -d
   ```
   The first start downloads everything and takes a few minutes.
6. **Open <http://localhost:8080>** in your browser and create your administrator account. Done!

| What | How (in the terminal, in the same folder) |
|---|---|
| Stop | `docker compose down` – your data is kept |
| Start again | `docker compose up -d` |
| Update to the newest version | `docker compose pull` and then `docker compose up -d` |
| Backup | `docker compose exec db pg_dump -U cmdb cmdb > cmdb-backup.sql` |

> **Use it from other computers:** colleagues open `http://<name-of-this-computer>:8080`. Change
> `APP_BASE_URL` in `docker-compose.yml` to that address (used for links in e-mails). The connection is not
> encrypted – use this only in your company network, or put an HTTPS reverse proxy in front.

### Way 2: Microsoft Azure in a few clicks

You need an Azure subscription in which you may create resources (role *Contributor* or *Owner*). There are two
variants – pick one:

| Variant | Reachable from | Button |
|---|---|---|
| **Private network** (recommended for companies) | only your company network: web app and database get private endpoints in a virtual network you choose | [![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2Fprivate%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2Fprivate%2FcreateUiDefinition.json) |
| **Public** (simplest) | the internet (sign-in required) – for people without a company network | [![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2FcreateUiDefinition.json) |

1. Click the button of your variant and sign in.
2. **Basics:** choose your **subscription**, a **resource group** (or *Create new*, e.g. `cmdb`) and a **region**.
   Optionally enter your company name and a web address.
3. **Networking** (private variant only):
   - **Virtual network:** pick an existing one or create a new one. Only networks in the selected region are listed.
   - **Private endpoints:** pick a subnet with free addresses – it can be shared with other resources.
   - **App Service integration subnet:** Azure requires a separate, empty subnet through which the web app reaches
     the database. Leave *Create a new subnet* selected and enter a free address range inside the network, e.g.
     `10.210.156.0/28` – the deployment creates it (delegated to `Microsoft.Web/serverFarms`, with a network
     security group). Alternatively choose an existing empty, delegated subnet.
   - **Private DNS zones:** *Create new* for a network with Azure DNS; *Use existing* if your company has central
     zones (e.g. in a hub – enter the resource IDs of `privatelink.azurewebsites.net` and
     `privatelink.postgres.database.azure.com`); *None* if Azure Policy creates the DNS records.
4. Click **Review + create**, then **Create**, and wait until *Your deployment is complete* appears (about 15 minutes).
5. Click **Outputs** on the left – `cmdbUrl` is the address of your CMDB. Open it (private variant: from your
   company network) and create your administrator account. Done!

Passwords and keys are generated automatically. What you get: an App Service (Linux, B1) running the CMDB
container and an Azure Database for PostgreSQL (Burstable B1ms, daily backups for 7 days) – about 30 € per month,
plus about 15 € for the two private endpoints in the private variant. **Update** to the newest version: open the
web app (`cmdb-…`) in the Azure portal and click **Restart**. **Remove everything:** delete the resource group
(a virtual network you selected in another resource group is not touched).

### Way 3: Azure with Terraform (for IT teams)

The enterprise setup: sign-in with **Microsoft Entra ID** (single sign-on, roles from Entra groups), no
passwords anywhere (managed identities), Key Vault, Blob Storage for files, monitoring and optional private
networking. All tools are already installed in the [Azure Cloud Shell](https://shell.azure.com) (choose *Bash*).

```bash
git clone https://github.com/alexrsntr/infrastruktur-cmdb.git && cd infrastruktur-cmdb
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
az ad signed-in-user show --query "{object_id:id, upn:userPrincipalName}"   # your IDs for the next step
nano infra/terraform/terraform.tfvars
```

In `terraform.tfvars` fill in at least: `subscription_id` (`az account show --query id -o tsv`), your object ID
in `terraform_principal_object_ids`, your e-mail in `bootstrap_admins`, and `postgres_entra_admin`
(simplest: yourself – `object_id` = your object ID, `name` = your UPN, `type = "User"`). Save with *Ctrl+O*, *Enter*, *Ctrl+X*.

```bash
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform apply                                # type "yes"
eval "$(terraform -chdir=infra/terraform output -raw grant_db_access_command)"
curl -fLO https://github.com/alexrsntr/infrastruktur-cmdb/releases/latest/download/infrastruktur-cmdb-app.zip
az webapp deploy --type zip --src-path infrastruktur-cmdb-app.zip \
  -g "$(terraform -chdir=infra/terraform output -raw resource_group_name)" \
  -n "$(terraform -chdir=infra/terraform output -raw web_app_name)"
terraform -chdir=infra/terraform output -raw web_app_url              # open this address
```

Then, in the Azure portal → *Microsoft Entra ID* → *Enterprise applications* → *Infrastruktur CMDB*:
*Permissions* → **Grant admin consent**, and *Users and groups* → **Add user/group** → choose a role for your
colleagues. Remote Terraform state, GitHub
Actions (automatic deployments), groups and go-live checklist: **[docs/SETUP.md](docs/SETUP.md)** and
**[docs/AZURE.md](docs/AZURE.md)**.

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
| **Permissions** | 4 roles (Admin, Editor, Operator, Viewer), managed in the app or from **Entra ID app roles**, plus optional **plant scoping** per user (e.g. a technician only sees plant MUC) |
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

* **Sign-in** (`AUTH_MODE`): `local` = e-mail + password accounts managed by the administrators in the app
  (Docker and the Azure one-click setup); `entra` = Microsoft Entra ID single sign-on.
* With Entra ID, roles come from the **app roles** `CMDB.Admin`, `CMDB.Editor`, `CMDB.Operator`, `CMDB.Viewer`
  (assigned to users or groups in *Enterprise applications*). Users without an app role get
  `DEFAULT_ROLE` and can be managed in the app.
* Local accounts: the first visitor creates the administrator; administrators add users with an initial
  password and can reset passwords; everyone can change their own password (user menu). Passwords are
  stored as scrypt hashes, sign-in attempts are rate-limited.
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

## Development

To work on the code (not needed to run the CMDB – see [Installation](#installation)):

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
| `AUTH_MODE` | `entra` | `entra` (Microsoft sign-in) or `local` (e-mail + password) |
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
