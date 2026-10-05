import { describe, expect, it } from 'vitest';
import { buildExportFilePlans } from '../src/modules/customer-export.service';

describe('customer export grouping', () => {
  it('splits resident IDs by city and combines every non-resident type', () => {
    expect(buildExportFilePlans([
      { province: '江苏省', city: '苏州市', _count: { _all: 12 } },
      { province: '江苏省', city: '南京市', _count: { _all: 8 } },
      { province: null, city: null, _count: { _all: 3 } },
    ], 21)).toEqual([
      {
        kind: 'resident_city',
        archiveName: '江苏省-苏州市-12条.xlsx',
        count: 12,
        province: '江苏省',
        city: '苏州市',
      },
      {
        kind: 'resident_city',
        archiveName: '江苏省-南京市-8条.xlsx',
        count: 8,
        province: '江苏省',
        city: '南京市',
      },
      {
        kind: 'resident_city',
        archiveName: '未知省份-未知城市-3条.xlsx',
        count: 3,
        province: null,
        city: null,
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
});
