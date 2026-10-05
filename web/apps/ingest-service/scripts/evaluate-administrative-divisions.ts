#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import {
  loadAdministrativeDivisionDataset,
  standardizeAdministrativeRegion,
  type RegionMappingStatus,
} from '../src/administrative-division';

interface CountRow {
  key: string;
  count: string;
}

interface ResidentGroupRow {
  origin_code: string | null;
  province: string;
  city: string;
  district: string;
  customer_count: string;
}

interface EvaluatedRow {
  originCode: string;
  province: string;
  city: string;
  district: string;
  customerCount: number;
  status: RegionMappingStatus;
  method: string;
  confidence: number;
  currentProvinceCode: string;
  currentProvinceName: string;
  currentPrefectureCode: string;
  currentPrefectureName: string;
  currentCountyCode: string;
  currentCountyName: string;
  groupCode: string;
  groupName: string;
  groupType: string;
  mappingReason: string;
  candidateTargetCodes: string;
}

const STATUS_ORDER: RegionMappingStatus[] = [
  'current',
  'historical_mapped',
  'partial',
  'ambiguous',
  'unresolved',
  'not_applicable',
];

function numberOf(value: string | number | bigint): number {
  return Number(value);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function percent(value: number, total: number): string {
  return total ? `${((value / total) * 100).toFixed(2)}%` : '0.00%';
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function markdownCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function parseArgument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

async function main(): Promise<void> {
  const connectionString = process.env.PG_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('PG_URL_or_DATABASE_URL_required');
  const reportDate = parseArgument('date') ?? new Date().toISOString().slice(0, 10);
  const outputDir = resolve(
    parseArgument('output-dir') ?? resolve(__dirname, '../../../../docs/07_测试文档'),
  );
  const dataset = loadAdministrativeDivisionDataset();
  const generation = dataset.crosswalk_generation;
  const crosswalkByCode = new Map(dataset.crosswalk.map((entry) => [entry.source_code, entry]));
  const currentNames = new Set(
    dataset.divisions
      .filter((division) => division.level !== 'county')
      .map((division) => division.name),
  );
  const pool = new Pool({ connectionString, max: 1 });
  const client = await pool.connect();
  let databaseName = '';
  let snapshot = '';
  let evaluatedAt = '';
  let activeCustomers = 0;
  let documentTypeRows: CountRow[] = [];
  let groupedRows: ResidentGroupRow[] = [];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '15min'`);
    const context = await client.query<{
      database_name: string;
      snapshot: string;
      evaluated_at: Date;
    }>(
      `SELECT current_database() AS database_name,
              txid_current_snapshot()::text AS snapshot,
              transaction_timestamp() AS evaluated_at`,
    );
    databaseName = context.rows[0].database_name;
    snapshot = context.rows[0].snapshot;
    evaluatedAt = context.rows[0].evaluated_at.toISOString();

    const totalResult = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM customer WHERE is_deleted = FALSE`,
    );
    activeCustomers = numberOf(totalResult.rows[0].count);
    documentTypeRows = (
      await client.query<CountRow>(
        `SELECT id_type AS key, count(*)::text AS count
           FROM customer
          WHERE is_deleted = FALSE
          GROUP BY id_type
          ORDER BY id_type`,
      )
    ).rows;
    groupedRows = (
      await client.query<ResidentGroupRow>(
        `SELECT CASE
                  WHEN id_card ~ '^[0-9]{17}[0-9X]$' THEN left(id_card, 6)
                  ELSE NULL
                END AS origin_code,
                COALESCE(province, '') AS province,
                COALESCE(city, '') AS city,
                COALESCE(district, '') AS district,
                count(*)::text AS customer_count
           FROM customer
          WHERE is_deleted = FALSE
            AND id_type = 'resident_id'
          GROUP BY 1, 2, 3, 4
          ORDER BY count(*) DESC`,
      )
    ).rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  const details: EvaluatedRow[] = groupedRows.map((row) => {
    const originCode = row.origin_code ?? '';
    const result = standardizeAdministrativeRegion('resident_id', originCode);
    const crosswalk = originCode ? crosswalkByCode.get(originCode) : undefined;
    return {
      originCode,
      province: row.province,
      city: row.city,
      district: row.district,
      customerCount: numberOf(row.customer_count),
      status: result.status,
      method: result.method,
      confidence: result.confidence,
      currentProvinceCode: result.current_province?.code ?? '',
      currentProvinceName: result.current_province?.name ?? '',
      currentPrefectureCode: result.current_prefecture?.code ?? '',
      currentPrefectureName: result.current_prefecture?.name ?? '',
      currentCountyCode: result.current_county?.code ?? '',
      currentCountyName: result.current_county?.name ?? '',
      groupCode: result.group?.code ?? '',
      groupName: result.group?.name ?? '',
      groupType: result.group?.group_type ?? '',
      mappingReason:
        crosswalk?.mapping_reason ?? (result.status === 'current' ? 'current_code' : result.method),
      candidateTargetCodes: crosswalk?.candidate_target_codes?.join(';') ?? '',
    };
  });
  details.sort(
    (left, right) =>
      right.customerCount - left.customerCount ||
      left.originCode.localeCompare(right.originCode) ||
      left.city.localeCompare(right.city, 'zh-CN'),
  );

  const residentCustomers = sum(details.map((row) => row.customerCount));
  const nonResidentCustomers = activeCustomers - residentCustomers;
  const statusCounts = new Map<RegionMappingStatus, number>(
    STATUS_ORDER.map((status) => [status, status === 'not_applicable' ? nonResidentCustomers : 0]),
  );
  const codeStatus = new Map<RegionMappingStatus, Set<string>>(
    STATUS_ORDER.map((status) => [status, new Set<string>()]),
  );
  for (const row of details) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + row.customerCount);
    codeStatus.get(row.status)?.add(row.originCode || '(invalid)');
  }

  const cityRows = new Map<
    string,
    {
      count: number;
      codes: Set<string>;
      statuses: Map<RegionMappingStatus, number>;
      groups: Map<string, number>;
    }
  >();
  for (const row of details) {
    if (!row.city) continue;
    const aggregate = cityRows.get(row.city) ?? {
      count: 0,
      codes: new Set<string>(),
      statuses: new Map<RegionMappingStatus, number>(),
      groups: new Map<string, number>(),
    };
    aggregate.count += row.customerCount;
    if (row.originCode) aggregate.codes.add(row.originCode);
    aggregate.statuses.set(
      row.status,
      (aggregate.statuses.get(row.status) ?? 0) + row.customerCount,
    );
    const group = row.groupName || '(无现行分组)';
    aggregate.groups.set(group, (aggregate.groups.get(group) ?? 0) + row.customerCount);
    cityRows.set(row.city, aggregate);
  }

  const crosswalkScopeCounts = dataset.crosswalk.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.mapping_scope] = (counts[entry.mapping_scope] ?? 0) + 1;
    return counts;
  }, {});
  const affectedByCode = new Map<string, number>();
  for (const row of details) {
    if (row.status !== 'ambiguous' && row.status !== 'unresolved') continue;
    affectedByCode.set(
      row.originCode || '(invalid)',
      (affectedByCode.get(row.originCode || '(invalid)') ?? 0) + row.customerCount,
    );
  }
  const topProblems = [...affectedByCode]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 100)
    .map(([code, count]) => {
      const rows = details.filter((row) => (row.originCode || '(invalid)') === code);
      const first = rows[0];
      return {
        code,
        count,
        status: first.status,
        oldRegion: [
          ...new Set(
            rows
              .map((row) => [row.province, row.city, row.district].filter(Boolean).join('/'))
              .filter(Boolean),
          ),
        ]
          .slice(0, 3)
          .join('；'),
        reason: first.mappingReason || 'invalid_or_unknown_code',
        candidates: first.candidateTargetCodes,
      };
    });

  const headers = [
    'origin_code',
    'legacy_province',
    'legacy_city',
    'legacy_district',
    'customer_count',
    'mapping_status',
    'mapping_method',
    'confidence',
    'current_province_code',
    'current_province_name',
    'current_prefecture_code',
    'current_prefecture_name',
    'current_county_code',
    'current_county_name',
    'region_group_code',
    'region_group_name',
    'region_group_type',
    'mapping_reason',
    'candidate_target_codes',
  ];
  const csv = [
    headers.join(','),
    ...details.map((row) =>
      [
        row.originCode,
        row.province,
        row.city,
        row.district,
        row.customerCount,
        row.status,
        row.method,
        row.confidence,
        row.currentProvinceCode,
        row.currentProvinceName,
        row.currentPrefectureCode,
        row.currentPrefectureName,
        row.currentCountyCode,
        row.currentCountyName,
        row.groupCode,
        row.groupName,
        row.groupType,
        row.mappingReason,
        row.candidateTargetCodes,
      ]
        .map(csvCell)
        .join(','),
    ),
  ].join('\n');

  const statusTable = STATUS_ORDER.map((status) => {
    const count = statusCounts.get(status) ?? 0;
    return `| \`${status}\` | ${formatNumber(count)} | ${percent(count, activeCustomers)} | ${formatNumber(codeStatus.get(status)?.size ?? 0)} |`;
  }).join('\n');
  const typeTable = documentTypeRows
    .map(
      (row) =>
        `| \`${markdownCell(row.key)}\` | ${formatNumber(numberOf(row.count))} | ${percent(numberOf(row.count), activeCustomers)} |`,
    )
    .join('\n');
  const problemTable = topProblems.length
    ? topProblems
        .map(
          (row) =>
            `| \`${row.code}\` | ${formatNumber(row.count)} | \`${row.status}\` | ${markdownCell(row.oldRegion)} | \`${markdownCell(row.reason)}\` | ${markdownCell(row.candidates)} |`,
        )
        .join('\n')
    : '| - | 0 | - | - | - | - |';
  const cityTable = [...cityRows]
    .sort((left, right) => right[1].count - left[1].count)
    .map(([city, aggregate]) => {
      const statusSummary = STATUS_ORDER.filter(
        (status) => (aggregate.statuses.get(status) ?? 0) > 0,
      )
        .map((status) => `${status}:${formatNumber(aggregate.statuses.get(status) ?? 0)}`)
        .join('；');
      const groups = [...aggregate.groups]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([name, count]) => `${name}:${formatNumber(count)}`)
        .join('；');
      return `| ${markdownCell(city)} | ${currentNames.has(city) ? '是' : '否'} | ${formatNumber(aggregate.count)} | ${aggregate.codes.size} | ${statusSummary} | ${markdownCell(groups)} |`;
    })
    .join('\n');

  const report = `# 行政区划只读评估报告

> 评估日期：${reportDate}
> 数据库：\`${databaseName}\`
> 事务快照：\`${snapshot}\`
> 执行时间：${evaluatedAt}
> 执行模式：PostgreSQL \`REPEATABLE READ READ ONLY\`，未更新客户表

## 1. 结论

- 当前有效客户 ${formatNumber(activeCustomers)} 条，其中居民身份证 ${formatNumber(residentCustomers)} 条，非居民证件 ${formatNumber(nonResidentCustomers)} 条。
- 可直接或通过唯一历史关系完整标准化 ${formatNumber((statusCounts.get('current') ?? 0) + (statusCounts.get('historical_mapped') ?? 0))} 条，占居民身份证的 ${percent((statusCounts.get('current') ?? 0) + (statusCounts.get('historical_mapped') ?? 0), residentCustomers)}。
- 仅能安全映射到父级 ${formatNumber(statusCounts.get('partial') ?? 0)} 条；歧义 ${formatNumber(statusCounts.get('ambiguous') ?? 0)} 条；未解析 ${formatNumber(statusCounts.get('unresolved') ?? 0)} 条。
- 本报告只评估标准化结果。未执行 \`008\` 迁移、未写 staging、未回填影子字段，也未改变 \`province/city/district\`。

## 2. 数据与规则基线

| 项目 | 值 |
|---|---:|
| 民政部数据版本 | \`${dataset.metadata.dataset_version}\` |
| 民政部快照 SHA-256 | \`${dataset.metadata.source_hash}\` |
| 现行省/地/县 | ${dataset.metadata.counts.province} / ${dataset.metadata.counts.prefecture} / ${dataset.metadata.counts.county} |
| 历史数据范围 | ${generation?.history_year_min ?? 1980}–${generation?.history_year_max_used ?? 2021} |
| 历史唯一代码 | ${formatNumber(generation?.history_unique_codes ?? 0)} |
| 现行已不存在的历史代码 | ${formatNumber(generation?.historical_only_codes ?? 0)} |
| crosswalk 已覆盖代码 | ${formatNumber(new Set(dataset.crosswalk.map((entry) => entry.source_code)).size)} |
| 完整映射 | ${formatNumber(crosswalkScopeCounts.full ?? 0)} |
| 父级映射 | ${formatNumber(crosswalkScopeCounts.parent_only ?? 0)} |
| 歧义 | ${formatNumber(crosswalkScopeCounts.ambiguous ?? 0)} |
| 未解析 | ${formatNumber(crosswalkScopeCounts.unresolved ?? 0)} |

自动映射只接受同省或已映射父级下的唯一同名/同根名称。仅在全国同名、代码复用、多候选和无继承证据时不会自动落到具体区县。

## 3. 客户评估结果

| 状态 | 客户数 | 占全部客户 | 身份证前缀数 |
|---|---:|---:|---:|
${statusTable}

### 3.1 证件类型

| 证件类型 | 客户数 | 占比 |
|---|---:|---:|
${typeTable}

### 3.2 高影响待确认代码

以下最多列出 100 个歧义或未解析代码，按影响客户数降序排列。完整明细见同目录 CSV。

| 原始代码 | 客户数 | 状态 | 旧省/市/县示例 | 原因 | 候选现行代码 |
|---|---:|---|---|---|---|
${problemTable}

## 4. 旧城市标签逐项去向

| 旧 city 标签 | 现行地级名称 | 客户数 | 前缀数 | 状态分布 | 主要现行分组 |
|---|---|---:|---:|---|---|
${cityTable}

## 5. 产物与下一步

- 逐代码、旧省市县组合的完整结果：\`行政区划只读评估明细_${reportDate}.csv\`
- 下一步先审核“歧义/未解析”中客户量最高的代码，再进入 P2 staging；不得直接回填客户影子字段。
- 正式迁移前仍需完成数据库备份，并记录备份校验、RPO/RTO 和恢复演练结果。
`;

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, `行政区划只读评估明细_${reportDate}.csv`), `${csv}\n`);
  writeFileSync(resolve(outputDir, `行政区划只读评估报告_${reportDate}.md`), report);
  process.stdout.write(
    `${JSON.stringify(
      {
        active_customers: activeCustomers,
        resident_customers: residentCustomers,
        statuses: Object.fromEntries(statusCounts),
        distinct_resident_codes: new Set(details.map((row) => row.originCode)).size,
        legacy_city_labels: cityRows.size,
        report: resolve(outputDir, `行政区划只读评估报告_${reportDate}.md`),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
