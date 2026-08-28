#!/usr/bin/env bash

set -e

yarn build:fast

export AZTEC_GENERATE_TEST_DATA=1

yarn workspace @aztec-labs/end-to-end test integration_l1_publisher.test.ts
yarn workspace @aztec-labs/end-to-end test automine/contracts/nested -t 'performs nested calls'

# this test takes considerable resources to run since it fully proves blocks
# only enable if needed
# yarn workspace @aztec-labs/end-to-end test e2e_prover

yarn workspace @aztec-labs/stdlib test -u --max-workers 8
yarn workspace @aztec-labs/noir-protocol-circuits-types test -u --max-workers 8
yarn workspace @aztec-labs/protocol-contracts test -u --max-workers 8

# format the noir code in noir-projects (outside of yarn-project)
cd ../noir-projects
./bootstrap.sh format
cd ../yarn-project
