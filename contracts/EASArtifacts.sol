// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

// Compiles the real Ethereum Attestation Service contracts (pinned 1.9.0, Solidity 0.8.28)
// so tests and the deploy script can deploy them by artifact name. Nothing here is new code.
import {SchemaRegistry} from "@eas/SchemaRegistry.sol";
import {EAS} from "@eas/EAS.sol";
