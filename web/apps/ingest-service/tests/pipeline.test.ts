import { describe, it, expect } from 'vitest';
import {
  stripPrefixDigits,
  mapGender,
  parseDate,
  parseDateTime,
  maskPhoneMid4,
  maskIdCard,
} from '../src/transforms';
import { cleanRow, cleanRowDetailed, CleaningError, RowDeduper, buildDynamicMappings } from '../src/pipeline';
import { isValidIdCardIdentity, normalizeIdCardForStorage, parseIdCard } from '../src/id-card';
import type { IngestSchema } from '../src/types';

describe('stripPrefixDigits', () => {
  it.each([
    ['2016户籍统计9161337', '9161337'],
    ['2016户籍统计 1295051', '1295051'],
    ['6894796', '6894796'],
    ['2016户籍统计ABC-123-456', '123456'],
    ['', ''],
    [null, ''],
  ])('%p → %p', (input, expected) => {
    expect(stripPrefixDigits(input, '2016户籍统计')).toBe(expected);
  });
});

describe('mapGender', () => {
  it('maps 男/女', () => {
    expect(mapGender('男')).toBe('M');
    expect(mapGender('女')).toBe('F');
    expect(mapGender('')).toBe('U');
  });
});

describe('maskPhoneMid4 (一期保留明文)', () => {
  it('passes through phone as-is (明文存储决策)', () => {
    expect(maskPhoneMid4('13368168284')).toBe('13368168284');
    expect(maskPhoneMid4('13452056005')).toBe('13452056005');
  });
});

describe('maskIdCard (一期保留明文)', () => {
  it('passes through 18-digit id card as-is (明文存储决策)', () => {
    expect(maskIdCard('510223197410137219')).toBe('510223197410137219');
    expect(maskIdCard('510227197910282119')).toBe('510227197910282119');
  });
  it('returns as-is for non-18', () => {
    expect(maskIdCard('')).toBe('');
    expect(maskIdCard('12345')).toBe('12345');
  });
});

describe('parseDate / parseDateTime', () => {
  it('parses birth_date yyyy/mm/dd', () => {
    expect(parseDate('1974/10/13')).toBe('1974-10-13');
  });
  it('parses stat_time with time', () => {
    expect(parseDateTime('2016/02/26 16:51:34')).toBe('2016-02-26 16:51:34');
  });
  it('rejects impossible calendar dates so id_card enrichment can replace them', () => {
    expect(parseDate('1974/02/30')).toBeNull();
    expect(parseDate('2023/02/29')).toBeNull();
    expect(parseDate('2024/02/29')).toBe('2024-02-29');
  });
});

const schema: IngestSchema = {
  source: { type: 's3', bucket: 'b', prefix: '' },
  parse: { skip_header_rows: 1, sheet: 0 },
  columns: {
    drop_indexes: [1, 3, -1, -2],
    mappings: [
      { index: 2, field: 'stat_time', transform: 'parse_datetime' },
      { index: 4, field: 'huji_no', transform: 'strip_prefix_digits', transform_args: ['2016户籍统计'] },
      { index: 5, field: 'birth_date', transform: 'parse_date' },
      { index: 6, field: 'gender', transform: 'map_gender' },
      { index: 7, field: 'id_card', transform: 'mask_id_card' },
      { index: 8, field: 'name', required: true },
      { index: 9, field: 'phone_masked', transform: 'mask_phone_mid4' },
      { index: 10, field: 'address' },
    ],
  },
  dedupe: { key: 'id_card', keep: 'last' },
  sink: { type: 'postgres', table: 'customer', batch_size: 2000, conflict_key: 'id_card' },
};

const ctx = { source_file: 'Demo.xlsx', source_row: 2, ingest_batch: 'b1' };

