/**
 * 身份证推导：从 15/18 位身份证中还原省份、市、区县、出生日期、性别。
 *
 * 码表优先级：
 *   extraDistrictCode > configs/gb2260.json > china-division（权威全国码表）
 *
 * 兼容：
 *   - 15 位老身份证（1980s 前）自动补成 18 位
 *   - 17 位身份证主体自动补校验位
 *   - 空格 / 全角数字 / 软连字符 / 小写 x 做清洗
 *   - 历史 GB2260 代码（已撤销/合并）自动回落
 */
import { readFileSync } from 'fs';
import { join } from 'path';
// 权威全国码表：31 省 + 400+ 地级 + 3200+ 县区
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chinaProvinces: Array<{ code: string; name: string }> = require('china-division/dist/provinces.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chinaCities: Array<{ code: string; name: string; provinceCode: string }> = require('china-division/dist/cities.json');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const chinaAreas: Array<{ code: string; name: string; cityCode: string }> = require('china-division/dist/areas.json');

interface Gb2260Table {
  provinces: Record<string, string>;
  cities: Record<string, string>;
  cities_historical: Record<string, string>;
  districts: Record<string, string>;
}

let tableCache: Gb2260Table | null = null;
let historyCache: {
  cities: Record<string, string>;
  districts: Record<string, string>;
  districtCities: Record<string, string>;
} | null = null;
let extraCityCode: Record<string, string> = {};
let extraDistrictCode: Record<string, string> = {};

const chinaProvinceMap: Record<string, string> = {};
const chinaCityMap: Record<string, string> = {};
const chinaCityToProvinceCode: Record<string, string> = {};
const chinaAreaMap: Record<string, string> = {};
const municipalityCountyCodes: Record<string, string> = {
  '1102': '北京市',
  '1202': '天津市',
  '3102': '上海市',
  '5000': '重庆市',
};
const provinceDirectCountyCodes = new Set([
  '1490', '2290', '2390', '3390', '3590',
  '3790', '4229', '4390', '4600', '5190',
]);
for (const p of chinaProvinces) chinaProvinceMap[p.code.slice(0, 2)] = p.name;
for (const c of chinaCities) {
  chinaCityMap[c.code.slice(0, 4)] = c.name;
  chinaCityToProvinceCode[c.code.slice(0, 4)] = c.provinceCode;
}
for (const a of chinaAreas) chinaAreaMap[a.code.slice(0, 6)] = a.name;

function loadTable(): Gb2260Table {
  if (tableCache) return tableCache;
  const path = join(__dirname, '..', 'configs', 'gb2260.json');
  tableCache = JSON.parse(readFileSync(path, 'utf-8')) as Gb2260Table;
  return tableCache;
}

function loadHistoryTable(): {
  cities: Record<string, string>;
  districts: Record<string, string>;
  districtCities: Record<string, string>;
} {
  if (historyCache) return historyCache;
  const path = require.resolve('@cndiv/source-history/data/divisions.csv');
  const latestCity = new Map<string, { year: number; name: string }>();
  const citySnapshots = new Map<string, string>();
  const latestDistrict = new Map<string, {
    year: number;
    name: string;
    parentCode: string;
  }>();

  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/).slice(1)) {
    const matched = line.match(/^(\d{12}),"((?:[^"]|"")*)",([123]),([^,]*),(\d{4}),/);
    if (!matched) continue;
    const [, rawCode, escapedName, levelText, parentCode, yearText] = matched;
    const year = Number(yearText);
    if (year > 2020) continue;
    const name = escapedName.replace(/""/g, '"').trim();
    const code6 = rawCode.slice(0, 6);
    if (!name) continue;
    if (levelText === '2') {
      const code4 = code6.slice(0, 4);
      citySnapshots.set(`${year}:${code4}`, name);
      const previous = latestCity.get(code4);
      if (!previous || previous.year <= year) latestCity.set(code4, { year, name });
    } else if (levelText === '3') {
      const previous = latestDistrict.get(code6);
      if (!previous || previous.year <= year) {
        latestDistrict.set(code6, { year, name, parentCode });
      }
    }
  }

  const districtCities: Record<string, string> = {};
  for (const [code, item] of latestDistrict) {
    const parent4 = item.parentCode.slice(0, 4);
    const city = citySnapshots.get(`${item.year}:${parent4}`);
    if (city) districtCities[code] = city;
  }
  historyCache = {
    cities: Object.fromEntries([...latestCity].map(([code, item]) => [code, item.name])),
    districts: Object.fromEntries([...latestDistrict].map(([code, item]) => [code, item.name])),
    districtCities,
  };
  return historyCache;
}

