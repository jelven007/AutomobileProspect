#!/usr/bin/env tsx
/**
 * 合成一份模拟 Demo.xlsx，用于本地联调。
 * 列序严格对齐 configs/ingest-schema.yaml：
 *   1 所属户籍站  2 统计时间  3 居住地址  4 编码编号  5 出生日期
 *   6 性别       7 身份证    8 名字      9 手机号    10 地址
 *   11 编码(丢)  12 编码(丢)
 *
 * 用 WorkbookWriter（streaming）输出，以保证运行时的 WorkbookReader 可以流式解析。
 */
import ExcelJS from 'exceljs';
import { resolve } from 'node:path';

async function main() {
  const out = resolve(__dirname, '../seed/Demo.xlsx');
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: out, useStyles: false });
  const ws = wb.addWorksheet('Sheet1');

  ws.addRow([
    '所属户籍站', '统计时间', '居住地址', '编码编号', '出生日期',
    '性别', '身份证', '名字', '手机号', '地址', '编码1', '编码2',
  ]).commit();

  ws.addRow([
    '内江站', '2026-10-01 09:00:00', '内江老地址', '2016户籍统计000001', '1988-03-15',
    '男', '511025198803151239', '张三', '13812345678', '四川省内江市荣县旭阳镇', 'x', 'y',
  ]).commit();
  ws.addRow([
    '深圳站', '2026-10-01 09:05:00', '深圳老地址', '2016户籍统计000002', '1992-07-20',
    '女', '440305199207208024', '李四', '13987654321', '广东省深圳市南山区科技园', 'x', 'y',
  ]).commit();
  ws.addRow([
    '北京站', '2026-10-01 09:10:00', '北京老地址', '2016户籍统计000003', '1985-11-30',
    '男', '110108198511306015', '王五', '13611112222', '北京市海淀区中关村大街', 'x', 'y',
  ]).commit();

  await ws.commit();
  await wb.commit();
  console.log(`wrote ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
