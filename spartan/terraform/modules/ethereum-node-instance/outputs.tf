output "clients" {
  description = "Instance-local Services, endpoints, claims, and disks. These Services are not registered with Kong."
  value = {
    for client, release in local.release_names : client => {
      release_name = helm_release.client[client].name
      service_name = release
      http_url     = "http://${release}.${var.NAMESPACE}.svc.cluster.local:${client == "reth" ? 8545 : 5052}"
      pvc_name     = kubernetes_persistent_volume_claim_v1.storage[client].metadata[0].name
      pv_name      = kubernetes_persistent_volume_v1.storage[client].metadata[0].name
      disk         = google_compute_disk.storage[client].id
    }
  }
}
