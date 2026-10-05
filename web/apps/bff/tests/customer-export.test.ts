import { describe, expect, it } from 'vitest';
import {
  buildExportFilePlans,
  EXCEL_DATA_ROWS_PER_SHEET,
  exportWorksheetName,
} from '../src/modules/customer-export.service';

describe('customer export grouping', () => {
  it('splits resident IDs by province and combines every non-resident type', () => {
    expect(buildExportFilePlans([
      { province: '江苏省', _count: { _all: 20 } },
      { province: '浙江省', _count: { _all: 8 } },
      { province: null, _count: { _all: 3 } },
    ], 21)).toEqual([
      {
        kind: 'resident_province',
        archiveName: '江苏省-20条.xlsx',
        count: 20,
        province: '江苏省',
      },
      {
        kind: 'resident_province',
        archiveName: '浙江省-8条.xlsx',
        count: 8,
        province: '浙江省',
      },
      {
        kind: 'resident_province',
        archiveName: '未知省份-3条.xlsx',
        count: 3,
        province: null,
      },
      {
        kind: 'non_resident',
        archiveName: '非居民身份证-21条.xlsx',
        count: 21,
      },
    ]);
  });

  it('does not create an empty non-resident file', () => {
    expect(buildExportFilePlans([], 0)).toEqual([]);
  });

  it('uses additional worksheets without exceeding the Excel row limit', () => {
    expect(EXCEL_DATA_ROWS_PER_SHEET).toBe(1_048_575);
    expect(exportWorksheetName(0)).toBe('customers');
    expect(exportWorksheetName(1)).toBe('customers-2');
  });
});
