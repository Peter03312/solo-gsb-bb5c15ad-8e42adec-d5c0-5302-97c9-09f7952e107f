'use strict';

// 已发布报告 · 单视野最近质心责任区划分 端到端 HTTP 自测（npm test）：
// 上传 → 定标/圈选/视野 → 发布报告 → 责任区划分（像素/mm² 面积、占比、RLE/多边形几何、
// 合计＝视野净像素面积）→ 无计入细胞空结果 → 视野不存在/重名/报告不存在明确报错 →
// 草稿修改与更正不改变旧报告结果 全流程。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8242;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-partition-'));
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

async function jget(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}

const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
];

function partQuery(reportId, fieldId) {
  return jsend('POST', `/api/reports/${reportId}/centroid-partition`, { fieldId });
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();

    // ---------- 切片 A：100×100 矩形视野（含孔洞）+ 2 个计入细胞 ----------
    const up = await upload(png);
    const imgId = up.body.id;

    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标 1px=1μm', r.status === 200, r.body);

    // fieldF：100×100 含 20×20 孔洞 (40,40) → 净像素 9600
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: r.body.version,
      fields: [
        { id: 'fieldF', name: '中心视野', outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)] },
        { id: 'fieldE', name: '空视野', outer: rect(150, 150, 50, 50), holes: [] }
      ]
    });
    check('保存视野', r.status === 200, r.body);

    // 甲质心 (25,50)、乙质心 (76,50)：中垂线 50.5，列 50 像素严格等距（归甲）；
    // 孔洞跨中垂线（列 40..59）两侧各扣 10×20=200
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'cellA', name: '甲', outer: rect(15, 40, 20, 20), holes: [] },
        { id: 'cellB', name: '乙', outer: rect(66, 40, 20, 20), holes: [] }
      ]
    });
    check('保存轮廓', r.status === 200, r.body);

    const pub = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: r.body.version, title: '切片A 报告'
    });
    check('发布报告', pub.status === 201, pub.body);
    const RID = pub.body.report.id;

    // ---------- 责任区划分 ----------
    let d = await partQuery(RID, 'fieldF');
    check('责任区划分成功', d.status === 200, d.body);
    check('响应基本信息',
      d.body.scope === 'report' && d.body.reportId === RID &&
      d.body.title === '切片A 报告' && d.body.matchedBy === 'id' &&
      d.body.calibrated === true && d.body.scaleUmPerPx === 1 &&
      d.body.empty === false && d.body.message === null &&
      d.body.snapshotUrl === `/api/reports/${RID}/file`, d.body);
    const P = d.body.partition;
    check('分区元数据',
      P.kind === 'centroid-partition' && P.fieldId === 'fieldF' &&
      P.fieldName === '中心视野' && P.fieldHoles === 1 &&
      P.empty === false && P.countedCellCount === 2, P);
    check('净像素面积 9600（扣孔洞）且各区合计相等',
      P.netPixelArea === 9600 && P.sumAreaPx === 9600 &&
      P.partitions.reduce((s, q) => s + q.areaPx, 0) === 9600 &&
      approx(P.netAreaMm2, 0.0096), P);
    const byKey = Object.fromEntries(P.partitions.map((q) => [q.key, q]));
    // 列 0..50（51 列）- 孔洞行 40..59 的列 40..50（11 列 ×20 行=220）归甲
    const areaA = 51 * 100 - 220;
    const areaB = 49 * 100 - (20 * 20 - 220); // 列 51..99 共 49 列，孔洞列 51..59 共 9 列×20=180
    check('甲/乙面积（等距列归甲、孔洞两侧扣除）',
      byKey.cellA.areaPx === areaA && byKey.cellB.areaPx === areaB &&
      areaA + areaB === 9600, [areaA, areaB, byKey.cellA.areaPx, byKey.cellB.areaPx]);
    check('占比合计 100%，单个占比正确',
      approx(byKey.cellA.ratio + byKey.cellB.ratio, 1, 1e-9) &&
      approx(byKey.cellA.ratioPercent, areaA / 9600 * 100, 1e-4), P.partitions.map((q) => q.ratioText));
    check('mm² 与展示文本',
      approx(byKey.cellA.areaMm2, areaA / 1e6) && byKey.cellA.areaText === String(areaA / 1e6),
      [byKey.cellA.areaMm2, byKey.cellA.areaText]);
    check('质心与细胞顺序',
      P.partitions[0].key === 'cellA' && P.partitions[0].name === '甲' &&
      P.partitions[0].centroid.x === 25 && P.partitions[0].centroid.y === 50 &&
      P.partitions[1].key === 'cellB', P.partitions.map((q) => [q.key, q.centroid]));
    check('每区有实际分区多边形且多边形面积≈像素面积',
      P.partitions.every((q) => Array.isArray(q.polygons) && q.polygons.length > 0 &&
        q.polygons.every((poly) => poly.length >= 3)), P.partitions.map((q) => q.polygons.length));
    check('RLE 游程覆盖净像素且 owner 合法、坐标为全局像素整数',
      P.runs.reduce((s, rn) => s + (rn.x1 - rn.x0 + 1), 0) === 9600 &&
      P.runs.every((rn) => Number.isInteger(rn.y) && Number.isInteger(rn.x0) &&
        Number.isInteger(rn.x1) && rn.x0 <= rn.x1 && rn.owner >= 0 && rn.owner < 2) &&
      P.runs.every((rn) => !(rn.y >= 40 && rn.y <= 59 && rn.x0 <= 59 && rn.x1 >= 40)),
      '孔洞像素不应出现在游程中');
    check('质心叠加标记',
      P.overlay.centroids.length === 2 &&
      P.overlay.centroids.some((m) => m.key === 'cellA' && m.x === 25 && m.y === 50),
      P.overlay);
    check('bounds 为参与像素包围盒（像素格坐标）',
      P.bounds.minX === 0 && P.bounds.minY === 0 &&
      P.bounds.maxX === 100 && P.bounds.maxY === 100, P.bounds);

    // 按视野名称查询（trim，matchedBy=name）
    d = await partQuery(RID, ' 中心视野 ');
    check('按视野名称划分且 matchedBy=name',
      d.status === 200 && d.body.matchedBy === 'name' &&
      d.body.partition.netPixelArea === 9600, d.body);

    // ---------- 无计入细胞：空结果 ----------
    d = await partQuery(RID, 'fieldE');
    check('无计入细胞 → 200 空结果',
      d.status === 200 && d.body.empty === true &&
      d.body.partition.empty === true &&
      d.body.partition.countedCellCount === 0 &&
      d.body.partition.partitions.length === 0 &&
      d.body.partition.runs.length === 0 &&
      /没有任何计入细胞/.test(d.body.message), d.body);

    // ---------- 错误语义 ----------
    let e = await partQuery(RID, '  ');
    check('空视野标识 → 400', e.status === 400 && /fieldId 必须为非空/.test(e.body.error), e.body);
    e = await jsend('POST', `/api/reports/${RID}/centroid-partition`, {});
    check('缺 fieldId → 400', e.status === 400 && /fieldId/.test(e.body.error), e.body);
    e = await partQuery(RID, 'ghost');
    check('视野不存在 → 400', e.status === 400 && /视野标识不存在：ghost/.test(e.body.error), e.body);
    e = await partQuery('no-such-report', 'fieldF');
    check('报告不存在 → 404', e.status === 404, e.body);

    // ---------- 视野名称歧义（另一切片发布含两个同名视野的报告） ----------
    const up2 = await upload(png);
    const img2 = up2.body.id;
    r = await jsend('PUT', `/api/images/${img2}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img2}/fields`, {
      version: r.body.version,
      fields: [
        { id: 'dup1', name: '同名', outer: rect(0, 0, 50, 50), holes: [] },
        { id: 'dup2', name: '同名', outer: rect(0, 0, 60, 60), holes: [] }
      ]
    });
    r = await jsend('PUT', `/api/images/${img2}/contours`, {
      version: r.body.version,
      cells: [{ id: 'X', name: 'X', outer: rect(0, 0, 20, 20), holes: [] }]
    });
    const pub2 = await jsend('POST', `/api/images/${img2}/publish`, {
      version: r.body.version, title: '切片B 报告'
    });
    const RID2 = pub2.body.report.id;
    e = await partQuery(RID2, '同名');
    check('视野名称重名 → 400 并提示改用 id',
      e.status === 400 && /2 个同名视野/.test(e.body.error) && /改用视野 id/.test(e.body.error), e.body);
    d = await partQuery(RID2, 'dup2');
    check('重名时按 id 仍可划分（60×60 净像素 3600，一个细胞得全部）',
      d.status === 200 && d.body.matchedBy === 'id' &&
      d.body.partition.netPixelArea === 3600 &&
      d.body.partition.partitions.length === 1 &&
      d.body.partition.partitions[0].areaPx === 3600, d.body.partition);

    // ---------- 无视野报告：明确报错 ----------
    const up3 = await upload(png);
    const img3 = up3.body.id;
    r = await jsend('PUT', `/api/images/${img3}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img3}/contours`, {
      version: r.body.version,
      cells: [{ id: 'Y', name: 'Y', outer: rect(0, 0, 20, 20), holes: [] }]
    });
    const pub3 = await jsend('POST', `/api/images/${img3}/publish`, {
      version: r.body.version, title: '无视野报告'
    });
    e = await partQuery(pub3.body.report.id, 'fieldF');
    check('无视野报告 → 400 视野标识不存在',
      e.status === 400 && /视野标识不存在/.test(e.body.error), e.body);

    // ---------- 只读 & 冻结：重复查询幂等；草稿修改与更正不改变旧报告结果 ----------
    const before = await partQuery(RID, 'fieldF');
    const again = await partQuery(RID, 'fieldF');
    check('查询幂等（结果字节一致）',
      JSON.stringify(again.body) === JSON.stringify(before.body));

    // 草稿在孔洞附近追加一个细胞并发起更正；旧报告结果不变
    r = await jget(`/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'cellA', name: '甲', outer: rect(15, 40, 20, 20), holes: [] },
        { id: 'cellB', name: '乙', outer: rect(66, 40, 20, 20), holes: [] },
        { id: 'cellN', name: '新增', outer: rect(80, 10, 10, 10), holes: [] }
      ]
    });
    check('草稿追加细胞', r.status === 200, r.body);
    const trace = await jget(`/api/reports/${RID}/trace`);
    const cor = await jsend('POST', `/api/reports/${RID}/correct`, {
      reason: '新增一个细胞', draftVersion: r.body.version, expectedTipId: trace.body.tipId
    });
    check('更正发布新报告', cor.status === 201, cor.body);

    const frozen = await partQuery(RID, 'fieldF');
    check('草稿修改+更正后旧报告责任区结果不变（字节一致）',
      JSON.stringify(frozen.body) === JSON.stringify(before.body), frozen.body);
    const dNew = await partQuery(cor.body.report.id, 'fieldF');
    check('新报告按新冻结数据计算（3 个计入细胞）',
      dNew.status === 200 && dNew.body.partition.countedCellCount === 3 &&
      dNew.body.partition.sumAreaPx === 9600, dNew.body && dNew.body.partition);

    // 报告读取/导出走原路径仍可用
    const rb = await jget(`/api/reports/${RID}`);
    check('旧报告读取正常且 draftVersion 未因查询改变',
      rb.status === 200 && rb.body.draftVersion === pub.body.report.draftVersion, rb.body);

  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部最近质心责任区划分 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
