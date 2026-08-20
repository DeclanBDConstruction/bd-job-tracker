// Converts a CAD drawing's scene JSON (see public/cad.js's header comment for the shape)
// into a minimal, valid DXF R12 ASCII file - openable in AutoCAD, LibreCAD, FreeCAD, etc.
// Pure string-building, no dependencies, no I/O - easy to unit-test (see test/cadDxf.test.js).
//
// Known v1 simplifications, both cosmetic rather than structural:
//  - Dimension entities export as plain LINE + TEXT, not true parametric DXF DIMENSION
//    objects (those need an anonymous block + associative geometry - a lot more DXF for a
//    feature that only matters if you're re-editing the exported file as a live dimension
//    inside AutoCAD itself; visually it's identical either way).
//  - Layer colours are mapped to the nearest of AutoCAD's 9 standard palette colours (ACI
//    1-9), not the full 256-colour index - those 9 are consistent across every DXF reader,
//    unlike the extended palette.
//  - Assumes 1 drawing unit = 1mm ($INSUNITS 4).

const ACI_PALETTE = [
  { aci: 1, rgb: [255, 0, 0] },     // red
  { aci: 2, rgb: [255, 255, 0] },   // yellow
  { aci: 3, rgb: [0, 255, 0] },     // green
  { aci: 4, rgb: [0, 255, 255] },   // cyan
  { aci: 5, rgb: [0, 0, 255] },     // blue
  { aci: 6, rgb: [255, 0, 255] },   // magenta
  { aci: 7, rgb: [255, 255, 255] }, // white
  { aci: 8, rgb: [65, 65, 65] },    // dark grey
  { aci: 9, rgb: [128, 128, 128] }, // light grey
];

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

function nearestAci(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = ACI_PALETTE[0];
  let bestDist = Infinity;
  for (const entry of ACI_PALETTE) {
    const [er, eg, eb] = entry.rgb;
    const dist = (r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2;
    if (dist < bestDist) { bestDist = dist; best = entry; }
  }
  return best.aci;
}

function pair(code, value) {
  return `${code}\n${value}\n`;
}

function num(n) {
  // Plain decimal, trimmed of noise - DXF just wants a valid numeric token per line.
  return String(Math.round((Number(n) || 0) * 1e6) / 1e6);
}

function safeLayerName(name) {
  return String(name || '0').replace(/[\r\n]/g, ' ').trim() || '0';
}

function safeText(content) {
  return String(content || '').replace(/[\r\n]/g, ' ');
}

function dxfHeader() {
  return pair(0, 'SECTION') + pair(2, 'HEADER')
    + pair(9, '$ACADVER') + pair(1, 'AC1009')
    + pair(9, '$INSUNITS') + pair(70, 4) // 4 = millimeters
    + pair(0, 'ENDSEC');
}

function dxfLayerTable(layers) {
  let out = pair(0, 'SECTION') + pair(2, 'TABLES')
    + pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, layers.length);
  for (const layer of layers) {
    out += pair(0, 'LAYER')
      + pair(2, safeLayerName(layer.name))
      + pair(70, 0)
      + pair(62, nearestAci(layer.color))
      + pair(6, 'CONTINUOUS');
  }
  out += pair(0, 'ENDTABLE') + pair(0, 'ENDSEC');
  return out;
}

function dxfLine(layerName, x1, y1, x2, y2) {
  return pair(0, 'LINE') + pair(8, layerName)
    + pair(10, num(x1)) + pair(20, num(y1)) + pair(30, '0.0')
    + pair(11, num(x2)) + pair(21, num(y2)) + pair(31, '0.0');
}

function dxfCircle(layerName, cx, cy, radius) {
  return pair(0, 'CIRCLE') + pair(8, layerName)
    + pair(10, num(cx)) + pair(20, num(cy)) + pair(30, '0.0')
    + pair(40, num(radius));
}

function dxfArc(layerName, cx, cy, radius, startAngle, endAngle) {
  // DXF ARC angles are degrees, CCW from the positive X axis - the same convention this
  // tool's arc entities already use internally, so no conversion beyond radians->degrees.
  return pair(0, 'ARC') + pair(8, layerName)
    + pair(10, num(cx)) + pair(20, num(cy)) + pair(30, '0.0')
    + pair(40, num(radius))
    + pair(50, num(startAngle * 180 / Math.PI)) + pair(51, num(endAngle * 180 / Math.PI));
}

