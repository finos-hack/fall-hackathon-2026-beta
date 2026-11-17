// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

// Compiles the pinned, unmodified Shibui contracts the kit deploys (Solidity 0.8.24),
// so the deployer can load their artifacts from out/. Nothing here is new code.
import {EASClaimVerifier} from "@shibui/EASClaimVerifier.sol";
import {EASTrustedIssuersAdapter} from "@shibui/EASTrustedIssuersAdapter.sol";
import {EASIdentityProxy} from "@shibui/EASIdentityProxy.sol";
import {ClaimTopicsRegistry} from "@shibui/ClaimTopicsRegistry.sol";
import {TrustedIssuerResolver} from "@shibui/resolvers/TrustedIssuerResolver.sol";
import {KYCStatusPolicy} from "@shibui/policies/KYCStatusPolicy.sol";
import {AMLPolicy} from "@shibui/policies/AMLPolicy.sol";
import {SanctionsPolicy} from "@shibui/policies/SanctionsPolicy.sol";
import {SourceOfFundsPolicy} from "@shibui/policies/SourceOfFundsPolicy.sol";
import {ProfessionalInvestorPolicy} from "@shibui/policies/ProfessionalInvestorPolicy.sol";
import {InstitutionalInvestorPolicy} from "@shibui/policies/InstitutionalInvestorPolicy.sol";
import {CountryAllowListPolicy} from "@shibui/policies/CountryAllowListPolicy.sol";
import {AccreditationPolicy} from "@shibui/policies/AccreditationPolicy.sol";
