# E-mail notifications

The CMDB sends a daily **warranty / support contract reminder** by e-mail. Everything is configured
in the app by an administrator under **Administration → Settings & notifications** – no redeploy needed.

## 1. E-mail server (SMTP)

| Field | Notes |
|---|---|
| SMTP server, port | e.g. an internal relay `smtp-relay.corp.local:25`, or `smtp.azurecomm.net:587` |
| Encryption | **STARTTLS** (587, upgrade required), **SSL/TLS** (465, implicit TLS) or **none** (internal relay on 25, no TLS at all) |
| Username / password | Optional – leave empty for relays that accept mail by source IP |
| Sender address / name | The `From:` of all CMDB e-mails |
| Accept self-signed certificates | Only for internal relays with an own CA; keep off otherwise |

* The settings are stored in the database table `app_setting` (key `smtp`).
* The **password is encrypted** (AES-256-GCM). The key is derived from `SETTINGS_ENCRYPTION_KEY`
  (Key Vault secret `settings-encryption-key`, created by Terraform). If that variable is empty the app
  falls back to `SESSION_SECRET` and logs a warning in production.
* The password is **never returned** by the API or shown in the UI; the audit log only records "changed".
* If the encryption key changes, the stored password can no longer be decrypted – the settings page then asks
  you to enter it again.
* **Send a test e-mail** uses the saved settings and shows the SMTP server's error message if it fails
  (connection refused, authentication failed, untrusted certificate, …).

### Which server to use

* **Internal SMTP relay** (recommended): allow the App Service outbound IPs (or the VNet subnet, with
  VNet integration) on the relay. Azure blocks outbound TCP 25 to the internet, so port 25 only works
  towards internal targets.
* **Azure Communication Services Email**: SMTP endpoint `smtp.azurecomm.net:587` (STARTTLS) with an Entra
  application as username/password.
* **Exchange Online mailbox with SMTP AUTH**: Microsoft is retiring basic authentication for SMTP AUTH client
  submission in Exchange Online. A mailbox username/password may stop working, so prefer one of the options above.

## 2. Warranty reminders

| Setting | Default | Meaning |
|---|---|---|
| On / off | off | Master switch |
| Remind … days before | 90, 30, 7 | Reminder stages |
| When the warranty has ended | notify once | Extra stage "expired" (stored as threshold `0`) |
| Send daily at / time zone | 07:00 Europe/Berlin | When the daily check runs |
| Ignore devices with status | Retired | e.g. also ignore *Planned* |
| Recipients for all plants | – | Receive every due device |
| Recipients per plant | – | Receive only the devices of that plant |

### How a device is selected

For every asset with a `warranty_end` (and a status that is not ignored):

1. `days_left = warranty_end − today` (today in the configured time zone).
2. All stages `T` with `days_left ≤ T` are *applicable* (plus `0` when expired and "notify once" is on).
3. Stages that were already sent for **this asset and this warranty end date** are removed.
4. If something is left, the device is included **once** in the e-mail and **all** remaining applicable stages
   are marked as sent.

Examples with stages 90/30/7:

* Warranty ends in 45 days → reported once (stage 90). At 30 days → reported again (stage 30), at 7 days again.
* A device is entered with 20 days left → reported once, stages 90 and 30 are both marked as sent.
* The warranty is **extended** (new `warranty_end`) → the dedupe key changes, the device is reported again
  when it reaches the stages for the new date.
* Devices already expired when the feature is switched on are reported once (if "notify once" is on).

### E-mails

* One **digest per recipient** per run (global recipients get all devices, plant recipients only theirs;
  addresses are de-duplicated case-insensitively).
* Subject e.g. `[IT CMDB] 3 warranties expiring – MUC, HAM`; HTML table with device, type, location, model,
  serial, warranty end and remaining days (red when ≤ 7 days or expired) plus a plain-text part.
* Links point to `APP_BASE_URL/assets/<id>`.
* Devices without any recipient (no global recipients and none for their plant) are **not** marked as sent, so
  they are included as soon as a recipient is configured. The preview shows them as "without recipient".

### Preview, send now, history

* **Preview** lists exactly what the next run would send and to whom.
* **Send now** runs the job immediately (marked as *manual*); devices sent now are not sent again by the schedule.
* **History** shows every run (scheduled/manual, status, devices, e-mails, error) and every sent reminder.

## 3. Reliability

* The scheduler runs inside the web app process and checks every 10 minutes. App Service **Always On** must be
  enabled (Terraform does this) so the app is not unloaded.
* The daily job runs once the local send hour has been reached and there is no successful scheduled run for
  that local date yet. Failed attempts are retried at most 3 times per day.
* **Several instances (scale-out):** a PostgreSQL advisory lock ensures only one instance checks at a time, and
  each device/stage is claimed with `INSERT … ON CONFLICT DO NOTHING` in the `notification_log` table – a device
  is never e-mailed twice even if two runs overlap.
* **Sending fails:** the whole run is rolled back (nothing is marked as sent), the run is stored with status
  *Failed* and the error message, and the devices are retried at the next attempt. If some recipients already
  received the e-mail before the failure, they may receive it again on the retry.
* Set `NOTIFICATIONS_SCHEDULER=false` to disable the scheduler in an instance (e.g. a staging slot).

## 4. API (administrators only, permission `settings.manage`)

| Method | Path | |
|---|---|---|
| GET / PUT | `/api/settings/email` | SMTP settings (`password`: omit = keep, `null` = remove, string = set) |
| POST | `/api/settings/email/test` | `{ "to": "…" }` – send a test e-mail |
| GET / PUT | `/api/settings/notifications` | Warranty reminder rules (+ last run, next run) |
| GET | `/api/notifications/warranty/preview` | Devices and recipients of the next run |
| POST | `/api/notifications/warranty/run` | Run now |
| GET | `/api/notifications/runs`, `/api/notifications/log` | History |

All changes, test e-mails and manual runs are recorded in the audit log.
