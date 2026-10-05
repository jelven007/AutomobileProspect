import { isValidIdCardIdentity, normalizeIdCardForStorage } from './id-card';

export type DocumentType =
  | 'resident_id' | 'organization_code' | 'credit_code'
  | 'passport_cn' | 'hk_macao_permit' | 'mainland_permit' | 'taiwan_permit'
  | 'hongkong_id' | 'pending_document';

export const DOCUMENT_TYPES: Record<DocumentType, string> = {
  resident_id: '居民身份证',
  organization_code: '组织机构代码',
  credit_code: '统一社会信用代码',
  passport_cn: '中国普通护照',
  hk_macao_permit: '往来港澳通行证',
  mainland_permit: '港澳居民来往内地通行证',
  taiwan_permit: '台湾居民来往大陆通行证',
  hongkong_id: '香港居民身份证',
  pending_document: '证件类型待核实',
};

const ALIASES: Record<string, DocumentType> = {
  身份证: 'resident_id',
  护照: 'passport_cn',
  回乡证: 'mainland_permit',
  台胞证: 'taiwan_permit',
  香港身份证: 'hongkong_id',
  ...Object.fromEntries(Object.entries(DOCUMENT_TYPES).map(([key, label]) => [label, key as DocumentType])),
};
const ORG_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CREDIT_ALPHABET = '0123456789ABCDEFGHJKLMNPQRTUWXY';
const ORG_WEIGHTS = [3, 7, 9, 10, 5, 8, 4, 2];
const CREDIT_WEIGHTS = [1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];

export function validOrganizationCode(value: string): boolean {
  if (!/^[0-9A-Z]{8}[0-9X]$/.test(value) || /^([0-9A-Z])\1+$/.test(value)) return false;
  const sum = ORG_WEIGHTS.reduce((total, weight, i) => total + ORG_ALPHABET.indexOf(value[i]) * weight, 0);
  const check = 11 - sum % 11;
  return value[8] === (check === 10 ? 'X' : check === 11 ? '0' : String(check));
}

export function validCreditCode(value: string): boolean {
  if (value.length !== 18 || [...value].some((char) => !CREDIT_ALPHABET.includes(char))) return false;
  if (!/^[1-9A-Y][1-9]\d{6}/.test(value) || /^([0-9A-Z])\1+$/.test(value)) return false;
  const sum = CREDIT_WEIGHTS.reduce((total, weight, i) => total + CREDIT_ALPHABET.indexOf(value[i]) * weight, 0);
  return value[17] === CREDIT_ALPHABET[(31 - sum % 31) % 31];
}

/** ASCII input; accepts paired parentheses or a compact explicit-type number. */
export function validHongKongId(value: string): boolean {
  const match = /^([A-Z]{1,2})(\d{6})(?:\(([0-9A])\)|([0-9A]))$/.exec(value);
  if (!match) return false;
  const [, prefix, digits, bracketCheck, compactCheck] = match;
  const letters = prefix.length === 1
    ? [36, ORG_ALPHABET.indexOf(prefix)]
    : [...prefix].map((letter) => ORG_ALPHABET.indexOf(letter));
  const check = bracketCheck ?? compactCheck;
  const sum = letters[0] * 9 + letters[1] * 8
    + [...digits].reduce((total, digit, i) => total + Number(digit) * (7 - i), 0)
    + (check === 'A' ? 10 : Number(check));
  return sum % 11 === 0;
}

export interface NormalizedDocument {
  value: string;
  type?: DocumentType;
  warnings: string[];
  error?: string;
}

/** Stable namespace for database locks and in-memory dedupe. Legacy rows default to resident ID. */
export function documentKey(row: { id_type?: string | null; id_card?: string | null }): string {
  return `${row.id_type ?? 'resident_id'}:${row.id_card ?? ''}`;
}

/**
 * Auto-detect only bounded, identifiable formats. Short numeric IDs require an explicit type.
 * Ambiguous passport/organization numbers require a type column or the organization hyphen.
 */
