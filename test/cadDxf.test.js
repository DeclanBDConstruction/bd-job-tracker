// Smoke tests for cadDxf.js's sceneToDxf() - a pure string-building function, no I/O, so no
// dummy env vars or DB needed (unlike db.pure.test.js). Assertions check structural properties
// of the output (sections balanced, right entity/layer showing up) rather than exact string
// equality, which would be too brittle against harmless formatting tweaks.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sceneToDxf, nearestAci } = require('../cadDxf');

function makeScene(overrides) {
  return Object.assign({
    version: 1,
    units: 'mm',
    scale: 50,
    layers: [{ id: 'l1', name: '0', color: '#ff0000', visible: true, locked: false }],
    entities: [],
  }, overrides);
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test('empty scene still produces a well-formed, balanced DXF file', () => {
  const dxf = sceneToDxf(makeScene());
  assert.match(dxf, /0\nSECTION\n2\nHEADER\n/);
  assert.match(dxf, /0\nSECTION\n2\nENTITIES\n/);
  assert.match(dxf, /0\nEOF\n$/);
  assert.equal(countOccurrences(dxf, '0\nSECTION\n'), countOccurrences(dxf, '0\nENDSEC\n'));
});

test('a line entity carries its layer name and endpoint coordinates', () => {
  const scene = makeScene({
    entities: [{ id: 'e1', type: 'line', layerId: 'l1', x1: 0, y1: 0, x2: 1000, y2: 500 }],
  });
  const dxf = sceneToDxf(scene);
  assert.match(dxf, /0\nLINE\n8\n0\n/);
  assert.match(dxf, /11\n1000\n/); // x2
  assert.match(dxf, /21\n500\n/); // y2
});

test('a circle entity carries centre and radius', () => {
  const scene = makeScene({
    entities: [{ id: 'e1', type: 'circle', layerId: 'l1', cx: 100, cy: 200, radius: 50 }],
  });
  const dxf = sceneToDxf(scene);
  assert.match(dxf, /0\nCIRCLE\n/);
  assert.match(dxf, /40\n50\n/);
});

test('an invisible layer is skipped entirely in the ENTITIES section', () => {
  const scene = makeScene({
    layers: [{ id: 'l1', name: 'Hidden', color: '#000000', visible: false, locked: false }],
    entities: [{ id: 'e1', type: 'line', layerId: 'l1', x1: 0, y1: 0, x2: 10, y2: 10 }],
  });
  const dxf = sceneToDxf(scene);
  assert.doesNotMatch(dxf, /LINE/);
});

test('a dimension entity flattens to LINE + TEXT, not a DIMENSION entity', () => {
  const scene = makeScene({
    entities: [{ id: 'e1', type: 'dimension', layerId: 'l1', kind: 'linear', x1: 0, y1: 0, x2: 1000, y2: 0, offset: 100, text: null }],
  });
  const dxf = sceneToDxf(scene);
  assert.doesNotMatch(dxf, /0\nDIMENSION\n/);
  assert.match(dxf, /0\nLINE\n/);
  assert.match(dxf, /0\nTEXT\n/);
  assert.match(dxf, /1\n1000mm\n/); // auto-computed dimension text
});

test('a rectangle exports as a closed 4-point POLYLINE', () => {
  const scene = makeScene({
    entities: [{ id: 'e1', type: 'rectangle', layerId: 'l1', x: 0, y: 0, width: 100, height: 50, rotation: 0 }],
  });
  const dxf = sceneToDxf(scene);
  assert.match(dxf, /0\nPOLYLINE\n/);
  assert.equal(countOccurrences(dxf, '0\nVERTEX\n'), 4);
  assert.match(dxf, /70\n1\n/); // closed flag
});

test('the layer table lists one LAYER entry per scene layer, each with a mapped ACI colour', () => {
  const scene = makeScene({
    layers: [
      { id: 'l1', name: 'Walls', color: '#ff0000', visible: true, locked: false },
      { id: 'l2', name: 'Dims', color: '#0000ff', visible: true, locked: false },
    ],
  });
  const dxf = sceneToDxf(scene);
  assert.match(dxf, /2\nWalls\n/);
  assert.match(dxf, /2\nDims\n/);
  assert.equal(countOccurrences(dxf, '0\nLAYER\n'), 2);
});

test('nearestAci maps primary colours to their standard AutoCAD index', () => {
  assert.equal(nearestAci('#ff0000'), 1); // red
  assert.equal(nearestAci('#00ff00'), 3); // green
  assert.equal(nearestAci('#0000ff'), 5); // blue
});
