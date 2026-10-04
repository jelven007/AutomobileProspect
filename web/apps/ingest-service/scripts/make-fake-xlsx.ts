#!/usr/bin/env tsx
/**
 * 生成大批量假 xlsx 用于性能压测。
 * 列序对齐 configs/ingest-schema.yaml，列顺序与 Demo.xlsx 一致。
 *
 * 用法：
 *   pnpm --filter @leadops/ingest-service exec tsx scripts/make-fake-xlsx.ts 100000
 *   # => seed/fake-100000.xlsx
 */
import ExcelJS from 'exceljs';
import { resolve } from 'node:path';

// 身份证前 6 位行政区划（取 10 个常见地市，分布做压测）
const DISTRICTS: Array<{ code: string; province: string; city: string; district: string }> = [
  { code: '110108', province: '北京市', city: '北京市', district: '海淀区' },
  { code: '310104', province: '上海市', city: '上海市', district: '徐汇区' },
  { code: '440305', province: '广东省', city: '深圳市', district: '南山区' },
  { code: '440106', province: '广东省', city: '广州市', district: '天河区' },
  { code: '510104', province: '四川省', city: '成都市', district: '锦江区' },
  { code: '320106', province: '江苏省', city: '南京市', district: '鼓楼区' },
  { code: '330106', province: '浙江省', city: '杭州市', district: '西湖区' },
  { code: '420106', province: '湖北省', city: '武汉市', district: '武昌区' },
  { code: '610103', province: '陕西省', city: '西安市', district: '碑林区' },
  { code: '500107', province: '重庆市', city: '重庆市', district: '九龙坡区' },
];

const SURNAMES = ['张', '王', '李', '赵', '刘', '陈', '杨', '周', '吴', '徐', '孙', '马', '朱', '胡', '林', '郭'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明', '超', '秀兰'];

/** ISO 7064 Mod 11-2 校验位计算（身份证第 18 位） */
function checksum(idCard17: string): string {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const m = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(idCard17[i]) * w[i];
  return m[sum % 11];
}

function pad(n: number, w = 2): string { return String(n).padStart(w, '0'); }

/**
 * 构造一个合法身份证号。
 * - 前 6 位：选一个预设区划
 * - 7-14：生日 1960~2000
 * - 15-17：顺序号（含性别）
 * - 18：校验位
 */
function makeIdCard(seed: number): { idCard: string; birth: string; gender: 'M' | 'F'; d: typeof DISTRICTS[number] } {
  const d = DISTRICTS[seed % DISTRICTS.length];
  const year = 1960 + (seed % 41);
  const month = 1 + (seed % 12);
  const day = 1 + (seed % 28);
  const seq = pad((seed % 999) + 1, 3);
  const base = `${d.code}${year}${pad(month)}${pad(day)}${seq}`;
  const idCard = base + checksum(base);
  const gender: 'M' | 'F' = Number(seq) % 2 === 1 ? 'M' : 'F';
  return { idCard, birth: `${year}-${pad(month)}-${pad(day)}`, gender, d };
}

async function main() {
  const total = Number(process.argv[2] ?? 100_000);
  if (!Number.isFinite(total) || total <= 0) {
    console.error('usage: tsx make-fake-xlsx.ts <rowCount>');
    process.exit(1);
  }
  const out = resolve(__dirname, `../seed/fake-${total}.xlsx`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: out, useStyles: false });
  const ws = wb.addWorksheet('Sheet1');

  ws.addRow([
    '所属户籍站', '统计时间', '居住地址', '编码编号', '出生日期',
    '性别', '身份证', '名字', '手机号', '地址', '编码1', '编码2',
  ]).commit();

  const startTs = Date.now();
  for (let i = 1; i <= total; i++) {
    const { idCard, birth, gender, d } = makeIdCard(i);
    const surname = SURNAMES[i % SURNAMES.length];
    const given = GIVEN[(i * 7) % GIVEN.length];
    const name = `${surname}${given}${i}`;
    const phone = `139${pad(((i * 37) % 100000000), 8)}`;
    const hujiNo = `2016户籍统计${pad(i, 7)}`;
    const addr = `${d.province}${d.city}${d.district}模拟街道${1 + (i % 999)}号`;
    ws.addRow([
      `${d.city}站`,
      '2026-10-01 09:00:00',
      `${d.city}老地址`,
      hujiNo,
      birth,
      gender === 'M' ? '男' : '女',
      idCard,
      name,
      phone,
      addr,
      'x', 'y',
    ]).commit();

    if (i % 10_000 === 0) {
      // eslint-disable-next-line no-console
      console.log(`[make-fake] wrote ${i}/${total} rows, elapsed=${Date.now() - startTs}ms`);
    }
  }

  await ws.commit();
  await wb.commit();
  // eslint-disable-next-line no-console
  console.log(`[make-fake] DONE wrote ${total} rows to ${out}, elapsed=${Date.now() - startTs}ms`);
}

main().catch((e) => { console.error(e); process.exit(1); });
