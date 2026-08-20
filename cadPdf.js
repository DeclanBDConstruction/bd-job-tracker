// Renders a CAD drawing's scene JSON to a vector PDF, fitted to the drawing's stated page
// size/scale with a simple title block - same pdf-lib module shape as permitPdf.js (one
// exported async function returning a Buffer via pdfDoc.save()).
//
// Both PDF points and this tool's world space put y increasing upward, so unlike the canvas
// renderer in public/cad.js (which flips y for screen space), no axis flip is needed here -
// only a uniform scale + origin offset to fit the drawing's bounding box on the page.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COMPANY_NAME = 'BD Construction Limited';

const TEXT_DARK = rgb(0.13, 0.13, 0.13);
const GREY = rgb(0.45, 0.45, 0.45);
const LINE_GREY = rgb(0.82, 0.82, 0.82);
const BLUE_DARK = rgb(0.07, 0.31, 0.47);

const PAGE_SIZES = {
  A4: [595.28, 841.89],
  A3: [841.89, 1190.55],
};

function pageDimensions(size, orientation) {
  const [w, h] = PAGE_SIZES[size] || PAGE_SIZES.A4;
  return orientation === 'landscape' ? [h, w] : [w, h];
}

function hexToRgbColor(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return TEXT_DARK;
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

// Same shape as cadEntityBounds/cadComputeSceneBounds in public/cad.js, duplicated rather
// than shared - that file runs in the browser and touches the DOM at load time, so it can't
// be required from Node.
function entityBounds(ent) {
  if (ent.type === 'line' || ent.type === 'dimension') {
    return { minX: Math.min(ent.x1, ent.x2), maxX: Math.max(ent.x1, ent.x2), minY: Math.min(ent.y1, ent.y2), maxY: Math.max(ent.y1, ent.y2) };
  }
  if (ent.type === 'polyline') {
    if (!ent.points.length) return null;
    const xs = ent.points.map((p) => p.x), ys = ent.points.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }
  if (ent.type === 'rectangle') {
    return { minX: ent.x, maxX: ent.x + ent.width, minY: ent.y, maxY: ent.y + ent.height };
  }
  if (ent.type === 'circle' || ent.type === 'arc') {
    return { minX: ent.cx - ent.radius, maxX: ent.cx + ent.radius, minY: ent.cy - ent.radius, maxY: ent.cy + ent.radius };
  }
  if (ent.type === 'text') {
    const w = (ent.content ? ent.content.length : 1) * ent.height * 0.6;
    return { minX: ent.x, maxX: ent.x + w, minY: ent.y, maxY: ent.y + ent.height };
  }
  return null;
}

function computeSceneBounds(scene) {
  const layerById = new Map(scene.layers.map((l) => [l.id, l]));
  let bounds = null;
  for (const ent of scene.entities) {
    const layer = layerById.get(ent.layerId);
    if (!layer || !layer.visible) continue;
    const b = entityBounds(ent);
    if (!b) continue;
    bounds = bounds
      ? { minX: Math.min(bounds.minX, b.minX), maxX: Math.max(bounds.maxX, b.maxX), minY: Math.min(bounds.minY, b.minY), maxY: Math.max(bounds.maxY, b.maxY) }
      : b;
  }
  return bounds;
}

function formatDimensionLength(worldLen, units) {
  if (units === 'm') return `${(worldLen / 1000).toFixed(2)}m`;
  if (units === 'ft') return `${(worldLen / 304.8).toFixed(2)}ft`;
  if (units === 'in') return `${(worldLen / 25.4).toFixed(1)}in`;
  return `${Math.round(worldLen)}mm`;
}

// Arcs have no native pdf-lib primitive, so they're tessellated into short line segments -
// the same simplification the plan calls for, and visually indistinguishable at print size.
function tessellateArc(cx, cy, radius, startAngle, endAngle, segments) {
  let sweep = endAngle - startAngle;
  while (sweep < 0) sweep += Math.PI * 2;
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = startAngle + (sweep * i) / segments;
    pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
  }
  return pts;
}