function dxfPolyline(layerName, points, closed) {
  let out = pair(0, 'POLYLINE') + pair(8, layerName) + pair(66, 1) + pair(70, closed ? 1 : 0);
  for (const p of points) {
    out += pair(0, 'VERTEX') + pair(8, layerName)
      + pair(10, num(p.x)) + pair(20, num(p.y)) + pair(30, '0.0');
  }
  out += pair(0, 'SEQEND');
  return out;
}

function dxfText(layerName, x, y, height, content) {
  return pair(0, 'TEXT') + pair(8, layerName)
    + pair(10, num(x)) + pair(20, num(y)) + pair(30, '0.0')
    + pair(40, num(height))
    + pair(1, safeText(content));
}

function formatDimensionLength(worldLen, units) {
  if (units === 'm') return `${(worldLen / 1000).toFixed(2)}m`;
  if (units === 'ft') return `${(worldLen / 304.8).toFixed(2)}ft`;
  if (units === 'in') return `${(worldLen / 25.4).toFixed(1)}in`;
  return `${Math.round(worldLen)}mm`;
}

// Flattened to LINE + TEXT - see the module header comment for why.
function dxfDimension(layerName, ent, units) {
  const dx = ent.x2 - ent.x1, dy = ent.y2 - ent.y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const off = ent.offset || 0;
  const p1 = { x: ent.x1 + nx * off, y: ent.y1 + ny * off };
  const p2 = { x: ent.x2 + nx * off, y: ent.y2 + ny * off };
  const worldLen = Math.hypot(dx, dy);
  const text = ent.text || formatDimensionLength(worldLen, units);
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const textHeight = Math.max(worldLen * 0.03, 50);
  return dxfLine(layerName, ent.x1, ent.y1, p1.x, p1.y)
    + dxfLine(layerName, ent.x2, ent.y2, p2.x, p2.y)
    + dxfLine(layerName, p1.x, p1.y, p2.x, p2.y)
    + dxfText(layerName, mid.x, mid.y, textHeight, text);
}

function dxfEntitySection(scene) {
  const layerById = new Map(scene.layers.map((l) => [l.id, l]));
  let out = pair(0, 'SECTION') + pair(2, 'ENTITIES');
  for (const ent of scene.entities) {
    const layer = layerById.get(ent.layerId);
    if (!layer || !layer.visible) continue;
    const layerName = safeLayerName(layer.name);
    if (ent.type === 'line') out += dxfLine(layerName, ent.x1, ent.y1, ent.x2, ent.y2);
    else if (ent.type === 'polyline') out += dxfPolyline(layerName, ent.points, ent.closed);
    else if (ent.type === 'rectangle') {
      out += dxfPolyline(layerName, [
        { x: ent.x, y: ent.y }, { x: ent.x + ent.width, y: ent.y },
        { x: ent.x + ent.width, y: ent.y + ent.height }, { x: ent.x, y: ent.y + ent.height },
      ], true);
    } else if (ent.type === 'circle') out += dxfCircle(layerName, ent.cx, ent.cy, ent.radius);
    else if (ent.type === 'arc') out += dxfArc(layerName, ent.cx, ent.cy, ent.radius, ent.startAngle, ent.endAngle);
    else if (ent.type === 'text') out += dxfText(layerName, ent.x, ent.y, ent.height, ent.content);
    else if (ent.type === 'dimension') out += dxfDimension(layerName, ent, scene.units);
  }
  out += pair(0, 'ENDSEC');
  return out;
}

function sceneToDxf(scene) {
  const safeScene = scene && Array.isArray(scene.layers) ? scene : { layers: [{ name: '0', color: '#000000' }], entities: [], units: 'mm' };
  return dxfHeader()
    + dxfLayerTable(safeScene.layers)
    + dxfEntitySection(safeScene)
    + pair(0, 'EOF');
}

module.exports = { sceneToDxf, nearestAci };
