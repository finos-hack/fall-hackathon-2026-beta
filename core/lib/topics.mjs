// Shibui claim topics, IEligibility statuses and the plain-language texts the console, CLI and
// scenario show for a refusal ("accreditation: policy rejected", "KYC: revoked").

/** Shibui topic ids (ERC-3643 numbering). The kit supports exactly these names in templates. */
export const TOPICS = Object.freeze({
  KYC: 1,
  AML: 2,
  COUNTRY: 3,
  ACCREDITATION: 7,
  PROFESSIONAL: 9,
  INSTITUTIONAL: 10,
  SANCTIONS: 13,
  SOURCE_OF_FUNDS: 14,
});

export const TOPIC_NAMES = Object.freeze(Object.keys(TOPICS));

/** Words used in refusal texts. Topic 0 is what ShibuiEligibility.explain reports when it is not wired. */
const TOPIC_LABELS = Object.freeze({
  0: 'eligibility source',
  1: 'KYC',
  2: 'AML',
  3: 'country',
  7: 'accreditation',
  9: 'professional investor',
  10: 'institutional investor',
  13: 'sanctions',
  14: 'source of funds',
  15: 'vLEI legal entity',
  16: 'vLEI authorized role',
});

/** Topics answered by a vLEI slot (OnChainTrust VleiEligibility), never by Shibui policies in Interlock. */
export const VLEI_TOPICS = Object.freeze({ VLEI_LEGAL_ENTITY: 15, VLEI_AUTHORIZED_ROLE: 16 });

/** IEligibility.Status, in enum order. */
export const STATUSES = Object.freeze([
  'OK',
  'NOT_REGISTERED',
  'REVOKED',
  'EXPIRED',
  'ATTESTER_NOT_TRUSTED',
  'POLICY_REJECTED',
  'POLICY_MISSING',
  'MISCONFIGURED',
]);

const STATUS_TEXTS = Object.freeze({
  OK: 'ok',
  NOT_REGISTERED: 'no credential',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  ATTESTER_NOT_TRUSTED: 'attester not trusted',
  POLICY_REJECTED: 'policy rejected',
  POLICY_MISSING: 'policy missing',
  MISCONFIGURED: 'misconfigured',
});

const NAME_BY_ID = new Map([...Object.entries(TOPICS), ...Object.entries(VLEI_TOPICS)].map(([name, id]) => [id, name]));

export function isTopicName(name) {
  return typeof name === 'string' && Object.hasOwn(TOPICS, name);
}

export function topicId(name) {
  if (!isTopicName(name)) throw new Error(`unknown topic "${name}". Supported: ${TOPIC_NAMES.join(', ')}`);
  return TOPICS[name];
}

/** Topic name for an id; unknown ids come back as "TOPIC_<id>" so nothing is silently dropped. */
export function topicName(id) {
  const n = Number(id);
  if (n === 0) return 'ELIGIBILITY';
  return NAME_BY_ID.get(n) ?? `TOPIC_${n}`;
}

export function topicLabel(id) {
  return TOPIC_LABELS[Number(id)] ?? `topic ${Number(id)}`;
}

export function statusName(index) {
  return STATUSES[Number(index)] ?? `STATUS_${Number(index)}`;
}

/** "accreditation: policy rejected" */
export function statusText(topic, status) {
  const id = typeof topic === 'string' && isTopicName(topic) ? TOPICS[topic] : Number(topic);
  const s = typeof status === 'string' ? status : statusName(status);
  return `${topicLabel(id)}: ${STATUS_TEXTS[s] ?? s.toLowerCase()}`;
}

/** Turns one IEligibility.TopicStatus ({topic, status} from explain) into the JSON shape the kit returns. */
export function describeTopicStatus({ topic, status }) {
  const id = Number(topic);
  const s = statusName(status);
  return { topic: topicName(id), topicId: id, status: s, text: statusText(id, s) };
}

/** Investor Eligibility accreditationType values (Shibui TopicPolicyBase). */
export const ACCREDITATION_TYPES = Object.freeze({
  0: 'none',
  1: 'retail qualified',
  2: 'accredited',
  3: 'qualified purchaser',
  4: 'institutional',
});

/** Investor Eligibility status codes the kit writes. */
export const CREDENTIAL_CODES = Object.freeze({
  KYC_VERIFIED: 1,
  KYC_REVOKED: 3,
  AML_CLEAR: 0,
  SANCTIONS_CLEAR: 0,
  SOF_VERIFIED: 1,
  METHOD_THIRD_PARTY: 2,
});
