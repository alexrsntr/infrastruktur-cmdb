# Authentication comes from the environment:
#  - locally: `az login` (Azure CLI)
#  - GitHub Actions: OIDC via ARM_USE_OIDC=true, ARM_CLIENT_ID, ARM_TENANT_ID, ARM_SUBSCRIPTION_ID
# Both providers (and the azurerm backend) read the same ARM_* variables.

provider "azurerm" {
  subscription_id = var.subscription_id # null = ARM_SUBSCRIPTION_ID / az CLI default subscription

  # The storage account has shared keys disabled: use Entra ID for any storage data-plane call.
  storage_use_azuread = true

  # Register only what this configuration needs (no subscription-wide bulk registration).
  resource_provider_registrations = "none"
  resource_providers_to_register = [
    "Microsoft.DBforPostgreSQL",
    "Microsoft.Insights",
    "Microsoft.KeyVault",
    "Microsoft.ManagedIdentity",
    "Microsoft.OperationalInsights",
    "Microsoft.Storage",
    "Microsoft.Web",
  ]

  features {
    key_vault {
      # Purge protection is on: never try to purge, recover soft-deleted objects instead.
      purge_soft_delete_on_destroy          = false
      purge_soft_deleted_secrets_on_destroy = false
      recover_soft_deleted_key_vaults       = true
      recover_soft_deleted_secrets          = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}

provider "azuread" {}