describe('identity admission before deduplication', () => {
  const identitySchema: IngestSchema = {
    ...schema,
    columns: {
      drop_indexes: [],
      mappings: [{ index: 1, field: 'name', required: true }, { index: 2, field: 'id_card' }],
    },
  };

  it.each([
    '未知', '无', 'NULL', '-', '12345', '111111111111111', '0'.repeat(18),
    '51022319741013721A', '5.10223197410137219E+17', '510223000001017219',
    '000000197410137219', '未知未知未知未知未知未知未知未知未知',
  ])('rejects invalid identity %s without deriving identity attributes', (value) => {
    expect(() => cleanRow(['客户甲', value], identitySchema, ctx)).toThrow(
      value === '-' ? 'required_missing:id_card' : 'invalid_id_card_format',
    );
    expect(parseIdCard(value)).toEqual({});
    expect(isValidIdCardIdentity(normalizeIdCardForStorage(value).value)).toBe(false);
  });

  it('never merges two different names sharing the same placeholder', () => {
    const deduper = new RowDeduper(identitySchema.dedupe);
    const rejected: string[] = [];
    for (const name of ['客户甲', '客户乙']) {
      try {
        deduper.add(cleanRow([name, '未知'], identitySchema, ctx));
      } catch (error) {
        expect(error).toBeInstanceOf(CleaningError);
        rejected.push((error as CleaningError).reason);
      }
    }
    expect(rejected).toEqual(['invalid_id_card_format', 'invalid_id_card_format']);
    expect(deduper.size()).toBe(0);
  });

  it.each([
    '510223741013721', '51022319741013721', '510223197410137219',
    '５１０２２３１９７４１０１３７２１９', ' 510223 19741013 7219 ',
  ])('normalizes compatible identity %s to the same key', (value) => {
    expect(cleanRow(['客户', value], identitySchema, ctx).id_card).toBe('510223197410137219');
  });

  it('accepts lowercase x, historical/unknown districts and bad checksums with warnings', () => {
    expect(cleanRow(['客户', '11010519491231002x'], identitySchema, ctx).id_card).toBe('11010519491231002X');
    const { row, warnings } = cleanRowDetailed(['客户', '999999197410137219'], identitySchema, ctx);
    expect(row.id_card).toBe('999999197410137219');
    expect(warnings).toContain('id_card_province_unknown');
    expect(cleanRowDetailed(['客户', '510223197410137210'], identitySchema, ctx).warnings)
      .toContain('id_card_checksum_invalid');
  });
});

