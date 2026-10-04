import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDynamicMappings } from '../src/pipeline';
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
