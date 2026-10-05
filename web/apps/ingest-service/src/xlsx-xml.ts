import { StringDecoder } from 'node:string_decoder';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import type { ParsedRow } from './xlsx-stream';

/** 所有 XML 入口共用有状态解码，避免中文或 emoji 被 ZIP 输出的块边界截断。 */
async function* decodedXml(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    yield decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const tail = decoder.end();
  if (tail) yield tail;
}

function attribute(tag: SaxesTagNS, name: string): string | undefined {
  return Object.values(tag.attributes).find((attr) => attr.local === name)?.value;
}

function spreadsheetText(value: string): string {
  // 单次替换，保留 _x005F_x0041_ 这样的字面量转义，不二次解码 XML 实体。
  return value.replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => (
    String.fromCharCode(Number.parseInt(hex, 16))
  ));
}

export async function parseSharedStrings(stream: NodeJS.ReadableStream): Promise<string[]> {
  const values: string[] = [];
  const parser = new SaxesParser({ xmlns: true });
  let inString = false;
  let inText = false;
  let phoneticDepth = 0;
  let current = '';
  parser.on('opentag', (tag) => {
    if (tag.local === 'si') {
      inString = true;
      current = '';
    } else if (tag.local === 'rPh') {
      phoneticDepth += 1;
    } else if (tag.local === 't' && inString && !phoneticDepth) {
      inText = true;
    }
  });
  const text = (value: string) => {
    if (inText) current += value;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', (tag) => {
    if (tag.local === 't') inText = false;
    if (tag.local === 'rPh') phoneticDepth -= 1;
    if (tag.local === 'si') {
      values.push(spreadsheetText(current));
      inString = false;
    }
  });
  for await (const chunk of decodedXml(stream)) parser.write(chunk);
  parser.close();
  return values;
}

export async function parseWorkbookSheets(stream: NodeJS.ReadableStream): Promise<string[]> {
  const ids: string[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (tag.local === 'sheet') ids.push(attribute(tag, 'id') ?? '');
  });
  for await (const chunk of decodedXml(stream)) parser.write(chunk);
  parser.close();
  return ids;
}

export interface WorkbookRelationship {
  id: string;
  target: string;
  type: string;
  external: boolean;
}

export async function parseWorkbookRelationships(
  stream: NodeJS.ReadableStream,
): Promise<WorkbookRelationship[]> {
  const relationships: WorkbookRelationship[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('opentag', (tag) => {
    if (tag.local !== 'Relationship') return;
    relationships.push({
      id: attribute(tag, 'Id') ?? '',
      target: attribute(tag, 'Target') ?? '',
      type: attribute(tag, 'Type') ?? '',
      external: attribute(tag, 'TargetMode') === 'External',
    });
  });
  for await (const chunk of decodedXml(stream)) parser.write(chunk);
  parser.close();
  return relationships;
}

function columnIndex(reference: string): number {
  const match = /^([A-Z]+)[1-9]\d*$/i.exec(reference);
  if (!match) throw new Error('xlsx_invalid_cell_reference');
  let column = 0;
  for (const ch of match[1].toUpperCase()) column = column * 26 + ch.charCodeAt(0) - 64;
  if (column > 16384) throw new Error('xlsx_invalid_cell_reference');
  return column - 1;
}

function cellValue(type: string, value: string, inline: string, shared: string[]): unknown {
  if (type === 'inlineStr') return spreadsheetText(inline);
  if (type === 's') {
    const index = Number(value);
    if (!value.trim() || !Number.isInteger(index) || index < 0 || index >= shared.length) {
      throw new Error('xlsx_shared_string_missing');
    }
    return shared[index];
  }
  if (type === 'str' || type === 'd') return spreadsheetText(value);
  if (!value) return undefined;
  if (type === 'b') return value === '1';
  if (type === 'e') return { error: value };
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error('xlsx_invalid_number');
  return numeric;
}

/** 只缓存当前行和当前 XML 块内的已完成行；公式读取缓存值，样式不参与解析。 */
export async function* parseWorksheet(
  stream: NodeJS.ReadableStream,
  sharedStrings: string[],
): AsyncGenerator<ParsedRow> {
  const parser = new SaxesParser({ xmlns: true });
  let ready: ParsedRow[] = [];
  let values: unknown[] | undefined;
  let rowNo = 0;
  let nextColumn = 0;
  let cell: { column: number; type: string; value: string; inline: string } | undefined;
  let inValue = false;
  let inInline = false;
  let inText = false;
  let phoneticDepth = 0;

  parser.on('opentag', (tag) => {
    if (tag.local === 'row') {
      rowNo = Number(attribute(tag, 'r') ?? rowNo + 1);
      if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > 1048576) {
        throw new Error('xlsx_invalid_row_number');
      }
      values = [];
      nextColumn = 0;
    } else if (tag.local === 'c' && values) {
      const reference = attribute(tag, 'r');
      const column = reference ? columnIndex(reference) : nextColumn;
      if (column >= 16384) throw new Error('xlsx_invalid_cell_reference');
      nextColumn = column + 1;
      cell = { column, type: attribute(tag, 't') ?? 'n', value: '', inline: '' };
    } else if (tag.local === 'v' && cell) {
      inValue = true;
    } else if (tag.local === 'is' && cell) {
      inInline = true;
    } else if (tag.local === 'rPh') {
      phoneticDepth += 1;
    } else if (tag.local === 't' && inInline && !phoneticDepth) {
      inText = true;
    }
  });
  const text = (value: string) => {
    if (!cell) return;
    if (inValue) cell.value += value;
    if (inText) cell.inline += value;
  };
  parser.on('text', text);
  parser.on('cdata', text);
  parser.on('closetag', (tag) => {
    if (tag.local === 'v') inValue = false;
    if (tag.local === 'is') inInline = false;
    if (tag.local === 't') inText = false;
    if (tag.local === 'rPh') phoneticDepth -= 1;
    if (tag.local === 'c' && cell && values) {
      values[cell.column] = cellValue(cell.type, cell.value, cell.inline, sharedStrings);
      cell = undefined;
    }
    if (tag.local === 'row' && values) {
      ready.push({ rowNo, values });
      values = undefined;
    }
  });
  for await (const chunk of decodedXml(stream)) {
    parser.write(chunk);
    yield* ready;
    ready = [];
  }
  parser.close();
  yield* ready;
}
