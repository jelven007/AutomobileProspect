#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DATASET_VERSION = 'MCA_2025-12-31';
const EFFECTIVE_DATE = '2025-12-31';
const EXPECTED_COUNTS = { province: 34, prefecture: 333, county: 2847 };
const SOURCE_PAGE = 'https://dmfw.mca.gov.cn/XzqhVersionPublish.html';
const SOURCE_URL = 'https://dmfw.mca.gov.cn/9095/xzqh/getList?code=&maxLevel=3';
const USER_AGENT = 'Mozilla/5.0 (compatible; LeadOpsRegionSnapshot/1.0)';

interface SourceNode {
  code: string;
  name: string | null;
  level: number;
  type: string;
  children?: SourceNode[];
}

interface SourceResponse {
  data: SourceNode;
  status?: number;
  message?: string;
}

function countLevels(node: SourceNode): Record<number, number> {
  const counts: Record<number, number> = {};
  const visit = (current: SourceNode) => {
    if (current.level > 0) counts[current.level] = (counts[current.level] ?? 0) + 1;
    current.children?.forEach(visit);
  };
  visit(node);
  return counts;
}

async function main(): Promise<void> {
  const temporaryDir = mkdtempSync(join(tmpdir(), 'leadops-region-'));
  const cookiePath = resolve(temporaryDir, 'cookies.txt');
  let page: string;
  let responseText: string;
  try {
    page = execFileSync(
      'curl',
      [
        '-fsSL',
        '--connect-timeout',
        '15',
        '--max-time',
        '60',
        '-A',
        USER_AGENT,
        '-c',
        cookiePath,
        SOURCE_PAGE,
      ],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
    );
    responseText = execFileSync(
      'curl',
      [
        '-fsSL',
        '--connect-timeout',
        '15',
        '--max-time',
        '60',
        '-A',
        USER_AGENT,
        '-b',
        cookiePath,
        '-e',
        SOURCE_PAGE,
        '-H',
        'Accept: application/json, text/plain, */*',
        '-H',
        'X-Requested-With: XMLHttpRequest',
        SOURCE_URL,
      ],
      { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 },
    );
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
  if (!page.includes('数据截止日期为2025年12月31日')) {
    throw new Error('source_page_effective_date_mismatch');
  }
  const tableName = /tableName\s*=\s*'([^']+)'/.exec(page)?.[1];
  if (tableName !== 'Xzqh20251231')
    throw new Error(`source_table_mismatch:${tableName ?? 'missing'}`);

  const payload = JSON.parse(responseText) as SourceResponse;
  if (!payload.data?.children) throw new Error('source_api_invalid_payload');

  const levels = countLevels(payload.data);
  const counts = {
    province: levels[1] ?? 0,
    prefecture: levels[2] ?? 0,
    county: levels[3] ?? 0,
  };
  if (JSON.stringify(counts) !== JSON.stringify(EXPECTED_COUNTS)) {
    throw new Error(`source_count_mismatch:${JSON.stringify(counts)}`);
  }

  const outputDir = resolve(__dirname, '../configs/administrative-division');
  const snapshotPath = resolve(outputDir, `${DATASET_VERSION}.json`);
  const metadataPath = resolve(outputDir, `${DATASET_VERSION}.meta.json`);
  const snapshot = `${JSON.stringify(payload)}\n`;
  const sourceHash = createHash('sha256').update(snapshot).digest('hex');
  const metadata = {
    dataset_version: DATASET_VERSION,
    effective_date: EFFECTIVE_DATE,
    fetched_at: new Date().toISOString(),
    source_page: SOURCE_PAGE,
    source_url: SOURCE_URL,
    source_table: tableName,
    source_hash: sourceHash,
    counts,
  };

  mkdirSync(outputDir, { recursive: true });
  if (existsSync(snapshotPath)) {
    const existingSnapshot = readFileSync(snapshotPath, 'utf8');
    const existingHash = createHash('sha256').update(existingSnapshot).digest('hex');
    if (existingHash !== sourceHash) {
      throw new Error(`published_dataset_changed:${DATASET_VERSION}:${existingHash}:${sourceHash}`);
    }
    const existingMetadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
      source_hash?: string;
    };
    if (existingMetadata.source_hash !== existingHash) {
      throw new Error(
        `existing_metadata_hash_mismatch:${existingMetadata.source_hash ?? 'missing'}`,
      );
    }
    process.stdout.write(
      `${JSON.stringify({ ...metadata, fetched_at: undefined, unchanged: true }, null, 2)}\n`,
    );
    return;
  }
  writeFileSync(snapshotPath, snapshot);
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
