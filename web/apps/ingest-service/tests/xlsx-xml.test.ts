import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseSharedStrings, parseWorksheet } from '../src/xlsx-xml';

function byteStream(xml: string): Readable {
  return Readable.from(Array.from(Buffer.from(xml), (byte) => Buffer.from([byte])));
}

describe('XML decoding at every byte boundary', () => {
  it('preserves rich strings, entities and escapes without including phonetic annotations', async () => {
    const strings = await parseSharedStrings(byteStream(
      '<sst><si><r><t>重庆🙂 &amp;amp;</t></r><r><t> 綦江</t></r>'
      + '<rPh sb="0" eb="2"><t>chongqing</t></rPh></si>'
      + '<si><t>_x005F_x0041_</t></si><si><t><![CDATA[中文<&>]]></t></si></sst>',
    ));
    expect(strings).toEqual(['重庆🙂 &amp; 綦江', '_x0041_', '中文<&>']);
  });

  it('decodes inline strings and cached formula text, retaining column and row references', async () => {
    const rows = [];
    const xml = '<worksheet><sheetData><row r="7">'
      + '<c r="B7" t="inlineStr"><is><r><t>地址🙂</t></r><r><t>重庆&amp;amp;</t></r>'
      + '<rPh sb="0" eb="2"><t>拼音</t></rPh></is></c>'
      + '<c r="D7" t="str"><f>"中文"</f><v>公式中文🙂&amp;地址</v></c>'
      + '<c r="E7" t="n"><v>2.5</v></c><c r="F7" t="s"><v>0</v></c>'
      + '<c r="G7" t="d"><v>2024-02-29</v></c>'
      + '<c r="H7"><f>1+1</f></c>'
      + '</row></sheetData></worksheet>';
    for await (const row of parseWorksheet(byteStream(xml), ['共享🙂'])) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0].rowNo).toBe(7);
    expect(Array.from(rows[0].values)).toEqual([
      undefined, '地址🙂重庆&amp;', undefined, '公式中文🙂&地址', 2.5, '共享🙂', '2024-02-29', undefined,
    ]);
  });

  it('rejects missing shared strings instead of silently producing empty identity cells', async () => {
    await expect((async () => {
      for await (const _row of parseWorksheet(byteStream(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>2</v></c></row></sheetData></worksheet>',
      ), [])) { /* drain */ }
    })()).rejects.toThrow('xlsx_shared_string_missing');
  });
});