describe('cleanRow (真实 Demo.xlsx 结构)', () => {
  it('drops 1/3/-1/-2 and maps 真实样例', () => {
    const row = ['派出所户籍站', '2016/02/26 16:51:34', '户籍地址：有效', '2016户籍统计9161337',
      '1974/10/13', '男', '510223197410137219', '谭陆友', '13368168284',
      '重庆市綦江县赶水镇太公村4组', '2', '8'];
    const out = cleanRow(row, schema, ctx);
    expect(out.huji_no).toBe('9161337');
    expect(out.name).toBe('谭陆友');
    expect(out.gender).toBe('M');
    expect(out.birth_date).toBe('1974-10-13');
    expect(out.phone_masked).toBe('13368168284');
    expect(out.id_card).toBe('510223197410137219');
    expect(out.address).toBe('重庆市綦江县赶水镇太公村4组');
    expect(out.stat_time).toBe('2016-02-26 16:51:34');
    // 身份证派生：5102/510223 使用 GB/T 2260 历史快照
    expect(out.province).toBe('四川省');
    expect(out.city).toBe('重庆市');
    expect(out.district).toBe('綦江县');
  });

  it.each(['ABC-123', '未知', ''])('accepts nonnumeric or empty huji_no %s without a digit transform', (hujiNo) => {
    const noTransformSchema: IngestSchema = {
      ...schema,
      columns: {
        ...schema.columns,
        mappings: schema.columns.mappings.map((column) => column.field === 'huji_no'
          ? { ...column, transform: undefined, transform_args: undefined }
          : column),
      },
    };
    const row = ['派出所', '2016/02/26', '地址', hujiNo, '', '男',
      '510223197410137219', '张三', '1', 'a', 'x', 'y'];
    expect(cleanRow(row, noTransformSchema, ctx)).toMatchObject({
      name: '张三', id_card: '510223197410137219', huji_no: hujiNo || undefined,
    });
  });

  it.each([['ABC-123', '123'], ['未知', ''], ['', '']])('retains configured code cleaning for %s', (raw, expected) => {
    const row = ['派出所', '2016/02/26', '地址', raw, '', '男',
      '510223197410137219', '张三', '1', 'a', 'x', 'y'];
    expect(cleanRow(row, schema, ctx)).toMatchObject({
      name: '张三', id_card: '510223197410137219', huji_no: expected,
    });
  });

  it('throws when name missing', () => {
    const row = ['派出所', 't', '地址', '2016户籍统计123', '', '男', 'x', '', '1', 'a', 'x', 'y'];
    expect(() => cleanRow(row, schema, ctx)).toThrow(CleaningError);
  });

  it('throws when id_card is missing', () => {
    const row = ['派出所', '2016/02/26 16:51:34', '地址', '2016户籍统计123', '', '男', '', '张三', '1', 'a', 'x', 'y'];
    expect(() => cleanRow(row, schema, ctx)).toThrow('required_missing:id_card');
  });

  it('enriches birth_date/gender from id_card when excel column is empty', () => {
    // Excel 原列的 birth_date 和 gender 都是空字符串
    const row = ['派出所户籍站', '2016/02/26 16:51:34', '户籍地址：有效', '2016户籍统计9161337',
      '', '', '510223199010137219', '谭陆友', '13368168284',
      '重庆市綦江县赶水镇太公村4组', '2', '8'];
    const out = cleanRow(row, schema, ctx);
    expect(out.birth_date).toBe('1990-10-13');  // 7-14 位
    expect(out.gender).toBe('M');               // 第 17 位 '1'=奇=M
  });

  it('does not overwrite excel-provided gender when id_card would say otherwise', () => {
    // 身份证第 17 位 2=偶=F，但 Excel 原列已给出 男=M，派生不覆盖
    const row = ['派出所户籍站', '2016/02/26 16:51:34', '户籍地址：有效', '2016户籍统计9161337',
      '1974/10/13', '男', '510223197410137229', '谭陆友', '13368168284',
      '重庆市綦江县赶水镇太公村4组', '2', '8'];
    const out = cleanRow(row, schema, ctx);
    expect(out.gender).toBe('M');
  });
});

