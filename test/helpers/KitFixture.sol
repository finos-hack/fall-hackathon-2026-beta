// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.24;

import {Test} from "forge-std/Test.sol";

import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData
} from "@eas/IEAS.sol";
import {ISchemaRegistry} from "@eas/ISchemaRegistry.sol";
import {ISchemaResolver} from "@eas/resolver/ISchemaResolver.sol";

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

import {RegulatedToken} from "../../contracts/RegulatedToken.sol";
import {ShibuiEligibility} from "../../contracts/ShibuiEligibility.sol";
import {IEligibility} from "../../contracts/interfaces/IEligibility.sol";

/// @title KitFixture
/// @notice Milestone M2 fixture: the whole kit deployed against the REAL Ethereum Attestation Service
///         (SchemaRegistry + EAS 1.9.0, deployed from their own 0.8.28 artifacts) and the REAL, unmodified
///         EEA Shibui contracts. Nothing here is mocked.
/// @dev Wiring follows the build plan's "Kit wiring" section (decision D1):
///      shared  SchemaRegistry, EAS, TrustedIssuerResolver(operator is the only authorizer), both schemas,
///              EASIdentityProxy, and the setting-less KYC/AML/SANCTIONS/SOURCE_OF_FUNDS/PROFESSIONAL/
///              INSTITUTIONAL policies;
///      per token ClaimTopicsRegistry, EASTrustedIssuersAdapter, EASClaimVerifier, CountryAllowListPolicy
///              (if COUNTRY), AccreditationPolicy (if ACCREDITATION), ShibuiEligibility, RegulatedToken.
///      setUp() then runs W1 (authorize KYC provider A on every token) and W2 (onboard the demo cast).
///      The cast is fictional. No private keys are used anywhere: actors are makeAddr() addresses.
abstract contract KitFixture is Test {
    // ============ Shibui claim topics ============

    uint256 internal constant KYC = 1;
    uint256 internal constant AML = 2;
    uint256 internal constant COUNTRY = 3;
    uint256 internal constant ACCREDITATION = 7;
    uint256 internal constant PROFESSIONAL = 9;
    uint256 internal constant INSTITUTIONAL = 10;
    uint256 internal constant SANCTIONS = 13;
    uint256 internal constant SOURCE_OF_FUNDS = 14;

    // ============ Investor Eligibility payload values (Shibui TopicPolicyBase) ============

    uint8 internal constant KYC_VERIFIED = 1;
    uint8 internal constant KYC_REVOKED = 3;
    uint8 internal constant AML_CLEAR = 0;
    uint8 internal constant SANCTIONS_CLEAR = 0;
    uint8 internal constant SANCTIONS_HIT = 1;
    uint8 internal constant SOF_VERIFIED = 1;
    uint8 internal constant ACC_NONE = 0;
    uint8 internal constant ACC_RETAIL_QUALIFIED = 1;
    uint8 internal constant ACC_ACCREDITED = 2;
    uint8 internal constant ACC_QUALIFIED_PURCHASER = 3;
    uint8 internal constant ACC_INSTITUTIONAL = 4;
    uint8 internal constant METHOD_THIRD_PARTY = 2;

    // ISO 3166-1 numeric
    uint16 internal constant US = 840;
    uint16 internal constant GB = 826;
    uint16 internal constant FR = 250;
    uint16 internal constant CN = 156;

    // ============ Schemas ============

    string internal constant INVESTOR_ELIGIBILITY_SCHEMA =
        "address identity,uint8 kycStatus,uint8 amlStatus,uint8 sanctionsStatus,uint8 sourceOfFundsStatus,uint8 accreditationType,uint16 countryCode,uint64 expirationTimestamp,bytes32 evidenceHash,uint8 verificationMethod";
    string internal constant ISSUER_AUTH_SCHEMA = "address issuerAddress,uint256[] authorizedTopics,string issuerName";

    // ============ Templates ============

    uint256 internal constant DEPOSIT = 0; // tokenized-deposit   dDEP  KYC + SANCTIONS
    uint256 internal constant FUND = 1; //    money-market-fund   dMMF  KYC + AML + COUNTRY [840, 826, 250]
    uint256 internal constant NOTE = 2; //    private-credit-note dPCN  KYC + ACCREDITATION + COUNTRY, accreditation [2, 3, 4]
    uint256 internal constant KIT_COUNT = 3;

    uint256 internal constant UNIT = 1e6; // every template uses 6 decimals

    /// @notice Everything deployed for one token (D1: one verifier / topics registry / adapter per token).
    struct Kit {
        string templateId;
        RegulatedToken token;
        ShibuiEligibility eligibility;
        EASClaimVerifier verifier;
        ClaimTopicsRegistry topicsRegistry;
        EASTrustedIssuersAdapter adapter;
        CountryAllowListPolicy countryPolicy; // zero when the template has no COUNTRY topic
        AccreditationPolicy accreditationPolicy; // zero when the template has no ACCREDITATION topic
        uint256[] topics;
    }

    /// @notice An Investor Eligibility credential as a KYC provider would issue it.
    struct Credential {
        uint8 kycStatus;
        uint8 amlStatus;
        uint8 sanctionsStatus;
        uint8 sourceOfFundsStatus;
        uint8 accreditationType;
        uint16 countryCode;
        uint64 expirationTimestamp; // payload-level expiry, checked by the Shibui topic policies (0 = never)
        bytes32 evidenceHash;
        uint8 verificationMethod;
        uint64 easExpirationTime; // EAS-level expiry, checked by EASClaimVerifier itself (0 = never)
    }

    // ============ Actors (fictional) ============

    address internal operator = makeAddr("operator");
    address internal issuer = makeAddr("issuer");
    address internal compliance = makeAddr("compliance officer");
    address internal providerA = makeAddr("kyc-provider-a");
    address internal providerB = makeAddr("kyc-provider-b");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    // ============ Shared deployment ============

    ISchemaRegistry internal schemaRegistry;
    IEAS internal eas;
    TrustedIssuerResolver internal resolver;
    EASIdentityProxy internal identityProxy;
    bytes32 internal investorEligibilitySchema;
    bytes32 internal issuerAuthSchema;

    KYCStatusPolicy internal kycPolicy;
    AMLPolicy internal amlPolicy;
    SanctionsPolicy internal sanctionsPolicy;
    SourceOfFundsPolicy internal sourceOfFundsPolicy;
    ProfessionalInvestorPolicy internal professionalPolicy;
    InstitutionalInvestorPolicy internal institutionalPolicy;

    Kit[3] internal kits;

    // ============ Demo state created by setUp ============

    bytes32 internal providerAAuth;
    bytes32 internal aliceCredential;
    bytes32 internal bobCredential;
    bytes32 internal daveCredential;

    /// @dev Every wallet I9 checks after each state change. Tests add their own extras with track().
    address[] internal trackedWallets;

    function setUp() public virtual {
        vm.warp(1_790_000_000); // a fixed, realistic clock so expiry arithmetic reads naturally
        _deployShared();
        _deployKit(DEPOSIT, "tokenized-deposit", "Demo Tokenized Deposit", "dDEP", _list(KYC, SANCTIONS), _u16(), _u8());
        _deployKit(
            FUND,
            "money-market-fund",
            "Demo Money Market Fund",
            "dMMF",
            _list(KYC, AML, COUNTRY),
            _u16(US, GB, FR),
            _u8()
        );
        _deployKit(
            NOTE,
            "private-credit-note",
            "Demo Private Credit Note",
            "dPCN",
            _list(KYC, ACCREDITATION, COUNTRY),
            _u16(US, GB, FR),
            _u8(ACC_ACCREDITED, ACC_QUALIFIED_PURCHASER, ACC_INSTITUTIONAL)
        );

        // W1: every template trusts kyc-provider-a.
        providerAAuth = authorize(providerA, allKitTopics(), "KYC Provider A (demo)");

        // W2: the demo cast. Carol never gets a credential.
        aliceCredential = onboard(providerA, alice, credential(US, ACC_NONE));
        bobCredential = onboard(providerA, bob, credential(US, ACC_ACCREDITED));
        daveCredential = onboard(providerA, dave, credential(CN, ACC_NONE));

        track(alice);
        track(bob);
        track(carol);
        track(dave);
        assertAllAgree();
    }

    // ============ Deployment ============

    function _deployShared() internal {
        vm.startPrank(operator);
        // EAS is 0.8.28 and cannot be imported into this =0.8.24 file: deploy it from its artifact.
        schemaRegistry = ISchemaRegistry(deployCode("SchemaRegistry.sol:SchemaRegistry"));
        eas = IEAS(deployCode("EAS.sol:EAS", abi.encode(address(schemaRegistry))));

        address[] memory authorizers = new address[](1);
        authorizers[0] = operator;
        resolver = new TrustedIssuerResolver(eas, operator, authorizers);

        investorEligibilitySchema =
            schemaRegistry.register(INVESTOR_ELIGIBILITY_SCHEMA, ISchemaResolver(address(0)), true);
        issuerAuthSchema = schemaRegistry.register(ISSUER_AUTH_SCHEMA, ISchemaResolver(address(resolver)), true);

        identityProxy = new EASIdentityProxy(operator);

        kycPolicy = new KYCStatusPolicy();
        amlPolicy = new AMLPolicy();
        sanctionsPolicy = new SanctionsPolicy();
        sourceOfFundsPolicy = new SourceOfFundsPolicy();
        professionalPolicy = new ProfessionalInvestorPolicy();
        institutionalPolicy = new InstitutionalInvestorPolicy();
        vm.stopPrank();
    }

    function _deployKit(
        uint256 idx,
        string memory templateId,
        string memory name_,
        string memory symbol_,
        uint256[] memory topics,
        uint16[] memory countries,
        uint8[] memory accreditationTypes
    ) internal {
        Kit storage k = kits[idx];
        k.templateId = templateId;
        k.topics = topics;

        vm.startPrank(operator);
        k.topicsRegistry = new ClaimTopicsRegistry(operator);
        for (uint256 i = 0; i < topics.length; i++) {
            k.topicsRegistry.addClaimTopic(topics[i]);
        }

        k.adapter = new EASTrustedIssuersAdapter(operator);
        k.adapter.setEASAddress(address(eas));
        k.adapter.setIssuerAuthSchemaUID(issuerAuthSchema);

        k.verifier = new EASClaimVerifier(operator);
        k.verifier.setEASAddress(address(eas));
        k.verifier.setTrustedIssuersAdapter(address(k.adapter));
        k.verifier.setIdentityProxy(address(identityProxy));
        k.verifier.setClaimTopicsRegistry(address(k.topicsRegistry));

        if (_contains(topics, COUNTRY)) {
            k.countryPolicy = new CountryAllowListPolicy(operator, CountryAllowListPolicy.Mode.Allow, countries);
        }
        if (_contains(topics, ACCREDITATION)) {
            k.accreditationPolicy = new AccreditationPolicy(operator, accreditationTypes);
        }
        for (uint256 i = 0; i < topics.length; i++) {
            k.verifier.setTopicSchemaMapping(topics[i], investorEligibilitySchema);
            k.verifier.setTopicPolicy(topics[i], policyFor(idx, topics[i]));
        }

        k.eligibility = new ShibuiEligibility(k.verifier, operator);
        k.token = new RegulatedToken(name_, symbol_, 6, operator, k.eligibility);
        bytes32 issuerRole = k.token.ISSUER_ROLE();
        bytes32 complianceRole = k.token.COMPLIANCE_ROLE();
        k.token.grantRole(issuerRole, issuer);
        k.token.grantRole(complianceRole, compliance);
        vm.stopPrank();
    }

    /// @notice The policy a template binds to `topic`. Country and accreditation policies are per token.
    function policyFor(uint256 idx, uint256 topic) internal view returns (address) {
        if (topic == KYC) return address(kycPolicy);
        if (topic == AML) return address(amlPolicy);
        if (topic == SANCTIONS) return address(sanctionsPolicy);
        if (topic == SOURCE_OF_FUNDS) return address(sourceOfFundsPolicy);
        if (topic == PROFESSIONAL) return address(professionalPolicy);
        if (topic == INSTITUTIONAL) return address(institutionalPolicy);
        if (topic == COUNTRY) return address(kits[idx].countryPolicy);
        if (topic == ACCREDITATION) return address(kits[idx].accreditationPolicy);
        revert("KitFixture: unknown topic");
    }

    // ============ W1: authorize a KYC provider ============

    /// @notice Operator writes an Issuer Authorization attestation for `provider` (recipient = provider).
    function attestIssuerAuth(address provider, uint256[] memory topics, string memory issuerName)
        internal
        returns (bytes32 uid)
    {
        bytes memory data = abi.encode(provider, topics, issuerName);
        vm.prank(operator);
        uid = eas.attest(
            AttestationRequest({
                schema: issuerAuthSchema,
                data: AttestationRequestData({
                    recipient: provider, expirationTime: 0, revocable: true, refUID: bytes32(0), data: data, value: 0
                })
            })
        );
    }

    /// @notice On one token: trust `provider` for (token topics ∩ authorized topics) and let explain watch it.
    function trust(uint256 idx, address provider, bytes32 authUID, uint256[] memory authorizedTopics) internal {
        uint256[] memory topics = _intersect(kits[idx].topics, authorizedTopics);
        if (topics.length == 0) return;
        vm.startPrank(operator);
        kits[idx].adapter.addTrustedAttester(provider, topics, authUID);
        kits[idx].eligibility.watchAttester(provider);
        vm.stopPrank();
    }

    /// @notice W1 in full: authorization attestation, then trust on every token (every template lists the provider).
    function authorize(address provider, uint256[] memory topics, string memory issuerName)
        internal
        returns (bytes32 authUID)
    {
        authUID = attestIssuerAuth(provider, topics, issuerName);
        for (uint256 i = 0; i < KIT_COUNT; i++) {
            trust(i, provider, authUID, topics);
        }
    }

    /// @notice W7: stop trusting `from` on every token, then authorize `to`. Investors must be re-attested by `to`.
    function rotate(address from, address to, uint256[] memory topics, string memory issuerName)
        internal
        returns (bytes32 authUID)
    {
        for (uint256 i = 0; i < KIT_COUNT; i++) {
            EASTrustedIssuersAdapter adapter = kits[i].adapter;
            if (!adapter.isTrustedAttester(from)) continue;
            vm.prank(operator);
            adapter.removeTrustedAttester(from);
        }
        authUID = authorize(to, topics, issuerName);
    }

    // ============ W2: onboard an investor ============

    /// @notice A clean credential: KYC verified, AML/sanctions clear, payload valid for a year, no EAS expiry.
    function credential(uint16 country, uint8 accreditationType) internal view returns (Credential memory c) {
        c.kycStatus = KYC_VERIFIED;
        c.amlStatus = AML_CLEAR;
        c.sanctionsStatus = SANCTIONS_CLEAR;
        c.sourceOfFundsStatus = SOF_VERIFIED;
        c.accreditationType = accreditationType;
        c.countryCode = country;
        c.expirationTimestamp = uint64(block.timestamp + 365 days);
        c.evidenceHash = keccak256(abi.encode("fictional demo evidence bundle", country, accreditationType));
        c.verificationMethod = METHOD_THIRD_PARTY;
        c.easExpirationTime = 0;
    }

    function encodeCredential(address wallet, Credential memory c) internal pure returns (bytes memory) {
        return abi.encode(
            wallet, // identity: the kit uses the investor wallet as its own identity
            c.kycStatus,
            c.amlStatus,
            c.sanctionsStatus,
            c.sourceOfFundsStatus,
            c.accreditationType,
            c.countryCode,
            c.expirationTimestamp,
            c.evidenceHash,
            c.verificationMethod
        );
    }

    /// @notice `provider` writes ONE Investor Eligibility attestation on EAS (recipient = wallet). No registration.
    function attest(address provider, address wallet, Credential memory c) internal returns (bytes32 uid) {
        uid = attestRaw(provider, wallet, encodeCredential(wallet, c), c.easExpirationTime);
    }

    /// @notice Same as attest() with an arbitrary payload, to exercise malformed credentials.
    function attestRaw(address provider, address wallet, bytes memory data, uint64 easExpirationTime)
        internal
        returns (bytes32 uid)
    {
        vm.prank(provider);
        uid = eas.attest(
            AttestationRequest({
                schema: investorEligibilitySchema,
                data: AttestationRequestData({
                    recipient: wallet,
                    expirationTime: easExpirationTime,
                    revocable: true,
                    refUID: bytes32(0),
                    data: data,
                    value: 0
                })
            })
        );
    }

    /// @notice As `provider`: registerAttestation for every token and every required topic it is trusted for.
    function register(address provider, address wallet, bytes32 uid) internal {
        for (uint256 i = 0; i < KIT_COUNT; i++) {
            _registerOn(i, provider, wallet, uid);
        }
    }

    function _registerOn(uint256 idx, address provider, address wallet, bytes32 uid) private {
        uint256[] memory topics = kits[idx].topics;
        EASTrustedIssuersAdapter adapter = kits[idx].adapter;
        EASClaimVerifier verifier = kits[idx].verifier;
        for (uint256 j = 0; j < topics.length; j++) {
            if (!adapter.isAttesterTrusted(provider, topics[j])) continue;
            vm.prank(provider);
            verifier.registerAttestation(wallet, topics[j], uid);
        }
    }

    /// @notice W2 in full: one credential, registered everywhere the provider is trusted.
    function onboard(address provider, address wallet, Credential memory c) internal returns (bytes32 uid) {
        uid = attest(provider, wallet, c);
        register(provider, wallet, uid);
    }

    // ============ W6: revoke ============

    /// @notice `attester` revokes `uid` on EAS (works for both schemas; EAS only lets the original attester revoke).
    function revoke(address attester, bytes32 uid) internal {
        bytes32 schema = eas.getAttestation(uid).schema;
        vm.prank(attester);
        eas.revoke(RevocationRequest({schema: schema, data: RevocationRequestData({uid: uid, value: 0})}));
    }

    // ============ Token helpers ============

    function issueTo(uint256 idx, address to, uint256 amount) internal {
        vm.prank(issuer);
        kits[idx].token.issue(to, amount);
    }

    // ============ I9: explain must agree with enforcement ============

    function track(address wallet) internal {
        for (uint256 i = 0; i < trackedWallets.length; i++) {
            if (trackedWallets[i] == wallet) return;
        }
        trackedWallets.push(wallet);
    }

    /// @notice I9: (every explain status is OK) == isEligible == Shibui isVerified (a revert counts as "no", D3).
    ///         Also: MISCONFIGURED is reported only when the verifier lacks EAS / adapter / proxy / registry.
    function assertExplainAgrees(ShibuiEligibility eligibility, address wallet) internal view {
        IEligibility.TopicStatus[] memory st = eligibility.explain(wallet);
        bool allOk = true;
        bool sawMisconfigured = false;
        for (uint256 i = 0; i < st.length; i++) {
            if (st[i].status != IEligibility.Status.OK) allOk = false;
            if (st[i].status == IEligibility.Status.MISCONFIGURED) sawMisconfigured = true;
        }
        bool eligible = eligibility.isEligible(wallet);
        assertEq(allOk, eligible, "I9: explain (all OK) disagrees with isEligible");

        EASClaimVerifier v = EASClaimVerifier(address(eligibility.verifier()));
        bool verified;
        try v.isVerified(wallet) returns (bool r) {
            verified = r;
        } catch {
            verified = false;
        }
        assertEq(eligible, verified, "I9: isEligible disagrees with Shibui isVerified");

        bool wired = v.getEASAddress() != address(0) && v.getTrustedIssuersAdapter() != address(0)
            && v.getIdentityProxy() != address(0) && v.getClaimTopicsRegistry() != address(0);
        assertEq(sawMisconfigured, !wired, "MISCONFIGURED must appear exactly when the verifier is not wired");
    }

    /// @notice I9 for every token and every tracked wallet, plus: the token's ERC-7943 views agree with its slot.
    function assertAllAgree() internal view {
        for (uint256 i = 0; i < KIT_COUNT; i++) {
            Kit storage k = kits[i];
            assertEq(address(k.token.eligibility()), address(k.eligibility), "fixture: token slot drifted from kit");
            for (uint256 j = 0; j < trackedWallets.length; j++) {
                address w = trackedWallets[j];
                assertExplainAgrees(k.eligibility, w);
                bool eligible = k.eligibility.isEligible(w);
                assertEq(k.token.canReceive(w), eligible, "canReceive must equal the slot answer");
                assertEq(k.token.canSend(w), eligible, "canSend must equal the slot answer");
            }
        }
    }

    // ============ explain helpers ============

    function statusOf(uint256 idx, address wallet, uint256 topic) internal view returns (IEligibility.Status) {
        return statusIn(kits[idx].eligibility, wallet, topic);
    }

    function statusIn(ShibuiEligibility eligibility, address wallet, uint256 topic)
        internal
        view
        returns (IEligibility.Status)
    {
        IEligibility.TopicStatus[] memory st = eligibility.explain(wallet);
        for (uint256 i = 0; i < st.length; i++) {
            if (st[i].topic == topic) return st[i].status;
        }
        revert("KitFixture: topic not in explain output");
    }

    function assertStatus(uint256 idx, address wallet, uint256 topic, IEligibility.Status expected, string memory why)
        internal
        view
    {
        assertEq(uint256(statusOf(idx, wallet, topic)), uint256(expected), why);
    }

    /// @notice explain lists exactly the token's topics, in registry order, each with `expected`.
    function assertEveryTopic(uint256 idx, address wallet, IEligibility.Status expected, string memory why)
        internal
        view
    {
        IEligibility.TopicStatus[] memory st = kits[idx].eligibility.explain(wallet);
        uint256[] memory topics = kits[idx].topicsRegistry.getClaimTopics();
        assertEq(st.length, topics.length, why);
        for (uint256 i = 0; i < st.length; i++) {
            assertEq(st[i].topic, topics[i], why);
            assertEq(uint256(st[i].status), uint256(expected), why);
        }
    }

    // ============ Small utilities ============

    function allKitTopics() internal pure returns (uint256[] memory t) {
        t = new uint256[](8);
        t[0] = KYC;
        t[1] = AML;
        t[2] = COUNTRY;
        t[3] = ACCREDITATION;
        t[4] = PROFESSIONAL;
        t[5] = INSTITUTIONAL;
        t[6] = SANCTIONS;
        t[7] = SOURCE_OF_FUNDS;
    }

    function _list(uint256 a) internal pure returns (uint256[] memory t) {
        t = new uint256[](1);
        t[0] = a;
    }

    function _list(uint256 a, uint256 b) internal pure returns (uint256[] memory t) {
        t = new uint256[](2);
        t[0] = a;
        t[1] = b;
    }

    function _list(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory t) {
        t = new uint256[](3);
        t[0] = a;
        t[1] = b;
        t[2] = c;
    }

    function _u16() internal pure returns (uint16[] memory t) {
        t = new uint16[](0);
    }

    function _u16(uint16 a, uint16 b, uint16 c) internal pure returns (uint16[] memory t) {
        t = new uint16[](3);
        t[0] = a;
        t[1] = b;
        t[2] = c;
    }

    function _u8() internal pure returns (uint8[] memory t) {
        t = new uint8[](0);
    }

    function _u8(uint8 a, uint8 b, uint8 c) internal pure returns (uint8[] memory t) {
        t = new uint8[](3);
        t[0] = a;
        t[1] = b;
        t[2] = c;
    }

    function _contains(uint256[] memory xs, uint256 x) internal pure returns (bool) {
        for (uint256 i = 0; i < xs.length; i++) {
            if (xs[i] == x) return true;
        }
        return false;
    }

    function _intersect(uint256[] memory a, uint256[] memory b) internal pure returns (uint256[] memory out) {
        uint256 n = 0;
        uint256[] memory tmp = new uint256[](a.length);
        for (uint256 i = 0; i < a.length; i++) {
            if (_contains(b, a[i])) tmp[n++] = a[i];
        }
        out = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = tmp[i];
        }
    }

    function _name(address w) internal view returns (string memory) {
        return vm.getLabel(w);
    }
}
