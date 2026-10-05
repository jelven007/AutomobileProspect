import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDynamicMappings, cleanRow } from '../src/pipeline';
import type { IngestSchema } from '../src/types';
import { streamXlsx } from '../src/xlsx-stream';

const tempDirs: string[] = [];

async function corruptZipEntry(path: string, entryName: string): Promise<void> {
  const bytes = await readFile(path);
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  let offset = 0;

  while ((offset = bytes.indexOf(signature, offset)) !== -1) {
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (name === entryName) {
      const compressedSize = bytes.readUInt32LE(offset + 18);
      const dataStart = nameStart + nameLength + extraLength;
      bytes[dataStart + Math.floor(compressedSize / 2)] ^= 0xff;
      await writeFile(path, bytes);
      return;
    }
    offset = nameStart + nameLength + extraLength;
  }

  throw new Error(`zip_entry_not_found:${entryName}`);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('streamXlsx', () => {
  it('reads a normal Workbook file whose worksheets precede workbook metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leadops-xlsx-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'normal.xlsx');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('客户');
    sheet.addRow(['姓名', '身份证']);
    sheet.addRow(['张三', '510223197410137219']);
    await workbook.xlsx.writeFile(path);
    const rows = [];
    for await (const row of streamXlsx(createReadStream(path), { skipHeaderRows: 0 })) rows.push(row);
    expect(rows.map((row) => row.values)).toEqual([
      ['姓名', '身份证'], ['张三', '510223197410137219'],
    ]);
    const mappings = buildDynamicMappings(rows[0].values);
    const schema = {
      columns: { mappings: mappings.mappings, drop_indexes: mappings.dropIndexes },
    } as IngestSchema;
    expect(cleanRow(rows[1].values, schema, {
      source_file: 'normal.xlsx', source_row: rows[1].rowNo, ingest_batch: 'test',
    })).toMatchObject({ name: '张三', id_card: '510223197410137219' });
  });

  it.each([true, false])('preserves every Chinese/emoji cell across chunks (shared=%s)', async (shared) => {
    const dir = await mkdtemp(join(tmpdir(), 'leadops-xlsx-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'unicode.xlsx');
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path, useSharedStrings: shared, useStyles: false,
    });
    const sheet = workbook.addWorksheet('客户');
    const expected = Array.from({ length: 5000 }, (_, index) => [
      `客户${index}张三🙂`, `重庆市綦江县赶水镇太公村${index}号 & <门牌> &amp;`,
    ]);
    for (const values of expected) sheet.addRow(values).commit();
    await sheet.commit();
    await workbook.commit();
    const actual = [];
    for await (const row of streamXlsx(createReadStream(path), { skipHeaderRows: 0 })) actual.push(row.values);
    expect(actual).toEqual(expected);
  });

  it('selects sheets in workbook order, retaining sparse columns, rich text and cached formulas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leadops-xlsx-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'ordered.xlsx');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('先创建').addRow(['另一个工作表']);
    const sheet = workbook.addWorksheet('先显示');
    // 构造“显示顺序与 sheet1/sheet2 文件名相反”的合法工作簿。
    (sheet as unknown as { orderNo: number }).orderNo = 0;
    sheet.getCell('A1').value = '表头';
    sheet.getCell('A3').value = { richText: [{ text: '中文' }, { text: '🙂&amp;' }] };
    sheet.getCell('C3').value = { formula: '1+1', result: 2 };
    sheet.getCell('D3').value = { formula: '"缓存中文"', result: '缓存中文' };
    sheet.getCell('F3').value = true;
    await workbook.xlsx.writeFile(path);
    const rows = [];
    for await (const row of streamXlsx(createReadStream(path))) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0].rowNo).toBe(3);
    expect(Array.from(rows[0].values)).toEqual(['中文🙂&amp;', undefined, 2, '缓存中文', undefined, true]);
    const otherRows = [];
    for await (const row of streamXlsx(createReadStream(path), { sheetIndex: 1, skipHeaderRows: 0 })) {
      otherRows.push(row.values);
    }
    expect(otherRows).toEqual([['另一个工作表']]);
    await expect((async () => {
      for await (const _row of streamXlsx(createReadStream(path), { sheetIndex: 2 })) { /* drain */ }
    })()).rejects.toThrow('xlsx_worksheet_missing:2');
  });

  it('resolves shared-string cells when worksheet entries precede sharedStrings.xml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leadops-xlsx-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'shared-strings.xlsx');
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path,
      useSharedStrings: true,
      useStyles: false,
    });
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow([
      '所属户籍站', '统计时间', '居住地址', '编码编号', '出生日期',
      '性别', '身份证', '名字', '手机号', '地址', '编码1', '编码2',
    ]).commit();
    sheet.addRow([
      '重庆站', '2016/02/26 16:51:34', '旧地址', '2016户籍统计9161337', '1974/10/13',
      '男', '510223197410137219', '谭陆友', '13368168284', '重庆市綦江县赶水镇', 2, 8,
    ]).commit();
    sheet.addRow([]).commit();
    await sheet.commit();
    await workbook.commit();

    const rows = [];
    for await (const row of streamXlsx(createReadStream(path), {
      sheetIndex: 0,
      skipHeaderRows: 0,
    })) {
      rows.push(row);
    }

    expect(rows).toHaveLength(2);
    expect(rows[0].values.slice(0, 4)).toEqual([
      '所属户籍站', '统计时间', '居住地址', '编码编号',
    ]);
    expect(rows[1].values.slice(3, 10)).toEqual([
      '2016户籍统计9161337', '1974/10/13', '男', '510223197410137219',
      '谭陆友', '13368168284', '重庆市綦江县赶水镇',
    ]);

    const mapping = buildDynamicMappings(rows[0].values);
    expect(mapping.detected.map((item) => item.field)).toEqual([
      'stat_time', 'huji_no', 'birth_date', 'gender',
      'id_card', 'name', 'phone_masked', 'address',
    ]);
  });

  it('reports a clear error before yielding rows from a corrupted worksheet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'leadops-xlsx-test-'));
    tempDirs.push(dir);
    const path = join(dir, 'corrupted.xlsx');
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      filename: path,
      useSharedStrings: true,
      useStyles: false,
    });
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['姓名', '身份证']).commit();
    for (let index = 0; index < 100; index += 1) {
      sheet.addRow([`客户${index}`, `51022319741013${String(index).padStart(4, '0')}`]).commit();
    }
    await sheet.commit();
    await workbook.commit();
    await corruptZipEntry(path, 'xl/worksheets/sheet1.xml');

    const yieldedRows: unknown[] = [];
    await expect((async () => {
      for await (const row of streamXlsx(createReadStream(path), {
        sheetIndex: 0,
        skipHeaderRows: 0,
      })) {
        yieldedRows.push(row);
      }
    })()).rejects.toThrow('xlsx_archive_corrupted:xl/worksheets/sheet1.xml');
    expect(yieldedRows).toHaveLength(0);
  });
});