describe('cleanRowDetailed', () => {
  it('accepts contact values longer than a standard 11-digit mobile number', () => {
    const row = ['派出所户籍站', '2016/02/26 16:51:34', '户籍地址：有效', '2016户籍统计9161337',
      '1974/10/13', '男', '510223197410137219', '谭陆友', '511623199012255035',
      '重庆市綦江县赶水镇太公村4组', '2', '8'];
    expect(cleanRowDetailed(row, schema, ctx).row.phone_masked).toBe('511623199012255035');
  });

  it('rejects overlong values as a row-level cleaning error', () => {
    const row = ['派出所户籍站', '2016/02/26 16:51:34', '户籍地址：有效', '2016户籍统计9161337',
      '1974/10/13', '男', '510223197410137219', '谭陆友', '1'.repeat(65),
      '重庆市綦江县赶水镇太公村4组', '2', '8'];
    expect(() => cleanRowDetailed(row, schema, ctx))
      .toThrowError('value_too_long:phone_masked:64');
  });

  it('emits id_card_checksum_invalid when check digit is wrong', () => {
    // 510223197410137219 的末位本是 9，这里改为 0 制造校验失败
    const row = ['派出所户籍站', '2016/02/26 16:51:34', '户籍地址：有效', '2016户籍统计9161337',
      '1974/10/13', '男', '510223197410137210', '谭陆友', '13368168284',
      '重庆市綦江县赶水镇太公村4组', '2', '8'];
    const { row: cleaned, warnings } = cleanRowDetailed(row, schema, ctx);
    expect(warnings).toContain('id_card_checksum_invalid');
    expect(cleaned.huji_no).toBe('9161337');  // 清洗仍成功，身份证明文入库
    expect(cleaned.id_card).toBe('510223197410137210');
  });

  it('corrects an impossible id_card birth date backwards before storage', () => {
    const row = ['派出所户籍站', '2016/01/15 11:53:06', '户籍地址：有效', '2016户籍统计3026015',
      '7402/30/14', '男', '220521740230141', '王玉辉', '13549657871',
      '通化县七道沟镇东明村', '8', '3'];
    const { row: cleaned, warnings } = cleanRowDetailed(row, schema, ctx);
    expect(cleaned.id_card).toBe('220521197402281418');
    expect(cleaned.birth_date).toBe('1974-02-28');
    expect(warnings).toContain('id_card_birth_date_corrected');
    expect(warnings).not.toContain('id_card_checksum_invalid');
  });

  it('no warnings when id_card is valid', () => {
    const row = ['派出所户籍站', '2016/02/26 16:51:34', '户籍地址：有效', '2016户籍统计9161337',
      '1974/10/13', '男', '510223197410137219', '谭陆友', '13368168284',
      '重庆市綦江县赶水镇太公村4组', '2', '8'];
    const { warnings } = cleanRowDetailed(row, schema, ctx);
    expect(warnings).toEqual([]);
  });
});

describe('parseIdCard', () => {
  it('extracts province/birth_date/gender from valid id card', () => {
    const info = parseIdCard('510223197410137219');
    expect(info.province).toBe('四川省');
    expect(info.birth_date).toBe('1974-10-13');
    expect(info.gender).toBe('M');  // 第 17 位 '1' 奇
  });

  it('resolves city for well-known modern codes', () => {
    expect(parseIdCard('510104199001012345').city).toBe('成都市');
  });

  it('resolves city and district via historical GB/T 2260 snapshots', () => {
    expect(parseIdCard('510223197410137219').city).toBe('重庆市');
    expect(parseIdCard('510223197410137219').district).toBe('綦江县');
    expect(parseIdCard('513524197410137219').city).toBe('黔江地区');
    expect(parseIdCard('513524197410137219').district).toBe('酉阳土家族苗族自治县');
    expect(parseIdCard('510212197410137219').district).toBe('沙坪坝区');
    expect(parseIdCard('120225197410137219').city).toBe('天津市');
    expect(parseIdCard('460002197410137219').city).toBe('海南省直辖县级行政区划');
  });

  it('resolves district for 6-digit code', () => {
    expect(parseIdCard('440305199001011234').district).toBe('南山区');
    expect(parseIdCard('500110199001011234').district).toBe('綦江区');
    expect(parseIdCard('110108199001011234').district).toBe('海淀区');
  });

  it('returns empty for non-18 id card', () => {
    expect(parseIdCard('')).toEqual({});
    expect(parseIdCard('12345')).toEqual({});
  });

  it('handles Beijing / Shanghai correctly', () => {
    expect(parseIdCard('110101199001012345').province).toBe('北京市');
    expect(parseIdCard('310115199001012345').province).toBe('上海市');
  });

  it('maps even last-digit-of-order to F', () => {
    expect(parseIdCard('510223197410137229').gender).toBe('F');
  });

  it('reports checksum_valid=false for bad check digit', () => {
    // 510223197410137219 的末位本是 9，这里改为 0 制造校验失败
    expect(parseIdCard('510223197410137210').checksum_valid).toBe(false);
    expect(parseIdCard('510223197410137219').checksum_valid).toBe(true);
  });

  it('corrects impossible dates and recalculates the checksum', () => {
    expect(normalizeIdCardForStorage('510223197402307219')).toEqual({
      value: '510223197402287217',
      birthDateCorrected: true,
      originalBirthDate: '1974-02-30',
      correctedBirthDate: '1974-02-28',
    });
    expect(normalizeIdCardForStorage('510223197402007219').value)
      .toBe('510223197401317218');
    expect(normalizeIdCardForStorage('21102119711131595')).toEqual({
      value: '211021197111305952',
      birthDateCorrected: true,
      originalBirthDate: '1971-11-31',
      correctedBirthDate: '1971-11-30',
    });
    const info = parseIdCard('510223197402307219');
    expect(info.birth_date).toBe('1974-02-28');
    expect(info.birth_date_corrected).toBe(true);
    expect(info.normalized_id_card).toBe('510223197402287217');
    expect(info.checksum_valid).toBe(true);
  });
});

