#!/usr/bin/env node
import { runIngest } from './runner';
import { listSources } from './runner';

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return out;
}

function usage(): never {
  console.error(`usage:
  ingest run --schema <path> [--prefix <prefix>]
  ingest ls  --schema <path> [--prefix <prefix>] [--format table|json]`);
  process.exit(1);
}

function fmtSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(2)} ${units[i]}`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (cmd === 'run') {
    const pgUrl = process.env.PG_URL;
    if (!pgUrl) throw new Error('PG_URL env missing');
    const report = await runIngest({
      schemaPath: args.schema ?? 'configs/ingest-schema.yaml',
      prefix: args.prefix,
      pgUrl,
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === 'ls') {
    const schemaPath = args.schema ?? 'configs/ingest-schema.yaml';
    const prefix = args.prefix;
    const format = args.format ?? 'table';
    const result = await listSources({ schemaPath, prefix });

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`bucket=${result.bucket} prefix=${result.prefix} type=${result.sourceType} endpoint=${result.endpoint ?? '-'} region=${result.region ?? '-'}`);
    console.log('');
    for (const f of result.files) {
      const lm = f.lastModified ? f.lastModified.toISOString() : '-';
      console.log(`${lm}  ${fmtSize(f.size).padStart(10)}  ${f.key}`);
    }
    console.log('');
    console.log(`total: ${result.files.length} files, ${fmtSize(result.totalBytes)}`);
    return;
  }

  usage();
}

main().catch((e) => { console.error(e); process.exit(1); });
