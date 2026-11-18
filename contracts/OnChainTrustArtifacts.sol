// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

// Compiles the pinned, unmodified OnChainTrust vLEI bridge contracts (lib/vlei-eas-contracts, MIT) the deployer
// uses: VleiEligibility, an IEligibility slot answered by GLEIF vLEI identity, and AttesterResolver, the schema
// resolver that admits one bridge attester. Locally the kit deploys both against a test bridge wallet; on Sepolia it
// deploys VleiEligibility against the real bridge schema and attester. Nothing here is new code.
import {VleiEligibility} from "@onchaintrust/VleiEligibility.sol";
import {AttesterResolver} from "@onchaintrust/AttesterResolver.sol";
