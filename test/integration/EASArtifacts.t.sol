// SPDX-License-Identifier: Apache-2.0
// The ONLY 0.8.28 file in the integration suite, and deliberately so:
// EAS 1.9.0 pins `pragma solidity 0.8.28`, so it cannot be imported by the =0.8.24 kit tests, which deploy it with
// deployCode("EAS.sol:EAS"). `forge test --match-path 'test/integration/*'` compiles sparsely: it emits artifacts
// only for matching test files and what they import, and skips the import-only contracts/EASArtifacts.sol. Without
// this file the suite fails in setUp with "vm.getCode: no matching artifact found". Importing EAS here makes the
// same compile run emit the SchemaRegistry and EAS artifacts the fixture needs.
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SchemaRegistry} from "@eas/SchemaRegistry.sol";
import {EAS} from "@eas/EAS.sol";

contract EASArtifactsTest is Test {
    /// M2 precondition: the bytecode KitFixture deploys by artifact name is the real, unmodified EAS 1.9.0 source
    /// (contract semver 1.4.0), not a stand-in.
    function test_M2_fixtureDeploysTheRealEASFromItsArtifacts() public {
        assertEq(
            keccak256(vm.getCode("SchemaRegistry.sol:SchemaRegistry")), keccak256(type(SchemaRegistry).creationCode)
        );
        assertEq(keccak256(vm.getCode("EAS.sol:EAS")), keccak256(type(EAS).creationCode));

        address registry = deployCode("SchemaRegistry.sol:SchemaRegistry");
        EAS eas = EAS(deployCode("EAS.sol:EAS", abi.encode(registry)));
        assertEq(address(eas.getSchemaRegistry()), registry);
        assertEq(eas.version(), "1.4.0");
        assertEq(SchemaRegistry(registry).version(), "1.4.0");
    }
}
