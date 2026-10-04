#!/usr/bin/env tsx
/**
 * 全国覆盖率审计：抽样全国 34 省各若干真实身份证前 6 位，
 * 跑 parseIdCard 看 province/city/district 命中率。
 */
import { parseIdCard } from '../src/id-card';

// 全国代表性 district 6位码（覆盖直辖市/各大省/边疆/港澳台）
const SAMPLES: Array<{ code: string; expect: string }> = [
  // 北京
  { code: '110101', expect: '北京/东城' },
  { code: '110108', expect: '北京/海淀' },
  { code: '110116', expect: '北京/怀柔' },
  // 天津
  { code: '120101', expect: '天津/和平' },
  { code: '120116', expect: '天津/滨海新区' },
  // 河北
  { code: '130102', expect: '河北/石家庄' },
  { code: '131002', expect: '河北/廊坊' },
  // 山西
  { code: '140105', expect: '山西/太原小店' },
  // 内蒙
  { code: '150102', expect: '内蒙古/呼和浩特' },
  // 辽宁
  { code: '210102', expect: '辽宁/沈阳' },
  { code: '210902', expect: '辽宁/阜新' },
  // 吉林
  { code: '220102', expect: '吉林/长春' },
  // 黑龙江
  { code: '230102', expect: '黑龙江/哈尔滨' },
  // 上海
  { code: '310101', expect: '上海/黄浦' },
  { code: '310115', expect: '上海/浦东' },
  // 江苏
  { code: '320102', expect: '江苏/南京' },
  { code: '320500', expect: '江苏/苏州' },
  // 浙江
  { code: '330102', expect: '浙江/杭州' },
  { code: '330200', expect: '浙江/宁波' },
  // 安徽
  { code: '340102', expect: '安徽/合肥' },
  // 福建
  { code: '350102', expect: '福建/福州' },
  { code: '350203', expect: '福建/厦门' },
  // 江西
  { code: '360102', expect: '江西/南昌' },
  // 山东
  { code: '370102', expect: '山东/济南' },
  { code: '370202', expect: '山东/青岛' },
  // 河南
  { code: '410102', expect: '河南/郑州' },
  // 湖北
  { code: '420102', expect: '湖北/武汉' },
  // 湖南
  { code: '430102', expect: '湖南/长沙' },
  // 广东
  { code: '440103', expect: '广东/广州' },
  { code: '440305', expect: '广东/深圳南山' },
  { code: '441900', expect: '广东/东莞' },
  { code: '442000', expect: '广东/中山' },
  // 广西
  { code: '450102', expect: '广西/南宁' },
  // 海南
  { code: '460102', expect: '海南/海口' },
  // 重庆
  { code: '500103', expect: '重庆/渝中' },
  { code: '500230', expect: '重庆/双桥(已撤)' },
  // 四川
  { code: '510104', expect: '四川/成都' },
  { code: '511025', expect: '四川/内江资中' },
  { code: '510225', expect: '四川/内江(老码)' },
  // 贵州
  { code: '520102', expect: '贵州/贵阳' },
  // 云南
  { code: '530102', expect: '云南/昆明' },
  // 西藏
  { code: '540102', expect: '西藏/拉萨' },
  // 陕西
  { code: '610102', expect: '陕西/西安' },
  // 甘肃
  { code: '620102', expect: '甘肃/兰州' },
  // 青海
  { code: '630102', expect: '青海/西宁' },
  // 宁夏
  { code: '640104', expect: '宁夏/银川' },
  // 新疆
  { code: '650102', expect: '新疆/乌鲁木齐' },
  { code: '659001', expect: '新疆/石河子' },
  // 港澳台
  { code: '810000', expect: '香港' },
  { code: '820000', expect: '澳门' },
  { code: '710000', expect: '台湾' },
];

function makeId(code6: string): string {
  return code6 + '19900101' + '1234';
}

let hitProvince = 0, hitCity = 0, hitDistrict = 0;
const missProv: string[] = [], missCity: string[] = [], missDist: string[] = [];

for (const s of SAMPLES) {
  const info = parseIdCard(makeId(s.code));
  if (info.province) hitProvince += 1; else missProv.push(`${s.code} (${s.expect})`);
  if (info.city) hitCity += 1; else missCity.push(`${s.code} (${s.expect})`);
  if (info.district) hitDistrict += 1; else missDist.push(`${s.code} (${s.expect})`);
}
const total = SAMPLES.length;
console.log(`样本总数: ${total}`);
console.log(`省份命中: ${hitProvince}/${total}  (${((hitProvince/total)*100).toFixed(1)}%)`);
console.log(`城市命中: ${hitCity}/${total}  (${((hitCity/total)*100).toFixed(1)}%)`);
console.log(`区县命中: ${hitDistrict}/${total}  (${((hitDistrict/total)*100).toFixed(1)}%)`);
if (missProv.length) console.log('\n省份未命中:'); missProv.forEach((m) => console.log('  -', m));
if (missCity.length) console.log('\n城市未命中:'); missCity.forEach((m) => console.log('  -', m));
if (missDist.length) console.log('\n区县未命中:'); missDist.forEach((m) => console.log('  -', m));
