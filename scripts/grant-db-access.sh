#!/usr/bin/env bash
# =============================================================================
# Infrastruktur CMDB – give the web app's managed identity access to its PostgreSQL database
#
# Connects as the server's Microsoft Entra administrator (token from
# `az account get-access-token --resource-type oss-rdbms`) and
#   1. creates the PostgreSQL role for the user-assigned managed identity
#      (pgaadauth_create_principal, in database "postgres"),
#   2. grants CONNECT/CREATE/TEMP on the database and USAGE/CREATE on schema public,
#   3. makes the identity OWNER of the database and of schema public.
#
# Why ownership? The app runs its own migrations at startup (DB_MIGRATE_ON_START)
# and therefore needs DDL rights. The tables it creates are owned by the identity
# anyway, but owning the database and schema as well means future migrations never
# hit "must be owner of ..." (ALTER/COMMENT ON SCHEMA, CREATE EXTENSION, …), and a
# restore/re-creation of the schema keeps working. The identity is used by this one
# application only, so it is the natural owner. Should the server refuse the
# ownership transfer, the script warns and the grants of step 2 remain: they are
# sufficient for the current migrations.
#
# Run once after the first `terraform apply` (Terraform cannot do this: the role must be
# created by the Entra DB admin inside PostgreSQL). `terraform output grant_db_access_command`
# prints the complete command line.
#
# Idempotent: safe to re-run. Requires: Azure CLI (az login as the Entra admin or
# a member of the Entra admin group), psql (PostgreSQL 14+ client), curl.
# =============================================================================
set -euo pipefail

SERVER=""
IDENTITY=""
IDENTITY_OID=""
DATABASE="cmdb"
ADMIN_USER=""
RESOURCE_GROUP=""
ADD_CLIENT_IP=false
TRANSFER_OWNERSHIP=true

usage() {
  cat <<'EOF'
Usage: scripts/grant-db-access.sh --server <name|fqdn> --identity <uami-name> [options]

Required:
  --server NAME|FQDN          PostgreSQL flexible server name or FQDN (terraform output postgres_fqdn)
  --identity NAME             Name of the web app's user-assigned managed identity
                              (terraform output managed_identity_name); becomes the PostgreSQL
                              role name and must equal the app setting PGUSER.

Options:
  --identity-object-id GUID   Create the role by object ID (pgaadauth_create_principal_with_oid)
                              instead of by name; use when several Entra principals share the name.
                              (terraform output managed_identity_principal_id)
  --database NAME             Application database (default: cmdb)
  --admin-user NAME           Entra administrator to log in as (default: your UPN). If the
                              server's Entra admin is a GROUP, pass the group's display name.
  --resource-group RG         Resource group of the server (required with --add-client-ip)
  --add-client-ip             Temporarily allow this machine's public IP in the server
                              firewall; the rule is removed again when the script exits.
  --skip-ownership            Only grant privileges; do not transfer database/schema ownership.
  -h, --help                  Show this help

Example:
  scripts/grant-db-access.sh \
    --server psql-infracmdb-prod-abc123.postgres.database.azure.com \
    --identity id-infracmdb-prod-abc123 \
    --admin-user "SG-CMDB-PostgreSQL-Admins" \
    --resource-group rg-infracmdb-prod --add-client-ip
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "==> $*" >&2; }
warn() { echo "WARNING: $*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed."; }
value_of() { [[ $# -ge 2 && -n $2 && $2 != --* ]] || die "$1 requires a value."; printf '%s' "$2"; }

while (($#)); do
  case "$1" in
    --server) SERVER="$(value_of "$@")"; shift 2 ;;
    --identity) IDENTITY="$(value_of "$@")"; shift 2 ;;
    --identity-object-id) IDENTITY_OID="$(value_of "$@")"; shift 2 ;;
    --database) DATABASE="$(value_of "$@")"; shift 2 ;;
    --admin-user) ADMIN_USER="$(value_of "$@")"; shift 2 ;;
    --resource-group) RESOURCE_GROUP="$(value_of "$@")"; shift 2 ;;
    --add-client-ip) ADD_CLIENT_IP=true; shift ;;
    --skip-ownership) TRANSFER_OWNERSHIP=false; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "Unknown argument: $1" ;;
  esac
done

