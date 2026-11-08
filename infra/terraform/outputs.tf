output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "web_app_name" {
  value = azurerm_linux_web_app.main.name
}

output "web_app_default_hostname" {
  value = azurerm_linux_web_app.main.default_hostname
}

output "web_app_url" {
  value = "https://${azurerm_linux_web_app.main.default_hostname}"
}

output "app_base_url" {
  description = "APP_BASE_URL of the app."
  value       = local.base_url
}

output "entra_tenant_id" {
  value = data.azuread_client_config.current.tenant_id
}

output "entra_client_id" {
  description = "Application (client) ID of the app registration (ENTRA_CLIENT_ID)."
  value       = azuread_application.cmdb.client_id
}

output "entra_redirect_uri" {
  value = "${local.base_url}/auth/callback"
}

output "entra_enterprise_app_object_id" {
  description = "Object ID of the enterprise application (service principal), for role assignments."
  value       = azuread_service_principal.cmdb.object_id
}

output "entra_app_role_ids" {
  value = azuread_application.cmdb.app_role_ids
}

output "managed_identity_name" {
  description = "Name of the user-assigned managed identity = PostgreSQL role name (PGUSER)."
  value       = azurerm_user_assigned_identity.app.name
}

output "managed_identity_client_id" {
  value = azurerm_user_assigned_identity.app.client_id
}

output "managed_identity_principal_id" {
  value = azurerm_user_assigned_identity.app.principal_id
}

output "postgres_server_name" {
  value = azurerm_postgresql_flexible_server.main.name
}

output "postgres_fqdn" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}

output "postgres_database_name" {
  value = azurerm_postgresql_flexible_server_database.cmdb.name
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "application_insights_name" {
  value = azurerm_application_insights.main.name
}

output "log_analytics_workspace_name" {
  value = azurerm_log_analytics_workspace.main.name
}

output "grant_db_access_command" {
  description = "Run once (as the PostgreSQL Entra admin) after the first apply."
  value = join(" ", [
    "scripts/grant-db-access.sh",
    "--server ${azurerm_postgresql_flexible_server.main.fqdn}",
    "--identity ${azurerm_user_assigned_identity.app.name}",
    "--admin-user '${var.postgres_entra_admin.name}'",
    "--resource-group ${azurerm_resource_group.main.name}",
    "--add-client-ip",
  ])
}

output "github_variables" {
  description = "Repository/environment variables for .github/workflows/deploy.yml."
  value = {
    AZURE_WEBAPP_NAME    = azurerm_linux_web_app.main.name
    AZURE_RESOURCE_GROUP = azurerm_resource_group.main.name
    AZURE_WEBAPP_URL     = local.base_url
  }
}

output "storage_account_name" {
  description = "Storage account holding the attachment files."
  value       = azurerm_storage_account.files.name
}

output "storage_blob_endpoint" {
  description = "Blob endpoint used by the app (AZURE_STORAGE_ACCOUNT_URL)."
  value       = azurerm_storage_account.files.primary_blob_endpoint
}
