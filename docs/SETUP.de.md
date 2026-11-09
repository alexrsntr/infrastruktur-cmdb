# Setup-Anleitung

English version: **[SETUP.md](SETUP.md)** · Kurzfassung auf Englisch: [README › Installation](../README.md#installation)

## Installation – so einfach wie möglich

Wähle **einen** der vier Wege. Für Weg A bis C braucht man keine IT-Kenntnisse.

| | Weg | Gut für | Anmeldung | Aufwand |
|---|---|---|---|---|
| A | [**Windows, ein Doppelklick**](#weg-a-windows--ausprobieren-mit-einem-doppelklick) | Ausprobieren auf dem eigenen PC | E-Mail + Passwort | ≈ 2 Min. |
| B | [**Docker**](#weg-b-docker-auf-dem-eigenen-rechner-oder-server) | kleine Firmen, eigener Server | E-Mail + Passwort | ≈ 10 Min. |
| C | [**Azure mit wenigen Klicks**](#weg-c-microsoft-azure-mit-wenigen-klicks) | in der Cloud betreiben, ohne IT-Kenntnisse | E-Mail + Passwort | ≈ 20 Min., ≈ 30–45 €/Monat |
| D | [**Azure mit Terraform**](#2-produktivbetrieb-planen) | Firmen mit Microsoft 365 / Entra ID | Microsoft-Konto (SSO) | ≈ 1–2 Std., für die IT |

Bei Weg A bis C legt **die erste Person, die die CMDB öffnet, das Administratorkonto an** – also direkt nach der
Installation öffnen. Die Anmeldung mit Microsoft lässt sich später direkt in der App ergänzen – siehe
[Microsoft-Anmeldung nachträglich einrichten](#microsoft-anmeldung-nachträglich-einrichten).

### Weg A: Windows – ausprobieren mit einem Doppelklick

Zum Ausprobieren auf dem eigenen Windows-PC: nichts installieren, keine Administratorrechte, kein Docker.

1. **Herunterladen:** [`Infrastruktur-CMDB-Windows.zip`](https://github.com/alexrsntr/infrastruktur-cmdb/releases/latest/download/Infrastruktur-CMDB-Windows.zip).
2. **Entpacken:** Rechtsklick auf die Datei → *Alle extrahieren …* → *Extrahieren*.
3. Im entpackten Ordner **doppelt auf `Start CMDB.cmd` klicken.** Fragt Windows, ob die Datei ausgeführt werden soll:
   *Ausführen* (bzw. *Weitere Informationen* → *Trotzdem ausführen*).
4. Nach etwa einer Minute öffnet sich der Browser mit <http://localhost:8080> – Administratorkonto anlegen. Fertig!

**Beenden:** das schwarze Fenster schließen. Die **Daten** liegen im Ordner `data` daneben (zum Sichern kopieren,
zum Neuanfang löschen). Die CMDB ist nur auf diesem Computer erreichbar – für mehrere Benutzer Weg B, C oder D.

### Weg B: Docker auf dem eigenen Rechner oder Server

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

### Weg C: Microsoft Azure mit wenigen Klicks

Voraussetzung: eine Azure-Subscription, in der man Ressourcen anlegen darf (Rolle *Mitwirkender* oder *Besitzer*).
Es gibt zwei Varianten – eine davon wählen:

| Variante | Erreichbar aus | Button |
|---|---|---|
| **Privates Netzwerk** (empfohlen für Firmen) | nur dem Firmennetz: Web-App und Datenbank bekommen Private Endpoints in einem VNet nach Wahl | [![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2Fprivate%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2Fprivate%2FcreateUiDefinition.json) |
| **Öffentlich** (am einfachsten) | dem Internet (mit Anmeldung) – für alle ohne Firmennetz | [![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2Fazuredeploy.json/createUIDefinitionUri/https%3A%2F%2Fraw.githubusercontent.com%2Falexrsntr%2Finfrastruktur-cmdb%2Fmain%2Fazure%2FcreateUiDefinition.json) |

1. Auf den Button der gewünschten Variante klicken und anmelden.
2. **Grundlagen:** **Abonnement**, **Ressourcengruppe** (oder *Neu erstellen*, z. B. `cmdb`) und **Region** wählen.
   Optional Firmenname und Web-Adresse eintragen.
3. **Networking** (nur private Variante):
   - **Virtual network:** ein bestehendes VNet auswählen oder ein neues anlegen. Es werden nur VNets der gewählten
     Region angezeigt.
   - **Private endpoints:** ein Subnetz mit freien Adressen wählen – es darf mit anderen Ressourcen geteilt sein.
   - **App Service integration subnet:** Azure verlangt dafür ein eigenes, leeres Subnetz, über das die Web-App die
     Datenbank erreicht. *Create a new subnet* ausgewählt lassen und einen freien Adressbereich im VNet eintragen,
     z. B. `10.0.1.0/28` – die Bereitstellung legt es an (delegiert an `Microsoft.Web/serverFarms`, mit
     Netzwerksicherheitsgruppe). Alternativ ein vorhandenes leeres, delegiertes Subnetz auswählen.
   - **Private DNS zones:** *Create new* bei einem VNet mit Azure-DNS; *Use existing*, wenn es zentrale Zonen gibt
     (z. B. im Hub – dann die Ressourcen-IDs von `privatelink.azurewebsites.net` und
     `privatelink.postgres.database.azure.com` eintragen); *None*, wenn eine Azure Policy die DNS-Einträge anlegt.
4. Auf **Überprüfen + erstellen**, dann auf **Erstellen** klicken und warten, bis *Ihre Bereitstellung wurde
   abgeschlossen* erscheint (ca. 15 Minuten).
5. Links auf **Ausgaben** klicken – `cmdbUrl` ist die Adresse der CMDB. Öffnen (private Variante: aus dem Firmennetz)
   und das Administratorkonto anlegen. Fertig!

Passwörter und Schlüssel werden automatisch erzeugt. Was angelegt wird: ein App Service (Linux, B1) mit dem
CMDB-Container und eine Azure Database for PostgreSQL (Burstable B1ms, tägliche Sicherung für 7 Tage) – zusammen
ca. 30 € pro Monat, bei der privaten Variante zusätzlich ca. 15 € für die zwei Private Endpoints. **Aktualisieren:**
im Azure-Portal die Web-App (`cmdb-…`) öffnen und auf **Neu starten** klicken. **Alles entfernen:** die
Ressourcengruppe löschen (ein ausgewähltes VNet in einer anderen Ressourcengruppe bleibt unberührt).

### Weg D: Azure mit Terraform

Die Unternehmensvariante mit Microsoft-Anmeldung (Single Sign-on, Rollen aus Entra-Gruppen), ohne Passwörter
(Managed Identities), mit Key Vault, Blob Storage, Monitoring und optional privatem Netzwerk – Schritt für Schritt
ab [Teil 2](#2-produktivbetrieb-planen). Die Kurzfassung mit allen Befehlen für die
[Azure Cloud Shell](https://shell.azure.com) steht im [README › Way 4](../README.md#way-4-azure-with-terraform-for-it-teams).

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
5. **Gerätetypen:** *Settings & e-mail → Device types* – nicht benötigte Typen ausblenden und eigene Felder ergänzen
   (z. B. Vertragsnummer bei Switches).
6. **Netzwerk:** auf der Werksseite, Reiter *Network* – VLANs und IP-Subnetze eintragen; die CMDB zeigt dann belegte und
   freie Adressen sowie doppelte IPs. Ports und Kabel werden auf der Geräteseite (Reiter *Ports*) gepflegt oder kommen aus
   der Discovery.
7. **Anwendungen:** *Applications → Add application* und die Server / VMs verknüpfen, auf denen sie läuft – jede Geräteseite
   zeigt dann, welche Anwendungen bei einem Ausfall betroffen sind.
8. Optional: [Auto-Discovery](#auto-discovery) und [Anbindung anderer Systeme](#andere-systeme-anbinden).

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

## Microsoft-Anmeldung nachträglich einrichten

Für Installationen, die mit E-Mail und Passwort gestartet sind (Docker, Windows-Paket, Azure mit wenigen Klicks):
Ein Administrator richtet die Anmeldung mit Microsoft Entra ID **direkt in der App** ein – ohne Umgebungsvariablen,
ohne Neustart. Die Anmeldung mit Passwort bleibt verfügbar, bis man sie einschränkt.

### A. App-Registrierung in Microsoft Entra ID (Entra Admin Center)

1. *Microsoft Entra ID → App-Registrierungen → Neue Registrierung*: Name z. B. `Infrastruktur CMDB`, *Nur Konten in
   diesem Organisationsverzeichnis*. **Verzeichnis-ID (Mandant)** und **Anwendungs-ID (Client)** notieren.
2. *Authentifizierung → Plattform hinzufügen → Web*: die beiden **Umleitungs-URIs** eintragen, die die App unter
   *Administration → Settings → Microsoft Entra ID* anzeigt (`https://<ihre-cmdb>/auth/callback` und `https://<ihre-cmdb>/`).
3. *Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel*: den **Wert** sofort kopieren (wird nur einmal
   angezeigt) und das Ablaufdatum notieren. *Alternative ohne Geheimnis:* die verwaltete Identität des App Service
   einschalten und als *Verbundanmeldeinformation* (Szenario „Verwaltete Identität“) hinzufügen.
4. *App-Rollen → App-Rolle erstellen* (zulässige Mitgliedstypen: Benutzer/Gruppen), Werte genau `CMDB.Admin`,
   `CMDB.Editor`, `CMDB.Operator`, `CMDB.Viewer`. Optional, wenn man stattdessen Entra-Gruppen in der App Rollen zuordnet.
5. *API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph*:
   - **Delegiert** (Anmeldung): `openid`, `profile`, `email`, `User.Read`
   - **Anwendung** – *optional*, nur lesend, nur für Benutzer-/Gruppensuche und Entra-Gruppenrollen:
     `User.Read.All`, `GroupMember.Read.All`, `Application.Read.All`
6. **Zustimmung (Consent):** Für die Anmeldung ist keine Administratorzustimmung nötig, wenn Benutzer in Ihrem
   Mandanten Apps zustimmen dürfen; sonst erteilt ein *Anwendungsadministrator* oder *Cloudanwendungsadministrator* die
   Zustimmung für die delegierten Berechtigungen. Die optionalen Anwendungsberechtigungen brauchen immer die Zustimmung
   eines *Administrators für privilegierte Rollen* oder *Globalen Administrators* – ohne sie kommen die CMDB-Rollen aus
   den App-Rollen (Schritt 7).
7. *Unternehmensanwendungen → Infrastruktur CMDB → Benutzer und Gruppen*: Personen oder Gruppen den App-Rollen zuweisen.
   Unter *Eigenschaften → Zuweisung erforderlich = Ja* setzen, wenn nur zugewiesene Personen hinein dürfen.

**Netzwerk:** Die CMDB braucht ausgehend HTTPS (Port 443) zu `login.microsoftonline.com` und `graph.microsoft.com`.
Läuft der gesamte ausgehende Verkehr des App Service über eine Firewall (*gesamten Datenverkehr über das VNet leiten*),
müssen dort beide Hostnamen freigegeben sein.

### B. In der CMDB (Administration → Settings → Microsoft Entra ID)

1. **Tenant-ID**, **Application (client) ID** und das **Client Secret** eintragen (oder *Managed identity* wählen),
   dann **Save**. Das Secret wird verschlüsselt gespeichert und nie wieder angezeigt.
2. **Test connection** – zeigt den Tenant-Namen und welche Graph-Berechtigungen erteilt sind; bei Fehlern steht da,
   was nicht stimmt (falsche ID, Secret abgelaufen, Zustimmung fehlt, Firewall).
3. **Test sign-in with Microsoft** – mit dem *eigenen* Microsoft-Konto anmelden. Es wird mit dem eigenen CMDB-Konto
   verknüpft und muss die Administratorrolle ergeben (keine niedrigere App-Rolle), sonst könnte man sich aussperren.
4. **Activate sign-in with Microsoft.** Die Anmeldeseite zeigt jetzt *Sign in with Microsoft*; bestehende Konten
   werden bei der ersten Anmeldung über die E-Mail-Adresse (= UPN) verknüpft – Historie und Werks-Scopes bleiben.
5. Optional unter *Users & permissions → Microsoft Entra ID*: Benutzer und Gruppen suchen, Personen vorab anlegen,
   **Entra-Gruppen CMDB-Rollen zuordnen** (mit Werks-Scope) und sehen, wer welcher App-Rolle zugewiesen ist.
6. Optional: die **Anmeldung mit Passwort** auf *Administratoren* (Notzugang) beschränken oder *abschalten* – möglich,
   sobald sich ein Administrator mit Microsoft angemeldet hat.

**Notzugang:** Fällt die Microsoft-Anmeldung aus und ist die Passwort-Anmeldung abgeschaltet, im App Service die
Einstellung `LOCAL_LOGIN_EMERGENCY=true` setzen und neu starten – Administratoren können sich dann wieder mit Passwort
anmelden. **Ablauf des Secrets:** das neue Client Secret vor Ablauf des alten im selben Formular eintragen (geht auch
im aktiven Betrieb) und danach *Test connection* ausführen.

## Auto-Discovery

Die CMDB findet Netzwerkgeräte und Server selbst und hält sie aktuell (*Administration → Discovered devices*).

**Was gelesen wird**

| Quelle | Daten |
|---|---|
| SNMP v2c / v3 (UDP 161) | Systemname, Beschreibung und Standort, Hersteller (sysObjectID – z. B. Extreme Networks, HPE, Aruba, Cisco, Fortinet, APC), Seriennummer, Modell und Firmware (ENTITY-MIB), physische Ports mit Geschwindigkeit und MAC (IF-MIB), Nachbarn (LLDP-MIB) |
| Active Directory (LDAPS 636 oder LDAP 389) | aktive Computerobjekte – standardmäßig nur Server – mit Hostname, Betriebssystem und letzter Anmeldung |

**Netzwerk-Voraussetzungen**

* Die CMDB fragt selbst ab. In Azure müssen die Werksnetze vom App Service über die VNet-Integration (Variante
  *privates Netzwerk* der Ein-Klick-Einrichtung bzw. Terraform) und VPN / ExpressRoute erreichbar sein; UDP 161 vom
  Integrations-Subnetz des App Service zu den Management-Netzen und TCP 636 zu den Domain Controllern freigeben.
* App Service kann kein ICMP (Ping) – Geräte werden ausschließlich per SNMP gefunden. Ein Gerät, das nicht auf SNMP
  antwortet (falsche Community, ACL), wird nicht gefunden.
* Eine **nur lesende** SNMP-Community oder besser einen SNMPv3-Benutzer mit *authPriv* (SHA + AES) verwenden, für LDAP
  ein Dienstkonto ohne besondere Rechte (jeder Domänenbenutzer darf Computerobjekte lesen).

**Einrichten**

1. *Discovered devices → Sources & runs → SNMP network scan*: Name, Netze (`10.10.0.0/24, 10.10.1.1-10.10.1.50`,
   max. 4096 Adressen je Quelle), Version und Zugangsdaten, Werk für neue Geräte, Intervall (z. B. alle 24 h).
2. *Jetzt ausführen* (▶) – das Ergebnis steht unter *Recent runs*.
3. *Inbox*: **Add** legt das Gerät an (Typ, Name und Ort anpassbar), **Link** verknüpft es mit einem vorhandenen Gerät,
   **Ignore** blendet es dauerhaft aus.
4. Optional: Quelle *Active Directory* mit `ldaps://dc01.example.local:636`, Suchbasis und Dienstkonto.

**Regeln**

* Abgleich: Seriennummer → MAC-Adresse → Hostname / FQDN → IP-Adresse. Das erste Merkmal, das genau ein Gerät findet,
  gewinnt (bei mehreren das im Werk der Quelle).
* Es werden nur **leere** Felder gefüllt (Seriennummer, Hersteller, Modell, MAC, FQDN, OS / Firmware, IP); von Hand
  Gepflegtes wird nie überschrieben. *Zuletzt gesehen* wird bei jedem Lauf aktualisiert.
* Fehlende Ports werden ergänzt; LLDP-Nachbarn werden zu *connected to*-Beziehungen und Kabeln zwischen den beiden
  Ports – nur wo noch nichts dokumentiert ist.
* Mehrere App-Instanzen: nur eine führt den Zeitplan aus (Datenbank-Sperre). Zugangsdaten werden verschlüsselt
  gespeichert (`SETTINGS_ENCRYPTION_KEY`).

## Andere Systeme anbinden

*Settings & e-mail → API & webhooks*:

* **API-Tokens** für Skripte, Monitoring, Ticketsystem oder Inventar-Tools – je mit eigener Rolle, Werksbeschränkung
  und Ablaufdatum. Der Token wird nur einmal angezeigt.
* **Webhooks** melden jede Änderung (Gerät angelegt, geändert, gelöscht, Monitoring-Status, Aktivitäten …) als
  signierte JSON-Anfrage an ein anderes System, mit Wiederholungen, wenn es nicht erreichbar ist.
* **Monitoring:** Zabbix, PRTG, Checkmk & Co. melden den Zustand der Geräte (`POST /api/monitoring`); die Geräteseite
  zeigt ihn an, *zuletzt gesehen* wird aktualisiert.
* **Tickets:** Tickets oder andere Referenzen mit Geräten verknüpfen (Geräteseite → *Tickets & links* oder per API).

Alles Weitere steht in [API.md](API.md) (englisch).

## QR-Etiketten und Datenqualität

* *Geräteseite → More → Print QR label* oder *Devices → Labels* für die aktuelle Liste: A4-Bögen mit 3 × 8 Etiketten
  (70 × 37 mm) oder ein Etikett je Seite für Etikettendrucker (62 × 40 mm). Der QR-Code öffnet die Geräteseite.
* *Administration → Data quality* zeigt einen Wert je Gerät und insgesamt, die Lücken je Regel und mögliche Dubletten
  (gleiche Seriennummer, MAC- oder IP-Adresse). Ein Klick auf eine Regel zeigt die betroffenen Geräte.

## Aktualisieren

* **Mit GitHub Actions:** auf `main` mergen – CI testet, *Deploy* spielt die neue Version ein. Datenbank-Migrationen
  laufen beim Start automatisch (`DB_MIGRATE_ON_START=true`).
* **Manuell:** `git pull`, danach Schritt 7 aus [Teil 3](#3-in-azure-bereitstellen) erneut ausführen.
* Infrastruktur ändern: `terraform.tfvars` anpassen, `terraform plan`, `terraform apply`.
