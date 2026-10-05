import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REGION_DATASET_VERSION = 'MCA_2025-12-31';
export const REGION_RULE_VERSION = 'region-v1';

export type AdministrativeDivisionLevel = 'province' | 'prefecture' | 'county';
export type RegionMappingStatus =
  'current' | 'historical_mapped' | 'partial' | 'ambiguous' | 'unresolved' | 'not_applicable';
export type RegionMappingMethod =
  'current_code' | 'historical_crosswalk' | 'exact_name' | 'manual' | 'none';
export type RegionGroupType = 'municipality' | 'prefecture' | 'province_direct_county' | 'unknown';

interface SourceNode {
  code: string;
  name: string | null;
  level: number;
  type: string;
  children?: SourceNode[];
}

interface SourceResponse {
  data: SourceNode;
}

export interface AdministrativeDivisionMetadata {
  dataset_version: string;
  effective_date: string;
  fetched_at: string;
  source_page: string;
  source_url: string;
  source_table: string;
  source_hash: string;
  counts: Record<AdministrativeDivisionLevel, number>;
}

export interface AdministrativeDivision {
  dataset_version: string;
  source_code: string;
  code?: string;
  name: string;
  level: AdministrativeDivisionLevel;
  division_type: string;
  parent_source_code?: string;
  parent_code?: string;
}

export interface AdministrativeDivisionCrosswalk {
  source_code: string;
  source_name: string;
  source_level: AdministrativeDivisionLevel;
  source_type: string;
  target_code?: string;
  mapping_kind: string;
  mapping_scope: 'full' | 'parent_only' | 'ambiguous';
  auto_apply: boolean;
  confidence: number;
  evidence: string;
}

interface CrosswalkFile {
  rule_version: string;
  target_dataset_version: string;
  entries: AdministrativeDivisionCrosswalk[];
}

export interface RegionUnit {
  code: string;
  name: string;
  type: string;
}

export interface StandardizedAdministrativeRegion {
  origin_code?: string;
  current_province?: RegionUnit;
  current_prefecture?: RegionUnit;
  current_county?: RegionUnit;
  current_division_type?: string;
  group?: RegionUnit & { group_type: RegionGroupType };
  source: 'resident_id' | 'source_field';
  status: RegionMappingStatus;
  method: RegionMappingMethod;
  confidence: number;
  dataset_version: string;
  rule_version: string;
}

export interface AdministrativeDivisionDataset {
  metadata: AdministrativeDivisionMetadata;
  divisions: AdministrativeDivision[];
  crosswalk: AdministrativeDivisionCrosswalk[];
}

interface LoadedDataset extends AdministrativeDivisionDataset {
  byCode: Map<string, AdministrativeDivision>;
  crosswalkByCode: Map<string, AdministrativeDivisionCrosswalk[]>;
}

let datasetCache: LoadedDataset | undefined;

function configPath(fileName: string): string {
  return join(__dirname, '..', 'configs', 'administrative-division', fileName);
}

function normalizedCode(sourceCode: string): string | undefined {
  return /^\d{12}$/.test(sourceCode) ? sourceCode.slice(0, 6) : undefined;
}

function flattenSnapshot(root: SourceNode): AdministrativeDivision[] {
  const divisions: AdministrativeDivision[] = [];
  const visit = (node: SourceNode, parent?: SourceNode) => {
    if (node.level >= 1 && node.level <= 3 && node.name) {
      const level: AdministrativeDivisionLevel =
        node.level === 1 ? 'province' : node.level === 2 ? 'prefecture' : 'county';
      divisions.push({
        dataset_version: REGION_DATASET_VERSION,
        source_code: node.code,
        code: normalizedCode(node.code),
        name: node.name,
        level,
        division_type: node.type,
        parent_source_code: parent?.level ? parent.code : undefined,
        parent_code: parent ? normalizedCode(parent.code) : undefined,
      });
    }
    node.children?.forEach((child) => visit(child, node));
  };
  visit(root);
  return divisions;
}

