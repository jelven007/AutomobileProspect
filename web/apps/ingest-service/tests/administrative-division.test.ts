import { describe, expect, it } from 'vitest';
import {
  loadAdministrativeDivisionDataset,
  standardizeAdministrativeRegion,
} from '../src/administrative-division';
import { parseIdCard } from '../src/id-card';

describe('administrative division dataset', () => {
  it('loads the verified MCA 2025-12-31 snapshot', () => {
    const dataset = loadAdministrativeDivisionDataset();
    expect(dataset.metadata.dataset_version).toBe('MCA_2025-12-31');
    expect(dataset.metadata.source_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(dataset.metadata.counts).toEqual({
      province: 34,
      prefecture: 333,
      county: 2847,
    });
    expect(dataset.divisions).toHaveLength(3214);
  });

  it('contains four municipalities and 33 province-direct county units', () => {
    const dataset = loadAdministrativeDivisionDataset();
    const bySourceCode = new Map(
      dataset.divisions.map((division) => [division.source_code, division]),
    );
    const municipalities = dataset.divisions.filter(
      (division) => division.level === 'province' && division.division_type === '直辖市',
    );
    const provinceDirectCounties = dataset.divisions.filter((division) => {
      const parent = division.parent_source_code
        ? bySourceCode.get(division.parent_source_code)
        : undefined;
      return (
        division.level === 'county' &&
        parent?.level === 'province' &&
        parent.division_type !== '直辖市'
      );
    });
    expect(new Set(municipalities.map((division) => division.name))).toEqual(
      new Set(['北京市', '天津市', '上海市', '重庆市']),
    );
    expect(provinceDirectCounties).toHaveLength(33);
  });
});

describe('standardizeAdministrativeRegion', () => {
  it('resolves a current county into province, prefecture and business group', () => {
    expect(standardizeAdministrativeRegion('resident_id', '510104199001012345')).toMatchObject({
      origin_code: '510104',
      current_province: { code: '510000', name: '四川省' },
      current_prefecture: { code: '510100', name: '成都市' },
      current_county: { code: '510104', name: '锦江区' },
      group: { code: '510100', name: '成都市', group_type: 'prefecture' },
      status: 'current',
      method: 'current_code',
      confidence: 100,
    });
  });

  it('uses the province as the business group for a municipality', () => {
    expect(standardizeAdministrativeRegion('resident_id', '110105199001011234')).toMatchObject({
      current_province: { code: '110000', name: '北京市' },
      current_prefecture: undefined,
      current_county: { code: '110105', name: '朝阳区' },
      group: { code: '110000', name: '北京市', group_type: 'municipality' },
    });
  });

  it('uses the county as the business group for a province-direct unit', () => {
    expect(standardizeAdministrativeRegion('resident_id', '429004199001011234')).toMatchObject({
      current_province: { code: '420000', name: '湖北省' },
      current_prefecture: undefined,
      current_county: { code: '429004', name: '仙桃市' },
      group: { code: '429004', name: '仙桃市', group_type: 'province_direct_county' },
    });
  });

  it('maps a verified historical code without changing the origin code', () => {
    const region = standardizeAdministrativeRegion('resident_id', '510223197410137219');
    expect(region).toMatchObject({
      origin_code: '510223',
      current_province: { code: '500000', name: '重庆市' },
      current_county: { code: '500110', name: '綦江区' },
      status: 'historical_mapped',
      method: 'historical_crosswalk',
      confidence: 95,
    });
  });

  it('does not derive regions for non-resident documents', () => {
    expect(standardizeAdministrativeRegion('passport_cn', 'E12345678')).toMatchObject({
      source: 'source_field',
      status: 'not_applicable',
      method: 'none',
    });
  });

  it('marks an unknown resident code as unresolved', () => {
    expect(standardizeAdministrativeRegion('resident_id', '999999199001011234')).toMatchObject({
      origin_code: '999999',
      status: 'unresolved',
      method: 'none',
    });
  });

  it('does not auto-apply a historically reused code', () => {
    expect(standardizeAdministrativeRegion('resident_id', '362321199001011234')).toMatchObject({
      origin_code: '362321',
      status: 'ambiguous',
      method: 'historical_crosswalk',
      confidence: 100,
    });
  });

  it('keeps legacy names while exposing the current standardized region', () => {
    const info = parseIdCard('510223197410137219');
    expect(info.city).toBe('重庆市');
    expect(info.district).toBe('綦江县');
    expect(info.region?.current_county).toMatchObject({
      code: '500110',
      name: '綦江区',
    });
  });
});
