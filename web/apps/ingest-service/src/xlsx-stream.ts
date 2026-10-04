import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';

export interface ParsedRow {
  rowNo: number;
  values: unknown[];
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

  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(input, {
    entries: 'emit',
    sharedStrings: 'cache',
    styles: 'ignore',
    hyperlinks: 'ignore',
    worksheets: 'emit',
  });

  let currentSheet = -1;
  for await (const sheet of workbookReader as unknown as AsyncIterable<ExcelJS.stream.xlsx.WorksheetReader>) {
    currentSheet += 1;
    if (currentSheet !== sheetIndex) continue;

    for await (const row of sheet as unknown as AsyncIterable<ExcelJS.Row>) {
      if (row.number <= skip) continue;
      const values = (row.values as unknown[]).slice(1); // exceljs 的 values[0] 为占位
      yield { rowNo: row.number, values };
    }
  }
}