function validateDataset(dataset: LoadedDataset): void {
  if (dataset.metadata.dataset_version !== REGION_DATASET_VERSION) {
    throw new Error(`region_dataset_version_mismatch:${dataset.metadata.dataset_version}`);
  }
  const actualCounts = dataset.divisions.reduce<Record<AdministrativeDivisionLevel, number>>(
    (counts, division) => {
      counts[division.level] += 1;
      return counts;
    },
    { province: 0, prefecture: 0, county: 0 },
  );
  for (const level of Object.keys(actualCounts) as AdministrativeDivisionLevel[]) {
    if (actualCounts[level] !== dataset.metadata.counts[level]) {
      throw new Error(`region_dataset_count_mismatch:${level}:${actualCounts[level]}`);
    }
  }
  for (const division of dataset.divisions) {
    if (division.level === 'province') continue;
    const parent = division.parent_code ? dataset.byCode.get(division.parent_code) : undefined;
    if (!parent) throw new Error(`region_parent_missing:${division.source_code}`);
    if (division.level === 'prefecture' && parent.level !== 'province') {
      throw new Error(`region_parent_level_invalid:${division.source_code}`);
    }
    if (division.level === 'county' && parent.level === 'county') {
      throw new Error(`region_parent_level_invalid:${division.source_code}`);
    }
  }
  for (const entry of dataset.crosswalk) {
    if (!/^\d{6}$/.test(entry.source_code)) {
      throw new Error(`region_crosswalk_source_invalid:${entry.source_code}`);
    }
    if (
      entry.auto_apply &&
      entry.mapping_scope !== 'ambiguous' &&
      (!entry.target_code || !dataset.byCode.has(entry.target_code))
    ) {
      throw new Error(`region_crosswalk_target_invalid:${entry.source_code}`);
    }
    if (entry.confidence < 0 || entry.confidence > 100) {
      throw new Error(`region_crosswalk_confidence_invalid:${entry.source_code}`);
    }
  }
}

export function loadAdministrativeDivisionDataset(): AdministrativeDivisionDataset {
  if (datasetCache) return datasetCache;
  const snapshotText = readFileSync(configPath(`${REGION_DATASET_VERSION}.json`), 'utf8');
  const metadata = JSON.parse(
    readFileSync(configPath(`${REGION_DATASET_VERSION}.meta.json`), 'utf8'),
  ) as AdministrativeDivisionMetadata;
  const actualHash = createHash('sha256').update(snapshotText).digest('hex');
  if (actualHash !== metadata.source_hash) {
    throw new Error(`region_snapshot_hash_mismatch:${actualHash}`);
  }
  const response = JSON.parse(snapshotText) as SourceResponse;
  const crosswalkFile = JSON.parse(
    readFileSync(configPath(`${REGION_RULE_VERSION}.crosswalk.json`), 'utf8'),
  ) as CrosswalkFile;
  if (
    crosswalkFile.rule_version !== REGION_RULE_VERSION ||
    crosswalkFile.target_dataset_version !== REGION_DATASET_VERSION
  ) {
    throw new Error('region_crosswalk_version_mismatch');
  }
  const divisions = flattenSnapshot(response.data);
  const byCode = new Map(
    divisions.flatMap((division) => (division.code ? [[division.code, division] as const] : [])),
  );
  const crosswalkByCode = new Map<string, AdministrativeDivisionCrosswalk[]>();
  for (const entry of crosswalkFile.entries) {
    const existing = crosswalkByCode.get(entry.source_code) ?? [];
    existing.push(entry);
    crosswalkByCode.set(entry.source_code, existing);
  }
  datasetCache = {
    metadata,
    divisions,
    crosswalk: crosswalkFile.entries,
    byCode,
    crosswalkByCode,
  };
  validateDataset(datasetCache);
  return datasetCache;
}

function toUnit(division: AdministrativeDivision): RegionUnit {
  if (!division.code) throw new Error(`region_code_missing:${division.source_code}`);
  return { code: division.code, name: division.name, type: division.division_type };
}

