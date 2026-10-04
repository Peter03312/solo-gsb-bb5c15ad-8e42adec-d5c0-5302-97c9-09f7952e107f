'use strict';

// 已发布报告 · 单视野「最近质心责任区」划分（只读）
//
// 选择报告冻结的一个取样视野，把【视野净区域】按【像素欧氏距离】分配给最近的
// 【计入细胞】（沿用现有净区域质心 + 视野严格归属规则：质心严格落在视野净区域内）：
//   - 以像素中心为采样点：中心严格落在视野净区域（外环内、不在孔洞内/边界上）的像素参与分配，
//     视野孔洞内部与视野外部像素一律不分配；
//   - 每个参与像素分给距其中心【像素欧氏距离】最近的计入细胞（比较平方距离即可）；
//   - 等距是零面积边界：比较使用严格小于，等距像素按报告细胞顺序归首个等距细胞，
//     数值上不产生面积偏差；质心重合时首个（按报告顺序）细胞占有全部相关区域，
//     其余细胞保留 areaPx=0 的零面积记录；
//   - 有计入细胞时各区面积合计恰好等于参与像素数（划分穷尽视野净区域的像素采样）。
//
// 像素面积按像素中心采样计数（1 px × 1 px），与冻结图片逐像素对应；
// 物理面积（mm²）按报告冻结标尺换算（与视野统计同一换算）。
// 结果同时返回矢量净面积（鞋带公式，供对照）；本划分只使用像素面积，不写任何数据。

const geo = require('./geometry');
const fieldsSvc = require('./fields');

const PENDING = '待定标';

function round(v, n = 6) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// ---------- 请求校验 ----------

// 解析视野标识：先按 id 精确匹配，再按名称（trim 后）精确匹配。
// 空标识 / 不存在 / 名称重名均抛出明确错误（由接口层返回 400）。返回 {field, index, matchBy}。
function resolvePartitionField(fields, identifier) {
  const all = Array.isArray(fields) ? fields : [];
  if (typeof identifier !== 'string' || !identifier.trim()) {
    throw { status: 400, message: '责任区划分请求无效：fieldId 必须为非空的视野标识（id 或视野名称）' };
  }
  const byIdIndex = all.findIndex((f) => f && typeof f.id === 'string' && f.id === identifier);
  if (byIdIndex >= 0) return { field: all[byIdIndex], index: byIdIndex, matchBy: 'id' };
  const name = identifier.trim();
  const nameMatches = [];
  all.forEach((f, i) => {
    if (f && typeof f.name === 'string' && f.name.trim() === name) nameMatches.push(i);
  });
  if (nameMatches.length === 1) return { field: all[nameMatches[0]], index: nameMatches[0], matchBy: 'name' };
  if (nameMatches.length > 1) {
    throw {
      status: 400,
      message: `视野名称「${name}」在本报告中存在 ${nameMatches.length} 个同名视野，` +
        '无法唯一确定，请改用视野 id 查询（可在报告详情的 fields 中获取）'
    };
  }
  throw {
    status: 400,
    message: `视野标识不存在：${identifier}（不属于该报告；请使用本报告发布时冻结的视野 id 或名称），请求被拒绝`
  };
}

// ---------- 像素栅格化（像素中心采样） ----------

function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// 计算水平线 y 与线段 (ax,ay)-(bx,by) 的交点 x；调用方已保证 y 严格位于两端 y 之间
// （水平边与端点情形在配对的另一侧交点处理）。
function edgeCrossX(y, ax, ay, bx, by) {
  const t = (y - ay) / (by - ay);
  return ax + t * (bx - ax);
}

// 收集扫描线与一个环的全部交点 x（不含水平边；端点按交叉数规则的半边约定计入）。
function scanlineCrossings(ring, y, out) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a.y === b.y) continue; // 水平边不与扫描线横切
    // 半边约定：下端点（y 较小者）包含、上端点不包含，顶点不会被计两次
    if (y >= a.y && y < b.y) out.push(edgeCrossX(y, a.x, a.y, b.x, b.y));
    else if (y >= b.y && y < a.y) out.push(edgeCrossX(y, b.x, b.y, a.x, a.y));
  }
}

// 对一条扫描线上已排序的交点做奇偶配对，生成落在区间内的整数像素列段 [l, r]（含端点列）。
// 像素列 c 的中心为 c+0.5；区间 (x0, x1) 内的列满足 x0 < c+0.5 < x1。
function spansFromPairs(xs, xStart, xEnd, out) {
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const x0 = xs[k];
    const x1 = xs[k + 1];
    // 最小整数 c 使 c+0.5 > x0：floor(x0+0.5)（x0 恰为半整数时该中心在边界上，自然排除）
    let l = Math.floor(x0 + 0.5);
    // 最大整数 c 使 c+0.5 < x1：ceil(x1-0.5)-1
    let r = Math.ceil(x1 - 0.5) - 1;
    if (l < xStart) l = xStart;
    if (r > xEnd) r = xEnd;
    if (l <= r) out.push(l, r);
  }
}

