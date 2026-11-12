terraform {
  required_providers {
    google = {
      source = "hashicorp/google"
    }
    helm = {
      source = "hashicorp/helm"
    }
    kubernetes = {
      source = "hashicorp/kubernetes"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}

resource "random_bytes" "jwt" {
  length = 32
}

locals {
  release_names = { for client in keys(var.CLIENTS) : client => "${var.RELEASE_PREFIX}-${client}" }
  pvc_names     = { for client, release in local.release_names : client => "storage-${release}-0" }
  storage_labels = {
    for client, release in local.release_names : client => {
      "app.kubernetes.io/instance"   = release
      "app.kubernetes.io/name"       = client
      "app.kubernetes.io/managed-by" = "Terraform"
    }
  }
  chart_versions = {
    reth       = "0.1.9"
    lighthouse = "1.1.9"
  }
  image_parts = { for client, config in var.CLIENTS : client => split(":", config.image) }

  common_values = merge({
    replicas = 1
    jwt      = random_bytes.jwt.hex
    nodeSelector = merge(var.NODE_SELECTOR, {
      "topology.kubernetes.io/zone" = var.ZONE
    })
    affinity = {
      podAntiAffinity = {
        requiredDuringSchedulingIgnoredDuringExecution = [
          for prefix in sort(tolist(var.AVOID_RELEASE_PREFIXES)) : {
            labelSelector = {
              matchExpressions = [{
                key      = "app.kubernetes.io/instance"
                operator = "In"
                values   = ["${prefix}-reth", "${prefix}-lighthouse"]
              }]
            }
            topologyKey = "kubernetes.io/hostname"
          }
        ]
      }
    }
  }, var.LIVENESS_PROBES_ENABLED ? {} : { livenessProbe = null })

  # Snapshots contain the source node's P2P keys; use instance-specific paths.
  client_values = {
    reth = {
      extraArgs = concat([
        "--chain=${var.CHAIN}",
        "--p2p-secret-key=/data/p2p-${var.RELEASE_PREFIX}.key",
      ], var.CLIENTS.reth.extra_args)
      fileLogging = { enabled = false }
    }
    lighthouse = {
      mode = "beacon"
      checkpointSync = {
        enabled = true
        url     = var.CHECKPOINT_SYNC_URL
      }
      extraArgs = concat([
        "--network=${var.CHAIN}",
        "--network-dir=/data/network-${var.RELEASE_PREFIX}",
        "--execution-endpoint=http://${local.release_names.reth}.${var.NAMESPACE}.svc.cluster.local:8551",
        "--semi-supernode",
      ], var.CLIENTS.lighthouse.extra_args)
    }
  }

  helm_values = {
    for client, config in var.CLIENTS : client => merge(local.common_values, local.client_values[client], {
      fullnameOverride = local.release_names[client]
      image = {
        repository = join(":", slice(local.image_parts[client], 0, length(local.image_parts[client]) - 1))
        tag        = local.image_parts[client][length(local.image_parts[client]) - 1]
        pullPolicy = "IfNotPresent"
      }
      resources = config.resources
      p2pNodePort = {
        enabled = true
        port    = config.p2p_port
      }
      persistence = {
        enabled       = true
        existingClaim = kubernetes_persistent_volume_claim_v1.storage[client].metadata[0].name
      }
      service = { type = "ClusterIP" }
    })
  }
}

resource "helm_release" "client" {
  for_each = var.CLIENTS

  name             = local.release_names[each.key]
  repository       = "https://ethpandaops.github.io/ethereum-helm-charts"
  chart            = each.key
  version          = local.chart_versions[each.key]
  namespace        = var.NAMESPACE
  create_namespace = false
  upgrade_install  = false
  reuse_values     = false
  timeout          = 600
  wait             = false

  values = [yamlencode(local.helm_values[each.key])]

  lifecycle {
    precondition {
      condition     = !contains(var.RESERVED_P2P_PORTS, each.value.p2p_port)
      error_message = "${local.release_names[each.key]} must use a NodePort not allocated to another Ethereum instance."
    }
  }
}
