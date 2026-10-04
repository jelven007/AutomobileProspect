/**
 * 身份证推导：从 15/18 位身份证中还原省份、市、区县、出生日期、性别。
 *
 * 码表优先级：
 *   extraDistrictCode > configs/gb2260.json > china-division（权威全国码表）
 *
 * 兼容：
 *   - 15 位老身份证（1980s 前）自动补成 18 位
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
let extraCityCode: Record<string, string> = {};
let extraDistrictCode: Record<string, string> = {};

const chinaProvinceMap: Record<string, string> = {};
const chinaCityMap: Record<string, string> = {};
const chinaCityToProvinceCode: Record<string, string> = {};
const chinaAreaMap: Record<string, string> = {};
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

export function setExtraCityCodes(table: Record<string, string>): void {
  extraCityCode = { ...table };
}

export function setExtraDistrictCodes(table: Record<string, string>): void {
  extraDistrictCode = { ...table };
}

export function _resetGb2260Cache(): void {
  tableCache = null;
}

export interface IdCardInfo {
  province?: string;
  city?: string;
  district?: string;
  birth_date?: string;
  gender?: 'M' | 'F' | 'U';
  checksum_valid?: boolean;
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

/** 15 位身份证补 18 位（19xx 年 + 校验位） */
export function expand15To18(s15: string): string | null {
  if (!/^\d{15}$/.test(s15)) return null;
  const body = s15.slice(0, 6) + '19' + s15.slice(6);
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(body[i]) * weights[i];
  return body + checks[sum % 11];
}

function validateIdCard(s: string): boolean {
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(s[i]) * weights[i];
  return checks[sum % 11] === s[17];
}

export function parseIdCard(value: unknown): IdCardInfo {
  if (value == null) return {};
  let s = sanitizeIdCard(value);
  if (s.length === 15) {
    const expanded = expand15To18(s);
    if (!expanded) return {};
    s = expanded;
  }
  if (s.length !== 18) return {};

  const table = loadTable();
  const info: IdCardInfo = {};
  const provCode = s.slice(0, 2);
  const cityCode = s.slice(0, 4);
  const districtCode = s.slice(0, 6);

  // 省份：gb2260 内置 → china-division 回落
  info.province = table.provinces[provCode] ?? chinaProvinceMap[provCode];

  // 城市：extra → gb2260 现行 → gb2260 历史 → china-division
  info.city = extraCityCode[cityCode]
    ?? table.cities[cityCode]
    ?? table.cities_historical[cityCode]
    ?? chinaCityMap[cityCode];

  // 区县：extra → gb2260 → china-division
  info.district = extraDistrictCode[districtCode]
    ?? table.districts[districtCode]
    ?? chinaAreaMap[districtCode];

  // 城市回落修正：如果 province 命中但 city 还没出来，尝试用 chinaAreas 的 cityCode 反查
  if (!info.city && info.district) {
    const area = chinaAreas.find((a) => a.code.slice(0, 6) === districtCode);
    if (area) info.city = chinaCityMap[area.cityCode.slice(0, 4)];
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
