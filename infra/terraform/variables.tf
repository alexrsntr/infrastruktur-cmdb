# -----------------------------------------------------------------------------
# General
# -----------------------------------------------------------------------------

variable "subscription_id" {
  description = "Azure subscription ID. null = ARM_SUBSCRIPTION_ID environment variable or the Azure CLI default subscription."
  type        = string
  default     = null
}

variable "location" {
  description = "Azure region for all resources."
  type        = string
  default     = "germanywestcentral"
}

variable "name_prefix" {
  description = "Short lowercase prefix for resource names (3-10 letters/digits, starting with a letter)."
  type        = string
  default     = "infracmdb"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,9}$", var.name_prefix))
    error_message = "name_prefix must be 3-10 lowercase letters/digits and start with a letter."
  }
}

variable "environment" {
  description = "Environment name used in resource names and tags."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["dev", "test", "prod"], var.environment)
    error_message = "environment must be one of: dev, test, prod."
  }
}

variable "name_suffix" {
  description = "Optional fixed suffix (1-6 lowercase letters/digits) for globally unique names. null = random suffix kept in state."
  type        = string
  default     = null

  validation {
    condition     = var.name_suffix == null || can(regex("^[a-z0-9]{1,6}$", var.name_suffix))
    error_message = "name_suffix must be 1-6 lowercase letters/digits."
  }
}

variable "resource_group_name" {
  description = "Name of the resource group to create. null = rg-<name_prefix>-<environment>."
  type        = string
  default     = null
}

variable "tags" {
  description = "Additional tags for all resources."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  description = "Log Analytics retention in days."
  type        = number
  default     = 30

  validation {
    condition     = var.log_retention_days >= 30 && var.log_retention_days <= 730
    error_message = "log_retention_days must be between 30 and 730."
  }
}

# -----------------------------------------------------------------------------
# Who runs Terraform / deploys
# -----------------------------------------------------------------------------

variable "terraform_principal_object_ids" {
  description = <<-EOT
    Object IDs of ALL principals that run `terraform apply` (admin users and the GitHub Actions
    service principal). They become owners of the Entra app registration and "Key Vault Secrets
    Officer" on the Key Vault. The current caller is always added; listing everybody keeps the
    plan stable no matter who runs it.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.terraform_principal_object_ids : can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", id))])
    error_message = "terraform_principal_object_ids must contain object IDs (GUIDs)."
  }
}

variable "terraform_plan_principal_object_ids" {
  description = "Object IDs of read-only identities that only run `terraform plan` (e.g. for pull requests). They get \"Key Vault Secrets User\" so they can refresh the session secret."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.terraform_plan_principal_object_ids : can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", id))])
    error_message = "terraform_plan_principal_object_ids must contain object IDs (GUIDs)."
  }
}

variable "deployment_principal_object_id" {
  description = "Object ID of the service principal used by .github/workflows/deploy.yml. Gets \"Website Contributor\" on the web app. null = none."
  type        = string
  default     = null

  validation {
    condition     = var.deployment_principal_object_id == null || can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", coalesce(var.deployment_principal_object_id, "x")))
    error_message = "deployment_principal_object_id must be an object ID (GUID) or null."
  }
}

# -----------------------------------------------------------------------------
# App Service
# -----------------------------------------------------------------------------

variable "app_service_plan_sku" {
  description = "Linux App Service plan SKU, e.g. P0v3, P1v3, B2."
  type        = string
  default     = "P0v3"
}

variable "app_service_plan_worker_count" {
  description = "Number of instances. Sessions are stored in PostgreSQL, so scale-out is safe."
  type        = number
  default     = 1
}

variable "app_base_url" {
  description = "Public base URL without trailing slash when a custom domain is used (e.g. https://cmdb.example.com). null = https://<web app name>.azurewebsites.net. Used for APP_BASE_URL and the Entra redirect URI."
  type        = string
  default     = null

  validation {
    condition     = var.app_base_url == null || can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?$", var.app_base_url))
    error_message = "app_base_url must look like https://<host> (no path, no trailing slash)."
  }
}

