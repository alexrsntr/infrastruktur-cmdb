# -----------------------------------------------------------------------------
# Attachments (photos, plans, documents): Azure Blob Storage
#
# - No shared keys / SAS: the web app uses its user-assigned managed identity
#   (role "Storage Blob Data Contributor"); Terraform uses Entra ID as well
#   (storage_use_azuread = true in providers.tf).
# - No anonymous access, TLS 1.2+, blob versioning and soft delete as safety net
#   against accidental deletes in the CMDB.
# -----------------------------------------------------------------------------

locals {
  # 3–24 characters, lowercase letters and digits only
  storage_account_name = substr(replace(lower("st${var.name_prefix}${var.environment}${local.suffix}"), "/[^a-z0-9]/", ""), 0, 24)
}

resource "azurerm_storage_account" "files" {
  name                = local.storage_account_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = local.tags

  account_kind             = "StorageV2"
  account_tier             = "Standard"
  account_replication_type = var.storage_replication_type
  access_tier              = "Hot"

  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  shared_access_key_enabled        = false
  default_to_oauth_authentication  = true
  allow_nested_items_to_be_public  = false
  public_network_access_enabled    = var.storage_public_network_access_enabled
  cross_tenant_replication_enabled = false

  blob_properties {
    versioning_enabled = true

    delete_retention_policy {
      days = var.storage_soft_delete_days
    }

    container_delete_retention_policy {
      days = var.storage_soft_delete_days
    }
  }
}

resource "azurerm_storage_container" "attachments" {
  name                  = "attachments"
  storage_account_id    = azurerm_storage_account.files.id
  container_access_type = "private"
}

resource "azurerm_role_assignment" "blob_contributor_app" {
  scope                = azurerm_storage_account.files.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
  description          = "Infrastruktur CMDB web app: read and write attachment files"
}
