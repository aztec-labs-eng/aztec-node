# Aztec Labs Repository

Projects owned by [Aztec Labs](https://aztec-labs.com/) supporting the [Aztec Network](https://docs.aztec.network).

- [**`noir-projects`**](/noir-projects): Noir code for Aztec contracts and protocol circuits.
- [**`yarn-project`**](/yarn-project): Typescript code for client and backend
- [**`docs`**](/docs): Documentation source for the docs site

## Popular packages

- [Aztec.nr](./noir-projects/labs/aztec-nr/): A [Noir](https://noir-lang.org) framework for smart contracts on Aztec.
- [Aztec](./yarn-project/aztec/): A package for starting up local dev net modules, including a local 'network' devnet, an Ethereum network, deployed rollup contracts and Aztec execution environment.
- [Aztec.js](./yarn-project/aztec.js/): A tool for interacting with the Aztec network. It communicates via the [Private Execution Environment (PXE)](./yarn-project/pxe/).
- [Example contracts](./noir-projects/labs/noir-contracts/): Example contracts for the Aztec network, written in Noir.
- [End to end tests](./yarn-project/end-to-end/): Integration tests written in Typescript--a good reference for how to use the packages for specific tasks.

## Releases

The projects in this repo are released via npm ([@aztec](https://www.npmjs.com/org/aztec)) and DockerHub ([aztecprotocol/aztec](https://hub.docker.com/r/aztecprotocol/aztec)).

## Contribute

There are many ways you can participate and help build high quality software. Check out the [contribution guide](CONTRIBUTING.md)!

## Development and CI

For a broad overview of the CI system take a look at [CI.md](CI.md).

For some deeper information on individual scripts etc (for developing CI itself), take a look at [ci3/README.md](ci3/README.md).
