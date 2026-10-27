#!/usr/bin/env bash
set -euo pipefail
set +x

umask 077
private_key=$(cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$KEY_INDEX_START")
address=$(cast wallet address --private-key "$private_key")
printf '%s' "$private_key" > /oxide-identity/key
printf '%s' "$address" > /shared/prover-id
unset private_key
