# One user-assigned managed identity for everything the app authenticates to:
#  - Key Vault references (key_vault_reference_identity_id)
#  - PostgreSQL: Entra token as password; its NAME is the PostgreSQL role (PGUSER)
#  - Entra ID sign-in: federated identity credential of the app registration (entra.tf)
resource "azurerm_user_assigned_identity" "app" {
  name                = local.names.identity
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}
