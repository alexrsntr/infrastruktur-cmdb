locals {
  postgres_private_access = var.postgres_delegated_subnet_id != null
}

# PostgreSQL Flexible Server 16 with Microsoft Entra authentication only (no passwords).
resource "azurerm_postgresql_flexible_server" "main" {
  name                = local.names.postgres
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  version             = "16"
  sku_name            = var.postgres_sku_name
  storage_mb          = var.postgres_storage_mb
  auto_grow_enabled   = true
  zone                = var.postgres_zone

  backup_retention_days        = var.postgres_backup_retention_days
  geo_redundant_backup_enabled = var.postgres_geo_redundant_backup_enabled

  # Public access + firewall (default) or private access in a delegated subnet (production).
  public_network_access_enabled = !local.postgres_private_access
  delegated_subnet_id           = var.postgres_delegated_subnet_id
  private_dns_zone_id           = var.postgres_private_dns_zone_id

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false
    tenant_id                     = local.tenant_id
  }

  maintenance_window {
    day_of_week  = 0 # Sunday
    start_hour   = 2
    start_minute = 0
  }

  dynamic "high_availability" {
    for_each = var.postgres_high_availability_mode == null ? [] : [var.postgres_high_availability_mode]
    content {
      mode = high_availability.value
    }
  }

  tags = local.tags

  lifecycle {
    # Azure picks / swaps availability zones (HA failover); do not fight it.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]

    precondition {
      condition     = var.postgres_delegated_subnet_id == null || var.postgres_private_dns_zone_id != null
      error_message = "postgres_private_dns_zone_id is required together with postgres_delegated_subnet_id."
    }
  }
}

# Server-level operations are serialised (admin -> database -> firewall rules):
# the service rejects concurrent operations on one server.
resource "azurerm_postgresql_flexible_server_active_directory_administrator" "main" {
  server_name         = azurerm_postgresql_flexible_server.main.name
  resource_group_name = azurerm_resource_group.main.name
  tenant_id           = local.tenant_id
  object_id           = var.postgres_entra_admin.object_id
  principal_name      = var.postgres_entra_admin.name
  principal_type      = var.postgres_entra_admin.type
}

resource "azurerm_postgresql_flexible_server_database" "cmdb" {
  name      = "cmdb"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"

  lifecycle {
    # Production data. Remove this guard deliberately if the environment must be torn down.
    prevent_destroy = true
  }

  depends_on = [azurerm_postgresql_flexible_server_active_directory_administrator.main]
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  count            = !local.postgres_private_access && var.postgres_allow_azure_services ? 1 : 0
  name             = "AllowAllAzureServicesAndResourcesWithinAzureIps"
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"

  depends_on = [azurerm_postgresql_flexible_server_database.cmdb]
}

resource "azurerm_postgresql_flexible_server_firewall_rule" "extra" {
  for_each         = local.postgres_private_access ? {} : var.postgres_firewall_rules
  name             = each.key
  server_id        = azurerm_postgresql_flexible_server.main.id
  start_ip_address = each.value.start_ip_address
  end_ip_address   = each.value.end_ip_address

  depends_on = [azurerm_postgresql_flexible_server_firewall_rule.azure_services]
}
