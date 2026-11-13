variable "PROJECT" {
  description = "GCP project containing the disks and source snapshots."
  type        = string
}

variable "ZONE" {
  description = "GCP zone for both restored disks and their pods."
  type        = string
}

variable "NAMESPACE" {
  description = "Existing Kubernetes namespace for the node pair."
  type        = string
}

variable "RELEASE_PREFIX" {
  description = "Unique instance name used for Helm releases, disks, PVs, and PVCs."
  type        = string

  validation {
    condition     = can(regex("^[a-z]([-a-z0-9]{0,42}[a-z0-9])?$", var.RELEASE_PREFIX))
    error_message = "RELEASE_PREFIX must be a lowercase RFC1035 name of at most 44 characters."
  }
}

variable "CHAIN" {
  description = "Ethereum chain, independent of the instance name."
  type        = string

  validation {
    condition     = contains(["mainnet", "sepolia"], var.CHAIN)
    error_message = "CHAIN must be mainnet or sepolia."
  }
}

variable "CHECKPOINT_SYNC_URL" {
  description = "Lighthouse checkpoint URL, used if starting without a beacon database."
  type        = string
}

variable "CLIENTS" {
  description = "Images, disk sizes in GiB, NodePorts, resources, and additional arguments for each client."
  type = object({
    reth = object({
      image       = string
      storage_gib = number
      p2p_port    = number
      resources = object({
        requests = map(string)
        limits   = map(string)
      })
      extra_args = optional(list(string), [])
    })
    lighthouse = object({
      image       = string
      storage_gib = number
      p2p_port    = number
      resources = object({
        requests = map(string)
        limits   = map(string)
      })
      extra_args = optional(list(string), [])
    })
  })

  validation {
    condition = alltrue([
      for client in var.CLIENTS :
      client.storage_gib > 0 && client.storage_gib == floor(client.storage_gib) &&
      client.p2p_port >= 30000 && client.p2p_port <= 32767 && client.p2p_port == floor(client.p2p_port)
    ]) && var.CLIENTS.reth.p2p_port != var.CLIENTS.lighthouse.p2p_port
    error_message = "Disk sizes must be positive integers, and the two NodePorts must be distinct integers between 30000 and 32767."
  }
}

variable "SOURCE_SNAPSHOTS" {
  description = "Optional pair of GCP snapshot names in PROJECT. Null creates empty disks. Keep these creation-time inputs unchanged after restoring."
  type = object({
    reth       = string
    lighthouse = string
  })
  default = null
}

variable "STORAGE_CLASS_NAME" {
  description = "Storage class recorded on the statically bound pd-balanced volumes and claims."
  type        = string
  default     = "standard-rwo"
}

variable "NODE_SELECTOR" {
  description = "Node labels required by both clients, in addition to the disk zone."
  type        = map(string)
  default     = { node-type = "infra" }
}

variable "AVOID_RELEASE_PREFIXES" {
  description = "Keep this instance off nodes hosting Reth or Lighthouse releases with these prefixes."
  type        = set(string)
  default     = []
}

variable "RESERVED_P2P_PORTS" {
  description = "NodePorts already allocated to other Ethereum instances."
  type        = set(number)
  default     = []
}

variable "LIVENESS_PROBES_ENABLED" {
  description = "Enable chart liveness probes after recovery and migration have been verified. Readiness probes remain enabled."
  type        = bool
  default     = false
}