variable "app_service_subnet_id" {
  description = "Optional (production): ID of a subnet delegated to Microsoft.Web/serverFarms for regional VNet integration; all outbound traffic is then routed through the VNet."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Application configuration
# -----------------------------------------------------------------------------

variable "entra_app_display_name" {
  description = "Display name of the Entra ID app registration / enterprise application."
  type        = string
  default     = "Infrastruktur CMDB"
}

variable "entra_additional_redirect_uris" {
  description = "Additional web redirect URIs, e.g. a second host name during a domain migration (https://<host>/auth/callback)."
  type        = list(string)
  default     = []
}

variable "entra_require_app_role" {
  description = "Reject sign-ins of users without one of the CMDB.* app roles (users in bootstrap_admins are always allowed)."
  type        = bool
  default     = true
}

variable "entra_grant_admin_consent" {
  description = "Grant tenant-wide admin consent for the delegated Graph permissions (openid profile email offline_access User.Read). Requires DelegatedPermissionGrant.ReadWrite.All + Application.Read.All for a service principal, or Cloud Application Administrator for a user."
  type        = bool
  default     = false
}

variable "entra_app_role_assignments" {
  description = <<-EOT
    Optional: users or (preferably) groups assigned to the app roles, by object ID, e.g.
    { "CMDB.Admin" = ["<group-object-id>"], "CMDB.Viewer" = ["<group-object-id>"] }.
    Group assignment needs Entra ID P1/P2; nested groups are not resolved. Requires
    AppRoleAssignment.ReadWrite.All for a service principal. Leave empty to assign in the portal.
  EOT
  type        = map(list(string))
  default     = {}

  validation {
    condition     = alltrue([for role in keys(var.entra_app_role_assignments) : contains(["CMDB.Admin", "CMDB.Editor", "CMDB.Operator", "CMDB.Viewer"], role)])
    error_message = "Keys must be CMDB.Admin, CMDB.Editor, CMDB.Operator or CMDB.Viewer."
  }

  validation {
    condition     = alltrue(flatten([for ids in values(var.entra_app_role_assignments) : [for id in ids : can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", id))]]))
    error_message = "entra_app_role_assignments values must be lists of object IDs (GUIDs)."
  }
}

variable "default_role" {
  description = "Role for users that sign in without an app role (only relevant if entra_require_app_role = false)."
  type        = string
  default     = "viewer"

  validation {
    condition     = contains(["viewer", "operator", "editor", "admin"], var.default_role)
    error_message = "default_role must be viewer, operator, editor or admin."
  }
}

variable "bootstrap_admins" {
  description = "UPNs that always get the admin role (bootstrap / break-glass). They still need an app role assignment, because assignment is required."
  type        = list(string)
  default     = []
}

variable "map_tile_url" {
  description = "Optional tile server (Leaflet URL template, e.g. an internal tile server or Azure Maps). Empty = built-in world map without external requests."
  type        = string
  default     = ""
}

variable "map_tile_attribution" {
  description = "Attribution HTML for the map tiles (only with map_tile_url); must match the tile provider."
  type        = string
  default     = ""
}

variable "extra_app_settings" {
  description = "Additional app settings merged last, e.g. { BRAND_PRIMARY_COLOR = \"#2563eb\", LOG_LEVEL = \"debug\" }."
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# PostgreSQL
# -----------------------------------------------------------------------------

variable "postgres_sku_name" {
  description = "PostgreSQL Flexible Server SKU: B_Standard_B1ms (Burstable), GP_Standard_D2ds_v5 (General Purpose), MO_... (Memory Optimized)."
  type        = string
  default     = "B_Standard_B1ms"

  validation {
    condition     = can(regex("^(B|GP|MO)_Standard_", var.postgres_sku_name))
    error_message = "postgres_sku_name must start with B_Standard_, GP_Standard_ or MO_Standard_."
  }
}

variable "postgres_storage_mb" {
  description = "Storage size in MB (32768 = 32 GiB). Auto-grow is enabled."
  type        = number
  default     = 32768
}

variable "postgres_backup_retention_days" {
  description = "Point-in-time-restore retention (7-35 days)."
  type        = number
  default     = 14

  validation {
    condition     = var.postgres_backup_retention_days >= 7 && var.postgres_backup_retention_days <= 35
    error_message = "postgres_backup_retention_days must be between 7 and 35."
  }
}

variable "postgres_geo_redundant_backup_enabled" {
  description = "Geo-redundant backups (forces a new server when changed)."
  type        = bool
  default     = false
}

variable "postgres_high_availability_mode" {
  description = "null (no HA), \"SameZone\" or \"ZoneRedundant\". Not available for Burstable SKUs."
  type        = string
  default     = null

  validation {
    condition     = var.postgres_high_availability_mode == null || contains(["SameZone", "ZoneRedundant"], coalesce(var.postgres_high_availability_mode, "x"))
    error_message = "postgres_high_availability_mode must be null, SameZone or ZoneRedundant."
  }
}

variable "postgres_zone" {
  description = "Availability zone (\"1\", \"2\", \"3\") or null to let Azure choose."
  type        = string
  default     = null
}

variable "postgres_entra_admin" {
  description = "Entra principal that becomes PostgreSQL administrator (recommended: a group of DBAs). name = group display name, user UPN or service principal name; it is the psql user name."
  type = object({
    object_id = string
    name      = string
    type      = optional(string, "Group")
  })

  validation {
    condition     = contains(["User", "Group", "ServicePrincipal"], var.postgres_entra_admin.type)
    error_message = "postgres_entra_admin.type must be User, Group or ServicePrincipal."
  }

  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", var.postgres_entra_admin.object_id))
    error_message = "postgres_entra_admin.object_id must be an object ID (GUID)."
  }
}

variable "postgres_allow_azure_services" {
  description = "Public access only: firewall rule 0.0.0.0 (\"Allow public access from any Azure service\"). Needed for App Service without VNet integration. Opens the network path for ALL Azure-hosted clients of any tenant; authentication remains Entra-only."
  type        = bool
  default     = true
}

variable "postgres_firewall_rules" {
  description = "Public access only: additional firewall rules, e.g. { office-hq = { start_ip_address = \"203.0.113.10\", end_ip_address = \"203.0.113.10\" } }."
  type = map(object({
    start_ip_address = string
    end_ip_address   = string
  }))
  default = {}
}

# Production recommendation: private networking instead of the public endpoint + firewall.
# Set app_service_subnet_id (VNet integration) and the two variables below. The network mode
# of a flexible server cannot be changed in place: switching later REPLACES the server
# (dump/restore the data first; the database resource has prevent_destroy).
variable "postgres_delegated_subnet_id" {
  description = "Optional (production): ID of a subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers. When set, the server uses private access (no public endpoint, firewall rules are ignored)."
  type        = string
  default     = null
}

variable "postgres_private_dns_zone_id" {
  description = "Required with postgres_delegated_subnet_id: ID of a private DNS zone ending in .postgres.database.azure.com that is linked to the VNet."
  type        = string
  default     = null
}

# -----------------------------------------------------------------------------
# Key Vault
# -----------------------------------------------------------------------------

variable "key_vault_purge_protection_enabled" {
  description = "Key Vault purge protection (recommended; cannot be disabled once enabled)."
  type        = bool
  default     = true
}

# -----------------------------------------------------------------------------
# Attachments storage
# -----------------------------------------------------------------------------

variable "storage_replication_type" {
  description = "Replication of the attachments storage account (LRS, ZRS, GRS, GZRS, RAGRS, RAGZRS)."
  type        = string
  default     = "ZRS"

  validation {
    condition     = contains(["LRS", "ZRS", "GRS", "GZRS", "RAGRS", "RAGZRS"], var.storage_replication_type)
    error_message = "storage_replication_type must be one of LRS, ZRS, GRS, GZRS, RAGRS, RAGZRS."
  }
}

variable "storage_soft_delete_days" {
  description = "Days deleted attachment files (and containers) can be restored."
  type        = number
  default     = 30

  validation {
    condition     = var.storage_soft_delete_days >= 1 && var.storage_soft_delete_days <= 365
    error_message = "storage_soft_delete_days must be between 1 and 365."
  }
}

variable "storage_public_network_access_enabled" {
  description = "Allow access to the storage account over public endpoints (secured by Entra ID RBAC). Set to false together with a private endpoint and VNet integration."
  type        = bool
  default     = true
}

variable "attachment_max_mb" {
  description = "Maximum size of one uploaded file in MB."
  type        = number
  default     = 50
}
