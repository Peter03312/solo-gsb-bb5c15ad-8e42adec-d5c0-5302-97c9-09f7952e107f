'use strict';

// 已发布报告 · 单视野最近质心责任区划分 纯逻辑自测（node test-centroid-partition.js）：
// 视野标识解析（id/名称/重名/不存在/空）、像素中心栅格化（外环扣除孔洞、L 形/旋转多边形、
// 参与像素数）、按像素欧氏距离分配（中垂线分区、等距像素归报告顺序首个）、
// 质心重合时首个占有/其余零面积、各区面积合计＝视野净像素面积、占比合计 100%、
// 分区多边形面积与像素面积一致、无计入细胞返回空结果、mm² 换算与未定标「待定标」。
const assert = require('assert');
const svc = require('./server/centroid-partition');
const geo = require('./server/geometry');

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const cell = (id, outer, holes = []) => ({ id, name: id, outer, holes });
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- 1. 视野标识解析 ----------

const fields1 = [
  { id: 'f1', name: '中心视野', outer: rect(0, 0, 10, 10), holes: [] },
  { id: 'f2', name: '同名', outer: rect(0, 0, 10, 10), holes: [] },
  { id: 'f3', name: '同名', outer: rect(0, 0, 10, 10), holes: [] }
];
assert.strictEqual(svc.resolvePartitionField(fields1, 'f1').field.id, 'f1');
assert.strictEqual(svc.resolvePartitionField(fields1, 'f1').matchBy, 'id');
assert.strictEqual(svc.resolvePartitionField(fields1, ' 中心视野 ').matchBy, 'name');
assert.strictEqual(svc.resolvePartitionField(fields1, 'f2').matchBy, 'id'); // id 始终优先精确匹配
assert.throws(() => svc.resolvePartitionField(fields1, '同名'),
  (e) => e.status === 400 && /2 个同名视野/.test(e.message) && /改用视野 id/.test(e.message));
assert.throws(() => svc.resolvePartitionField(fields1, 'ghost'),
  (e) => e.status === 400 && /视野标识不存在：ghost/.test(e.message));
for (const bad of [undefined, null, '', '   ', 5]) {
  assert.throws(() => svc.resolvePartitionField(fields1, bad),
    (e) => e.status === 400 && /非空的视野标识/.test(e.message), `空标识 ${String(bad)}`);
}
console.log('ok 1 视野标识解析：id/名称/重名/不存在/空标识（id 优先精确匹配）');

// ---------- 2. 像素中心栅格化 ----------

{
  // 整数矩形 100×100：10000 个像素中心全部在内
  const rast = svc.rasterizeNetRegion({ outer: rect(0, 0, 100, 100), holes: [] });
  let n = 0;
  rast.rows.forEach((pairs) => {
    for (let i = 0; i < pairs.length; i += 2) n += pairs[i + 1] - pairs[i] + 1;
  });
  assert.strictEqual(n, 10000, `矩形参与像素 ${n}`);
  assert.strictEqual(rast.yStart, 0);
  assert.strictEqual(rast.yEnd, 99);
  assert.strictEqual(rast.xStart, 0);
  assert.strictEqual(rast.xEnd, 99);

  // 含 20×20 孔洞 (40,40)：10000-400=9600
  const rastH = svc.rasterizeNetRegion({
    outer: rect(0, 0, 100, 100), holes: [rect(40, 40, 20, 20)]
  });
  let nH = 0;
  rastH.rows.forEach((pairs) => {
    for (let i = 0; i < pairs.length; i += 2) nH += pairs[i + 1] - pairs[i] + 1;
  });
  assert.strictEqual(nH, 9600, `含孔洞参与像素 ${nH}`);

  // L 形（上半 100×50 + 左下 50×50）：7500
  const rastL = svc.rasterizeNetRegion({
    outer: [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 },
      { x: 50, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 100 }
    ],
    holes: []
  });
  let nL = 0;
  rastL.rows.forEach((pairs) => {
    for (let i = 0; i < pairs.length; i += 2) nL += pairs[i + 1] - pairs[i] + 1;
  });
  assert.strictEqual(nL, 7500, `L 形参与像素 ${nL}`);
  console.log('ok 2 像素中心栅格化：整数矩形/孔洞扣除/L 形的参与像素数');
}

// ---------- 3. 中垂线分区：等距 50/50，合计不变量 ----------