export function normalizeDocument(raw: unknown, requestedType?: unknown): NormalizedDocument {
  const text = raw == null ? '' : String(raw).normalize('NFKC').toUpperCase()
    .replace(/[\s\u200B\u200C\u200D\u00AD]/g, '').replace(/[‐‑–—−]/g, '-');
  const typeText = requestedType == null ? '' : String(requestedType).trim();
  const type = Object.hasOwn(DOCUMENT_TYPES, typeText) ? typeText as DocumentType : ALIASES[typeText];
  if (typeText && typeText !== 'auto' && !type) {
    return { value: text, warnings: [], error: 'unsupported_document_type' };
  }
  if (!text || /^-+$/.test(text)) return { value: '', warnings: [], error: 'id_card_required' };
  if (/^(NULL|NONE|N\/A|NAN|未知|无|未提供|无证件)$/.test(text) || /^1[3-9]\d{9}$/.test(text)) {
    return { value: text, warnings: [], error: 'invalid_id_card_format' };
  }

  const wrapped = /^#([0-9X-]+)#$/.exec(text);
  const residentRaw = wrapped ? wrapped[1] : text;
  const resident = normalizeIdCardForStorage(residentRaw);
  const residentValid = isValidIdCardIdentity(resident.value);
  // Only a complete, valid resident number may have its outside # pair removed.
  if (wrapped && !residentValid) return { value: text, warnings: [], error: 'invalid_id_card_format' };
  const orgValue = /^[0-9A-Z]{8}-[0-9X]$/.test(text) ? text.replace('-', '') : text;
  const valid: Record<DocumentType, boolean> = {
    resident_id: residentValid,
    organization_code: validOrganizationCode(orgValue),
    credit_code: validCreditCode(text),
    passport_cn: /^(?:[GE]\d{8}|E[A-HJ-NP-Z]\d{7})$/.test(text),
    hk_macao_permit: /^C(?:\d{8}|[A-HJ-NP-Z]\d{7})$/.test(text),
    mainland_permit: /^[HM]\d{8}(?:\d{2})?$/.test(text),
    taiwan_permit: /^\d{8}$/.test(text) && !/^(\d)\1+$/.test(text),
    hongkong_id: validHongKongId(text),
    pending_document: false,
  };
  const matches = (Object.keys(valid) as DocumentType[]).filter((key) =>
    key !== 'taiwan_permit' && key !== 'pending_document'
    && (key !== 'hongkong_id' || text.includes('(')) && valid[key]);
  // Explicit, bounded holding namespace; never an escape hatch for invalid/unknown IDs.
  valid.pending_document = !residentValid && matches.length > 1;
  let selected = type;
  // Preserve the historical resident-ID namespace for valid 15/17/18-digit IDs.
  // A wholly numeric credit code that also encodes a real birth date needs an explicit type.
  if (!selected && residentValid) selected = 'resident_id';
  if (!selected) {
    if (matches.length > 1) return { value: text, warnings: [], error: 'ambiguous_document_type' };
    selected = matches[0];
  }
  if (!selected || !valid[selected]) {
    return { value: text, warnings: [], error: 'invalid_id_card_format' };
  }
  const warnings: string[] = [];
  let value = text;
  if (selected === 'resident_id') {
    value = resident.value;
    if (wrapped) warnings.push('id_card_hash_wrapper_removed');
    if (/[\u0027\u2018\u2019\uFF07]/.test(residentRaw)) warnings.push('id_card_quote_removed');
  } else if (selected === 'organization_code') {
    value = orgValue;
  } else if (selected === 'mainland_permit' && text.length === 11) {
    value = text.slice(0, 9);
    warnings.push('document_issue_suffix_removed');
  } else if (selected === 'hongkong_id') {
    const compact = text.replace(/[()]/g, '');
    value = `${compact.slice(0, -1)}(${compact.slice(-1)})`;
  } else if (selected === 'pending_document') {
    warnings.push('document_type_pending_verification');
  }
  return { value, type: selected, warnings };
}