[[ -n $SERVER && -n $IDENTITY ]] || { usage >&2; die "--server and --identity are required."; }
# Managed identity names: 3-128 chars, letters, digits, '-' and '_'
[[ $IDENTITY =~ ^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$ ]] || die "Invalid identity name: $IDENTITY"
[[ $DATABASE =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "Invalid database name: $DATABASE"
if [[ -n $IDENTITY_OID && ! $IDENTITY_OID =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]]; then
  die "--identity-object-id must be a GUID."
fi
if $ADD_CLIENT_IP && [[ -z $RESOURCE_GROUP ]]; then die "--add-client-ip requires --resource-group."; fi

if [[ $SERVER == *.* ]]; then
  FQDN="$SERVER"
  SERVER_NAME="${SERVER%%.*}"
else
  SERVER_NAME="$SERVER"
  FQDN="$SERVER.postgres.database.azure.com" # public cloud; pass the FQDN for sovereign clouds
fi

need az
need psql
az account show -o none 2>/dev/null || die "Not logged in. Run 'az login' first."
if [[ -z $ADMIN_USER ]]; then
  ADMIN_USER="$(az ad signed-in-user show --query userPrincipalName -o tsv 2>/dev/null)" ||
    die "Could not determine your UPN; pass --admin-user."
fi

# --------------------------------------------------------------------------- firewall (optional)
FIREWALL_RULE=""
cleanup() {
  if [[ -n $FIREWALL_RULE ]]; then
    log "Removing temporary firewall rule $FIREWALL_RULE"
    az postgres flexible-server firewall-rule delete --resource-group "$RESOURCE_GROUP" --name "$SERVER_NAME" \
      --rule-name "$FIREWALL_RULE" --yes --only-show-errors -o none ||
      warn "Could not remove firewall rule $FIREWALL_RULE – delete it manually."
  fi
}
trap cleanup EXIT

if $ADD_CLIENT_IP; then
  need curl
  MY_IP="$(curl -fsS --max-time 10 https://api.ipify.org)" || die "Could not determine the public IP address."
  [[ $MY_IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "Unexpected public IP: $MY_IP"
  FIREWALL_RULE="tmp-grant-db-access-$(date +%Y%m%d%H%M%S)"
  log "Allowing $MY_IP on $SERVER_NAME (rule $FIREWALL_RULE)"
  az postgres flexible-server firewall-rule create --resource-group "$RESOURCE_GROUP" --name "$SERVER_NAME" \
    --rule-name "$FIREWALL_RULE" --start-ip-address "$MY_IP" --end-ip-address "$MY_IP" --only-show-errors -o none
fi

# --------------------------------------------------------------------------- connect as Entra admin
log "Requesting an Entra access token for Azure Database for PostgreSQL"
PGPASSWORD="$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)"
export PGPASSWORD PGHOST="$FQDN" PGPORT=5432 PGUSER="$ADMIN_USER" PGSSLMODE=require PGCONNECT_TIMEOUT=20
export PGAPPNAME="infrastruktur-cmdb-grant-db-access"

# psql variables :'name' (literal) and :"name" (identifier) quote the values safely.
run_sql() { # <database> [psql args...]  – SQL on stdin
  local db="$1"
  shift
  psql -X -q -v ON_ERROR_STOP=1 -v role="$IDENTITY" -v oid="$IDENTITY_OID" -v db="$DATABASE" -d "$db" "$@"
}

log "Connecting to $FQDN as '$ADMIN_USER'"
if ! run_sql postgres -tA >/dev/null <<<'SELECT 1;'; then
  die "Cannot connect. Check: the server firewall/network path (--add-client-ip), that '$ADMIN_USER' is the Entra
       administrator (for a group admin use the group name), and that 'az login' used the server's tenant."
fi

# --------------------------------------------------------------------------- 1. role for the managed identity
exists="$(run_sql postgres -tA <<<"SELECT count(*) FROM pg_roles WHERE rolname = :'role';")"
if [[ $exists == "1" ]]; then
  log "Role \"$IDENTITY\" already exists"
elif [[ -n $IDENTITY_OID ]]; then
  log "Creating role \"$IDENTITY\" for Entra object ID $IDENTITY_OID"
  run_sql postgres <<<"SELECT * FROM pgaadauth_create_principal_with_oid(:'role', :'oid', 'service', false, false);"
else
  log "Creating role \"$IDENTITY\" for the Entra principal of the same name"
  run_sql postgres <<<"SELECT * FROM pgaadauth_create_principal(:'role', false, false);"
fi

# --------------------------------------------------------------------------- 2. privileges
log "Granting privileges on database \"$DATABASE\""
run_sql "$DATABASE" <<'SQL'
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"db" TO :"role";
GRANT USAGE, CREATE ON SCHEMA public TO :"role";
SQL

# --------------------------------------------------------------------------- 3. ownership
if $TRANSFER_OWNERSHIP; then
  log "Transferring ownership of database \"$DATABASE\" and schema public to \"$IDENTITY\""
  # PostgreSQL 16 only lets you hand an object to a role you can SET ROLE to, so the
  # admin first becomes a member of the app role (also handy for maintenance: SET ROLE).
  run_sql "$DATABASE" <<<'GRANT :"role" TO CURRENT_USER;' 2>/dev/null ||
    warn "Could not grant role \"$IDENTITY\" to $ADMIN_USER (continuing)."
  if run_sql "$DATABASE" <<'SQL'
ALTER DATABASE :"db" OWNER TO :"role";
ALTER SCHEMA public OWNER TO :"role";
SQL
  then
    log "Ownership transferred"
  else
    warn "Ownership transfer was refused (see error above). The grants of step 2 are sufficient for the" \
      "current migrations; re-run later or use --skip-ownership to silence this."
  fi
fi

# --------------------------------------------------------------------------- 4. sanity checks
foreign="$(run_sql "$DATABASE" -tA <<'SQL'
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND pg_get_userbyid(c.relowner) <> :'role';
SQL
)"
if [[ $foreign != "0" ]]; then
  warn "$foreign table(s)/view(s)/sequence(s) in schema public are owned by other roles; migrations cannot" \
    "alter them. Transfer them, e.g.: ALTER TABLE <name> OWNER TO \"$IDENTITY\";"
fi

echo
run_sql "$DATABASE" <<'SQL'
\pset footer off
SELECT r.rolname                    AS app_role,
       r.rolcanlogin                AS can_login,
       current_database()           AS database,
       pg_get_userbyid(d.datdba)    AS database_owner,
       pg_get_userbyid(n.nspowner)  AS schema_public_owner,
       has_schema_privilege(r.rolname, 'public', 'CREATE') AS can_create_in_public
FROM pg_roles r
JOIN pg_database d ON d.datname = current_database()
JOIN pg_namespace n ON n.nspname = 'public'
WHERE r.rolname = :'role';
SQL

cat <<EOF

Done. The web app must use these settings (set by infra/terraform):
  DB_AUTH=entra
  PGHOST=$FQDN
  PGDATABASE=$DATABASE
  PGUSER=$IDENTITY
  PGSSLMODE=require
  AZURE_CLIENT_ID=<client ID of $IDENTITY>
EOF
