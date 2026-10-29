resource "google_project_service" "github_identity" {
  for_each = toset([
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])
  project            = var.project
  service            = each.key
  disable_on_destroy = false
}

resource "google_service_account" "observability_deployer" {
  account_id   = "observability-deployer"
  display_name = "Observability GitHub Actions"
  description  = "Deploys resources from aztec-labs-eng/aztec-observability"
}

resource "google_iam_workload_identity_pool_provider" "observability" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "aztec-observability"
  display_name                       = "aztec-observability repo"

  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }
  attribute_condition = join(" && ", [
    "assertion.repository_id == '1362476395'",
    "assertion.repository_owner_id == '278675722'",
    "assertion.environment == 'production'",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  depends_on = [google_project_service.github_identity]
}

resource "google_service_account_iam_member" "observability_deployer_wif" {
  service_account_id = google_service_account.observability_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/1362476395"
}

resource "google_project_iam_member" "observability_deployer_cluster_viewer" {
  project = var.project
  role    = "roles/container.clusterViewer"
  member  = "serviceAccount:${google_service_account.observability_deployer.email}"
}

resource "google_project_iam_member" "observability_deployer_irm_state" {
  project = var.project
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.observability_deployer.email}"

  condition {
    title       = "grafana-irm-terraform-state"
    description = "Access Grafana IRM state and lock objects, and list the state bucket"
    expression = join(" || ", [
      "resource.name == 'projects/_/buckets/aztec-terraform'",
      "resource.name.startsWith('projects/_/buckets/aztec-terraform/objects/grafana-irm/terraform.tfstate/')",
    ])
  }
}
