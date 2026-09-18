#!/usr/bin/env bash

# Sizes the prover publisher key range. Sourced by deploy_network.sh and calculate_publisher_indices.sh so the
# deployment and the funding calculation cannot disagree about which keys exist.
#
# Publisher keys belong to prover *nodes*, not prover agents: an agent proves and hands its result back, while the
# node is what signs and submits to L1. Only the `node` sub-chart of aztec-prover-stack reads PUBLISHERS_PER_PROVER
# and PUBLISHER_KEY_INDEX_START; `agent.replicaCount` (which KEDA autoscales) owns no keys at all. Sizing the range
# off the agent count creates keys nothing ever uses and moves the start of every index range allocated after it.
#
# The prover stack deploys one prover node per release (aztec-prover-stack's `node.replicaCount`, which the
# Terraform module does not override), so an enabled prover contributes exactly one publisher-bearing replica
# regardless of how far its agents scale.
PROVER_NODE_REPLICAS_WHEN_ENABLED=1

# Sets TOTAL_PROVER_PUBLISHERS from PROVER_ENABLED and PUBLISHERS_PER_PROVER.
calculate_total_prover_publishers() {
  local prover_node_replicas=0
  if [[ "${PROVER_ENABLED:-true}" == "true" ]]; then
    prover_node_replicas=$PROVER_NODE_REPLICAS_WHEN_ENABLED
  fi
  TOTAL_PROVER_PUBLISHERS=$((prover_node_replicas * ${PUBLISHERS_PER_PROVER:-1}))
}