// 栅格化净区域：返回参与分配的像素列段（按行，每行一个 [l,r] 对数组）与包围盒像素范围。
// 外环与孔洞的交点合并后奇偶配对：外环内、孔洞外的中心才参与（孔洞按奇偶填充自动挖去）。
function rasterizeNetRegion(field) {
  const holes = Array.isArray(field.holes) ? field.holes : [];
  const b = ringBBox(field.outer);
  // 像素行 r 的中心为 r+0.5；落在 (minY, maxY) 内的行（半整数边界按中心在边界上排除）
  const yStart = Math.floor(b.minY + 0.5);
  const yEnd = Math.ceil(b.maxY - 0.5) - 1;
  // 像素列范围（外环内的列不可能越出外环包围盒）
  const xStart = Math.floor(b.minX + 0.5);
  const xEnd = Math.ceil(b.maxX - 0.5) - 1;

  const rows = [];
  const crossings = [];
  for (let r = yStart; r <= yEnd; r++) {
    const y = r + 0.5;
    crossings.length = 0;
    scanlineCrossings(field.outer, y, crossings);
    for (const h of holes) scanlineCrossings(h, y, crossings);
    if (crossings.length < 2) { rows.push([]); continue; }
    crossings.sort((u, v) => u - v);
    const pairs = [];
    spansFromPairs(crossings, xStart, xEnd, pairs);
    rows.push(pairs);
  }
  return { yStart, yEnd, xStart, xEnd, rows };
}

// ---------- 责任区边界提取（像素网格上的 4-邻接等值线） ----------

// 在标签网格（相对包围盒的 Int32Array，-1 为未分配）上收集各区的边界单位边。
// 对每个分配像素的四条单位边，若相邻像素（越界按未分配）标签不同，该边进入该区的边集：
// 两个责任区之间的分界会【分别】进入两侧区的边集（同一条边闭合各自的轮廓），
// 区与未分配（孔洞/视野外）之间的边只属于该区一次。返回 Map<owner, 边数组>。
function collectBoundaryEdges(labels, stride, w, h) {
  const byOwner = new Map();
  const addEdge = (owner, x0, y0, x1, y1) => {
    let list = byOwner.get(owner);
    if (!list) { list = []; byOwner.set(owner, list); }
    // 每个 owner 的每条单位边只会被其自身像素扫描一次，无需去重
    list.push({ x0, y0, x1, y1, owner });
  };
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const owner = labels[py * stride + px];
      if (owner < 0) continue;
      const up = py > 0 ? labels[(py - 1) * stride + px] : -1;
      const down = py < h - 1 ? labels[py * stride + px + stride] : -1;
      const left = px > 0 ? labels[py * stride + px - 1] : -1;
      const right = px < w - 1 ? labels[py * stride + px + 1] : -1;
      if (up !== owner) addEdge(owner, px, py, px + 1, py);           // 上边
      if (down !== owner) addEdge(owner, px, py + 1, px + 1, py + 1); // 下边
      if (left !== owner) addEdge(owner, px, py, px, py + 1);         // 左边
      if (right !== owner) addEdge(owner, px + 1, py, px + 1, py + 1); // 右边
    }
  }
  return byOwner;
}

// 把【同一个责任区】的无向单位边按端点拼接为闭合折线（每条边恰好属于一条折线；
// 分叉处共享顶点，逐度数配对仍能得到覆盖全部边的闭合行走）。返回点数组的列表。
function stitchLoops(edges) {
  const byVertex = new Map(); // "x,y" -> [{to, edge}]
  const add = (x, y, to, edge) => {
    const k = `${x},${y}`;
    if (!byVertex.has(k)) byVertex.set(k, []);
    byVertex.get(k).push({ to, edge });
  };
  edges.forEach((edge, id) => {
    edge.id = id;
    add(edge.x0, edge.y0, { x: edge.x1, y: edge.y1 }, edge);
    add(edge.x1, edge.y1, { x: edge.x0, y: edge.y0 }, edge);
  });
  const used = new Uint8Array(edges.length);
  const loops = [];
  for (const e0 of edges) {
    if (used[e0.id]) continue;
    const start = { x: e0.x0, y: e0.y0 };
    const pts = [start];
    let cur = { x: e0.x1, y: e0.y1 };
    let curEdge = e0;
    used[e0.id] = 1;
    while (true) {
      pts.push(cur);
      const cands = byVertex.get(`${cur.x},${cur.y}`) || [];
      let next = null;
      // 优先走不通向起点的未用边：避免在分叉顶点提前沿闭合边回到起点
      for (const c of cands) {
        if (c.edge.id === curEdge.id || used[c.edge.id]) continue;
        if (!(c.to.x === start.x && c.to.y === start.y)) { next = c; break; }
      }
      // 只剩通向起点的边（或无路可走）时才闭合
      if (!next) {
        for (const c of cands) {
          if (c.edge.id === curEdge.id || used[c.edge.id]) continue;
          if (c.to.x === start.x && c.to.y === start.y) { next = c; break; }
        }
      }
      if (!next) break; // 防御：理论上闭合前每步都有未用边
      used[next.edge.id] = 1;
      cur = next.to;
      curEdge = next.edge;
      if (cur.x === start.x && cur.y === start.y) break;
    }
    if (pts.length >= 2) loops.push(pts);
  }
  return loops;
}

