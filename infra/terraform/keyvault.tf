# Key Vault in RBAC mode. Public endpoint, because App Service without VNet integration
# and the Terraform runners reach it over the internet; with VNet integration, add a
# private endpoint and set public_network_access_enabled = false.
resource "azurerm_key_vault" "main" {
  name                          = local.names.key_vault
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  tenant_id                     = local.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  purge_protection_enabled      = var.key_vault_purge_protection_enabled
  soft_delete_retention_days    = 90
  public_network_access_enabled = true

  network_acls {
    default_action = "Allow"
    bypass         = "AzureServices"
  }

  tags = local.tags
}

# --- RBAC ----------------------------------------------------------------------

# Web app (via its UAMI) reads secrets to resolve Key Vault references.
resource "azurerm_role_assignment" "kv_secrets_user_app" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
  description          = "Infrastruktur CMDB web app: resolve Key Vault references"
}

# Terraform itself writes the secret through the data plane.
resource "azurerm_role_assignment" "kv_secrets_officer_terraform" {
  for_each             = toset(local.terraform_principal_object_ids)
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
  description          = "Terraform: manage Infrastruktur CMDB secrets"
}

# Read-only plan identities must be able to refresh the secret.
resource "azurerm_role_assignment" "kv_secrets_user_plan" {
  for_each             = toset(var.terraform_plan_principal_object_ids)
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = each.value
  description          = "Terraform plan: read Infrastruktur CMDB secrets"
}

# New data-plane role assignments take a while to become effective.
resource "time_sleep" "kv_rbac_propagation" {
  create_duration = "90s"

  triggers = {
    principals = join(",", sort(local.terraform_principal_object_ids))
  }

  depends_on = [azurerm_role_assignment.kv_secrets_officer_terraform]
}

# --- Secrets -------------------------------------------------------------------

# Rotate with: terraform apply -replace=random_password.session_secret
# (signs out all users). The value is stored in the Terraform state: protect the state.
resource "random_password" "session_secret" {
  length  = 64
  special = false
}

resource "azurerm_key_vault_secret" "session_secret" {
  name         = "session-secret"
  value        = random_password.session_secret.result
  key_vault_id = azurerm_key_vault.main.id
  content_type = "text/plain"

  depends_on = [time_sleep.kv_rbac_propagation]
}

# Key for secrets the app stores in its own settings (e.g. the SMTP password, AES-256-GCM).
# Do NOT rotate casually: stored secrets become unreadable and must be re-entered in
# Administration → Settings. The value is stored in the Terraform state: protect the state.
resource "random_password" "settings_encryption_key" {
  length  = 64
  special = false
}

resource "azurerm_key_vault_secret" "settings_encryption_key" {
  name         = "settings-encryption-key"
  value        = random_password.settings_encryption_key.result
  key_vault_id = azurerm_key_vault.main.id
  content_type = "text/plain"

  depends_on = [time_sleep.kv_rbac_propagation]
}
