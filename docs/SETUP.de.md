# Setup-Anleitung

English version: **[SETUP.md](SETUP.md)** · Kurzfassung auf Englisch: [README › Installation](../README.md#installation)

## Installation – so einfach wie möglich

Wähle **einen** der drei Wege. Für Weg A und B braucht man keine IT-Kenntnisse.

| | Weg | Gut für | Anmeldung | Aufwand |
|---|---|---|---|---|
| A | [**Docker**](#weg-a-docker-auf-dem-eigenen-rechner-oder-server) | Ausprobieren, kleine Firmen, eigener Server | E-Mail + Passwort | ≈ 10 Min. |
| B | [**Azure mit wenigen Klicks**](#weg-b-microsoft-azure-mit-wenigen-klicks) | in der Cloud betreiben, ohne IT-Kenntnisse | E-Mail + Passwort | ≈ 20 Min., ≈ 30 €/Monat |
| C | [**Azure mit Terraform**](#2-produktivbetrieb-planen) | Firmen mit Microsoft 365 / Entra ID | Microsoft-Konto (SSO) | ≈ 1–2 Std., für die IT |

Bei Weg A und B legt **die erste Person, die die CMDB öffnet, das Administratorkonto an** – also direkt nach der
Installation öffnen. Auf Microsoft-Anmeldung kann man später umstellen.

### Weg A: Docker auf dem eigenen Rechner oder Server

1. **Docker Desktop installieren:** <https://www.docker.com/products/docker-desktop/> herunterladen, installieren
   und starten (auf einem Linux-Server: [Docker Engine](https://docs.docker.com/engine/install/)).
2. **Ordner anlegen**, z. B. `cmdb` auf dem Desktop.
3. **Datei herunterladen:** [`docker-compose.yml`](https://raw.githubusercontent.com/alexrsntr/infrastruktur-cmdb/main/docker-compose.yml)
   (Rechtsklick auf den Link → *Link speichern unter …*) und in diesem Ordner speichern.
4. **Eingabeaufforderung im Ordner öffnen:**
   - *Windows:* Ordner im Explorer öffnen, oben in die Adresszeile klicken, `cmd` eintippen, Enter drücken.
   - *Mac:* Programm *Terminal* öffnen, `cd ` (mit Leerzeichen) tippen, den Ordner ins Fenster ziehen, Enter drücken.
5. **CMDB starten** – das hier eintippen und Enter drücken:
   ```bash
   docker compose up -d
   ```
   Beim ersten Mal wird alles heruntergeladen, das dauert ein paar Minuten.
6. **<http://localhost:8080> im Browser öffnen** und das Administratorkonto anlegen. Fertig!

| Was | Wie (in der Eingabeaufforderung, im selben Ordner) |
|---|---|
| Stoppen | `docker compose down` – die Daten bleiben erhalten |
| Wieder starten | `docker compose up -d` |
| Auf die neueste Version aktualisieren | `docker compose pull`, danach `docker compose up -d` |
| Sicherung | `docker compose exec db pg_dump -U cmdb cmdb > cmdb-sicherung.sql` |

> **Von anderen Rechnern aus nutzen:** Kollegen öffnen `http://<name-dieses-rechners>:8080`. In
> `docker-compose.yml` dann `APP_BASE_URL` auf diese Adresse ändern (wird für Links in E-Mails verwendet). Die
> Verbindung ist unverschlüsselt – nur im Firmennetz nutzen oder einen HTTPS-Reverse-Proxy davorschalten.

### Weg B: Microsoft Azure mit wenigen Klicks

Voraussetzung: eine Azure-Subscription, in der man Ressourcen anlegen darf (Rolle *Mitwirkender* oder *Besitzer*).

1. Auf **[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2FcreateUiDefinition.json)** klicken und anmelden.
2. **Abonnement**, **Ressourcengruppe** (oder *Neu erstellen*, z. B. `cmdb`) und eine **Region** in der Nähe wählen
   (z. B. *Germany West Central* oder *West Europe*). Optional Firmenname und Web-Adresse eintragen.
   Passwörter und Schlüssel werden automatisch erzeugt – sonst gibt es nichts auszufüllen.
3. Auf **Überprüfen + erstellen**, dann auf **Erstellen** klicken.
4. Warten, bis *Ihre Bereitstellung wurde abgeschlossen* erscheint (ca. 10–15 Minuten).
5. Links auf **Ausgaben** klicken – `cmdbUrl` ist die Adresse der CMDB. Öffnen und das Administratorkonto anlegen. Fertig!

Was angelegt wird: ein App Service (Linux, B1) mit dem CMDB-Container und eine Azure Database for PostgreSQL
(Burstable B1ms, tägliche Sicherung für 7 Tage) – zusammen ca. 30 € pro Monat. **Aktualisieren:** im Azure-Portal
die Web-App (`cmdb-…`) öffnen und auf **Neu starten** klicken. **Alles entfernen:** die Ressourcengruppe löschen.

### Weg C: Azure mit Terraform

Die Unternehmensvariante mit Microsoft-Anmeldung (Single Sign-on, Rollen aus Entra-Gruppen), ohne Passwörter
(Managed Identities), mit Key Vault, Blob Storage, Monitoring und optional privatem Netzwerk – Schritt für Schritt
ab [Teil 2](#2-produktivbetrieb-planen). Die Kurzfassung mit allen Befehlen für die
[Azure Cloud Shell](https://shell.azure.com) steht im [README › Way 3](../README.md#way-3-azure-with-terraform-for-it-teams).

---

## Für IT-Teams und Entwickler

Ab hier: Entwicklung auf dem eigenen Rechner und der vollständige Produktiv-Rollout in Azure mit Terraform.
Hintergründe, Automatisierung und Fehlersuche stehen im englischen Runbook **[AZURE.md](AZURE.md)**.

| Teil | Ziel | Dauer |
|---|---|---|
| [1. Lokale Installation](#1-lokale-installation) | App mit Demodaten ausprobieren, entwickeln | ≈ 10 Min. |
| [2. Produktivbetrieb planen](#2-produktivbetrieb-planen) | Entscheidungen, Rechte, Entra-ID-Gruppen | ≈ 30 Min. |
| [3. In Azure bereitstellen](#3-in-azure-bereitstellen) | Infrastruktur per Terraform, erste Bereitstellung | ≈ 1–2 Std. |
| [4. Erste Einrichtung in der App](#4-erste-einrichtung-in-der-app) | Werke, Benutzer, E-Mail | ≈ 30 Min. |
| [5. Mit GitHub Actions automatisieren](#5-mit-github-actions-automatisieren) | Jeder Push auf `main` wird getestet und ausgerollt | ≈ 1 Std. |
| [6. Go-Live-Checkliste](#6-go-live-checkliste) | | |

---

## 1. Lokale Installation

### 1.1 Voraussetzungen

* **Node.js 22** oder neuer (`node --version`)
* **PostgreSQL 14+** (16 empfohlen) – lokal installiert oder per Docker
* **git**

### 1.2 Datenbank

Mit Docker (am einfachsten):

```bash
docker run -d --name cmdb-postgres -p 5432:5432 \
  -e POSTGRES_USER=cmdb -e POSTGRES_PASSWORD=cmdb -e POSTGRES_DB=cmdb postgres:16
docker exec cmdb-postgres createdb -U cmdb cmdb_test     # nur für die Tests
```

Mit einer lokal installierten PostgreSQL:

```bash
createuser -P cmdb            # Passwort: cmdb
createdb -O cmdb cmdb
createdb -O cmdb cmdb_test    # nur für die Tests
```

### 1.3 Anwendung

```bash
git clone https://github.com/<owner>/infrastruktur-cmdb.git
cd infrastruktur-cmdb
cp .env.example .env          # AUTH_MODE=dev → Login-Auswahl mit Demo-Personen
npm install
npm run seed                  # legt das Schema an und lädt Demodaten (6 fiktive Werke, ~160 Geräte)
npm run dev                   # API auf :3000, Oberfläche auf http://localhost:5173
```

<http://localhost:5173> öffnen. Im Dev-Modus bietet die Anmeldeseite Demo-Personen an (Admin, Editor, Operator
mit Beschränkung auf ein Werk, Viewer), damit man Rollen und Werksbeschränkung ausprobieren kann. Der Dev-Modus
wird verweigert, sobald `NODE_ENV=production` gesetzt ist.

Nützliche Befehle:

| Befehl | |
|---|---|
| `npm test` | API-Tests gegen `cmdb_test` (`TEST_DATABASE_URL`, Standard `postgres://cmdb:cmdb@localhost:5432/cmdb_test`) |
| `npm run typecheck` | TypeScript-Prüfung für Server und Oberfläche |
| `npm run build && npm start` | Produktions-Build (`dist/`) und Server auf Port 3000 |
| `npm run seed -- --force` | Demodaten zurücksetzen – **löscht alle CMDB-Tabellen, nie in Produktion** |

### 1.4 Eigenes Erscheinungsbild

In der `.env` (in Azure: Terraform-Variable `extra_app_settings`, siehe [AZURE.md](AZURE.md)):

```bash
BRAND_NAME=Beispiel GmbH      # kleine Zeile über dem App-Namen, z. B. der Firmenname
APP_NAME=IT CMDB
BRAND_PRIMARY_COLOR="#2563eb" # Hauptfarbe für Buttons, Links und E-Mails
```

---

## 2. Produktivbetrieb planen

Im Produktivbetrieb läuft die App auf **Azure App Service** mit **Azure Database for PostgreSQL**, **Key Vault**,
**Blob Storage** und **Application Insights**. Die Anmeldung erfolgt über **Microsoft Entra ID**. Es gibt keine
Passwörter und keine Client-Secrets: Für Datenbank, Key Vault, Storage und die eigene Anmeldung nutzt die App
eine Managed Identity.

### 2.1 Vorher entscheiden

| Thema | Empfehlung für den Start | Später |
|---|---|---|
| Azure-Subscription | eigene Ressourcengruppe in einer bestehenden Subscription (Terraform legt sie an) | – |
| Region | die Region nahe an den Benutzern, z. B. **Germany West Central** (`germanywestcentral`) | – |
| Netzwerk | öffentlich erreichbar, Login nur mit Firmenkonto (Entra ID), Datenbank nur für Azure-Dienste offen | Private Endpoints / VNet mit dem Netzwerk-Team (siehe [AZURE.md](AZURE.md)) |
| Adresse | `https://<name>.azurewebsites.net` | eigene Domain, z. B. `cmdb.ihre-domain.de` (CNAME + Zertifikat) |
| Code-Ablage | Repository in der GitHub-Organisation der Firma (Fork oder Spiegel dieses Projekts) | – |
| E-Mail | interner SMTP-Relay (Exchange-Online-Login per Passwort wird von Microsoft abgeschaltet) | – |
| Daten | **leer starten** – Demodaten nie in Produktion laden; vorhandene Listen per Excel-Import | – |

### 2.2 Wer braucht welche Rechte

| Wer | Recht | Wofür |
|---|---|---|
| Person, die Terraform ausführt | **Owner** auf die Subscription (oder Contributor + User Access Administrator) | Ressourcen und Rollenzuweisungen anlegen |
| dieselbe Person (oder Entra-Admin) | Entra-Rolle **Cloud Application Administrator** | App-Registrierung, Rollen, Admin-Consent |
| Mitglied der Gruppe *SG-CMDB-PostgreSQL-Admins* | – | einmalig den Datenbankzugriff der App freischalten |
| Repo-Admin auf GitHub | Admin | nur für Teil 5 (Secrets/Variablen) |

### 2.3 Entra-Gruppen anlegen

Die Namen sind frei wählbar; die Dokumentation verwendet diese:

| Gruppe | App-Rolle | Für wen |
|---|---|---|
| SG-CMDB-Admins | CMDB.Admin | zentrales IT-Team (alles, inkl. Benutzer & Einstellungen) |
| SG-CMDB-Editors | CMDB.Editor | **lokale IT-Admins der Werke** – in der App auf ihr Werk beschränkt |
| SG-CMDB-Operators | CMDB.Operator | Techniker vor Ort (Notizen, Aktivitäten, Status, Dateien) |
| SG-CMDB-Viewers | CMDB.Viewer | Lesen und Export |
| SG-CMDB-PostgreSQL-Admins | – | Datenbank-Administratoren |

---

## 3. In Azure bereitstellen

**Werkzeuge auf dem Admin-Rechner:** Azure CLI, Terraform ≥ 1.6, Node.js 22, `psql`, `git`, `zip`, eine Bash
(Linux, macOS, WSL oder Git Bash).

```bash
# 1) Code holen
git clone https://github.com/<owner>/infrastruktur-cmdb.git && cd infrastruktur-cmdb

# 2) Bei Azure anmelden
az login --tenant <TENANT-ID>
az account set --subscription <SUBSCRIPTION-ID>
```

**3) Terraform-State-Speicher anlegen (einmalig)** – Befehle in [AZURE.md › 0.1](AZURE.md#01-terraform-state-storage),
danach `infra/terraform/backend.tf.example` nach `backend.tf` kopieren und die Namen eintragen.

**4) Werte eintragen:** `infra/terraform/terraform.tfvars.example` nach `terraform.tfvars` kopieren und ausfüllen:

| Wert | Woher |
|---|---|
| `subscription_id` | `az account show --query id -o tsv` |
| `location` | eigene Region, z. B. `germanywestcentral` |
| `name_prefix` | kurzes Präfix für alle Ressourcennamen (3–10 Kleinbuchstaben/Ziffern), z. B. `cmdb` |
| `terraform_principal_object_ids` | eigene Object-ID: `az ad signed-in-user show --query id -o tsv` |
| `bootstrap_admins` | UPN(s) der ersten Administratoren, z. B. `vorname.nachname@ihre-domain.de` |
| `postgres_entra_admin` | Object-ID von *SG-CMDB-PostgreSQL-Admins*: `az ad group show -g SG-CMDB-PostgreSQL-Admins --query id -o tsv` |
| `entra_require_app_role` | `true` – nur wer einer Rolle zugewiesen ist, kommt hinein |

```bash
# 5) Infrastruktur anlegen (App Service, PostgreSQL, Key Vault, Storage, Monitoring, App-Registrierung)
cd infra/terraform
terraform init
terraform plan -out tfplan
terraform apply tfplan
cd ../..

# 6) Datenbankzugriff der App freischalten (als Mitglied von SG-CMDB-PostgreSQL-Admins, im Repo-Hauptordner)
eval "$(terraform -chdir=infra/terraform output -raw grant_db_access_command)"

# 7) App bauen und hochladen
scripts/deploy-local.sh "$(terraform -chdir=infra/terraform output -raw resource_group_name)" \
                        "$(terraform -chdir=infra/terraform output -raw web_app_name)"
```

**8) Im Entra Admin Center** → *Unternehmensanwendungen* → **Infrastruktur CMDB**
(bzw. der Name aus `entra_app_display_name`):

- *Berechtigungen* → **Administratorzustimmung erteilen** (nur Anmeldung: `openid`, `profile`, `email`, `offline_access`, `User.Read`)
- *Benutzer und Gruppen* → die Gruppen aus [2.3](#23-entra-gruppen-anlegen) den Rollen zuweisen

**9) Anmelden:** `terraform -chdir=infra/terraform output -raw web_app_url` im Browser öffnen und mit dem
Firmenkonto anmelden. Die `bootstrap_admins` sind automatisch Administrator.

> **Kein Azure?** Die App ist ein normaler Node.js-22-Server mit PostgreSQL und läuft auf jedem Host
> (`npm run build && npm start`, Konfiguration über Umgebungsvariablen, `DB_AUTH=password`,
> `STORAGE_DRIVER=database`). Die Anmeldung im Produktivbetrieb erfolgt immer über Microsoft Entra ID; ohne
> Managed Identity wird `ENTRA_CLIENT_SECRET` einer App-Registrierung mit der Redirect-URI
> `https://<host>/auth/callback` gesetzt. Alle Variablen sind in [`.env.example`](../.env.example) beschrieben.

---

## 4. Erste Einrichtung in der App

1. **Werke anlegen** (*Plants → Add plant*) – oder vorhandene Listen über *Export & import* einlesen
   (zuerst eine Excel-Vorlage herunterladen, ausfüllen, *Validate*, dann *Import*).
2. **Lokale Admins auf ihr Werk beschränken:** *Benutzermenü → Users & permissions* → Benutzer → *Plant scope*.
   Benutzer erscheinen nach ihrer ersten Anmeldung; vorher per *Add user* mit E-Mail anlegbar.
3. **E-Mail einrichten:** *Settings & e-mail* → SMTP-Relay eintragen → *Send test e-mail* → Garantie-Erinnerungen
   aktivieren und Empfänger (zentral + je Werk) eintragen. Details: [NOTIFICATIONS.md](NOTIFICATIONS.md).
4. Optional: Gebäude, Etagen mit Grundriss, Racks, Rechenzentren und Werksbilder anlegen.

---

## 5. Mit GitHub Actions automatisieren

Damit jedes `git push` auf `main` automatisch getestet und ausgerollt wird:

1. Identitäten für GitHub anlegen – [AZURE.md › 0.2 und 0.4](AZURE.md#02-terraform-identity-for-github-actions)
2. GitHub-Secrets/-Variablen setzen – [AZURE.md › 3](AZURE.md#3-github-setup)
   (`terraform output github_variables` liefert die Werte)
3. Repository-Variablen **`TERRAFORM_ENABLED=true`** und **`AZURE_WEBAPP_NAME`** setzen – erst dann laufen
   die Workflows *Terraform* und *Deploy* (vorher werden sie absichtlich übersprungen, CI läuft immer).

---

## 6. Go-Live-Checkliste

- [ ] `terraform apply` ohne Fehler, `…/healthz` und `…/readyz` liefern `ok`
- [ ] Anmeldung mit Firmenkonto funktioniert; Benutzer ohne Rolle werden abgewiesen
- [ ] Bootstrap-Admin sieht *Users & permissions* und *Settings*
- [ ] Ein lokaler Admin (Rolle Editor, auf sein Werk beschränkt) sieht nur sein Werk und kann ein Gerät anlegen
- [ ] Datei-Upload und -Download funktionieren (Azure Blob Storage)
- [ ] Test-E-Mail kommt an; Garantie-Erinnerung *Preview* zeigt die erwarteten Geräte
- [ ] Export (Excel) funktioniert
- [ ] Datenbank-Backup aktiv (14 Tage), Application Insights zeigt Requests

## Aktualisieren

* **Mit GitHub Actions:** auf `main` mergen – CI testet, *Deploy* spielt die neue Version ein. Datenbank-Migrationen
  laufen beim Start automatisch (`DB_MIGRATE_ON_START=true`).
* **Manuell:** `git pull`, danach Schritt 7 aus [Teil 3](#3-in-azure-bereitstellen) erneut ausführen.
* Infrastruktur ändern: `terraform.tfvars` anpassen, `terraform plan`, `terraform apply`.
