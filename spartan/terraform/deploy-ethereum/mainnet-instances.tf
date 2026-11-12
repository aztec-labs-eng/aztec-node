locals {
  # Deployment membership must not depend on remembering a local var file during routine applies.
  mainnet_instances = {
    blue = {
      reth_image          = "ghcr.io/paradigmxyz/reth:v2.11.0"
      lighthouse_image    = "sigp/lighthouse:v8.3.3"
      reth_p2p_port       = 32400
      lighthouse_p2p_port = 32401
      reth_storage_gib    = 3584
      source_snapshots = {
        reth       = "mainnet-live-20261111-162729-26781-reth"
        lighthouse = "mainnet-live-20261111-162729-26781-lighthouse"
      }
    }
  }

  mainnet_instance_defaults = {
    reth_storage_gib        = 3328
    lighthouse_storage_gib  = 512
    avoid_release_prefixes  = ["mainnet"]
    liveness_probes_enabled = false
  }
  mainnet_instance_configs = {
    for slot, instance in local.mainnet_instances : slot => merge(local.mainnet_instance_defaults, instance)
  }
}

module "mainnet_instances" {
  for_each = local.mainnet_instance_configs

  source = "../modules/ethereum-node-instance"

  providers = {
    google     = google
    helm       = helm.gke-cluster
    kubernetes = kubernetes.gke-cluster
  }

  PROJECT             = local.gcp_project_id
  ZONE                = "us-west1-a"
  NAMESPACE           = local.namespace
  RELEASE_PREFIX      = "mainnet-${each.key}"
  CHAIN               = "mainnet"
  CHECKPOINT_SYNC_URL = local.ethereum_chains.mainnet.checkpoint_sync_url
  STORAGE_CLASS_NAME  = local.storage_class_name
  SOURCE_SNAPSHOTS = {
    reth       = each.value.source_snapshots.reth
    lighthouse = each.value.source_snapshots.lighthouse
  }

  CLIENTS = {
    reth = {
      image       = each.value.reth_image
      storage_gib = each.value.reth_storage_gib
      p2p_port    = each.value.reth_p2p_port
      resources   = local.ethereum_chains.mainnet.reth_resources
      extra_args  = local.ethereum_chains.mainnet.reth_extra_args
    }
    lighthouse = {
      image       = each.value.lighthouse_image
      storage_gib = each.value.lighthouse_storage_gib
      p2p_port    = each.value.lighthouse_p2p_port
      resources   = local.ethereum_chains.mainnet.lighthouse_resources
      extra_args  = local.ethereum_chains.mainnet.lighthouse_extra_args
    }
  }

  AVOID_RELEASE_PREFIXES  = each.value.avoid_release_prefixes
  LIVENESS_PROBES_ENABLED = each.value.liveness_probes_enabled
  RESERVED_P2P_PORTS = concat(
    flatten([for chain in local.ethereum_chains : [chain.reth_p2p_port, chain.lighthouse_p2p_port]]),
    flatten([
      for slot, instance in local.mainnet_instance_configs : [instance.reth_p2p_port, instance.lighthouse_p2p_port]
      if slot != each.key
    ])
  )

  depends_on = [kubernetes_namespace_v1.ethereum]
}

output "mainnet_instances" {
  description = "Isolated blue/green mainnet endpoints and storage; production routes remain unchanged."
  value       = { for slot, instance in module.mainnet_instances : slot => instance.clients }
}
