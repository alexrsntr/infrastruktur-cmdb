resource "azurerm_service_plan" "main" {
  name                = local.names.service_plan
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  os_type             = "Linux"
  sku_name            = var.app_service_plan_sku
  worker_count        = var.app_service_plan_worker_count
  tags                = local.tags
}

locals {
  # All app settings are owned by Terraform: values changed in the portal are reverted by
  # the next apply. Use var.extra_app_settings for additional values.
  app_settings = merge({
    # Runtime / deployment (the zip from deploy.yml contains dist/ + production node_modules)
    NODE_ENV                              = "production"
    SCM_DO_BUILD_DURING_DEPLOYMENT        = "false"
    WEBSITE_RUN_FROM_PACKAGE              = "1"
    APPLICATIONINSIGHTS_CONNECTION_STRING = azurerm_application_insights.main.connection_string
    APP_BASE_URL                          = local.base_url
    SESSION_SECRET                        = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.session_secret.versionless_id})"
    SETTINGS_ENCRYPTION_KEY               = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.settings_encryption_key.versionless_id})"
    NOTIFICATIONS_SCHEDULER               = "true"

    # Authentication: Microsoft Entra ID, secretless (UAMI as federated credential)
    AUTH_MODE                  = "entra"
    ENTRA_TENANT_ID            = data.azuread_client_config.current.tenant_id
    ENTRA_CLIENT_ID            = azuread_application.cmdb.client_id
    ENTRA_USE_MANAGED_IDENTITY = "true"
    ENTRA_REQUIRE_APP_ROLE     = tostring(var.entra_require_app_role)
    DEFAULT_ROLE               = var.default_role
    BOOTSTRAP_ADMINS           = join(",", var.bootstrap_admins)

    # Database: the UAMI's Entra token is the password (refreshed by the app)
    DB_AUTH             = "entra"
    PGHOST              = azurerm_postgresql_flexible_server.main.fqdn
    PGPORT              = "5432"
    PGDATABASE          = azurerm_postgresql_flexible_server_database.cmdb.name
    PGUSER              = azurerm_user_assigned_identity.app.name
    PGSSLMODE           = "require"
    AZURE_CLIENT_ID     = azurerm_user_assigned_identity.app.client_id
    DB_MIGRATE_ON_START = "true"

    # Attachments in Blob Storage (managed identity, no keys)
    STORAGE_DRIVER            = "azure-blob"
    AZURE_STORAGE_ACCOUNT_URL = azurerm_storage_account.files.primary_blob_endpoint
    AZURE_STORAGE_CONTAINER   = azurerm_storage_container.attachments.name
    ATTACHMENT_MAX_MB         = tostring(var.attachment_max_mb)

    # UI
    MAP_TILE_URL         = var.map_tile_url
    MAP_TILE_ATTRIBUTION = var.map_tile_attribution
  }, var.extra_app_settings)
}

resource "azurerm_linux_web_app" "main" {
  name                = local.names.web_app
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  service_plan_id     = azurerm_service_plan.main.id

  https_only                      = true
  client_affinity_enabled         = false # sessions live in PostgreSQL, no sticky sessions needed
  public_network_access_enabled   = true
  key_vault_reference_identity_id = azurerm_user_assigned_identity.app.id
  virtual_network_subnet_id       = var.app_service_subnet_id

  # GitHub Actions deploys with Entra ID (OIDC); no FTP / basic-auth publishing credentials.
  ftp_publish_basic_authentication_enabled       = false
  webdeploy_publish_basic_authentication_enabled = false

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  site_config {
    always_on                         = true
    app_command_line                  = "npm start"
    ftps_state                        = "Disabled"
    health_check_path                 = "/healthz"
    health_check_eviction_time_in_min = 10
    http2_enabled                     = true
    minimum_tls_version               = "1.2"
    scm_minimum_tls_version           = "1.2"
    remote_debugging_enabled          = false
    websockets_enabled                = false
    vnet_route_all_enabled            = var.app_service_subnet_id != null

    application_stack {
      node_version = "22-lts"
    }
  }

  app_settings = local.app_settings

  # Container stdout/stderr to the file system => portal "Log stream" / az webapp log tail
  logs {
    detailed_error_messages = false
    failed_request_tracing  = false

    http_logs {
      file_system {
        retention_in_days = 7
        retention_in_mb   = 35
      }
    }
  }

  tags = local.tags

  # The identity needs its Key Vault role before the references are resolved.
  depends_on = [azurerm_role_assignment.kv_secrets_user_app]
}

resource "azurerm_role_assignment" "deploy_website_contributor" {
  count                = var.deployment_principal_object_id == null ? 0 : 1
  scope                = azurerm_linux_web_app.main.id
  role_definition_name = "Website Contributor"
  principal_id         = var.deployment_principal_object_id
  principal_type       = "ServicePrincipal"
  description          = "GitHub Actions: deploy Infrastruktur CMDB"
}

# APP_BASE_URL and the Entra redirect URI are derived from the web app NAME at plan time.
# Warn if Azure assigned a different default host name (e.g. "secure unique default hostname").
check "web_app_default_hostname" {
  assert {
    condition     = var.app_base_url != null || azurerm_linux_web_app.main.default_hostname == "${local.names.web_app}.azurewebsites.net"
    error_message = "The web app's default host name (${azurerm_linux_web_app.main.default_hostname}) differs from ${local.base_url}. Set app_base_url to https://${azurerm_linux_web_app.main.default_hostname}."
  }
}
