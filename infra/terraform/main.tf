# =============================================================================
# Infrastruktur CMDB – Azure infrastructure
#
#   Web App (Linux, Node 22) ──UAMI──► Key Vault       (SESSION_SECRET via Key Vault reference)
#                            ──UAMI──► PostgreSQL 16   (Entra token = password, no DB passwords)
#                            ──UAMI──► Entra ID app    (federated credential = client assertion)
#   Logs / metrics ──► Log Analytics ◄── Application Insights
#
# Runbook: docs/AZURE.md
# =============================================================================

data "azurerm_client_config" "current" {}

data "azuread_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}

locals {
  suffix = coalesce(var.name_suffix, random_string.suffix.result)
  stem   = "${var.name_prefix}-${var.environment}"

  names = {
    resource_group = coalesce(var.resource_group_name, "rg-${local.stem}")
    identity       = "id-${local.stem}-${local.suffix}" # = PostgreSQL role name (PGUSER)
    log_analytics  = "log-${local.stem}-${local.suffix}"
    app_insights   = "appi-${local.stem}-${local.suffix}"
    key_vault      = "kv-${substr(var.name_prefix, 0, 9)}-${var.environment}-${local.suffix}" # max. 24 chars
    service_plan   = "asp-${local.stem}-${local.suffix}"
    web_app        = "app-${local.stem}-${local.suffix}"
    postgres       = "psql-${local.stem}-${local.suffix}"
  }

  tags = merge({
    application = "infrastruktur-cmdb"
    environment = var.environment
    managed-by  = "terraform"
  }, var.tags)

  tenant_id = data.azurerm_client_config.current.tenant_id

  # Known at plan time (no dependency on the web app), so the Entra app and the
  # web app settings do not depend on each other.
  base_url = coalesce(var.app_base_url, "https://${local.names.web_app}.azurewebsites.net")

  terraform_principal_object_ids = distinct(concat(var.terraform_principal_object_ids, [data.azurerm_client_config.current.object_id]))
}

resource "azurerm_resource_group" "main" {
  name     = local.names.resource_group
  location = var.location
  tags     = local.tags
}
