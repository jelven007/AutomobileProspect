import { describe, expect, it } from 'vitest';
import { documentKey, normalizeDocument } from '../src/document';
import { buildDynamicMappings, cleanRowDetailed, RowDeduper } from '../src/pipeline';
import type { IngestSchema } from '../src/types';

const ctx = { source_file: 'documents.xlsx', source_row: 2, ingest_batch: 'test' };
const schema: IngestSchema = {
  source: { type: 's3', bucket: '', prefix: '' },
  parse: { sheet: 0, skip_header_rows: 1 },
  columns: { drop_indexes: [], mappings: [
    { index: 1, field: 'name' }, { index: 2, field: 'id_card' }, { index: 3, field: 'id_type' },
  ] },
  sink: { type: 'postgres', table: 'customer', batch_size: 100, conflict_key: 'id_card' },
};

describe('document normalization and admission', () => {
  it('removes only an outside hash pair around a valid resident number', () => {
    expect(normalizeDocument('#11010519491231002x#')).toEqual({
      value: '11010519491231002X', type: 'resident_id', warnings: ['id_card_hash_wrapper_removed'],
    });
    for (const raw of ['##', '#未知#', '#12345#', '110105#19491231002X', '#11010519491231002X']) {
      expect(normalizeDocument(raw).error).toBe('invalid_id_card_format');
    }
  });

  it.each(["'", '‘', '’', '＇'])('removes the %s quote variant from resident IDs', (quote) => {
    expect(normalizeDocument(`${quote}11010519491231002x`)).toEqual({
      value: '11010519491231002X', type: 'resident_id', warnings: ['id_card_quote_removed'],
    });
  });

  it('derives resident attributes after removing a quote prefix', () => {
    const cleaned = cleanRowDetailed(['张三', "'11010519491231002x"], schema, ctx);
    expect(cleaned.row).toMatchObject({
      id_card: '11010519491231002X',
      id_type: 'resident_id',
      birth_date: '1949-12-31',
      gender: 'F',
      province: '北京市',
      city: '北京市',
    });
    expect(cleaned.warnings).toContain('id_card_quote_removed');
  });

  it.each([
    ['５６４３２４５４－５', 'organization_code', '564324545'],
    ['564324545', 'organization_code', '564324545'],
    ['91350211M000100Y46', 'credit_code', '91350211M000100Y46'],
    ['G12345670', 'passport_cn', 'G12345670'],
    ['EA1234567', 'passport_cn', 'EA1234567'],
    ['CA1234567', 'hk_macao_permit', 'CA1234567'],
    ['H1234567001', 'mainland_permit', 'H12345670'],
  ])('recognizes %s as %s', (input, type, value) => {
    expect(normalizeDocument(input)).toMatchObject({ value, type });
    expect(normalizeDocument(input).error).toBeUndefined();
  });

  it('rejects bad organization and credit checksums rather than inventing identities', () => {
    expect(normalizeDocument('56432454-6').error).toBe('invalid_id_card_format');
    expect(normalizeDocument('91350211M000100Y43').error).toBe('invalid_id_card_format');
  });

  it('requires a namespace for overlapping organization/passport numbers', () => {
    expect(normalizeDocument('G12345678').error).toBe('ambiguous_document_type');
    expect(normalizeDocument('G1234567-8').type).toBe('organization_code');
    expect(normalizeDocument('G12345678', '中国普通护照').type).toBe('passport_cn');
    expect(normalizeDocument('G12345678', '组织机构代码').type).toBe('organization_code');
  });

  it('keeps short numbers and placeholders out of auto detection', () => {
    for (const value of ['NULL', '未知', '13812345678', '12345678', '123456', '000000000', '000000000000000000']) {
      expect(normalizeDocument(value).error).toBeTruthy();
    }
    expect(normalizeDocument('12345678', '台胞证')).toMatchObject({ type: 'taiwan_permit', value: '12345678' });
    expect(normalizeDocument('12345678', 'other').error).toBe('unsupported_document_type');
    expect(normalizeDocument('564324545', 'resident_id').error).toBe('invalid_id_card_format');
  });

  it.each(['A123456(3)', 'AB123456(9)', 'C660495(A)'])('checks and round-trips Hong Kong ID %s', (value) => {
    expect(normalizeDocument(value)).toEqual({ value, type: 'hongkong_id', warnings: [] });
    expect(normalizeDocument(value.replace(/[()]/g, ''), '香港身份证'))
      .toEqual({ value, type: 'hongkong_id', warnings: [] });
    expect(normalizeDocument(value.toLowerCase().replace('(', '（').replace(')', '）')).value).toBe(value);
  });

  it('rejects HK check digit errors, malformed parentheses and compact auto detection', () => {
    for (const value of ['A123456(4)', 'AB123456(0)', 'C660495(0)', 'A123456(3', 'A1234563)',
      'A123456((3))', 'ABC123456(3)', 'A123456(B)', 'A123456']) {
      expect(normalizeDocument(value, 'hongkong_id').error).toBe('invalid_id_card_format');
    }
    expect(normalizeDocument('A1234563').error).toBe('invalid_id_card_format');
  });

  it('requires an explicit pending type and restricts it to genuinely ambiguous formats', () => {
    expect(normalizeDocument('G12345678').error).toBe('ambiguous_document_type');
    expect(normalizeDocument('G12345678', '证件类型待核实')).toEqual({
      value: 'G12345678', type: 'pending_document', warnings: ['document_type_pending_verification'],
    });
    for (const value of ['NULL', '未知', '13812345678', '12345678', 'ABC123', 'G12345670',
      '56432454-5', 'A123456(3)', '11010519491231002X']) {
      expect(normalizeDocument(value, 'pending_document').error).toBeTruthy();
    }
    const pending = cleanRowDetailed(['待核实客户', 'G12345678', '证件类型待核实'], schema, ctx);
    expect(pending.warnings).toEqual(['document_type_pending_verification']);
    expect(pending.row.birth_date).toBeUndefined();
    expect(pending.row.gender).toBeUndefined();
  });

  it('only derives resident attributes and retains existing date repair and checksum warnings', () => {
    const resident = cleanRowDetailed(['甲', '#220521740230141#'], schema, ctx);
    expect(resident.row).toMatchObject({ id_card: '220521197402281418', birth_date: '1974-02-28' });
    expect(resident.warnings).toContain('id_card_birth_date_corrected');
    const company = cleanRowDetailed(['测试机构', '56432454-5'], schema, ctx);
    expect(company.row.id_type).toBe('organization_code');
    expect(company.row.birth_date).toBeUndefined();
    expect(company.row.gender).toBeUndefined();
    expect(company.row.province).toBeUndefined();
    expect(company.warnings).toEqual([]);
  });

  it('keeps equal numbers from different namespaces during file dedupe', () => {
    const deduper = new RowDeduper({ key: 'id_card', keep: 'last' });
    const org = cleanRowDetailed(['组织', 'G12345678', '组织机构代码'], schema, ctx).row;
    const person = cleanRowDetailed(['个人', 'G12345678', '中国普通护照'], schema, { ...ctx, source_row: 3 }).row;
    expect(documentKey(org)).not.toBe(documentKey(person));
    deduper.add(org);
    deduper.add(person);
    deduper.add({ ...org, name: '更新' });
    expect([...deduper.values()].map((row) => row.name)).toEqual(['更新', '个人']);
  });

  it('recognizes the document type column before the generic identity header', () => {
    expect(buildDynamicMappings(['姓名', '身份证件类型', '证件号码']).detected.map((item) => item.field))
      .toEqual(['name', 'id_type', 'id_card']);
  });
});
