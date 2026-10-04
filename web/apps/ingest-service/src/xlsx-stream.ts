import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { Open } from 'unzipper';
import { SaxesParser } from 'saxes';

export interface ParsedRow {
  rowNo: number;
  values: unknown[];
}

interface ZipEntryInfo {
  path: string;
  uncompressedSize?: number;
  vars?: { uncompressedSize?: number };
  stream(): NodeJS.ReadableStream;
}

function corruptedArchiveError(entryPath: string): Error {
  return new Error(`xlsx_archive_corrupted:${entryPath}`);
}

async function assertZipEntryReadable(entry: ZipEntryInfo): Promise<void> {
  try {
    await pipeline(
      entry.stream(),
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    );
  } catch {
    throw corruptedArchiveError(entry.path);
  }
}

function envBytes(name: string, fallbackMb: number): number {
  const value = Number(process.env[name] ?? fallbackMb);
  return value * 1024 * 1024;
}

async function parseSharedStrings(stream: NodeJS.ReadableStream): Promise<string[]> {
  const values: string[] = [];
  let inString = false;
  let inText = false;
  let current = '';
  const parser = new SaxesParser();
  const localName = (name: string) => name.split(':').at(-1);

  parser.on('opentag', (tag) => {
    const name = localName(tag.name);
    if (name === 'si') {
      inString = true;
      current = '';
    } else if (inString && name === 't') {
      inText = true;
    }
  });
  parser.on('text', (text) => {
    if (inString && inText) current += text;
  });
  parser.on('cdata', (text) => {
    if (inString && inText) current += text;
  });
  parser.on('closetag', (tag) => {
    const name = localName(tag.name);
    if (name === 't') inText = false;
    if (name === 'si') {
      values.push(current);
      inString = false;
      current = '';
    }
  });

  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    parser.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  parser.close();
  return values;
}

/**
 * 使用 exceljs 的流式读取（WorkbookReader），避免整个工作簿加载到内存。
 * 对 1 GB 级 xlsx 文件内存控制在 ~400 MB 以内。
 */
export async function* streamXlsx(
  input: Readable,
  opts: { sheetIndex?: number; skipHeaderRows?: number } = {},
): AsyncGenerator<ParsedRow> {
  const sheetIndex = opts.sheetIndex ?? 0;
  const skip = opts.skipHeaderRows ?? 1;
  const tempDir = await mkdtemp(join(tmpdir(), 'leadops-xlsx-'));
  const tempPath = join(tempDir, 'upload.xlsx');

  try {
    const disk = await statfs(tempDir);
    const availableBytes = disk.bavail * disk.bsize;
    const requiredTempBytes = envBytes('MAX_UPLOAD_MB', 512) * 2;
    if (availableBytes < requiredTempBytes) {
      throw new Error('xlsx_temp_disk_insufficient');
    }

    await pipeline(input, createWriteStream(tempPath));
    const compressedBytes = (await stat(tempPath)).size;
    const maxCompressedBytes = envBytes('MAX_UPLOAD_MB', 512);
    if (compressedBytes > maxCompressedBytes) throw new Error('xlsx_file_too_large');

    let sharedStrings: unknown[] = [];
    const zip = await Open.file(tempPath);
    const entries = zip.files as ZipEntryInfo[];
    const maxEntries = Number(process.env.XLSX_MAX_ENTRIES ?? 2000);
    if (entries.length > maxEntries) throw new Error('xlsx_too_many_zip_entries');
    const totalUncompressed = entries.reduce((total, entry) => (
      total + (entry.uncompressedSize ?? entry.vars?.uncompressedSize ?? 0)
    ), 0);
    const maxUncompressedBytes = envBytes('XLSX_MAX_UNCOMPRESSED_MB', 2048);
    if (totalUncompressed > maxUncompressedBytes) throw new Error('xlsx_uncompressed_size_exceeded');
    if (compressedBytes > 0 && totalUncompressed / compressedBytes > 200) {
      throw new Error('xlsx_compression_ratio_exceeded');
    }

    const sharedStringsEntry = entries.find((entry) => entry.path === 'xl/sharedStrings.xml');
    if (sharedStringsEntry) {
      const sharedStringsBytes = sharedStringsEntry.uncompressedSize
        ?? sharedStringsEntry.vars?.uncompressedSize
        ?? 0;
      if (sharedStringsBytes > envBytes('XLSX_MAX_SHARED_STRINGS_MB', 256)) {
        throw new Error('xlsx_shared_strings_size_exceeded');
      }
      try {
        sharedStrings = await parseSharedStrings(sharedStringsEntry.stream());
      } catch {
        throw corruptedArchiveError(sharedStringsEntry.path);
      }
    }

    const worksheetEntries = entries
      .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.path))
      .sort((left, right) => {
        const leftIndex = Number(left.path.match(/sheet(\d+)\.xml$/i)?.[1] ?? 0);
        const rightIndex = Number(right.path.match(/sheet(\d+)\.xml$/i)?.[1] ?? 0);
        return leftIndex - rightIndex;
      });
    const worksheetEntry = worksheetEntries[sheetIndex];
    if (!worksheetEntry) throw new Error(`xlsx_worksheet_missing:${sheetIndex}`);

    // Validate the complete deflate stream before yielding rows, so a damaged
    // worksheet cannot leave a partially committed import behind.
    await assertZipEntryReadable(worksheetEntry);

    const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(tempPath, {
      entries: 'ignore',
      sharedStrings: 'cache',
      styles: 'ignore',
      hyperlinks: 'ignore',
      worksheets: 'emit',
    });
    (workbookReader as unknown as { sharedStrings: unknown[] }).sharedStrings = sharedStrings;

    let currentSheet = -1;
    for await (const sheet of workbookReader as unknown as AsyncIterable<ExcelJS.stream.xlsx.WorksheetReader>) {
      currentSheet += 1;
      if (currentSheet !== sheetIndex) continue;

      for await (const row of sheet as unknown as AsyncIterable<ExcelJS.Row>) {
        if (row.number <= skip) continue;
        const values = (row.values as unknown[]).slice(1); // exceljs 的 values[0] 为占位
        if (values.every((value) => (
          value == null || (typeof value === 'string' && value.trim() === '')
        ))) {
          continue;
        }
        yield { rowNo: row.number, values };
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