export function setExtraCityCodes(table: Record<string, string>): void {
  extraCityCode = { ...table };
}

export function setExtraDistrictCodes(table: Record<string, string>): void {
  extraDistrictCode = { ...table };
}

export function _resetGb2260Cache(): void {
  tableCache = null;
  historyCache = null;
}

export interface IdCardInfo {
  province?: string;
  city?: string;
  district?: string;
  birth_date?: string;
  birth_date_corrected?: boolean;
  original_birth_date?: string;
  normalized_id_card?: string;
  gender?: 'M' | 'F' | 'U';
  checksum_valid?: boolean;
}

export interface NormalizedIdCard {
  value: string;
  birthDateCorrected: boolean;
  originalBirthDate?: string;
  correctedBirthDate?: string;
}

/** 输入清洗：去空格 / 全角数字 → 半角 / 软连字符 → 空 / 小写 x → X */
export function sanitizeIdCard(raw: unknown): string {
  if (raw == null) return '';
  let s = String(raw).trim();
  s = s.replace(/[\s\u00A0\u3000\u200B\u200C\u200D-]/g, '');
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[xｘ]/g, 'X');
  return s;
}

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECKS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

function checksumForBody(body: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(body[i]) * ID_CARD_WEIGHTS[i];
  return ID_CARD_CHECKS[sum % 11];
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeBirthDateInBody(body: string): {
  body: string;
  corrected: boolean;
  originalBirthDate: string;
  correctedBirthDate?: string;
} {
  const year = Number(body.slice(6, 10));
  const month = Number(body.slice(10, 12));
  const day = Number(body.slice(12, 14));
  const originalBirthDate = formatDate(year, month, day);
  if (year < 1800 || year > 2099) {
    return { body, corrected: false, originalBirthDate };
  }

  let correctedYear = year;
  let correctedMonth = month;
  let correctedDay = day;
  if (correctedMonth < 1) {
    correctedYear -= 1;
    correctedMonth = 12;
  } else if (correctedMonth > 12) {
    correctedMonth = 12;
  }

  const maxDay = new Date(Date.UTC(correctedYear, correctedMonth, 0)).getUTCDate();
  if (correctedDay < 1) {
    const previousMonth = new Date(Date.UTC(correctedYear, correctedMonth - 1, 0));
    correctedYear = previousMonth.getUTCFullYear();
    correctedMonth = previousMonth.getUTCMonth() + 1;
    correctedDay = previousMonth.getUTCDate();
  } else if (correctedDay > maxDay) {
    correctedDay = maxDay;
  }

  const correctedBirthDate = formatDate(correctedYear, correctedMonth, correctedDay);
  if (correctedBirthDate === originalBirthDate) {
    return { body, corrected: false, originalBirthDate };
  }
  const dateDigits = correctedBirthDate.replace(/-/g, '');
  return {
    body: `${body.slice(0, 6)}${dateDigits}${body.slice(14)}`,
    corrected: true,
    originalBirthDate,
    correctedBirthDate,
  };
}

/** 15 位身份证补 18 位（19xx 年 + 校验位） */
export function expand15To18(s15: string): string | null {
  if (!/^\d{15}$/.test(s15)) return null;
  const normalized = normalizeBirthDateInBody(s15.slice(0, 6) + '19' + s15.slice(6));
  return normalized.body + checksumForBody(normalized.body);
}

export function normalizeIdCardForStorage(raw: unknown): NormalizedIdCard {
  const sanitized = sanitizeIdCard(raw);
  // 全重复数字是占位值，不能通过日期修复变成看似有效的身份键。
  if (/^(\d)\1+$/.test(sanitized)) {
    return { value: sanitized, birthDateCorrected: false };
  }
  let body: string;
  let originalValue = sanitized;
  if (/^\d{15}$/.test(sanitized)) {
    body = sanitized.slice(0, 6) + '19' + sanitized.slice(6);
    originalValue = body + checksumForBody(body);
  } else if (/^\d{17}$/.test(sanitized)) {
    body = sanitized;
    originalValue = body + checksumForBody(body);
  } else if (/^\d{17}[\dX]$/.test(sanitized)) {
    body = sanitized.slice(0, 17);
  } else {
    return { value: sanitized, birthDateCorrected: false };
  }

  const normalized = normalizeBirthDateInBody(body);
  return {
    value: normalized.corrected
      ? normalized.body + checksumForBody(normalized.body)
      : originalValue,
    birthDateCorrected: normalized.corrected,
    originalBirthDate: normalized.originalBirthDate,
    correctedBirthDate: normalized.correctedBirthDate,
  };
}

function validateIdCard(s: string): boolean {
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  return checksumForBody(s.slice(0, 17)) === s[17];
}

/**
 * 归一化后的身份键准入：格式、年份和真实日历日期必须有效。
 * 不要求命中现行行政区划，也不把校验位告警升级为拒绝。
 */
export function isValidIdCardIdentity(value: string): boolean {
  if (!/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dX]$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(6, 10));
  const month = Number(value.slice(10, 12));
  const day = Number(value.slice(12, 14));
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseIdCard(value: unknown): IdCardInfo {
  if (value == null) return {};
  const normalized = normalizeIdCardForStorage(value);
  const s = normalized.value;
  if (!isValidIdCardIdentity(s)) return {};

  const table = loadTable();
  const history = loadHistoryTable();
  const info: IdCardInfo = {
    birth_date_corrected: normalized.birthDateCorrected,
    original_birth_date: normalized.originalBirthDate,
    normalized_id_card: s,
  };
  const provCode = s.slice(0, 2);
  const cityCode = s.slice(0, 4);
  const districtCode = s.slice(0, 6);

  // 省份：gb2260 内置 → china-division 回落
  info.province = table.provinces[provCode] ?? chinaProvinceMap[provCode];

  // 城市：extra → 现行码表 → 1980-2020 官方历史快照 → 旧手工回落
  info.city = extraCityCode[cityCode]
    ?? table.cities[cityCode]
    ?? chinaCityMap[cityCode]
    ?? history.districtCities[districtCode]
    ?? history.cities[cityCode]
    ?? table.cities_historical[cityCode];

  // 区县：extra → 现行码表 → 1980-2020 官方历史快照 → 旧手工回落
  info.district = extraDistrictCode[districtCode]
    ?? chinaAreaMap[districtCode]
    ?? history.districts[districtCode]
    ?? table.districts[districtCode];

  // 城市回落修正：如果 province 命中但 city 还没出来，尝试用 chinaAreas 的 cityCode 反查
  if (!info.city && info.district) {
    const area = chinaAreas.find((a) => a.code.slice(0, 6) === districtCode);
    if (area) info.city = chinaCityMap[area.cityCode.slice(0, 4)];
  }
  if (!info.city) {
    info.city = municipalityCountyCodes[cityCode]
      ?? (provinceDirectCountyCodes.has(cityCode) && info.province
        ? `${info.province}直辖县级行政区划`
        : undefined);
  }

  const y = s.slice(6, 10);
  const m = s.slice(10, 12);
  const d = s.slice(12, 14);
  if (/^(18|19|20)\d{2}$/.test(y) && Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
    info.birth_date = `${y}-${m}-${d}`;
  }

  const seq = Number(s.slice(16, 17));
  if (!Number.isNaN(seq)) info.gender = seq % 2 === 1 ? 'M' : 'F';

  info.checksum_valid = validateIdCard(s);
  return info;
}
