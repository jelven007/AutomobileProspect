import { describe, expect, it } from 'vitest';
import type { IngestSchema } from '@leadops/ingest-service';
import {
  adaptPhoneAddressMappings,
  resolveImportLayout,
} from '../src/modules/customer-import.service';

const baseSchema: IngestSchema = {
  source: { type: 's3', bucket: 'test', prefix: '' },
  parse: { skip_header_rows: 1, sheet: 0 },
  columns: {
    drop_indexes: [1, 3, -1, -2],
    mappings: [
      { index: 2, field: 'stat_time', transform: 'parse_date' },
      { index: 4, field: 'huji_no', transform: 'strip_prefix_digits' },
      { index: 5, field: 'birth_date', transform: 'parse_date' },
      { index: 6, field: 'gender', transform: 'map_gender' },
      { index: 7, field: 'id_card', transform: 'mask_id_card' },
      { index: 8, field: 'name', required: true },
      { index: 9, field: 'phone_masked', transform: 'mask_phone_mid4' },
      { index: 10, field: 'address' },
    ],
  },
  dedupe: { key: 'id_card', keep: 'last' },
  sink: {
    type: 'postgres',
    table: 'customer',
    batch_size: 1000,
    conflict_key: 'id_card',
  },
};

describe('resolveImportLayout', () => {
  it('uses dynamic mappings only when the first row is a real header', () => {
    const layout = resolveImportLayout(baseSchema, [
      '所属户籍站', '统计时间', '居住地址', '编码编号', '出生日期',
      '性别', '身份证', '名字', '手机号', '地址', '编码1', '编码2',
    ]);

    expect(layout.hasHeader).toBe(true);
    expect(layout.detected.map((item) => item.field)).toContain('id_card');
    expect(layout.detected.map((item) => item.field)).toContain('name');
  });

  it('corrects a mislabeled phone/address pair using the first data row', () => {
    const layout = resolveImportLayout(baseSchema, [
      '所属户籍站', '统计时间', '居住地址', '编码编号', '出生日期',
      '性别', '身份证', '名字', '手机号', '地址', '编码1', '编码2',
    ]);
    const reversedSchema = adaptPhoneAddressMappings(layout.schema, [
      '派出所户籍站',
      '2016/01/09 11:57:10',
      '户籍地址：有效',
      '2016户籍统计5151653',
      '1941/09/26',
      '男',
      '410926194109260015',
      '胡文修',
      '河南省范县城关镇１号院０号',
      '3743766666',
      7,
      3,
    ]);
    const standardSchema = adaptPhoneAddressMappings(layout.schema, [
      '派出所户籍站',
      '2016/01/21 09:13:46',
      '户籍地址：有效',
      '2016户籍统计8248391',
      '1941/09/26',
      '男',
      '410926194109260015',
      '胡文修',
      '18238333307',
      '河南省范县城关镇１号院０号',
      2,
      9,
    ]);
    const reversedByField = Object.fromEntries(
      reversedSchema.columns.mappings.map((mapping) => [mapping.field, mapping.index]),
    );
    const standardByField = Object.fromEntries(
      standardSchema.columns.mappings.map((mapping) => [mapping.field, mapping.index]),
    );

    expect(reversedByField).toMatchObject({ address: 9, phone_masked: 10 });
    expect(standardByField).toMatchObject({ address: 10, phone_masked: 9 });
  });

  it('treats a headerless customer row as data and swaps address/phone when needed', () => {
    const layout = resolveImportLayout(baseSchema, [
      '派出所户籍站',
      '2016/01/09 11:57:10',
      '户籍地址：有效',
      '2016户籍统计5151653',
      '1941/09/26',
      '男',
      '410926194109260015',
      '胡文修',
      '河南省范县城关镇１号院０号',
      '18238333307',
      7,
      3,
    ]);
    const byField = Object.fromEntries(
      layout.schema.columns.mappings.map((mapping) => [mapping.field, mapping.index]),
    );

    expect(layout.hasHeader).toBe(false);
    expect(layout.detected).toEqual([]);
    expect(byField).toMatchObject({
      id_card: 7,
      name: 8,
      address: 9,
      phone_masked: 10,
    });
  });

  it('keeps the configured phone/address order for headerless standard rows', () => {
    const layout = resolveImportLayout(baseSchema, [
      '派出所户籍站',
      '2016/01/09 11:57:10',
      '户籍地址：有效',
      '2016户籍统计5151653',
      '1941/09/26',
      '男',
      '410926194109260015',
      '胡文修',
      '18238333307',
      '河南省范县城关镇１号院０号',
      7,
      3,
    ]);
    const byField = Object.fromEntries(
      layout.schema.columns.mappings.map((mapping) => [mapping.field, mapping.index]),
    );

    expect(layout.hasHeader).toBe(false);
    expect(byField).toMatchObject({ phone_masked: 9, address: 10 });
  });
});