{
  const field = { id: 'f', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  // 质心 (25,50) 与 (75,50)：像素中垂线在 x=50（无像素中心落在整数中垂线上）
  const cells = [cell('A', rect(15, 40, 20, 20)), cell('B', rect(65, 40, 20, 20))];
  const r = svc.buildPartition(field, cells, 1);
  assert.strictEqual(r.empty, false);
  assert.strictEqual(r.countedCellCount, 2);
  assert.strictEqual(r.netPixelArea, 10000);
  assert.strictEqual(r.sumAreaPx, 10000);
  const a = r.partitions.find((p) => p.key === 'A');
  const b = r.partitions.find((p) => p.key === 'B');
  assert.strictEqual(a.areaPx, 5000);
  assert.strictEqual(b.areaPx, 5000);
  assert.strictEqual(a.ratioPercent, 50);
  assert.strictEqual(a.ratioText, '50%');
  assert.strictEqual(a.zeroArea, false);
  // mm²：1 px = 1 μm → 1 px² = 1e-6 mm²
  assert(approx(a.areaMm2, 0.005), `A mm² ${a.areaMm2}`);
  assert.strictEqual(a.areaText, '0.005');
  // 质心坐标
  assert.deepStrictEqual(a.centroid, { x: 25, y: 50 });
  // 多边形面积与像素面积一致（整格矩形）
  const polyArea = a.polygons.reduce((s, poly) => s + geo.shoelaceArea(poly), 0);
  assert(approx(polyArea, 5000), `A 多边形面积 ${polyArea}`);
  assert(r.runs.length > 0, '返回 RLE 游程');
  const rleCount = r.runs.reduce((s, rn) => s + (rn.x1 - rn.x0 + 1), 0);
  assert.strictEqual(rleCount, 10000, 'RLE 覆盖全部参与像素');
  console.log('ok 3 中垂线分区：50/50、合计＝净像素面积、占比 100%、多边形面积一致');
}

// ---------- 4. 等距像素归报告顺序首个（等距边界不计面积） ----------

{
  const field = { id: 'f', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  // 质心 (25,50) 与 (76,50)：中垂线 x=50.5，恰为列 50 的像素中心 → 该列严格等距
  const cells = [cell('A', rect(15, 40, 20, 20)), cell('B', rect(66, 40, 20, 20))];
  const ownerOfCol50 = (result) => {
    const rn = result.runs.find((z) => z.y === 50 && z.x0 <= 50 && z.x1 >= 50);
    return result.partitions[rn.owner].key;
  };
  const r = svc.buildPartition(field, cells, 1);
  assert.strictEqual(r.sumAreaPx, 10000);
  assert.strictEqual(ownerOfCol50(r), 'A', '原顺序：等距列 50 归首个 A');
  assert.strictEqual(r.partitions.find((p) => p.key === 'A').areaPx, 5100);
  assert.strictEqual(r.partitions.find((p) => p.key === 'B').areaPx, 4900);
  // 交换细胞顺序：同一条等距列改归新的首个细胞 B（几何上列 51+ 本就归 B，
  // 故 B 得到列 50..99 共 5000、A 得到列 0..49 共 5000）
  const r2 = svc.buildPartition(field, [cells[1], cells[0]], 1);
  assert.strictEqual(ownerOfCol50(r2), 'B', '顺序反转后等距列归首个 B');
  assert.strictEqual(r2.partitions.find((p) => p.key === 'B').areaPx, 5000);
  assert.strictEqual(r2.partitions.find((p) => p.key === 'A').areaPx, 5000);
  assert.strictEqual(r2.sumAreaPx, 10000);
  console.log('ok 4 等距像素按报告细胞顺序归首个等距细胞（等距边界零面积语义）');
}

// ---------- 5. 质心重合：首个占有，其余保留零面积记录 ----------

{
  const field = { id: 'f', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  // 两个完全相同的轮廓（质心重合）
  const c = rect(10, 10, 20, 20);
  const r = svc.buildPartition(field, [cell('A', c), cell('B', c)], 1);
  assert.strictEqual(r.countedCellCount, 2);
  assert.strictEqual(r.partitions[0].key, 'A');
  assert.strictEqual(r.partitions[0].areaPx, 10000, '首个细胞占有全部区域');
  assert.strictEqual(r.partitions[1].key, 'B');
  assert.strictEqual(r.partitions[1].areaPx, 0, '其余细胞零面积');
  assert.strictEqual(r.partitions[1].zeroArea, true);
  assert.strictEqual(r.partitions[1].ratio, 0);
  assert.strictEqual(r.partitions[1].polygons.length, 0, '零面积细胞无分区几何');
  assert.strictEqual(r.sumAreaPx, 10000, '合计仍等于净像素面积');
  console.log('ok 5 质心重合：首个细胞占有全部区域，其余细胞保留零面积记录');
}

// ---------- 6. 孔洞与视野外不分配 ----------

{
  const field = {
    id: 'fh', name: 'FH', outer: rect(0, 0, 100, 100),
    holes: [rect(40, 40, 20, 20)]
  }; // 净像素 9600
  const cells = [cell('A', rect(15, 40, 20, 20)), cell('B', rect(65, 40, 20, 20))];
  const r = svc.buildPartition(field, cells, 1);
  assert.strictEqual(r.netPixelArea, 9600);
  assert.strictEqual(r.sumAreaPx, 9600);
  // 孔洞恰跨中垂线（列 40..59，行 40..59）：A 侧孔洞 10×20=200，B 侧同
  const a = r.partitions.find((p) => p.key === 'A');
  const b = r.partitions.find((p) => p.key === 'B');
  assert.strictEqual(a.areaPx, 4800, `A ${a.areaPx}`);
  assert.strictEqual(b.areaPx, 4800, `B ${b.areaPx}`);
  // 孔洞像素不在任何 RLE 游程中
  const inHole = r.runs.some((rn) => rn.y >= 40 && rn.y <= 59 && rn.x0 <= 50 && rn.x1 >= 40);
  assert.strictEqual(inHole, false, '孔洞像素不分配');
  console.log('ok 6 视野孔洞不分配（合计为扣洞后的净像素面积）');
}

// ---------- 7. 无计入细胞：空结果 ----------

{
  const field = { id: 'f', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  // 细胞质心在视野外
  const r1 = svc.buildPartition(field, [cell('O', rect(200, 200, 10, 10))], 1);
  assert.strictEqual(r1.empty, true);
  assert.strictEqual(r1.countedCellCount, 0);
  assert.deepStrictEqual(r1.partitions, []);
  assert.strictEqual(r1.netPixelArea, 0);
  assert.strictEqual(r1.sumAreaPx, 0);
  assert.strictEqual(r1.vectorAreaPx, 10000, '空结果仍给矢量净面积供对照');
  // 细胞在孔洞内（质心不严格落在净区域）
  const fh = { ...field, holes: [rect(40, 40, 20, 20)] };
  const r2 = svc.buildPartition(fh, [cell('H', rect(42, 42, 10, 10))], 1);
  assert.strictEqual(r2.empty, true);
  // 无细胞
  const r3 = svc.buildPartition(field, [], 1);
  assert.strictEqual(r3.empty, true);
  console.log('ok 7 无计入细胞（视野外/孔洞内/无细胞）返回空结果');
}

// ---------- 8. 旋转多边形与非对称三区 ----------

{
  // 菱形 (50,0),(100,50),(50,100),(0,50)：矢量面积 5000；三个质心在内的细胞
  const diamond = {
    id: 'd', name: 'D',
    outer: [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }],
    holes: []
  };
  const cells = [
    cell('A', rect(20, 45, 8, 8)),   // 质心 (24,49)
    cell('B', rect(60, 30, 8, 8)),   // 质心 (64,34)
    cell('C', rect(55, 70, 8, 8))    // 质心 (59,74)
  ];
  const r = svc.buildPartition(diamond, cells, 1);
  assert.strictEqual(r.countedCellCount, 3);
  assert.strictEqual(r.partitions.length, 3);
  assert(r.netPixelArea > 4800 && r.netPixelArea < 5000, `菱形净像素 ${r.netPixelArea}`);
  assert.strictEqual(r.sumAreaPx, r.netPixelArea);
  const sumRatio = r.partitions.reduce((s, p) => s + p.ratio, 0);
  assert(approx(sumRatio, 1, 1e-9), `占比合计 ${sumRatio}`);
  // 每区多边形为简单矩形/多边形区域，面积合计与像素合计接近
  const polySum = r.partitions.reduce(
    (s, p) => s + p.polygons.reduce((t, poly) => t + geo.shoelaceArea(poly), 0), 0);
  assert(Math.abs(polySum - r.netPixelArea) < r.netPixelArea * 0.05,
    `多边形合计 ${polySum} 与像素 ${r.netPixelArea} 偏差过大`);
  assert(r.partitions.every((p) => p.areaPx > 0), '三区都有正面积');
  console.log('ok 8 旋转视野 + 三区：合计不变量、占比 100%、多边形几何可用');
}

// ---------- 9. 未定标：mm² 文本「待定标」，像素面积照常 ----------

{
  const field = { id: 'f', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const cells = [cell('A', rect(15, 40, 20, 20)), cell('B', rect(65, 40, 20, 20))];
  const r = svc.buildPartition(field, cells, null);
  assert.strictEqual(r.calibrated, false);
  assert.strictEqual(r.netAreaMm2, null);
  assert.strictEqual(r.netAreaText, '待定标');
  for (const p of r.partitions) {
    assert.strictEqual(p.areaMm2, null);
    assert.strictEqual(p.areaText, '待定标');
    assert(p.areaPx > 0, '像素面积不依赖定标');
  }
  console.log('ok 9 未定标：像素面积与占比照常，mm² 为「待定标」');
}

// ---------- 10. 质心严格归属：质心在视野边界上的细胞不计入 ----------

{
  // 视野 0..100；细胞外轮廓跨左边界，质心恰在 x=0 边界上（rect(-20,40,40,20) 中心 x=0）
  const field = { id: 'f', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const onEdge = cell('E', rect(-20, 40, 40, 20)); // 质心 (0,50) 在视野边界
  const inside = cell('A', rect(10, 10, 20, 20));
  const r = svc.buildPartition(field, [onEdge, inside], 1);
  assert.strictEqual(r.countedCellCount, 1, '边界质心不计入');
  assert.strictEqual(r.partitions[0].key, 'A');
  assert.strictEqual(r.sumAreaPx, 10000);
  console.log('ok 10 质心落在视野边界的细胞不计入（沿用严格归属规则）');
}

console.log('\n全部最近质心责任区划分纯逻辑自测通过 ✔');
