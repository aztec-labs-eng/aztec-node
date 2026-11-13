resource "google_compute_disk" "storage" {
  for_each = var.CLIENTS

  project  = var.PROJECT
  zone     = var.ZONE
  name     = "${var.RELEASE_PREFIX}-${each.key}"
  type     = "pd-balanced"
  size     = each.value.storage_gib
  snapshot = var.SOURCE_SNAPSHOTS == null ? null : "projects/${var.PROJECT}/global/snapshots/${var.SOURCE_SNAPSHOTS[each.key]}"
  labels = {
    eth-network = var.CHAIN
    eth-client  = each.key
    instance    = var.RELEASE_PREFIX
  }

  timeouts {
    create = "2h"
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [size]
  }
}

resource "kubernetes_persistent_volume_v1" "storage" {
  for_each = var.CLIENTS

  metadata {
    name   = "${var.RELEASE_PREFIX}-${each.key}"
    labels = local.storage_labels[each.key]
  }

  spec {
    access_modes                     = ["ReadWriteOnce"]
    capacity                         = { storage = "${each.value.storage_gib}Gi" }
    storage_class_name               = var.STORAGE_CLASS_NAME
    persistent_volume_reclaim_policy = "Retain"
    volume_mode                      = "Filesystem"

    claim_ref {
      name      = local.pvc_names[each.key]
      namespace = var.NAMESPACE
    }

    persistent_volume_source {
      csi {
        driver        = "pd.csi.storage.gke.io"
        volume_handle = google_compute_disk.storage[each.key].id
        fs_type       = "ext4"
      }
    }

    node_affinity {
      required {
        node_selector_term {
          match_expressions {
            key      = "topology.kubernetes.io/zone"
            operator = "In"
            values   = [var.ZONE]
          }
        }
      }
    }
  }

  # Updating PV capacity directly can bypass CSI filesystem expansion.
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [spec[0].capacity]
  }
}

resource "kubernetes_persistent_volume_claim_v1" "storage" {
  for_each = var.CLIENTS

  metadata {
    name      = local.pvc_names[each.key]
    namespace = var.NAMESPACE
    labels    = local.storage_labels[each.key]
  }

  spec {
    access_modes       = ["ReadWriteOnce"]
    storage_class_name = var.STORAGE_CLASS_NAME
    volume_name        = kubernetes_persistent_volume_v1.storage[each.key].metadata[0].name

    resources {
      requests = { storage = "${each.value.storage_gib}Gi" }
    }
  }

  wait_until_bound = true

  lifecycle {
    prevent_destroy = true
  }
}