describe('RowDeduper', () => {
  const dedupe = { key: 'id_card' as const, keep: 'last' as const };
  const mk = (huji_no: string, id_card = '', name = 'x') => ({
    huji_no, id_card, name,
    source_file: 'f', source_row: 0, ingest_batch: 'b',
  });

  it('keeps last for same id_card', () => {
    const d = new RowDeduper(dedupe);
    d.add(mk('100', 'IDCARD1', 'v1'));
    const added = d.add(mk('200', 'IDCARD1', 'v2'));
    expect(added).toBe(false);
    expect(d.size()).toBe(1);
    expect(Array.from(d.values())[0].name).toBe('v2');
    expect(Array.from(d.values())[0].huji_no).toBe('200');
    expect(d.warnings).toHaveLength(0);
  });
});

describe('buildDynamicMappings (基于表头的动态列识别)', () => {
  it('识别 Demo.xlsx 的 12 列表头（居住地址 + 地址 共存时丢弃前者）', () => {
    const header = ['所属户籍站', '统计时间', '居住地址', '编码编号', '出生日期', '性别',
      '身份证', '名字', '手机号', '地址', '编码1', '编码2'];
    const { mappings, dropIndexes, detected } = buildDynamicMappings(header);
    const map = Object.fromEntries(detected.map((d) => [d.field, d.index]));
    expect(map).toMatchObject({
      stat_time: 2, huji_no: 4, birth_date: 5, gender: 6,
      id_card: 7, name: 8, phone_masked: 9, address: 10,
    });
    // 所属户籍站 / 居住地址 / 编码1 / 编码2 均被丢弃
    expect(dropIndexes).toEqual(expect.arrayContaining([1, 3, 11, 12]));
    expect(mappings).toHaveLength(8);
  });

  it('列顺序不同也能识别（真实全国 Excel 的常见变体）', () => {
    const header = ['客户姓名', '身份证号码', '移动电话', '详细地址', '登记时间'];
    const { detected } = buildDynamicMappings(header);
    const map = Object.fromEntries(detected.map((d) => [d.field, d.index]));
    expect(map).toEqual({ name: 1, id_card: 2, phone_masked: 3, address: 4, stat_time: 5 });
  });

  it('只有"居住地址"时视为 address（不是无脑丢弃）', () => {
    const header = ['姓名', '身份证', '手机号', '居住地址'];
    const { detected } = buildDynamicMappings(header);
    expect(detected.find((d) => d.field === 'address')?.index).toBe(4);
  });

  it('关键字段都识别不到时返回空 mappings，上游可回落到 schema.yaml', () => {
    const header = ['A', 'B', 'C'];
    const { mappings } = buildDynamicMappings(header);
    expect(mappings).toHaveLength(0);
  });

  it('识别别名：联系方式/受教育程度/工作单位/婚姻状况', () => {
    const header = ['客户姓名', '身份证', '联系方式', '工作单位', '受教育程度', '婚姻状况'];
    const { detected } = buildDynamicMappings(header);
    const fields = detected.map((d) => d.field).sort();
    expect(fields).toEqual(['education', 'id_card', 'marital_status', 'name', 'occupation', 'phone_masked'].sort());
  });
});
