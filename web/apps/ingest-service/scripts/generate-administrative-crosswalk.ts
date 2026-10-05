#!/usr/bin/env tsx
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DATASET_VERSION = 'MCA_2025-12-31';
const RULE_VERSION = 'region-v1';
const HISTORY_MAX_YEAR = 2021;

type DivisionLevel = 'province' | 'prefecture' | 'county';
type MappingScope = 'full' | 'parent_only' | 'ambiguous' | 'unresolved';

interface CurrentNode {
  code: string;
  name: string | null;
  level: number;
  type: string;
  children?: CurrentNode[];
}

interface CurrentDivision {
  code?: string;
  name: string;
  level: DivisionLevel;
  type: string;
  parentCode?: string;
}

interface HistoryObservation {
  code: string;
  name: string;
  level: DivisionLevel;
  parentCode?: string;
  year: number;
}

interface HistoryCode {
  code: string;
  observations: HistoryObservation[];
  names: string[];
  parentCodes: string[];
  firstYear: number;
  lastYear: number;
  latest: HistoryObservation;
}

interface CrosswalkEntry {
  source_code: string;
  source_name: string;
  source_names?: string[];
  source_level: DivisionLevel;
  source_type: string;
  source_parent_codes?: string[];
  source_first_year?: number;
  source_last_year?: number;
  target_code?: string;
  candidate_target_codes?: string[];
  mapping_kind: string;
  mapping_scope: MappingScope;
  auto_apply: boolean;
  confidence: number;
  mapping_reason: string;
  evidence: string;
}

interface CandidateMatch {
  values: CurrentDivision[];
  locality: 'parent' | 'province' | 'global';
}

interface OverrideFile {
  rule_version: string;
  target_dataset_version: string;
  entries: CrosswalkEntry[];
}

function levelOf(value: number): DivisionLevel {
  if (value === 1) return 'province';
  if (value === 2) return 'prefecture';
  if (value === 3) return 'county';
  throw new Error(`unsupported_level:${value}`);
}

function code6(value: string): string | undefined {
  return /^\d{12}$/.test(value) ? value.slice(0, 6) : undefined;
}

function flattenCurrent(root: CurrentNode): CurrentDivision[] {
  const result: CurrentDivision[] = [];
  const visit = (node: CurrentNode, parent?: CurrentNode) => {
    if (node.level >= 1 && node.level <= 3 && node.name) {
      result.push({
        code: code6(node.code),
        name: node.name,
        level: levelOf(node.level),
        type: node.type,
        parentCode: parent ? code6(parent.code) : undefined,
      });
    }
    node.children?.forEach((child) => visit(child, node));
  };
  visit(root);
  return result;
}

function parseHistory(csv: string): Map<string, HistoryCode> {
  const grouped = new Map<string, HistoryObservation[]>();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const matched = line.match(
      /^(\d{12}),"((?:[^"]|"")*)",([123]),([^,]*),(\d{4}),([^,]*),([^,]*),(\d+)/,
    );
    if (!matched) continue;
    const [, sourceCode, escapedName, levelText, parentCode, yearText] = matched;
    const year = Number(yearText);
    if (year > HISTORY_MAX_YEAR) continue;
    const observation: HistoryObservation = {
      code: sourceCode.slice(0, 6),
      name: escapedName.replace(/""/g, '"').trim(),
      level: levelOf(Number(levelText)),
      parentCode: parentCode ? parentCode.slice(0, 6) : undefined,
      year,
    };
    const existing = grouped.get(observation.code) ?? [];
    existing.push(observation);
    grouped.set(observation.code, existing);
  }

  return new Map(
    [...grouped].map(([code, observations]) => {
      observations.sort((left, right) => left.year - right.year);
      return [
        code,
        {
          code,
          observations,
          names: [...new Set(observations.map((item) => item.name))],
          parentCodes: [...new Set(observations.flatMap((item) => item.parentCode ?? []))],
          firstYear: observations[0].year,
          lastYear: observations.at(-1)!.year,
          latest: observations.at(-1)!,
        },
      ];
    }),
  );
}