async function generateCadPdf(drawing) {
  const scene = drawing.sceneData && Array.isArray(drawing.sceneData.layers)
    ? drawing.sceneData
    : { layers: [], entities: [], units: 'mm', scale: 50, page: { size: 'A3', orientation: 'landscape' } };

  const pdfDoc = await PDFDocument.create();
  const [pageWidth, pageHeight] = pageDimensions(
    (scene.page && scene.page.size) || 'A3',
    (scene.page && scene.page.orientation) || 'landscape',
  );
  const page = pdfDoc.addPage([pageWidth, pageHeight]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const margin = 36;
  const titleBlockHeight = 40;
  const drawAreaX = margin;
  const drawAreaY = margin + titleBlockHeight;
  const drawAreaWidth = pageWidth - margin * 2;
  const drawAreaHeight = pageHeight - margin * 2 - titleBlockHeight;

  const bounds = computeSceneBounds(scene);
  const boundsW = bounds ? Math.max(bounds.maxX - bounds.minX, 1) : 1000;
  const boundsH = bounds ? Math.max(bounds.maxY - bounds.minY, 1) : 1000;
  const scalePtPerMm = bounds ? Math.min(drawAreaWidth / boundsW, drawAreaHeight / boundsH) : 1;
  const originWorldX = bounds ? bounds.minX : 0;
  const originWorldY = bounds ? bounds.minY : 0;
  // Centre the fitted drawing within the drawable area on whichever axis has slack.
  const offsetX = drawAreaX + (drawAreaWidth - boundsW * scalePtPerMm) / 2;
  const offsetY = drawAreaY + (drawAreaHeight - boundsH * scalePtPerMm) / 2;

  function toPdf(x, y) {
    return { x: offsetX + (x - originWorldX) * scalePtPerMm, y: offsetY + (y - originWorldY) * scalePtPerMm };
  }

  const layerById = new Map(scene.layers.map((l) => [l.id, l]));

  function drawPolylinePoints(points, color, closed) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = toPdf(points[i].x, points[i].y), b = toPdf(points[i + 1].x, points[i + 1].y);
      page.drawLine({ start: a, end: b, thickness: 1, color });
    }
    if (closed && points.length > 2) {
      const a = toPdf(points[points.length - 1].x, points[points.length - 1].y), b = toPdf(points[0].x, points[0].y);
      page.drawLine({ start: a, end: b, thickness: 1, color });
    }
  }

  function drawDimension(ent, color) {
    const dx = ent.x2 - ent.x1, dy = ent.y2 - ent.y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const off = ent.offset || 0;
    const p1 = { x: ent.x1 + nx * off, y: ent.y1 + ny * off };
    const p2 = { x: ent.x2 + nx * off, y: ent.y2 + ny * off };
    page.drawLine({ start: toPdf(ent.x1, ent.y1), end: toPdf(p1.x, p1.y), thickness: 0.75, color });
    page.drawLine({ start: toPdf(ent.x2, ent.y2), end: toPdf(p2.x, p2.y), thickness: 0.75, color });
    page.drawLine({ start: toPdf(p1.x, p1.y), end: toPdf(p2.x, p2.y), thickness: 0.75, color });
    const worldLen = Math.hypot(dx, dy);
    const text = ent.text || formatDimensionLength(worldLen, scene.units);
    const mid = toPdf((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    page.drawText(text, { x: mid.x, y: mid.y + 3, size: 8, font, color });
  }

  for (const ent of scene.entities) {
    const layer = layerById.get(ent.layerId);
    if (!layer || !layer.visible) continue;
    const color = hexToRgbColor(layer.color);
    if (ent.type === 'line') {
      page.drawLine({ start: toPdf(ent.x1, ent.y1), end: toPdf(ent.x2, ent.y2), thickness: 1, color });
    } else if (ent.type === 'polyline') {
      drawPolylinePoints(ent.points, color, ent.closed);
    } else if (ent.type === 'rectangle') {
      const bl = toPdf(ent.x, ent.y);
      page.drawRectangle({ x: bl.x, y: bl.y, width: ent.width * scalePtPerMm, height: ent.height * scalePtPerMm, borderColor: color, borderWidth: 1 });
    } else if (ent.type === 'circle') {
      const c = toPdf(ent.cx, ent.cy);
      page.drawEllipse({ x: c.x, y: c.y, xScale: ent.radius * scalePtPerMm, yScale: ent.radius * scalePtPerMm, borderColor: color, borderWidth: 1 });
    } else if (ent.type === 'arc') {
      drawPolylinePoints(tessellateArc(ent.cx, ent.cy, ent.radius, ent.startAngle, ent.endAngle, 32), color, false);
    } else if (ent.type === 'text') {
      const p = toPdf(ent.x, ent.y);
      page.drawText(String(ent.content || ''), { x: p.x, y: p.y, size: Math.max(4, ent.height * scalePtPerMm), font, color });
    } else if (ent.type === 'dimension') {
      drawDimension(ent, color);
    }
  }

  // Title block
  page.drawLine({ start: { x: margin, y: margin + titleBlockHeight }, end: { x: pageWidth - margin, y: margin + titleBlockHeight }, thickness: 1, color: LINE_GREY });
  page.drawText(COMPANY_NAME, { x: margin, y: margin + titleBlockHeight - 16, size: 12, font: boldFont, color: BLUE_DARK });
  page.drawText(String(drawing.name || 'Untitled Drawing'), { x: margin, y: margin + titleBlockHeight - 30, size: 10, font, color: TEXT_DARK });
  const scaleLabel = `Scale 1:${scene.scale || 50}  |  Units ${scene.units || 'mm'}  |  ${new Date().toLocaleDateString('en-GB')}`;
  const scaleLabelWidth = font.widthOfTextAtSize(scaleLabel, 9);
  page.drawText(scaleLabel, { x: pageWidth - margin - scaleLabelWidth, y: margin + titleBlockHeight - 22, size: 9, font, color: GREY });

  return Buffer.from(await pdfDoc.save());
}

module.exports = { generateCadPdf };