// Douglas–Peucker 折线简化（平方距离阈值），去掉像素锯齿上的共线阶梯点。
function simplifyRing(points, epsilonPx) {
  if (points.length < 3) return points;
  const tol2 = epsilonPx * epsilonPx;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    if (j <= i + 1) continue;
    const a = points[i];
    const b = points[j];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let maxD = -1;
    let maxK = -1;
    for (let k = i + 1; k < j; k++) {
      const p = points[k];
      const cross = (p.x - a.x) * dy - (p.y - a.y) * dx;
      const d = (cross * cross) / len2;
      if (d > maxD) { maxD = d; maxK = k; }
    }
    if (maxD > tol2 && maxK > 0) {
      keep[maxK] = true;
      stack.push([i, maxK], [maxK, j]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// ---------- 责任区划分 ----------

// field：目标视野（已解析）；cells：报告冻结的全部细胞；
// scale：μm/px（报告冻结定标，未定标 null）。
// 返回每个计入细胞的责任区像素面积、mm² 面积、占比与实际分区几何；不写任何数据。
function buildPartition(field, cells, scale) {
  const safeCells = Array.isArray(cells) ? cells : [];
  const holes = Array.isArray(field.holes) ? field.holes : [];

  // 计入细胞：沿用现有净区域质心 + 视野严格归属规则（与 fieldStats 同一批质心与判定）
  const centroids = fieldsSvc.computeCentroids(safeCells);
  const counted = [];
  safeCells.forEach((cell, i) => {
    const ctr = centroids[i];
    if (!ctr) return; // 净面积为零的细胞没有良定义质心，不计入
    if (!fieldsSvc.pointInFieldNet(ctr, field)) return;
    counted.push({ index: i, cell, key: fieldsSvc.cellKey(cell, i), cx: ctr.x, cy: ctr.y });
  });

  // 视野矢量净面积（鞋带公式；与逐视野统计同公式，仅作对照信息）
  const vectorAreaPx = Math.abs(geo.signedArea(field.outer)) -
    holes.reduce((s, h) => s + Math.abs(geo.signedArea(h)), 0);

  const calibrated = typeof scale === 'number' && Number.isFinite(scale) && scale > 0;

  // 无计入细胞：视野净区域无法划分，返回空结果（由调用方给出提示）
  if (!counted.length) {
    return {
      kind: 'centroid-partition',
      fieldId: field.id,
      fieldName: (field.name && String(field.name).trim()) || '',
      fieldHoles: holes.length,
      empty: true,
      countedCellCount: 0,
      bounds: null,
      netPixelArea: 0,
      vectorAreaPx: round(vectorAreaPx),
      netAreaMm2: calibrated ? fieldsSvc.px2ToMm2(vectorAreaPx, scale) : null,
      sumAreaPx: 0,
      partitions: [],
      runs: [],
      overlay: { centroids: [] },
      calibrated
    };
  }

  // 参与分配的像素（中心严格落在视野净区域内）
  const rast = rasterizeNetRegion(field);
  const { yStart, yEnd, xStart, xEnd, rows } = rast;
  const w = Math.max(0, xEnd - xStart + 1);
  const h = Math.max(0, yEnd - yStart + 1);
  const stride = w;
  const labels = new Int32Array(w * h).fill(-1); // 值为 counted 序号；-1 未分配
  const areaByOwner = new Int32Array(counted.length);
  // 质心坐标取出为定长数组，避免热循环里的对象寻址
  const ccx = Float64Array.from(counted, (t) => t.cx);
  const ccy = Float64Array.from(counted, (t) => t.cy);
  const nCells = counted.length;

  // 逐扫描线分配：每个像素归平方欧氏距离【严格】最近的计入细胞；
  // 等距时保留先出现者（数组按报告细胞顺序）——等距边界为零面积，不影响面积合计。
  const dy2 = new Float64Array(nCells);
  for (let ry = 0; ry < rows.length; ry++) {
    const pairs = rows[ry];
    const yAbs = yStart + ry;
    const y = yAbs + 0.5;
    for (let t = 0; t < nCells; t++) {
      const ddy = y - ccy[t];
      dy2[t] = ddy * ddy;
    }
    const rowBase = (yAbs - yStart) * stride;
    for (let p = 0; p < pairs.length; p += 2) {
      const l = pairs[p];
      const r = pairs[p + 1];
      for (let xAbs = l; xAbs <= r; xAbs++) {
        const px = xAbs + 0.5;
        let best = 0;
        let bestD2 = Infinity;
        for (let t = 0; t < nCells; t++) {
          const ddx = px - ccx[t];
          const d2 = ddx * ddx + dy2[t];
          if (d2 < bestD2) { bestD2 = d2; best = t; } // 严格小于：等距/质心重合归首个
        }
        labels[rowBase + (xAbs - xStart)] = best;
        areaByOwner[best] += 1;
      }
    }
  }

  let netPixelArea = 0;
  for (const a of areaByOwner) netPixelArea += a;

  // RLE：逐行记录每个责任区的连续列段 [c0, c1]（全局像素坐标，含端点列），
  // 供页面精确命中测试与逐像素重绘；等距边界按上述归属落在某一侧，不产生额外段。
  const runs = [];
  for (let ry = 0; ry < h; ry++) {
    const yAbs = yStart + ry;
    let c = 0;
    while (c < w) {
      const owner = labels[ry * stride + c];
      if (owner < 0) { c += 1; continue; }
      let end = c;
      while (end + 1 < w && labels[ry * stride + end + 1] === owner) end += 1;
      runs.push({ y: yAbs, x0: xStart + c, x1: xStart + end, owner });
      c = end + 1;
    }
  }

  // 实际分区几何：像素网格上的 4-邻接等值线 → 按区分组闭合折线 → Douglas–Peucker 简化
  const edgesByOwner = collectBoundaryEdges(labels, stride, w, h);
  const polygonsByOwner = new Map();
  for (const [oi, edgeList] of edgesByOwner) {
    const rawLoops = stitchLoops(edgeList);
    const polys = [];
    for (const loop of rawLoops) {
      const simplified = simplifyRing(loop, 0.75)
        .map((p) => ({ x: round3(p.x + xStart), y: round3(p.y + yStart) }));
      if (simplified.length >= 3) polys.push(simplified);
    }
    polygonsByOwner.set(oi, polys);
  }

  // 每个计入细胞一条记录（按报告细胞顺序；零面积细胞保留）
  const partitions = counted.map((entry, t) => {
    const areaPx = areaByOwner[t];
    const areaMm2 = calibrated ? fieldsSvc.px2ToMm2(areaPx, scale) : null;
    const ratio = netPixelArea > 0 ? areaPx / netPixelArea : 0;
    return {
      key: entry.key,
      cellIndex: entry.index,
      name: entry.cell.name || '',
      centroid: { x: round3(entry.cx), y: round3(entry.cy) },
      areaPx,
      areaMm2,
      areaText: calibrated ? String(round(areaMm2)) : PENDING,
      ratio,
      ratioPercent: round(ratio * 100, 4),
      ratioText: `${round(ratio * 100, 4)}%`,
      zeroArea: areaPx === 0,
      polygons: polygonsByOwner.get(t) || []
    };
  });

  let sumRatio = 0;
  for (const p of partitions) sumRatio += p.ratio;
  if (netPixelArea > 0 && Math.abs(sumRatio - 1) > 1e-9) {
    throw new Error('责任区划分内部校验失败：各区占比之和不为 1');
  }

  return {
    kind: 'centroid-partition',
    fieldId: field.id,
    fieldName: (field.name && String(field.name).trim()) || '',
    fieldHoles: holes.length,
    empty: false,
    countedCellCount: counted.length,
    // 像素包围盒（参与像素的全局列/行范围）
    bounds: { minX: xStart, minY: yStart, maxX: xEnd + 1, maxY: yEnd + 1 },
    netPixelArea,                 // 参与分配的像素总数（各区面积合计必须相等）
    vectorAreaPx: round(vectorAreaPx), // 矢量净面积（鞋带公式，仅作对照）
    netAreaMm2: calibrated ? fieldsSvc.px2ToMm2(netPixelArea, scale) : null,
    netAreaText: calibrated ? String(round(fieldsSvc.px2ToMm2(netPixelArea, scale))) : PENDING,
    sumAreaPx: partitions.reduce((s, p) => s + p.areaPx, 0),
    runs,
    partitions,
    // 分区多边形直接随各 partition.polygons 返回；overlay 只保留质心点
    overlay: {
      centroids: counted.map((entry) => ({
        key: entry.key, x: round3(entry.cx), y: round3(entry.cy)
      }))
    },
    calibrated
  };
}

module.exports = {
  PENDING,
  resolvePartitionField,
  rasterizeNetRegion,
  buildPartition,
  round
};
