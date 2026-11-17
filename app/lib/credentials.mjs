// Investor Eligibility and Issuer Authorization payloads (Shibui schemas), encoded and described.

import { encodeAbiParameters, decodeAbiParameters, keccak256, toHex } from 'viem';
import { ACCREDITATION_TYPES, CREDENTIAL_CODES, topicName } from './topics.mjs';

const INVESTOR_ELIGIBILITY_TYPES = [
  { name: 'identity', type: 'address' },
  { name: 'kycStatus', type: 'uint8' },
  { name: 'amlStatus', type: 'uint8' },
  { name: 'sanctionsStatus', type: 'uint8' },
  { name: 'sourceOfFundsStatus', type: 'uint8' },
  { name: 'accreditationType', type: 'uint8' },
  { name: 'countryCode', type: 'uint16' },
  { name: 'expirationTimestamp', type: 'uint64' },
  { name: 'evidenceHash', type: 'bytes32' },
  { name: 'verificationMethod', type: 'uint8' },
];

const ISSUER_AUTH_TYPES = [
  { name: 'issuerAddress', type: 'address' },
  { name: 'authorizedTopics', type: 'uint256[]' },
  { name: 'issuerName', type: 'string' },
];

/** Defaults for a clean credential: KYC verified, AML/sanctions clear, source of funds verified, third-party check. */
export const CREDENTIAL_DEFAULTS = Object.freeze({
  kycStatus: CREDENTIAL_CODES.KYC_VERIFIED,
  amlStatus: CREDENTIAL_CODES.AML_CLEAR,
  sanctionsStatus: CREDENTIAL_CODES.SANCTIONS_CLEAR,
  sourceOfFundsStatus: CREDENTIAL_CODES.SOF_VERIFIED,
  accreditationType: 0,
  countryCode: 0,
  verificationMethod: CREDENTIAL_CODES.METHOD_THIRD_PARTY,
});

/** A hash standing in for an off-chain evidence bundle. No personal data goes into it. */
export function demoEvidenceHash(label) {
  return keccak256(toHex(`fictional demo evidence bundle: ${label}`));
}

export function encodeCredential(wallet, f) {
  return encodeAbiParameters(INVESTOR_ELIGIBILITY_TYPES, [
    wallet,
    f.kycStatus,
    f.amlStatus,
    f.sanctionsStatus,
    f.sourceOfFundsStatus,
    f.accreditationType,
    f.countryCode,
    BigInt(f.expirationTimestamp ?? 0),
    f.evidenceHash,
    f.verificationMethod,
  ]);
}

export function decodeCredential(data) {
  try {
    const v = decodeAbiParameters(INVESTOR_ELIGIBILITY_TYPES, data);
    const o = {};
    INVESTOR_ELIGIBILITY_TYPES.forEach((t, i) => {
      o[t.name] = typeof v[i] === 'bigint' ? Number(v[i]) : v[i];
    });
    return o;
  } catch {
    return null;
  }
}

export function encodeIssuerAuth(provider, topicIds, issuerName) {
  return encodeAbiParameters(ISSUER_AUTH_TYPES, [provider, topicIds.map(BigInt), issuerName]);
}

export function decodeIssuerAuth(data) {
  try {
    const [issuerAddress, topics, issuerName] = decodeAbiParameters(ISSUER_AUTH_TYPES, data);
    return { issuerAddress, topics: topics.map((t) => topicName(Number(t))), issuerName };
  } catch {
    return null;
  }
}

const KYC_WORDS = { 0: 'KYC not verified', 1: 'KYC verified', 2: 'KYC expired', 3: 'KYC revoked', 4: 'KYC pending' };

/** "KYC verified, AML clear, sanctions clear, country 840, accreditation: accredited" */
export function describeCredential(f) {
  if (!f) return 'unreadable credential';
  const parts = [
    KYC_WORDS[f.kycStatus] ?? `KYC status ${f.kycStatus}`,
    f.amlStatus === 0 ? 'AML clear' : 'AML flagged',
    f.sanctionsStatus === 0 ? 'sanctions clear' : 'sanctions hit',
    f.sourceOfFundsStatus === 1 ? 'source of funds verified' : 'source of funds not verified',
    `country ${f.countryCode}`,
    `accreditation: ${ACCREDITATION_TYPES[f.accreditationType] ?? f.accreditationType}`,
  ];
  if (f.expirationTimestamp) parts.push(`valid until ${new Date(f.expirationTimestamp * 1000).toISOString().slice(0, 10)}`);
  return parts.join(', ');
}
