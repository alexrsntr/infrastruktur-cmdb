# =============================================================================
# Microsoft Entra ID: app registration, enterprise application, app roles and the
# federated identity credential that lets the web app's managed identity act as
# the app's client credential (ENTRA_USE_MANAGED_IDENTITY=true, no secret).
# =============================================================================

locals {
  # value => metadata. The app maps the highest role found in the ID token "roles" claim.
  app_roles = {
    "CMDB.Admin" = {
      display_name = "CMDB Administrator"
      description  = "Full access including user management and plant scoping, deletion of plants and the audit log."
    }
    "CMDB.Editor" = {
      display_name = "CMDB Editor"
      description  = "Create, change and delete infrastructure, buildings, floors and floor plans; create and change plants; import data."
    }
    "CMDB.Operator" = {
      display_name = "CMDB Operator"
      description  = "Read access plus notes, activities and asset status changes (e.g. on-site technicians)."
    }
    "CMDB.Viewer" = {
      display_name = "CMDB Viewer"
      description  = "Read-only access and exports."
    }
  }

  msgraph_client_id = "00000003-0000-0000-c000-000000000000"
  # Delegated Microsoft Graph permissions for OpenID Connect sign-in (well-known IDs)
  msgraph_delegated_scopes = {
    "openid"         = "37f7f235-527c-4136-accd-4a02d197296e"
    "profile"        = "14dad69e-099b-42c9-810b-d002981feec1"
    "email"          = "64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0"
    "offline_access" = "7427e0e9-2fba-42fe-b0c0-848c9e6a8182"
    "User.Read"      = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"
  }

  entra_app_owners = distinct(concat(var.terraform_principal_object_ids, [data.azuread_client_config.current.object_id]))

  app_role_assignments = {
    for a in flatten([
      for role, principal_ids in var.entra_app_role_assignments : [
        for principal_id in principal_ids : { role = role, principal_object_id = principal_id }
      ]
    ]) : "${a.role}/${a.principal_object_id}" => a
  }
}

# Stable app role IDs (changing an ID would orphan existing assignments).
resource "random_uuid" "app_role" {
  for_each = local.app_roles
}

resource "azuread_application" "cmdb" {
  display_name            = var.entra_app_display_name
  sign_in_audience        = "AzureADMyOrg"
  owners                  = local.entra_app_owners
  prevent_duplicate_names = true

  web {
    homepage_url = "${local.base_url}/"
    # /auth/callback = OIDC redirect URI; "/" = post-logout redirect (must be registered)
    redirect_uris = distinct(concat(
      ["${local.base_url}/auth/callback", "${local.base_url}/"],
      var.entra_additional_redirect_uris,
    ))

    implicit_grant {
      access_token_issuance_enabled = false
      id_token_issuance_enabled     = false # authorization code flow + PKCE
    }
  }

  # Assigned app roles are always emitted in the ID token "roles" claim.
  dynamic "app_role" {
    for_each = local.app_roles
    content {
      allowed_member_types = ["User"]
      value                = app_role.key
      display_name         = app_role.value.display_name
      description          = app_role.value.description
      enabled              = true
      id                   = random_uuid.app_role[app_role.key].result
    }
  }

  optional_claims {
    id_token {
      name      = "email"
      essential = false
    }
  }

  required_resource_access {
    resource_app_id = local.msgraph_client_id

    dynamic "resource_access" {
      for_each = local.msgraph_delegated_scopes
      content {
        id   = resource_access.value
        type = "Scope"
      }
    }
  }

  lifecycle {
    precondition {
      condition     = data.azuread_client_config.current.tenant_id == data.azurerm_client_config.current.tenant_id
      error_message = "The azuread provider (app registration) and the azurerm provider (managed identity) must authenticate to the same tenant."
    }
  }
}

# Enterprise application: only users/groups assigned to an app role can sign in.
resource "azuread_service_principal" "cmdb" {
  client_id                    = azuread_application.cmdb.client_id
  app_role_assignment_required = true
  owners                       = local.entra_app_owners

  feature_tags {
    enterprise = true # listed under "Enterprise applications"
  }
}

# Secretless sign-in: the web app presents a token of its UAMI (audience
# api://AzureADTokenExchange) as client assertion for this app registration.
resource "azuread_application_federated_identity_credential" "web_app_uami" {
  application_id = azuread_application.cmdb.id
  display_name   = "infrastruktur-cmdb-webapp-uami"
  description    = "Infrastruktur CMDB web app: user-assigned managed identity as client credential"
  issuer         = "https://login.microsoftonline.com/${local.tenant_id}/v2.0"
  subject        = azurerm_user_assigned_identity.app.principal_id
  audiences      = ["api://AzureADTokenExchange"]
}

# --- Optional: tenant-wide admin consent for the delegated Graph permissions -----

data "azuread_service_principal" "msgraph" {
  count     = var.entra_grant_admin_consent ? 1 : 0
  client_id = local.msgraph_client_id
}

resource "azuread_service_principal_delegated_permission_grant" "msgraph" {
  count                                = var.entra_grant_admin_consent ? 1 : 0
  service_principal_object_id          = azuread_service_principal.cmdb.object_id
  resource_service_principal_object_id = data.azuread_service_principal.msgraph[0].object_id
  claim_values                         = keys(local.msgraph_delegated_scopes)
}

# --- Optional: assign users / groups to the app roles ----------------------------

resource "azuread_app_role_assignment" "cmdb" {
  for_each            = local.app_role_assignments
  app_role_id         = azuread_service_principal.cmdb.app_role_ids[each.value.role]
  principal_object_id = each.value.principal_object_id
  resource_object_id  = azuread_service_principal.cmdb.object_id
}
