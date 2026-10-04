#!/usr/bin/env tsx
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  buildDynamicMappings,
  cleanRowDetailed,
  CleaningError,
} from '../src/pipeline';
import { parseIdCard, sanitizeIdCard } from '../src/id-card';
import { streamXlsx } from '../src/xlsx-stream';
import type { IngestSchema } from '../src/types';

const input = process.argv.slice(2).find((arg) => arg !== '--');
if (!input) {
  process.stderr.write('usage: pnpm region:audit -- /absolute/path/to/file.xlsx\n');
  process.exit(1);
}

function top(map: Map<string, number>, limit = 100) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([code, count]) => ({ code, count }));
}

async function main() {
  const schemaPath = resolve(__dirname, '../configs/ingest-schema.yaml');
  const base = parseYaml(
    readFileSync(schemaPath, 'utf8').replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? ''),
  ) as IngestSchema;
  let schema = base;
  let headerParsed = false;
  let total = 0;
  let cleaned = 0;
  const skipped = new Map<string, number>();
  const cityMisses = new Map<string, number>();
  const districtMisses = new Map<string, number>();

  for await (const { rowNo, values } of streamXlsx(createReadStream(resolve(input)), {
    sheetIndex: base.parse.sheet,
    skipHeaderRows: 0,
  })) {
    if (!headerParsed) {
      headerParsed = true;
      const dynamic = buildDynamicMappings(values);
      schema = {
        ...base,
        columns: {
          drop_indexes: dynamic.dropIndexes,
          mappings: dynamic.mappings,
        },
      };
      continue;
    }
    if (rowNo <= base.parse.skip_header_rows) continue;
    total += 1;
    try {
      const { row } = cleanRowDetailed(values, schema, {
        source_file: input,
        source_row: rowNo,
        ingest_batch: 'region-audit',
      });
      cleaned += 1;
      const idCard = sanitizeIdCard(row.id_card);
      if (idCard.length !== 18) continue;
      const info = parseIdCard(idCard);
      if (!info.city) {
        const code = idCard.slice(0, 4);
        cityMisses.set(code, (cityMisses.get(code) ?? 0) + 1);
      }
      if (!info.district) {
        const code = idCard.slice(0, 6);
        districtMisses.set(code, (districtMisses.get(code) ?? 0) + 1);
      }
    } catch (error) {
      const reason = error instanceof CleaningError ? error.reason : 'unknown';
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    }
  }

  const cityMissRows = [...cityMisses.values()].reduce((sum, count) => sum + count, 0);
  const districtMissRows = [...districtMisses.values()].reduce((sum, count) => sum + count, 0);
  process.stdout.write(`${JSON.stringify({
    file: resolve(input),
    total,
    cleaned,
    skipped: total - cleaned,
    skippedReasons: Object.fromEntries(skipped),
    city: {
      matched: cleaned - cityMissRows,
      missingRows: cityMissRows,
      missingCodes: cityMisses.size,
      coverage: cleaned ? Number((((cleaned - cityMissRows) / cleaned) * 100).toFixed(4)) : 100,
      topMissing: top(cityMisses),
    },
    district: {
      matched: cleaned - districtMissRows,
      missingRows: districtMissRows,
      missingCodes: districtMisses.size,
      coverage: cleaned ? Number((((cleaned - districtMissRows) / cleaned) * 100).toFixed(4)) : 100,
      topMissing: top(districtMisses),
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