function resolveHierarchy(
  division: AdministrativeDivision,
  dataset: LoadedDataset,
): Pick<
  StandardizedAdministrativeRegion,
  'current_province' | 'current_prefecture' | 'current_county' | 'current_division_type' | 'group'
> {
  let province: AdministrativeDivision | undefined;
  let prefecture: AdministrativeDivision | undefined;
  let county: AdministrativeDivision | undefined;
  let cursor: AdministrativeDivision | undefined = division;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor.source_code)) throw new Error(`region_parent_cycle:${cursor.source_code}`);
    seen.add(cursor.source_code);
    if (cursor.level === 'province') province = cursor;
    if (cursor.level === 'prefecture') prefecture = cursor;
    if (cursor.level === 'county') county = cursor;
    cursor = cursor.parent_code ? dataset.byCode.get(cursor.parent_code) : undefined;
  }

  let group: StandardizedAdministrativeRegion['group'];
  if (province?.division_type === '直辖市') {
    group = { ...toUnit(province), group_type: 'municipality' };
  } else if (prefecture) {
    group = { ...toUnit(prefecture), group_type: 'prefecture' };
  } else if (county && province) {
    group = { ...toUnit(county), group_type: 'province_direct_county' };
  }
  return {
    current_province: province ? toUnit(province) : undefined,
    current_prefecture: prefecture ? toUnit(prefecture) : undefined,
    current_county: county ? toUnit(county) : undefined,
    current_division_type: division.division_type,
    group,
  };
}

function baseResult(
  source: StandardizedAdministrativeRegion['source'],
): Pick<StandardizedAdministrativeRegion, 'source' | 'dataset_version' | 'rule_version'> {
  return {
    source,
    dataset_version: REGION_DATASET_VERSION,
    rule_version: REGION_RULE_VERSION,
  };
}

export function standardizeAdministrativeRegion(
  idType: string | null | undefined,
  normalizedIdCard: string | null | undefined,
): StandardizedAdministrativeRegion {
  if (idType !== 'resident_id') {
    return {
      ...baseResult('source_field'),
      status: 'not_applicable',
      method: 'none',
      confidence: 0,
    };
  }
  const originCode = /^\d{6}/.exec(normalizedIdCard ?? '')?.[0];
  if (!originCode) {
    return {
      ...baseResult('resident_id'),
      status: 'unresolved',
      method: 'none',
      confidence: 0,
    };
  }

  const dataset = loadAdministrativeDivisionDataset() as LoadedDataset;
  const current = dataset.byCode.get(originCode);
  if (current) {
    return {
      ...baseResult('resident_id'),
      origin_code: originCode,
      ...resolveHierarchy(current, dataset),
      status: 'current',
      method: 'current_code',
      confidence: 100,
    };
  }

  const candidates = dataset.crosswalkByCode.get(originCode) ?? [];
  if (candidates.length !== 1 || candidates[0].mapping_scope === 'ambiguous') {
    return {
      ...baseResult('resident_id'),
      origin_code: originCode,
      status: candidates.length ? 'ambiguous' : 'unresolved',
      method: candidates.length ? 'historical_crosswalk' : 'none',
      confidence: candidates.length ? Math.max(...candidates.map((item) => item.confidence)) : 0,
    };
  }
  const mapping = candidates[0];
  const target = mapping.target_code ? dataset.byCode.get(mapping.target_code) : undefined;
  if (!mapping.auto_apply || !target) {
    return {
      ...baseResult('resident_id'),
      origin_code: originCode,
      status: mapping.mapping_scope === 'parent_only' ? 'partial' : 'unresolved',
      method: 'historical_crosswalk',
      confidence: mapping.confidence,
    };
  }
  return {
    ...baseResult('resident_id'),
    origin_code: originCode,
    ...resolveHierarchy(target, dataset),
    status: mapping.mapping_scope === 'parent_only' ? 'partial' : 'historical_mapped',
    method: 'historical_crosswalk',
    confidence: mapping.confidence,
  };
}