function inferType(name: string, level: DivisionLevel): string {
  if (name.endsWith('特别行政区')) return '特别行政区';
  if (name.endsWith('自治区')) return '自治区';
  if (name.endsWith('自治州')) return '自治州';
  if (name.endsWith('自治县')) return '自治县';
  if (name.endsWith('自治旗')) return '自治旗';
  if (name.endsWith('地区')) return '地区';
  if (name.endsWith('林区')) return '林区';
  if (name.endsWith('特区')) return '特区';
  if (name.endsWith('盟')) return '盟';
  if (name.endsWith('旗')) return '旗';
  if (name.endsWith('县')) return '县';
  if (name.endsWith('区')) return level === 'province' ? '自治区' : '市辖区';
  if (name.endsWith('市')) return level === 'county' ? '县级市' : '市';
  return level;
}

function canonicalName(name: string): string {
  const stripped = name.replace(
    /(?:特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|自治县|自治旗|地区|林区|特区|市|县|区|盟|旗)$/,
    '',
  );
  return stripped.length >= 2 ? stripped : name;
}

function uniqueByCode(values: CurrentDivision[]): CurrentDivision[] {
  return [
    ...new Map(values.flatMap((value) => (value.code ? [[value.code, value]] : []))).values(),
  ];
}

function evidence(historyPackage: string, historyHash: string, reason: string): string {
  return [`${historyPackage} sha512=${historyHash}`, `${DATASET_VERSION}`, `rule=${reason}`].join(
    '; ',
  );
}

