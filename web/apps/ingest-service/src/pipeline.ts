import type { CustomerRow, DedupeConfig, IngestSchema, SchemaColumn } from './types';
import { TRANSFORMS } from './transforms';
import { parseIdCard } from './id-card';
import { documentKey, normalizeDocument } from './document';

export class CleaningError extends Error {
  constructor(public readonly reason: string, public readonly raw: unknown[]) {
    super(reason);
  }
}

export interface CleanedRow {
  row: CustomerRow;
  /** 清洗阶段生成的非致命告警，调用方可写入 ingest_row_log（如 id_card_checksum_invalid）。 */
  warnings: string[];
}

/**
 * 中文表头 → 字段名的回落映射。
 * 当真实 Excel 的列顺序 / 列数与 schema.columns.mappings 的硬编码 index 不一致时，
 * 会尝试用这张表按表头名匹配，避免手机号 / 地址 / 身份证等关键字段"看起来丢失"。
 */
// 顺序敏感：越具体 / 越长的 keyword 要排在越前面，先命中更长的词再回落到短别名。
// 例如 '手机号码' 要排在 '手机' 之前，'居住地址' 由 buildDynamicMappings 显式丢弃不进此表。
const HEADER_TO_FIELD: Array<{ keywords: string[]; field: keyof CustomerRow; transform?: string; transform_args?: unknown[] }> = [
  { keywords: ['统计时间', '采集时间', '登记时间', '登记日期', '入库时间', '建档时间', '创建时间'], field: 'stat_time', transform: 'parse_date' },
  { keywords: ['编码编号', '编码号', '户籍编号', '户籍号', '客户编号', '编号'], field: 'huji_no', transform: 'strip_prefix_digits', transform_args: ['2016户籍统计'] },
  { keywords: ['出生日期', '出生年月', '出生日', '生日'], field: 'birth_date', transform: 'parse_date' },
  { keywords: ['性别'], field: 'gender', transform: 'map_gender' },
  { keywords: ['证件类型', '证件种类', '身份证件类型'], field: 'id_type' },
  { keywords: ['公民身份号码', '身份证件号码', '身份证件号', '身份证号码', '身份证号', '身份证', '证件号码', '证件号', '组织机构代码', '统一社会信用代码', '护照号码', '通行证号码'], field: 'id_card', transform: 'mask_id_card' },
  { keywords: ['客户姓名', '姓名', '名字', '客户名', '企业名称', '机构名称'], field: 'name' },
  { keywords: ['手机号码', '移动电话', '联系电话', '联系方式', '客户手机', '客户电话', '手机号', '手机', '电话'], field: 'phone_masked', transform: 'mask_phone_mid4' },
  { keywords: ['详细地址', '家庭地址', '通讯地址', '现住地址', '现住址', '住址', '地址'], field: 'address' },
  { keywords: ['省份', '所在省', '省'], field: 'province' },
  { keywords: ['所在市', '城市', '市'], field: 'city' },
  { keywords: ['区县', '县区', '所在区', '行政区', '区域', '区', '县'], field: 'district' },
  { keywords: ['从事行业', '工作单位', '单位', '职业', '工作'], field: 'occupation' },
  { keywords: ['受教育程度', '文化程度', '学历'], field: 'education' },
  { keywords: ['婚姻状况', '婚姻', '婚否'], field: 'marital_status' },
];

const MAX_FIELD_LENGTHS: Partial<Record<keyof CustomerRow, number>> = {
  huji_no: 32,
  name: 64,
  gender: 1,
  id_card: 32,
  phone_masked: 64,
  address: 256,
  province: 32,
  city: 64,
  district: 64,
  occupation: 64,
  education: 32,
  marital_status: 16,
};

function matchFieldByHeader(header: string): { field: keyof CustomerRow; transform?: string; transform_args?: unknown[] } | null {
  const s = header.replace(/\s+/g, '');
  for (const rule of HEADER_TO_FIELD) {
    if (rule.keywords.some((k) => s === k || s.includes(k))) return rule;
  }
  return null;
}

/**
 * 把 ExcelJS 返回的任意 cell value 强制变成"干净的字符串或原值"：
 *   - 富文本 { richText: [...] } → 拼接 text
 *   - 超链接 { text, hyperlink } → text
 *   - 公式 { result } → result
 *   - 数字 → trim 后字符串
 *   - 普通字符串 → trim
 * 不这么做，手机号 / 地址等列可能被当成 { richText:[...] } 对象塞进 DB，前端看到的就是"空"。
 */
