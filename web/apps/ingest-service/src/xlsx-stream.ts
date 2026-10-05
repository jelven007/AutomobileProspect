import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { Open } from 'unzipper';
import {
  parseSharedStrings,
  parseWorkbookRelationships,
  parseWorkbookSheets,
  parseWorksheet,
} from './xlsx-xml';

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

async function readXml<T>(
  entry: ZipEntryInfo,
  parse: (stream: NodeJS.ReadableStream) => Promise<T>,
): Promise<T> {
  try {
    return await parse(entry.stream());
  } catch {
    throw corruptedArchiveError(entry.path);
  }
}

/**
 * 根据工作簿关系定位工作表，再以有状态 UTF-8 解码流式解析 XML。
 * 不依赖 ZIP 条目顺序，也不将整个工作表加载到内存。
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

    let sharedStrings: string[] = [];
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

    const requiredEntry = (path: string): ZipEntryInfo => {
      const entry = entries.find((item) => item.path === path);
      if (!entry) throw new Error(`xlsx_entry_missing:${path}`);
      return entry;
    };
    const sheetIds = await readXml(requiredEntry('xl/workbook.xml'), parseWorkbookSheets);
    const relationships = await readXml(
      requiredEntry('xl/_rels/workbook.xml.rels'),
      parseWorkbookRelationships,
    );
    const targetPath = (target: string) => posix.normalize(
      target.startsWith('/') ? target.slice(1) : posix.join('xl', target),
    );
    const worksheetRelation = relationships.find((relation) => (
      relation.id === sheetIds[sheetIndex]
      && relation.type.endsWith('/worksheet')
      && !relation.external
    ));
    if (!worksheetRelation) throw new Error(`xlsx_worksheet_missing:${sheetIndex}`);
    const worksheetEntry = requiredEntry(targetPath(worksheetRelation.target));

    const sharedRelation = relationships.find((relation) => (
      relation.type.endsWith('/sharedStrings') && !relation.external
    ));
    const sharedStringsEntry = sharedRelation
      ? requiredEntry(targetPath(sharedRelation.target))
      : entries.find((entry) => entry.path === 'xl/sharedStrings.xml');
    if (sharedStringsEntry) {
      const sharedStringsBytes = sharedStringsEntry.uncompressedSize
        ?? sharedStringsEntry.vars?.uncompressedSize
        ?? 0;
      if (sharedStringsBytes > envBytes('XLSX_MAX_SHARED_STRINGS_MB', 256)) {
        throw new Error('xlsx_shared_strings_size_exceeded');
      }
      sharedStrings = await readXml(sharedStringsEntry, parseSharedStrings);
    }

    // Validate the complete deflate stream before yielding rows, so a damaged
    // worksheet cannot leave a partially committed import behind.
    await assertZipEntryReadable(worksheetEntry);

    try {
      for await (const row of parseWorksheet(worksheetEntry.stream(), sharedStrings)) {
        if (row.rowNo <= skip) continue;
        if (row.values.every((value) => (
          value == null || (typeof value === 'string' && value.trim() === '')
        ))) {
          continue;
        }
        yield row;
      }
    } catch {
      throw corruptedArchiveError(worksheetEntry.path);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