function main(): void {
  const configDir = resolve(__dirname, '../configs/administrative-division');
  const snapshot = JSON.parse(
    readFileSync(resolve(configDir, `${DATASET_VERSION}.json`), 'utf8'),
  ) as { data: CurrentNode };
  const snapshotMetadata = JSON.parse(
    readFileSync(resolve(configDir, `${DATASET_VERSION}.meta.json`), 'utf8'),
  ) as { source_hash: string };
  const historyPath = require.resolve('@cndiv/source-history/data/divisions.csv');
  const historyManifest = JSON.parse(
    readFileSync(require.resolve('@cndiv/source-history/data/manifest.json'), 'utf8'),
  ) as { sha512: string; year_min: number; year_max: number };
  const historyPackageVersion = (
    JSON.parse(readFileSync(require.resolve('@cndiv/source-history/package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const historyPackage = `@cndiv/source-history@${historyPackageVersion}`;
  const overrides = JSON.parse(
    readFileSync(resolve(configDir, `${RULE_VERSION}.overrides.json`), 'utf8'),
  ) as OverrideFile;
  if (
    overrides.rule_version !== RULE_VERSION ||
    overrides.target_dataset_version !== DATASET_VERSION
  ) {
    throw new Error('region_override_version_mismatch');
  }

  const current = flattenCurrent(snapshot.data);
  const currentByCode = new Map(
    current.flatMap((division) => (division.code ? [[division.code, division] as const] : [])),
  );
  const history = parseHistory(readFileSync(historyPath, 'utf8'));
  const overrideByCode = new Map(overrides.entries.map((entry) => [entry.source_code, entry]));
  const decisions = new Map<string, CrosswalkEntry>();

  const currentCandidates = (
    source: HistoryCode,
    mode: 'exact' | 'canonical',
    parentTarget?: string,
  ): CandidateMatch => {
    const sourceName = mode === 'exact' ? source.latest.name : canonicalName(source.latest.name);
    const matching = current.filter((target) => {
      const targetName = mode === 'exact' ? target.name : canonicalName(target.name);
      return target.code && targetName === sourceName;
    });
    const sameParent = parentTarget
      ? matching.filter(
          (target) => target.parentCode === parentTarget || target.code === parentTarget,
        )
      : [];
    if (sameParent.length) return { values: uniqueByCode(sameParent), locality: 'parent' };
    const sameProvince = matching.filter(
      (target) => target.code?.slice(0, 2) === source.code.slice(0, 2),
    );
    if (sameProvince.length) {
      return { values: uniqueByCode(sameProvince), locality: 'province' };
    }
    return { values: uniqueByCode(matching), locality: 'global' };
  };

  const mappingScope = (
    source: HistoryCode,
    target: CurrentDivision,
  ): 'full' | 'parent_only' | 'ambiguous' => {
    if (source.latest.level === target.level) return 'full';
    if (
      source.latest.level === 'prefecture' &&
      target.level === 'province' &&
      target.type === '直辖市'
    ) {
      return 'full';
    }
    if (
      source.latest.level === 'county' &&
      (target.level === 'prefecture' || target.level === 'province')
    ) {
      return 'parent_only';
    }
    return 'ambiguous';
  };

  const parentTarget = (source: HistoryCode): string | undefined => {
    const sourceParent = source.latest.parentCode;
    if (!sourceParent) return undefined;
    if (currentByCode.has(sourceParent)) return sourceParent;
    const parentDecision = decisions.get(sourceParent);
    return parentDecision?.auto_apply ? parentDecision.target_code : undefined;
  };

  const buildGeneratedEntry = (
    source: HistoryCode,
    partial: Omit<
      CrosswalkEntry,
      | 'source_code'
      | 'source_name'
      | 'source_names'
      | 'source_level'
      | 'source_type'
      | 'source_parent_codes'
      | 'source_first_year'
      | 'source_last_year'
      | 'evidence'
    > & { evidence?: string },
  ): CrosswalkEntry => ({
    source_code: source.code,
    source_name: source.latest.name,
    ...(source.names.length > 1 ? { source_names: source.names } : {}),
    source_level: source.latest.level,
    source_type: inferType(source.latest.name, source.latest.level),
    ...(source.parentCodes.length ? { source_parent_codes: source.parentCodes } : {}),
    source_first_year: source.firstYear,
    source_last_year: source.lastYear,
    ...partial,
    evidence: [
      partial.evidence,
      evidence(historyPackage, historyManifest.sha512, partial.mapping_reason),
    ]
      .filter(Boolean)
      .join('; '),
  });

  for (const level of ['province', 'prefecture', 'county'] as const) {
    const sources = [...history.values()]
      .filter((source) => source.latest.level === level && !currentByCode.has(source.code))
      .sort((left, right) => left.code.localeCompare(right.code));
    for (const source of sources) {
      const override = overrideByCode.get(source.code);
      if (override) {
        decisions.set(
          source.code,
          buildGeneratedEntry(source, {
            ...override,
            candidate_target_codes: override.candidate_target_codes,
          }),
        );
        continue;
      }

      const parent = parentTarget(source);
      const exact = currentCandidates(source, 'exact', parent);
      const canonical = currentCandidates(source, 'canonical', parent);
      const reused = new Set(source.names.map(canonicalName)).size > 1;
      if (reused) {
        decisions.set(
          source.code,
          buildGeneratedEntry(source, {
            candidate_target_codes: uniqueByCode([
              ...(exact.locality === 'global' ? [] : exact.values),
              ...(canonical.locality === 'global' ? [] : canonical.values),
            ]).flatMap((item) => item.code ?? []),
            mapping_kind: 'ambiguous',
            mapping_scope: 'ambiguous',
            auto_apply: false,
            confidence: 100,
            mapping_reason: 'historical_code_reused',
          }),
        );
        continue;
      }

      if (exact.values.length === 1 && exact.locality !== 'global') {
        const target = exact.values[0];
        const scope = mappingScope(source, target);
        decisions.set(
          source.code,
          buildGeneratedEntry(source, {
            ...(scope !== 'ambiguous' ? { target_code: target.code } : {}),
            ...(scope === 'ambiguous' ? { candidate_target_codes: [target.code!] } : {}),
            mapping_kind: target.level === source.latest.level ? 'code_change' : 'level_change',
            mapping_scope: scope,
            auto_apply: scope !== 'ambiguous',
            confidence: scope === 'ambiguous' ? 100 : 90,
            mapping_reason:
              parent && (target.parentCode === parent || target.code === parent)
                ? 'unique_exact_name_under_mapped_parent'
                : 'unique_exact_name',
          }),
        );
        continue;
      }
      if (exact.values.length) {
        decisions.set(
          source.code,
          buildGeneratedEntry(source, {
            candidate_target_codes:
              exact.locality === 'global' ? [] : exact.values.flatMap((item) => item.code ?? []),
            mapping_kind: 'ambiguous',
            mapping_scope: 'ambiguous',
            auto_apply: false,
            confidence: 100,
            mapping_reason:
              exact.locality === 'global'
                ? 'cross_province_exact_name_requires_review'
                : 'multiple_exact_name_targets',
          }),
        );
        continue;
      }
      if (canonical.values.length === 1 && canonical.locality !== 'global') {
        const target = canonical.values[0];
        const scope = mappingScope(source, target);
        decisions.set(
          source.code,
          buildGeneratedEntry(source, {
            ...(scope !== 'ambiguous' ? { target_code: target.code } : {}),
            ...(scope === 'ambiguous' ? { candidate_target_codes: [target.code!] } : {}),
            mapping_kind: target.level === source.latest.level ? 'rename' : 'level_change',
            mapping_scope: scope,
            auto_apply: scope !== 'ambiguous',
            confidence: scope === 'ambiguous' ? 100 : 85,
            mapping_reason:
              parent && (target.parentCode === parent || target.code === parent)
                ? 'unique_canonical_name_under_mapped_parent'
                : 'unique_canonical_name',
          }),
        );
        continue;
      }
      if (canonical.values.length) {
        decisions.set(
          source.code,
          buildGeneratedEntry(source, {
            candidate_target_codes:
              canonical.locality === 'global'
                ? []
                : canonical.values.flatMap((item) => item.code ?? []),
            mapping_kind: 'ambiguous',
            mapping_scope: 'ambiguous',
            auto_apply: false,
            confidence: 100,
            mapping_reason:
              canonical.locality === 'global'
                ? 'cross_province_canonical_name_requires_review'
                : 'multiple_canonical_name_targets',
          }),
        );
        continue;
      }
      if (parent) {
        decisions.set(
          source.code,
          buildGeneratedEntry(source, {
            target_code: parent,
            mapping_kind: 'abolished',
            mapping_scope: 'parent_only',
            auto_apply: true,
            confidence: 70,
            mapping_reason: 'mapped_parent_only',
          }),
        );
        continue;
      }
      decisions.set(
        source.code,
        buildGeneratedEntry(source, {
          mapping_kind: 'abolished',
          mapping_scope: 'unresolved',
          auto_apply: false,
          confidence: 0,
          mapping_reason: 'no_supported_successor',
        }),
      );
    }
  }

  for (const sourceCode of overrideByCode.keys()) {
    if (!history.has(sourceCode)) throw new Error(`override_source_missing:${sourceCode}`);
  }
  const historicalOnlyCodes = [...history.keys()].filter((code) => !currentByCode.has(code));
  if (decisions.size !== historicalOnlyCodes.length) {
    throw new Error(`crosswalk_incomplete:${decisions.size}:${historicalOnlyCodes.length}`);
  }
  for (const decision of decisions.values()) {
    if (decision.target_code && !currentByCode.has(decision.target_code)) {
      throw new Error(`crosswalk_target_missing:${decision.source_code}:${decision.target_code}`);
    }
    for (const candidate of decision.candidate_target_codes ?? []) {
      if (!currentByCode.has(candidate)) {
        throw new Error(`crosswalk_candidate_missing:${decision.source_code}:${candidate}`);
      }
    }
  }

  const entries = [...decisions.values()].sort((left, right) =>
    left.source_code.localeCompare(right.source_code),
  );
  const scopeCounts = entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.mapping_scope] = (counts[entry.mapping_scope] ?? 0) + 1;
    return counts;
  }, {});
  const output = {
    rule_version: RULE_VERSION,
    target_dataset_version: DATASET_VERSION,
    generation: {
      history_package: historyPackage,
      history_sha512: historyManifest.sha512,
      history_year_min: historyManifest.year_min,
      history_year_max_used: HISTORY_MAX_YEAR,
      target_source_hash: snapshotMetadata.source_hash,
      history_unique_codes: history.size,
      current_numeric_codes: currentByCode.size,
      historical_only_codes: historicalOnlyCodes.length,
      covered_source_codes: decisions.size,
      scope_counts: scopeCounts,
      reviewed_overrides: overrides.entries.length,
    },
    entries,
  };
  writeFileSync(
    resolve(configDir, `${RULE_VERSION}.crosswalk.json`),
    `${JSON.stringify(output, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(output.generation, null, 2)}\n`);
}

main();