function coerceCell(raw: unknown): string | number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') return raw.trim() || undefined;
  if (typeof raw === 'number') return String(raw).trim();
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return obj.richText.map((seg: unknown) => (seg as { text?: string })?.text ?? '').join('').trim() || undefined;
    }
    if (typeof obj.text === 'string') return obj.text.trim() || undefined;
    if (obj.result != null) return coerceCell(obj.result);
    if (typeof obj.hyperlink === 'string') return obj.hyperlink.trim() || undefined;
  }
  const s = String(raw).trim();
  return s || undefined;
}

/**
 * 根据第 1 行表头，动态构建 column mapping。
 * 不再依赖 schema.columns.mappings 的硬编码 index——只要表头名字能匹配到 HEADER_TO_FIELD，
 * 就按真实列号映射。
 *
 * 策略：
 *   - "所属户籍站"、/^编码\d+$/ 等噪声列显式丢弃
 *   - 若同时出现"居住地址" + "地址 / 详细地址"：丢弃前者保留后者（Demo.xlsx 场景）；
 *     若只出现"居住地址"：把它也映射成 address，避免真实 Excel 只有"居住地址"一列时字段丢失
 *   - 返回 detected：所有被识别的列（原始表头 + 推导字段名），便于前端可视化校对
 */
export function buildDynamicMappings(header: unknown[]): {
  mappings: SchemaColumn[];
  dropIndexes: number[];
  detected: Array<{ index: number; header: string; field: keyof CustomerRow }>;
} {
  const seen = new Set<keyof CustomerRow>();
  const mappings: SchemaColumn[] = [];
  const dropIndexes: number[] = [];
  const detected: Array<{ index: number; header: string; field: keyof CustomerRow }> = [];

  // 第 1 遍：收集每个 cell 的归一化文本，便于后续决策
  const normalized = header.map((cell) => (cell == null ? '' : String(cell).trim()));
  const hasOtherAddress = normalized.some(
    (t) => t && t !== '居住地址' && ['地址', '详细地址', '家庭地址', '通讯地址', '现住址', '住址'].some((k) => t.includes(k)),
  );

  for (let i = 0; i < normalized.length; i += 1) {
    const text = normalized[i];
    const idx = i + 1;
    if (!text) {
      dropIndexes.push(idx);
      continue;
    }
    if (text === '所属户籍站' || /^编码\d+$/.test(text)) {
      dropIndexes.push(idx);
      continue;
    }
    if (text === '居住地址' && hasOtherAddress) {
      // Demo.xlsx 有"居住地址 + 地址"两列，优先后者；只有"居住地址"一列时走正常匹配
      dropIndexes.push(idx);
      continue;
    }
    const matched = matchFieldByHeader(text);
    if (!matched) {
      dropIndexes.push(idx);
      continue;
    }
    if (seen.has(matched.field)) {
      dropIndexes.push(idx);
      continue;
    }
    seen.add(matched.field);
    mappings.push({
      index: idx,
      field: matched.field,
      required: matched.field === 'name',
      transform: matched.transform,
      transform_args: matched.transform_args,
    });
    detected.push({ index: idx, header: text, field: matched.field });
  }
  return { mappings, dropIndexes, detected };
}

export function cleanRow(
  rawRow: unknown[],
  schema: IngestSchema,
  ctx: { source_file: string; source_row: number; ingest_batch: string },
): CustomerRow {
  const { row } = cleanRowDetailed(rawRow, schema, ctx);
  return row;
}

