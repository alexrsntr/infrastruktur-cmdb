# Setup guide

This guide takes you from zero to a running Infrastruktur CMDB – first on your own machine to try it out,
then in production on Microsoft Azure. It says *what to do in which order*; background, automation details
and troubleshooting are in the Azure runbook **[AZURE.md](AZURE.md)**.

German version: **[SETUP.de.md](SETUP.de.md)**

> **Just want to run it?** The simplest ways – Docker in 10 minutes or Azure in a few clicks, no IT knowledge
> needed – are in the **[README › Installation](../README.md#installation)**. This guide is for developers and
> for the full enterprise rollout with Terraform and Microsoft Entra ID.

| Part | Goal | Time |
|---|---|---|
| [1. Local installation](#1-local-installation) | Try the app with demo data, develop | ≈ 10 min |
| [2. Plan the production rollout](#2-plan-the-production-rollout) | Decisions, permissions, Entra ID groups | ≈ 30 min |
| [3. Deploy to Azure](#3-deploy-to-azure) | Infrastructure with Terraform, first deployment | ≈ 1–2 h |
| [4. First configuration in the app](#4-first-configuration-in-the-app) | Plants, users, e-mail | ≈ 30 min |
| [5. Automate with GitHub Actions](#5-automate-with-github-actions) | Every push to `main` is tested and deployed | ≈ 1 h |
| [6. Go-live checklist](#6-go-live-checklist) | | |

---

## 1. Local installation

### 1.1 Prerequisites

* **Node.js 22** or newer (`node --version`)
* **PostgreSQL 14+** (16 recommended) – natively installed or via Docker
* **git**

### 1.2 Database

With Docker (simplest):

```bash
docker run -d --name cmdb-postgres -p 5432:5432 \
  -e POSTGRES_USER=cmdb -e POSTGRES_PASSWORD=cmdb -e POSTGRES_DB=cmdb postgres:16
docker exec cmdb-postgres createdb -U cmdb cmdb_test     # only needed for the test suite
```

With a native PostgreSQL installation:

```bash
createuser -P cmdb            # password: cmdb
createdb -O cmdb cmdb
createdb -O cmdb cmdb_test    # only needed for the test suite
```

### 1.3 Application

```bash
git clone https://github.com/<owner>/infrastruktur-cmdb.git
cd infrastruktur-cmdb
cp .env.example .env          # AUTH_MODE=dev → login picker with demo personas
npm install
npm run seed                  # creates the schema and loads demo data (6 fictitious plants, ~160 devices)
npm run dev                   # API on :3000, UI on http://localhost:5173
```

Open <http://localhost:5173>. In dev mode the login page offers demo personas (Admin, Editor, Operator restricted
to one plant, Viewer) so you can see how roles and plant scoping behave. Dev mode is refused as soon as
`NODE_ENV=production`.

Useful commands:

| Command | |
|---|---|
| `npm test` | API test suite against `cmdb_test` (`TEST_DATABASE_URL`, default `postgres://cmdb:cmdb@localhost:5432/cmdb_test`) |
| `npm run typecheck` | TypeScript checks for server and web |
| `npm run build && npm start` | production build (`dist/`) and server on port 3000 |
| `npm run seed -- --force` | reset demo data – **wipes all CMDB tables, never in production** |

### 1.4 Branding

Set your own look in `.env` (on Azure: Terraform variable `extra_app_settings`, see [AZURE.md](AZURE.md)):

```bash
BRAND_NAME=Example Corp       # small caption above the app name, e.g. your company
APP_NAME=IT CMDB
BRAND_PRIMARY_COLOR="#2563eb" # primary colour of buttons, links and e-mails
```

---

## 2. Plan the production rollout

The production setup runs on **Azure App Service** with **Azure Database for PostgreSQL**, **Key Vault**,
**Blob Storage** and **Application Insights**. Users sign in with **Microsoft Entra ID**. There are no passwords
or client secrets: the app uses a managed identity for the database, Key Vault, storage and its own sign-in.

### 2.1 Decide up front

| Topic | Recommendation to start | Later |
|---|---|---|
| Azure subscription | a dedicated resource group in an existing subscription (Terraform creates it) | – |
| Region | the region closest to your users, e.g. `germanywestcentral`, `westeurope`, `eastus` | – |
| Network | publicly reachable, sign-in only with an organisation account (Entra ID), database open to Azure services only | private endpoints / VNet integration (see [AZURE.md](AZURE.md)) |
| Address | `https://<name>.azurewebsites.net` | own domain, e.g. `cmdb.yourdomain.com` (CNAME + certificate) |
| Source code | a repository in your organisation's GitHub account (fork or mirror of this project) | – |
| E-mail | an internal SMTP relay (Microsoft is retiring basic-auth SMTP for Exchange Online) | – |
| Data | **start empty** – never load demo data in production; import existing lists via Excel | – |

### 2.2 Who needs which permissions

| Who | Permission | Why |
|---|---|---|
| Person running Terraform | **Owner** on the subscription (or Contributor + User Access Administrator) | create resources and role assignments |
| Same person (or an Entra admin) | Entra role **Cloud Application Administrator** | app registration, app roles, admin consent |
| Member of *SG-CMDB-PostgreSQL-Admins* | – | grant the app access to the database once |
| GitHub repository admin | Admin | only for part 5 (secrets and variables) |

### 2.3 Create Entra ID groups

The names are up to you; these are used throughout the documentation:

| Group | App role | For whom |
|---|---|---|
| SG-CMDB-Admins | CMDB.Admin | central IT team (everything, including users and settings) |
| SG-CMDB-Editors | CMDB.Editor | **local IT admins of the plants** – restricted to their plant in the app |
| SG-CMDB-Operators | CMDB.Operator | on-site technicians (notes, activities, status, files) |
| SG-CMDB-Viewers | CMDB.Viewer | read and export |
| SG-CMDB-PostgreSQL-Admins | – | database administrators |

---

## 3. Deploy to Azure

**Tools on the admin workstation:** Azure CLI, Terraform ≥ 1.6, Node.js 22, `psql`, `git`, `zip`, a Bash shell
(Linux, macOS, WSL or Git Bash).

```bash
# 1) Get the code
git clone https://github.com/<owner>/infrastruktur-cmdb.git && cd infrastruktur-cmdb

# 2) Sign in to Azure
az login --tenant <TENANT-ID>
az account set --subscription <SUBSCRIPTION-ID>
```

**3) Create the Terraform state storage (once)** – commands in [AZURE.md › 0.1](AZURE.md#01-terraform-state-storage).
Then copy `infra/terraform/backend.tf.example` to `backend.tf` and fill in the names.

**4) Fill in the values:** copy `infra/terraform/terraform.tfvars.example` to `terraform.tfvars` and adjust it:

| Value | Where to get it |
|---|---|
| `subscription_id` | `az account show --query id -o tsv` |
| `location` | your region, e.g. `germanywestcentral` |
| `name_prefix` | short prefix for all resource names (3–10 lowercase letters/digits), e.g. `cmdb` |
| `terraform_principal_object_ids` | your own object ID: `az ad signed-in-user show --query id -o tsv` |
| `bootstrap_admins` | UPN(s) of the first administrators, e.g. `firstname.lastname@yourdomain.com` |
| `postgres_entra_admin` | object ID of *SG-CMDB-PostgreSQL-Admins*: `az ad group show -g SG-CMDB-PostgreSQL-Admins --query id -o tsv` |
| `entra_require_app_role` | `true` – only users assigned to an app role can sign in |

```bash
# 5) Create the infrastructure (App Service, PostgreSQL, Key Vault, Storage, monitoring, app registration)
cd infra/terraform
terraform init
terraform plan -out tfplan
terraform apply tfplan
cd ../..

# 6) Grant the app access to its database (as a member of SG-CMDB-PostgreSQL-Admins, from the repository root)
eval "$(terraform -chdir=infra/terraform output -raw grant_db_access_command)"

# 7) Build and upload the app
scripts/deploy-local.sh "$(terraform -chdir=infra/terraform output -raw resource_group_name)" \
                        "$(terraform -chdir=infra/terraform output -raw web_app_name)"
```

**8) In the Entra admin center** → *Enterprise applications* → **Infrastruktur CMDB**
(or the name you set in `entra_app_display_name`):

- *Permissions* → **Grant admin consent** (sign-in only: `openid`, `profile`, `email`, `offline_access`, `User.Read`)
- *Users and groups* → assign the groups from [2.3](#23-create-entra-id-groups) to their app roles

**9) Sign in:** open `terraform -chdir=infra/terraform output -raw web_app_url` in the browser and sign in with
your organisation account. The `bootstrap_admins` are administrators automatically.

> **Not on Azure?** The app is a plain Node.js 22 server with PostgreSQL and runs on any host
> (`npm run build && npm start`, configuration via environment variables, `DB_AUTH=password`,
> `STORAGE_DRIVER=database`). Sign-in in production always uses Microsoft Entra ID; without a managed identity,
> set `ENTRA_CLIENT_SECRET` of an app registration with the redirect URI `https://<host>/auth/callback`.
> All variables are documented in [`.env.example`](../.env.example).

---

## 4. First configuration in the app

1. **Create plants** (*Plants → Add plant*) – or import existing lists via *Export & import*
   (download an Excel template first, fill it in, *Validate*, then *Import*).
2. **Restrict local admins to their plant:** *user menu → Users & permissions* → user → *Plant scope*.
   Users appear after their first sign-in; you can also create them beforehand with *Add user* and their e-mail.
3. **Set up e-mail:** *Settings & e-mail* → enter the SMTP relay → *Send test e-mail* → enable warranty
   reminders and enter recipients (central and per plant). Details: [NOTIFICATIONS.md](NOTIFICATIONS.md).
4. Optional: buildings, floors with floor plans, racks, data centers and site pictures.

---

## 5. Automate with GitHub Actions

So that every `git push` to `main` is tested and deployed automatically:

1. Create identities for GitHub – [AZURE.md › 0.2 and 0.4](AZURE.md#02-terraform-identity-for-github-actions)
2. Set GitHub secrets and variables – [AZURE.md › 3](AZURE.md#3-github-setup)
   (`terraform output github_variables` prints the values)
3. Set the repository variables **`TERRAFORM_ENABLED=true`** and **`AZURE_WEBAPP_NAME`** – only then do the
   *Terraform* and *Deploy* workflows run (until then they are skipped on purpose, CI runs regardless).

---

## 6. Go-live checklist

- [ ] `terraform apply` without errors, `…/healthz` and `…/readyz` return `ok`
- [ ] Sign-in with an organisation account works; users without an app role are rejected
- [ ] Bootstrap admin sees *Users & permissions* and *Settings*
- [ ] A local admin (role Editor, restricted to one plant) only sees that plant and can create a device
- [ ] File upload and download work (Azure Blob Storage)
- [ ] Test e-mail arrives; the warranty reminder *Preview* shows the expected devices
- [ ] Excel export works
- [ ] Database backup active (14 days), Application Insights shows requests

## Updating

* **With GitHub Actions:** merge to `main` – CI runs the tests, *Deploy* ships the new version. Database
  migrations run automatically on start (`DB_MIGRATE_ON_START=true`).
* **Manually:** `git pull`, then step 7 of [part 3](#3-deploy-to-azure) again.
* Infrastructure changes: adjust `terraform.tfvars`, `terraform plan`, `terraform apply`.
