/**
 * 清洗变换集：固化一期规则。
 * 新增变换只需在 TRANSFORMS 注册即可，schema yaml 配置生效。
 */

export type Transformer = (value: unknown, ...args: unknown[]) => unknown;

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/** 去除指定前缀，仅保留数字。用于编码编号 "2016户籍统计12345678" → "12345678"。 */
export const stripPrefixDigits: Transformer = (value, prefix) => {
  if (value == null) return '';
  const s = String(value).trim();
  const p = String(prefix ?? '');
  const stripped = p && s.startsWith(p) ? s.slice(p.length) : s;
  return stripped.replace(/\D/g, '');
};

/** 性别映射 */
export const mapGender: Transformer = (value) => {
  const s = String(value ?? '').trim();
  if (s === '男' || s.toUpperCase() === 'M') return 'M';
  if (s === '女' || s.toUpperCase() === 'F') return 'F';
  return 'U';
};

/** 日期解析：支持 Excel 序列号 / yyyy-mm-dd / yyyy/mm/dd / yyyy.mm.dd / yyyymmdd / 带时间串；统一产出 "yyyy-MM-dd"（纯日期，无时区偏移） */
export const parseDate: Transformer = (value) => {
  if (value == null || value === '') return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 59) {
    const base = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(base.getTime() + Number(s) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const m = s.match(/^(\d{4})[-/.年]?(\d{1,2})[-/.月]?(\d{1,2})/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y >= 1800 && y <= 2100 && isValidCalendarDate(y, mo, d)) {
      return `${y}-${pad(mo)}-${pad(d)}`;
    }
  }
  return null;
};

/** 日期时间解析：支持 "yyyy/mm/dd HH:MM:SS"、ISO 和 Excel 序列号；统一产出 "yyyy-MM-dd HH:mm:ss"（本地时区） */
export const parseDateTime: Transformer = (value) => {
  if (value == null || value === '') return null;
  const toLocal = (d: Date) => {
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  if (value instanceof Date) return toLocal(value);
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const base = new Date(Date.UTC(1899, 11, 30));
    return toLocal(new Date(base.getTime() + Number(s) * 86400000));
  }
  return toLocal(new Date(s.replace(/\//g, '-')));
};

/** 手机号明文直通（一期不脱敏） */
export const maskPhoneMid4: Transformer = (value) => {
  const s = String(value ?? '').trim();
  return s;
};

/** 身份证明文直通（一期不脱敏），清洗空格/全角/软连字符/小写 x */
export const maskIdCard: Transformer = (value) => {
  if (value == null) return '';
  let s = String(value).trim();
  s = s.replace(/[\s\u00A0\u3000\u200B\u200C\u200D-]/g, '');
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[xｘ]/g, 'X');
  return s;
};

export const TRANSFORMS: Record<string, Transformer> = {
  strip_prefix_digits: stripPrefixDigits,
  map_gender: mapGender,
  parse_date: parseDate,
  parse_datetime: parseDateTime,
  mask_phone_mid4: maskPhoneMid4,
  mask_id_card: maskIdCard,
};