/** 带 warnings 的清洗入口。cleanRow 保留只返回 row 的轻量签名用于测试。 */
export function cleanRowDetailed(
  rawRow: unknown[],
  schema: IngestSchema,
  ctx: { source_file: string; source_row: number; ingest_batch: string },
): CleanedRow {
  const dropSet = new Set(
    schema.columns.drop_indexes.map((i) => (i < 0 ? rawRow.length + i + 1 : i)),
  );

  const row: Partial<CustomerRow> = {
    source_file: ctx.source_file,
    source_row: ctx.source_row,
    ingest_batch: ctx.ingest_batch,
  };
  const warnings: string[] = [];

  // Pass 1：先按配置填字段，但身份证列只做大小写归一，暂不脱敏
  let idCardRaw: string | undefined;

  for (const col of schema.columns.mappings) {
    if (dropSet.has(col.index)) continue;
    // 关键：所有 cell 先用 coerceCell 归一（处理富文本 / 公式 / 超链接等 ExcelJS 对象），
    // 不然 transforms 里的 String(raw) 会变成 "[object Object]"
    const raw = coerceCell(rawRow[col.index - 1]);

    if (col.field === 'id_card') {
      const normalized = raw == null ? '' : String(raw).trim().toUpperCase();
      idCardRaw = normalized || undefined;
      if (col.transform) {
        const fn = TRANSFORMS[col.transform];
        if (!fn) throw new CleaningError(`unknown_transform:${col.transform}`, rawRow);
      }
      if (col.required && !idCardRaw) {
        throw new CleaningError('required_missing:id_card', rawRow);
      }
      continue;
    }

    let value: unknown = raw;
    if (col.transform) {
      const fn = TRANSFORMS[col.transform];
      if (!fn) throw new CleaningError(`unknown_transform:${col.transform}`, rawRow);
      value = fn(raw, ...(col.transform_args ?? []));
    }

    if (col.required && (value == null || value === '')) {
      throw new CleaningError(`required_missing:${col.field}`, rawRow);
    }
    (row as Record<string, unknown>)[col.field] = value as never;
  }

  // 先准入，再派生和去重，避免“未知”等占位文本成为不同客户共享的身份键。
  const document = normalizeDocument(idCardRaw, row.id_type);
  if (document.error) {
    throw new CleaningError(document.error === 'id_card_required' ? 'required_missing:id_card' : document.error, rawRow);
  }
  row.id_card = document.value;
  row.id_type = document.type;
  warnings.push(...document.warnings);

  // Pass 2：用原始身份证派生，保留日期修正告警；只补充原字段缺失的值。
  if (idCardRaw && row.id_type === 'resident_id') {
    const info = parseIdCard(idCardRaw.normalize('NFKC').replace(/[\s\u200B\u200C\u200D\u00AD]/g, '').replace(/^#(.+)#$/, '$1'));
    if (info.province && !row.province) row.province = info.province;
    if (info.city && !row.city) row.city = info.city;
    if (info.district && !row.district) row.district = info.district;
    if (info.birth_date && !row.birth_date) row.birth_date = info.birth_date;
    if (info.gender && (!row.gender || row.gender === 'U')) row.gender = info.gender;
    if (info.birth_date_corrected) warnings.push('id_card_birth_date_corrected');
    if (info.checksum_valid === false) warnings.push('id_card_checksum_invalid');
    if (!info.province) warnings.push('id_card_province_unknown');
    if (!info.city) warnings.push('id_card_city_unknown');
    if (!info.district) warnings.push('id_card_district_unknown');
  }

  if (!row.name) {
    throw new CleaningError('required_missing:name', rawRow);
  }
  for (const [field, maxLength] of Object.entries(MAX_FIELD_LENGTHS)) {
    const value = row[field as keyof CustomerRow];
    if (typeof value === 'string' && [...value].length > maxLength) {
      throw new CleaningError(`value_too_long:${field}:${maxLength}`, rawRow);
    }
  }

  return { row: row as CustomerRow, warnings };
}

/**
 * 批次内去重器：按 dedupe.key 去重，默认保留最后一条；
 * 可选 secondary_key_warn 仅用于兼容旧配置的次级冲突告警。
 */
export class RowDeduper {
  private readonly byKey = new Map<string, CustomerRow>();
  private readonly bySecondary = new Map<string, string>(); // secondary → first-seen primary key
  readonly warnings: Array<{ row: CustomerRow; reason: string; against: string }> = [];

  constructor(private readonly cfg: DedupeConfig) {}

  /** 返回 true 表示入列成功；false 表示被同 key 覆盖/忽略。 */
  add(row: CustomerRow): boolean {
    const primary = this.cfg.key === 'id_card' && row.id_card
      ? documentKey(row)
      : String(row[this.cfg.key] ?? '');
    const k = primary || `__row_${row.source_row ?? Math.random().toString(36).slice(2)}`;

    if (this.cfg.secondary_key_warn) {
      const sv = String(row[this.cfg.secondary_key_warn] ?? '');
      if (sv) {
        const seen = this.bySecondary.get(sv);
        if (seen && seen !== k) {
          this.warnings.push({ row, reason: `${this.cfg.secondary_key_warn}_conflict`, against: seen });
        } else if (!seen) {
          this.bySecondary.set(sv, k);
        }
      }
    }

    const exists = this.byKey.has(k);
    if (!exists) {
      this.byKey.set(k, row);
      return true;
    }
    if ((this.cfg.keep ?? 'last') === 'last') {
      this.byKey.set(k, row);
    }
    return false;
  }

  values(): IterableIterator<CustomerRow> {
    return this.byKey.values();
  }

  size(): number {
    return this.byKey.size;
  }
}
