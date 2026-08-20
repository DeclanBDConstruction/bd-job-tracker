// ---------- CAD Drawings ----------
// Standalone 2D drafting tool for admins/surveyors. Shares globals with app.js (state,
// api(), escapeHtml(), toast(), isAdmin(), isSurveyor()) - loaded after it, no imports.
//
// Scene JSON shape (stored verbatim server-side in cad_drawings.scene_data):
// {
//   version: 1,
//   units: 'mm',
//   scale: 50,                          // 1:N - drives dimension text + PDF page fit
//   page: { size: 'A3', orientation: 'landscape' },
//   layers: [{ id, name, color, visible, locked }, ...],
//   entities: [
//     { id, type: 'line',      layerId, x1, y1, x2, y2 },
//     { id, type: 'polyline',  layerId, points: [{x,y},...], closed },
//     { id, type: 'rectangle', layerId, x, y, width, height, rotation },
//     { id, type: 'circle',    layerId, cx, cy, radius },
//     { id, type: 'arc',       layerId, cx, cy, radius, startAngle, endAngle },
//     { id, type: 'text',      layerId, x, y, content, height, rotation },
//     { id, type: 'dimension', layerId, kind: 'linear', x1, y1, x2, y2, offset, text },
//   ],
// }
// All entity coordinates are real-world drawing units (per `units`), never screen pixels -
// the world<->screen transform below is a pure view concern and is never persisted.

const CAD_LAYER_PALETTE = ['#186a9c', '#b6402e', '#2f7a3a', '#b8720d', '#7a4fb0', '#009a8b', '#87156c', '#1e2733'];
const CAD_MIN_ZOOM = 0.005;
const CAD_MAX_ZOOM = 40;
const CAD_DEFAULT_ZOOM = 0.2; // 1mm = 0.2px, so a 5m wall renders at 1000px

function cadClamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function cadGenId() {
  return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : `cad-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cadMakeEmptyScene() {
  return {
    version: 1,
    units: 'mm',
    scale: 50,
    page: { size: 'A3', orientation: 'landscape' },
    layers: [{ id: cadGenId(), name: '0', color: CAD_LAYER_PALETTE[0], visible: true, locked: false }],
    entities: [],
  };
}

const cadState = {
  drawings: [],
  current: null, // { id, name, sceneData }
  view: { panX: 0, panY: 0, zoom: CAD_DEFAULT_ZOOM },
  activeLayerId: null,
  selection: [],
  tool: 'select',
  gridSnap: true,
  objectSnap: true,
  dirty: false,
  saving: false,
  spaceDown: false,
  panDrag: null, // { startScreenX, startScreenY, startPanX, startPanY }
};

let cadAutosaveTimer = null;
let cadDrawPoints = []; // in-progress points for whatever draw tool is active
let cadCursorPoint = null; // last computed { x, y, snapType } cursor world position
let cadMoveDrag = null; // { anchor: {x,y}, entries: [{ id, before }] } while dragging a selection
let cadMarquee = null; // { x1, y1, x2, y2 } screen-space rubber-band rectangle, while active
const cadHistory = { undo: [], redo: [] }; // command stack - see cadPushCommand/cadUndo/cadRedo

// ---------- List view ----------

async function loadCadDrawings() {
  try {
    cadState.drawings = await api('/api/cad-drawings');
    renderCadDrawings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderCadDrawings() {
  const grid = document.getElementById('cadGrid');
  const empty = document.getElementById('cadGridEmpty');
  const drawings = cadState.drawings;
  empty.hidden = drawings.length > 0;
  grid.innerHTML = drawings.map((d) => `
    <div class="ra-card cad-card">
      <div class="cad-card-thumb">${d.thumbnailStoredName
        ? `<img src="/api/cad-drawings/${d.id}/thumbnail" alt="">`
        : `<span class="cad-card-thumb-placeholder">No preview yet</span>`}</div>
      <div class="ra-card-top">
        <h3>${escapeHtml(d.name)}</h3>
      </div>
      <p class="ra-card-summary">Updated ${new Date(d.updatedAt).toLocaleDateString('en-GB')}${d.updatedBy ? ' · ' + escapeHtml(d.updatedBy) : ''}</p>
      <div class="ra-card-actions">
        <button type="button" class="cad-open-btn" data-cad="${d.id}">Open</button>
        <button type="button" class="cad-duplicate-btn" data-cad="${d.id}">Duplicate</button>
        ${isAdmin() ? `<button type="button" class="danger cad-delete-btn" data-cad="${d.id}">Delete</button>` : ''}
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('.cad-open-btn').forEach((btn) => btn.addEventListener('click', () => openCadDrawing(btn.dataset.cad)));
  grid.querySelectorAll('.cad-duplicate-btn').forEach((btn) => btn.addEventListener('click', () => duplicateCadDrawing(btn.dataset.cad)));
  grid.querySelectorAll('.cad-delete-btn').forEach((btn) => btn.addEventListener('click', () => confirmDeleteCadDrawing(btn.dataset.cad)));
}

document.getElementById('cadNewBtn').addEventListener('click', async () => {
  try {
    const drawing = await api('/api/cad-drawings', {
      method: 'POST',
      body: JSON.stringify({ name: 'Untitled Drawing', sceneData: cadMakeEmptyScene() }),
    });
    openCadEditor(drawing);
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function openCadDrawing(id) {
  try {
    const drawing = await api(`/api/cad-drawings/${id}`);
    openCadEditor(drawing);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function duplicateCadDrawing(id) {
  try {
    const full = await api(`/api/cad-drawings/${id}`);
    await api('/api/cad-drawings', {
      method: 'POST',
      body: JSON.stringify({ name: `${full.name} (copy)`, sceneData: full.sceneData }),
    });
    await loadCadDrawings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function confirmDeleteCadDrawing(id) {
  if (!confirm('Delete this drawing? This cannot be undone.')) return;
  try {
    await api(`/api/cad-drawings/${id}`, { method: 'DELETE' });
    await loadCadDrawings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------- Editor: open/close ----------

function openCadEditor(drawing) {
  const sceneData = (drawing.sceneData && drawing.sceneData.version) ? drawing.sceneData : cadMakeEmptyScene();
  cadState.current = { id: drawing.id, name: drawing.name, sceneData };
  cadState.view = { panX: 0, panY: 0, zoom: CAD_DEFAULT_ZOOM };
  cadState.activeLayerId = sceneData.layers[0] ? sceneData.layers[0].id : null;
  cadState.selection = [];
  cadState.tool = 'select';
  cadState.dirty = false;
  cadDrawPoints = [];
  cadCursorPoint = null;
  cadMoveDrag = null;
  cadMarquee = null;
  cadHistory.undo = [];
  cadHistory.redo = [];

  document.getElementById('cadNameInput').value = cadState.current.name;
  document.querySelectorAll('.cad-tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === 'select'));
  setCadSaveStatus('Saved');
  renderCadLayers();
  renderCadPropertiesPanel();
  document.getElementById('cadExportDxfLink').href = `/api/cad-drawings/${drawing.id}/export/dxf`;
  document.getElementById('cadExportPdfLink').href = `/api/cad-drawings/${drawing.id}/export/pdf`;

  document.getElementById('cadListView').hidden = true;
  document.getElementById('cadEditorView').hidden = false;

  requestAnimationFrame(() => {
    resizeCadCanvas();
    cadZoomExtents();
  });
}

document.getElementById('cadBackBtn').addEventListener('click', async () => {
  await flushCadAutosave();
  document.getElementById('cadEditorView').hidden = true;
  document.getElementById('cadListView').hidden = false;
  cadState.current = null;
  await loadCadDrawings();
});

document.getElementById('cadNameInput').addEventListener('input', (e) => {
  if (!cadState.current) return;
  cadState.current.name = e.target.value;
  scheduleCadAutosave();
});

// ---------- Save / autosave ----------

function setCadSaveStatus(text) {
  const el = document.getElementById('cadSaveStatus');
  if (el) el.textContent = text;
}

function cadMarkDirty() {
  scheduleCadAutosave();
}

function scheduleCadAutosave() {
  if (!cadState.current) return;
  cadState.dirty = true;
  setCadSaveStatus('Unsaved changes');
  cadMirrorDraftToLocalStorage();
  clearTimeout(cadAutosaveTimer);
  cadAutosaveTimer = setTimeout(saveCadDrawing, 3000);
}

async function saveCadDrawing() {
  if (!cadState.current || cadState.saving) return;
  clearTimeout(cadAutosaveTimer);
  if (!cadState.current.name.trim()) return; // wait for a real name before saving
  cadState.saving = true;
  setCadSaveStatus('Saving…');
  try {
    await api(`/api/cad-drawings/${cadState.current.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: cadState.current.name, sceneData: cadState.current.sceneData }),
    });
    cadState.dirty = false;
    setCadSaveStatus('Saved');
    cadUploadThumbnail();
  } catch (err) {
    setCadSaveStatus('Save failed');
    toast(err.message, 'error');
  } finally {
    cadState.saving = false;
  }
}

// Fire-and-forget - a failed thumbnail upload shouldn't surface as a save error, the
// drawing itself already saved fine. Captures whatever's currently on screen rather than
// forcing a zoom-to-extents, so the view doesn't jump mid-edit every autosave tick.
function cadUploadThumbnail() {
  const canvas = document.getElementById('cadCanvas');
  const drawingId = cadState.current && cadState.current.id;
  if (!canvas || !drawingId) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const formData = new FormData();
    formData.append('file', blob, 'thumbnail.png');
    fetch(`/api/cad-drawings/${drawingId}/thumbnail`, { method: 'POST', body: formData }).catch(() => {});
  }, 'image/png', 0.8);
}

async function flushCadAutosave() {
  if (cadState.dirty) await saveCadDrawing();
}

document.getElementById('cadSaveBtn').addEventListener('click', () => saveCadDrawing());

// DXF/PDF are generated server-side from the saved drawing, so flush any pending autosave
// first - otherwise a very recent edit could export stale geometry. PNG is a client-side
// canvas snapshot instead (see below), so it always reflects exactly what's on screen.
document.getElementById('cadExportDxfLink').addEventListener('click', async (e) => {
  if (!cadState.current) { e.preventDefault(); return; }
  e.preventDefault();
  await flushCadAutosave();
  window.location.href = `/api/cad-drawings/${cadState.current.id}/export/dxf`;
});
document.getElementById('cadExportPdfLink').addEventListener('click', async (e) => {
  if (!cadState.current) { e.preventDefault(); return; }
  e.preventDefault();
  await flushCadAutosave();
  window.location.href = `/api/cad-drawings/${cadState.current.id}/export/pdf`;
});
document.getElementById('cadExportPngBtn').addEventListener('click', () => {
  const canvas = document.getElementById('cadCanvas');
  if (!canvas || !cadState.current) return;
  const prevView = { ...cadState.view };
  cadZoomExtents();
  canvas.toBlob((blob) => {
    cadState.view = prevView;
    cadRender();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(cadState.current.name || 'drawing').replace(/[^a-zA-Z0-9_.\- ]/g, '_')}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
});

document.addEventListener('keydown', (e) => {
  if (!cadState.current || document.getElementById('cadEditorView').hidden) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveCadDrawing();
  }
});

// Same-browser safety net only, never the source of truth - the server autosave above is.
// Recovers work if a tab closes between edits and the next debounced PUT landing.
function cadDraftStorageKey(id) {
  return `cadDraft:${id}`;
}

function cadMirrorDraftToLocalStorage() {
  if (!cadState.current) return;
  try {
    localStorage.setItem(cadDraftStorageKey(cadState.current.id), JSON.stringify({
      name: cadState.current.name,
      sceneData: cadState.current.sceneData,
      savedAt: Date.now(),
    }));
  } catch (err) { /* storage unavailable/full - not load-bearing, safe to ignore */ }
}

// ---------- Layers ----------

function cadNextLayerColor(layerCount) {
  return CAD_LAYER_PALETTE[layerCount % CAD_LAYER_PALETTE.length];
}

function renderCadLayers() {
  const list = document.getElementById('cadLayerList');
  const scene = cadState.current.sceneData;
  list.innerHTML = scene.layers.map((l) => `
    <div class="cad-layer-row ${l.id === cadState.activeLayerId ? 'active' : ''}" data-layer="${l.id}">
      <input type="checkbox" class="cad-layer-visible" title="Visible" ${l.visible ? 'checked' : ''}>
      <input type="color" class="cad-layer-color" value="${l.color}" title="Layer colour">
      <input type="text" class="cad-layer-name" value="${escapeHtml(l.name)}" title="Layer name">
      <button type="button" class="cad-layer-lock" title="${l.locked ? 'Unlock layer' : 'Lock layer'}">${l.locked ? '🔒' : '🔓'}</button>
      <button type="button" class="cad-layer-delete" title="Delete layer" ${scene.layers.length <= 1 ? 'disabled' : ''}>✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.cad-layer-row').forEach((row) => {
    const id = row.dataset.layer;
    const layer = scene.layers.find((l) => l.id === id);

    row.addEventListener('click', (e) => {
      if (e.target.closest('input, button')) return;
      cadState.activeLayerId = id;
      renderCadLayers();
    });
    row.querySelector('.cad-layer-visible').addEventListener('change', (e) => {
      layer.visible = e.target.checked;
      cadMarkDirty();
      cadRender();
    });
    row.querySelector('.cad-layer-color').addEventListener('input', (e) => {
      layer.color = e.target.value;
      cadMarkDirty();
      cadRender();
    });
    row.querySelector('.cad-layer-name').addEventListener('change', (e) => {
      const name = e.target.value.trim();
      if (!name) { e.target.value = layer.name; return; }
      layer.name = name;
      cadMarkDirty();
    });
    row.querySelector('.cad-layer-lock').addEventListener('click', () => {
      layer.locked = !layer.locked;
      cadMarkDirty();
      renderCadLayers();
    });
    const deleteBtn = row.querySelector('.cad-layer-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        if (scene.layers.length <= 1) return;
        if (!confirm(`Delete layer "${layer.name}"? Anything drawn on it goes too.`)) return;
        scene.entities = scene.entities.filter((ent) => ent.layerId !== id);
        scene.layers = scene.layers.filter((l) => l.id !== id);
        if (cadState.activeLayerId === id) cadState.activeLayerId = scene.layers[0].id;
        renderCadLayers();
        cadMarkDirty();
        cadRender();
      });
    }
  });
}

document.getElementById('cadAddLayerBtn').addEventListener('click', () => {
  if (!cadState.current) return;
  const scene = cadState.current.sceneData;
  const id = cadGenId();
  scene.layers.push({
    id,
    name: `Layer ${scene.layers.length + 1}`,
    color: cadNextLayerColor(scene.layers.length),
    visible: true,
    locked: false,
  });
  cadState.activeLayerId = id;
  renderCadLayers();
  cadMarkDirty();
});

// ---------- Properties panel ----------

function cadCommitPropertyEdit(entity, beforeClone) {
  cadPushCommand({ type: 'edit', changes: [{ id: entity.id, before: beforeClone, after: cadCloneEntity(entity) }] });
  cadMarkDirty();
  cadRender();
}

function renderCadPropertiesPanel() {
  const panel = document.getElementById('cadPropertiesPanel');
  if (!cadState.current || !cadState.selection.length) {
    panel.innerHTML = `<p class="empty-state">Nothing selected.</p>`;
    return;
  }
  if (cadState.selection.length > 1) {
    panel.innerHTML = `<p class="empty-state">${cadState.selection.length} items selected.</p><button type="button" id="cadDeleteSelectionBtn" class="danger">Delete Selected</button>`;
    document.getElementById('cadDeleteSelectionBtn').addEventListener('click', cadDeleteSelection);
    return;
  }

  const ent = cadFindEntityById(cadState.selection[0]);
  if (!ent) {
    panel.innerHTML = `<p class="empty-state">Nothing selected.</p>`;
    return;
  }
  const scene = cadState.current.sceneData;
  const layerOptions = scene.layers.map((l) => `<option value="${l.id}" ${l.id === ent.layerId ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('');
  const num = (label, key, value) => `<label class="cad-prop-field">${escapeHtml(label)}<input type="number" step="any" data-key="${key}" value="${value}"></label>`;
  let fields = '';
  if (ent.type === 'line') {
    fields = num('X1', 'x1', ent.x1) + num('Y1', 'y1', ent.y1) + num('X2', 'x2', ent.x2) + num('Y2', 'y2', ent.y2);
  } else if (ent.type === 'rectangle') {
    fields = num('X', 'x', ent.x) + num('Y', 'y', ent.y) + num('Width', 'width', ent.width) + num('Height', 'height', ent.height);
  } else if (ent.type === 'circle') {
    fields = num('Centre X', 'cx', ent.cx) + num('Centre Y', 'cy', ent.cy) + num('Radius', 'radius', ent.radius);
  } else if (ent.type === 'arc') {
    fields = num('Centre X', 'cx', ent.cx) + num('Centre Y', 'cy', ent.cy) + num('Radius', 'radius', ent.radius)
      + num('Start °', '__startDeg', (ent.startAngle * 180 / Math.PI).toFixed(1)) + num('End °', '__endDeg', (ent.endAngle * 180 / Math.PI).toFixed(1));
  } else if (ent.type === 'text') {
    fields = `<label class="cad-prop-field">Text<input type="text" data-key="content" value="${escapeHtml(ent.content)}"></label>` + num('Height', 'height', ent.height);
  } else if (ent.type === 'dimension') {
    fields = `<label class="cad-prop-field">Override text<input type="text" data-key="text" value="${escapeHtml(ent.text || '')}" placeholder="Auto"></label>` + num('Offset', 'offset', ent.offset || 0);
  } else if (ent.type === 'polyline') {
    fields = `<p class="empty-state">${ent.points.length}-point polyline. Drag to move, or delete and redraw to change its points.</p>`;
  }

  panel.innerHTML = `
    <label class="cad-prop-field">Layer<select id="cadPropLayerSelect">${layerOptions}</select></label>
    ${fields}
    <button type="button" id="cadDeleteSelectionBtn" class="danger">Delete</button>
  `;

  document.getElementById('cadPropLayerSelect').addEventListener('change', (e) => {
    const before = cadCloneEntity(ent);
    ent.layerId = e.target.value;
    cadCommitPropertyEdit(ent, before);
  });
  panel.querySelectorAll('input[data-key]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const before = cadCloneEntity(ent);
      const key = e.target.dataset.key;
      const raw = e.target.value;
      if (key === 'content' || key === 'text') {
        ent[key] = raw;
      } else if (key === '__startDeg') {
        ent.startAngle = (parseFloat(raw) || 0) * Math.PI / 180;
      } else if (key === '__endDeg') {
        ent.endAngle = (parseFloat(raw) || 0) * Math.PI / 180;
      } else {
        ent[key] = parseFloat(raw) || 0;
      }
      cadCommitPropertyEdit(ent, before);
    });
  });
  document.getElementById('cadDeleteSelectionBtn').addEventListener('click', cadDeleteSelection);
}

// ---------- Tools (draw behaviour wired in a later phase - this just tracks the active one) ----------

function cadSetTool(tool) {
  cadState.tool = tool;
  cadDrawPoints = [];
  document.querySelectorAll('.cad-tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  const canvas = document.getElementById('cadCanvas');
  canvas.style.cursor = tool === 'pan' ? 'grab' : (tool === 'select' ? 'default' : 'crosshair');
  cadRender();
}

document.querySelectorAll('.cad-tool-btn').forEach((btn) => {
  btn.addEventListener('click', () => cadSetTool(btn.dataset.tool));
});

function isCadDrawTool(tool) {
  return ['line', 'polyline', 'rectangle', 'circle', 'arc', 'text', 'dimension'].includes(tool);
}

document.getElementById('cadGridSnapToggle').addEventListener('change', (e) => { cadState.gridSnap = e.target.checked; });
document.getElementById('cadObjectSnapToggle').addEventListener('change', (e) => { cadState.objectSnap = e.target.checked; });

// ---------- Undo/redo command stack ----------
// Commands store minimal diffs (an added/removed entity, or a before/after clone of just the
// entities that changed), not full-scene snapshots - a drawing can hold hundreds of entities,
// so re-cloning the whole scene into history on every edit would add up fast.

function cadCloneEntity(ent) {
  return JSON.parse(JSON.stringify(ent));
}

function cadPushCommand(cmd) {
  cadHistory.undo.push(cmd);
  cadHistory.redo = [];
}

function cadApplyCommand(cmd) {
  const scene = cadState.current.sceneData;
  if (cmd.type === 'add') {
    scene.entities.push(cmd.entity);
  } else if (cmd.type === 'delete') {
    const ids = new Set(cmd.entities.map((e) => e.id));
    scene.entities = scene.entities.filter((e) => !ids.has(e.id));
  } else if (cmd.type === 'edit') {
    for (const c of cmd.changes) {
      const idx = scene.entities.findIndex((e) => e.id === c.id);
      if (idx !== -1) scene.entities[idx] = cadCloneEntity(c.after);
    }
  }
}

function cadRevertCommand(cmd) {
  const scene = cadState.current.sceneData;
  if (cmd.type === 'add') {
    scene.entities = scene.entities.filter((e) => e.id !== cmd.entity.id);
  } else if (cmd.type === 'delete') {
    scene.entities.push(...cmd.entities.map(cadCloneEntity));
  } else if (cmd.type === 'edit') {
    for (const c of cmd.changes) {
      const idx = scene.entities.findIndex((e) => e.id === c.id);
      if (idx !== -1) scene.entities[idx] = cadCloneEntity(c.before);
    }
  }
}

function cadUndo() {
  const cmd = cadHistory.undo.pop();
  if (!cmd || !cadState.current) return;
  cadRevertCommand(cmd);
  cadHistory.redo.push(cmd);
  cadState.selection = [];
  renderCadPropertiesPanel();
  cadMarkDirty();
  cadRender();
}

function cadRedo() {
  const cmd = cadHistory.redo.pop();
  if (!cmd || !cadState.current) return;
  cadApplyCommand(cmd);
  cadHistory.undo.push(cmd);
  cadState.selection = [];
  renderCadPropertiesPanel();
  cadMarkDirty();
  cadRender();
}

document.getElementById('cadUndoBtn').addEventListener('click', cadUndo);
document.getElementById('cadRedoBtn').addEventListener('click', cadRedo);

function cadIsTypingInField() {
  const tag = document.activeElement && document.activeElement.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

document.addEventListener('keydown', (e) => {
  if (!cadState.current || document.getElementById('cadEditorView').hidden) return;
  if (cadIsTypingInField()) return;
  if (e.key === ' ' && !cadState.spaceDown) {
    cadState.spaceDown = true;
    const canvas = document.getElementById('cadCanvas');
    if (cadState.tool !== 'pan') canvas.style.cursor = 'grab';
  } else if (e.key === 'Escape') {
    // Esc cancels whatever's in progress first (matches AutoCAD convention); only drops
    // back to the Select tool once there's nothing left to cancel.
    if (cadDrawPoints.length) {
      cadDrawPoints = [];
      cadRender();
    } else {
      cadSetTool('select');
    }
  } else if (e.key === 'Enter' && cadState.tool === 'polyline' && cadDrawPoints.length >= 2) {
    cadCommitPolyline();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && cadState.selection.length) {
    e.preventDefault();
    cadDeleteSelection();
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    cadUndo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault();
    cadRedo();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    cadState.spaceDown = false;
    const canvas = document.getElementById('cadCanvas');
    if (canvas && cadState.tool !== 'pan') canvas.style.cursor = cadState.tool === 'select' ? 'default' : 'crosshair';
  }
});

// ---------- World <-> screen transform ----------
// World space: real drawing units (mm), y-up (standard drafting convention). Screen space:
// canvas CSS pixels, y-down. Pan/zoom is purely a view concern - never persisted.

function cadWorldToScreen(x, y) {
  const { panX, panY, zoom } = cadState.view;
  return { x: panX + x * zoom, y: panY - y * zoom };
}

function cadScreenToWorld(x, y) {
  const { panX, panY, zoom } = cadState.view;
  return { x: (x - panX) / zoom, y: (panY - y) / zoom };
}

// ---------- Canvas sizing + render loop ----------
// Redraw-on-change, not a continuous rAF loop - nothing here animates on its own.

function resizeCadCanvas() {
  const canvas = document.getElementById('cadCanvas');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cadRender();
}

window.addEventListener('resize', () => {
  if (cadState.current && !document.getElementById('cadEditorView').hidden) resizeCadCanvas();
});

// "Nice" grid spacing (1/2/5 sequence) so on-screen spacing stays readable at any zoom.
function cadNiceGridSpacing(zoom) {
  const targetPx = 60;
  const rawWorld = targetPx / zoom;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawWorld)));
  const steps = [1, 2, 5, 10];
  let best = magnitude * 10;
  for (const step of steps) {
    const candidate = magnitude * step;
    if (candidate >= rawWorld) { best = candidate; break; }
  }
  return best;
}

function cadDrawGrid(ctx, rect) {
  const { zoom } = cadState.view;
  const spacing = cadNiceGridSpacing(zoom);
  const topLeft = cadScreenToWorld(0, 0);
  const bottomRight = cadScreenToWorld(rect.width, rect.height);
  const startX = Math.floor(topLeft.x / spacing) * spacing;
  const endX = Math.ceil(bottomRight.x / spacing) * spacing;
  const startY = Math.floor(bottomRight.y / spacing) * spacing;
  const endY = Math.ceil(topLeft.y / spacing) * spacing;

  ctx.save();
  ctx.strokeStyle = '#e4e9ed';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= endX; x += spacing) {
    const s = cadWorldToScreen(x, 0);
    ctx.moveTo(s.x + 0.5, 0);
    ctx.lineTo(s.x + 0.5, rect.height);
  }
  for (let y = startY; y <= endY; y += spacing) {
    const s = cadWorldToScreen(0, y);
    ctx.moveTo(0, s.y + 0.5);
    ctx.lineTo(rect.width, s.y + 0.5);
  }
  ctx.stroke();

  // Origin cross, so there's always a fixed reference point to orient by.
  const origin = cadWorldToScreen(0, 0);
  ctx.strokeStyle = '#b9c2cb';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(origin.x - 10, origin.y);
  ctx.lineTo(origin.x + 10, origin.y);
  ctx.moveTo(origin.x, origin.y - 10);
  ctx.lineTo(origin.x, origin.y + 10);
  ctx.stroke();
  ctx.restore();
}

function cadRender() {
  const canvas = document.getElementById('cadCanvas');
  if (!canvas || !cadState.current) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, rect.width, rect.height);
  cadDrawGrid(ctx, rect);
  cadDrawEntities(ctx);
  cadDrawSelectionHighlight(ctx);
  cadDrawToolPreview(ctx);
  cadDrawSnapMarker(ctx);
  cadDrawMarquee(ctx);
}

function cadDrawEntities(ctx) {
  const scene = cadState.current.sceneData;
  const layerById = new Map(scene.layers.map((l) => [l.id, l]));
  for (const ent of scene.entities) {
    const layer = layerById.get(ent.layerId);
    if (!layer || !layer.visible) continue;
    cadDrawEntity(ctx, ent, layer.color);
  }
}

function cadDrawSelectionHighlight(ctx) {
  if (!cadState.selection.length || !cadState.current) return;
  const scene = cadState.current.sceneData;
  for (const id of cadState.selection) {
    const ent = scene.entities.find((e) => e.id === id);
    if (ent) cadDrawEntity(ctx, ent, '#2f7a3a', 3);
  }
}

function cadDrawMarquee(ctx) {
  if (!cadMarquee) return;
  const x = Math.min(cadMarquee.x1, cadMarquee.x2), y = Math.min(cadMarquee.y1, cadMarquee.y2);
  const w = Math.abs(cadMarquee.x2 - cadMarquee.x1), h = Math.abs(cadMarquee.y2 - cadMarquee.y1);
  ctx.save();
  ctx.strokeStyle = '#186a9c';
  ctx.fillStyle = 'rgba(24,106,156,0.08)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

function cadDrawEntity(ctx, ent, color, lineWidth) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth || 1.5;
  if (ent.type === 'line') {
    const a = cadWorldToScreen(ent.x1, ent.y1);
    const b = cadWorldToScreen(ent.x2, ent.y2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  } else if (ent.type === 'polyline') {
    if (ent.points.length) {
      ctx.beginPath();
      ent.points.forEach((p, i) => {
        const s = cadWorldToScreen(p.x, p.y);
        if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
      });
      if (ent.closed) ctx.closePath();
      ctx.stroke();
    }
  } else if (ent.type === 'rectangle') {
    const a = cadWorldToScreen(ent.x, ent.y + ent.height);
    const b = cadWorldToScreen(ent.x + ent.width, ent.y);
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (ent.type === 'circle') {
    const c = cadWorldToScreen(ent.cx, ent.cy);
    ctx.beginPath();
    ctx.arc(c.x, c.y, ent.radius * cadState.view.zoom, 0, Math.PI * 2);
    ctx.stroke();
  } else if (ent.type === 'arc') {
    const c = cadWorldToScreen(ent.cx, ent.cy);
    ctx.beginPath();
    // World is y-up, canvas arc() is y-down, so angles flip sign here.
    ctx.arc(c.x, c.y, ent.radius * cadState.view.zoom, -ent.startAngle, -ent.endAngle, true);
    ctx.stroke();
  } else if (ent.type === 'text') {
    const p = cadWorldToScreen(ent.x, ent.y);
    ctx.font = `${Math.max(8, ent.height * cadState.view.zoom)}px "Segoe UI", sans-serif`;
    ctx.fillText(ent.content, p.x, p.y);
  } else if (ent.type === 'dimension') {
    cadDrawDimension(ctx, ent, color);
  }
  ctx.restore();
}

function cadDrawDimension(ctx, ent, color) {
  const dx = ent.x2 - ent.x1;
  const dy = ent.y2 - ent.y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; // unit normal, for the offset extension lines
  const ny = dx / len;
  const off = ent.offset || 0;
  const p1 = { x: ent.x1 + nx * off, y: ent.y1 + ny * off };
  const p2 = { x: ent.x2 + nx * off, y: ent.y2 + ny * off };
  const s1 = cadWorldToScreen(ent.x1, ent.y1);
  const sp1 = cadWorldToScreen(p1.x, p1.y);
  const s2 = cadWorldToScreen(ent.x2, ent.y2);
  const sp2 = cadWorldToScreen(p2.x, p2.y);

  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(s1.x, s1.y); ctx.lineTo(sp1.x, sp1.y);
  ctx.moveTo(s2.x, s2.y); ctx.lineTo(sp2.x, sp2.y);
  ctx.moveTo(sp1.x, sp1.y); ctx.lineTo(sp2.x, sp2.y);
  ctx.stroke();

  const scene = cadState.current.sceneData;
  const worldLen = Math.hypot(ent.x2 - ent.x1, ent.y2 - ent.y1);
  const text = ent.text || cadFormatDimensionLength(worldLen, scene.units);
  const mid = { x: (sp1.x + sp2.x) / 2, y: (sp1.y + sp2.y) / 2 };
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(text, mid.x, mid.y - 4);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function cadFormatDimensionLength(worldLen, units) {
  if (units === 'm') return `${(worldLen / 1000).toFixed(2)}m`;
  if (units === 'ft') return `${(worldLen / 304.8).toFixed(2)}ft`;
  if (units === 'in') return `${(worldLen / 25.4).toFixed(1)}in`;
  return `${Math.round(worldLen)}mm`;
}

// ---------- Snap engine ----------
// Two layers, object snap takes priority when both are in range (matches AutoCAD's running
// osnap behaviour): grid snap (nearest grid intersection) and object snap (endpoints,
// midpoints, centers, quadrants of nearby entities).

const CAD_SNAP_PIXEL_RADIUS = 10;

// Candidate points to snap to, computed fresh each cursor move - fine at drawing sizes this
// tool is meant for (a floor plan is hundreds, not tens of thousands, of entities).
function cadCollectSnapCandidates() {
  const scene = cadState.current.sceneData;
  const layerById = new Map(scene.layers.map((l) => [l.id, l]));
  const pts = [];
  for (const ent of scene.entities) {
    const layer = layerById.get(ent.layerId);
    if (!layer || !layer.visible) continue;
    if (ent.type === 'line') {
      pts.push({ x: ent.x1, y: ent.y1, type: 'endpoint' });
      pts.push({ x: ent.x2, y: ent.y2, type: 'endpoint' });
      pts.push({ x: (ent.x1 + ent.x2) / 2, y: (ent.y1 + ent.y2) / 2, type: 'midpoint' });
    } else if (ent.type === 'polyline') {
      ent.points.forEach((p, i) => {
        pts.push({ x: p.x, y: p.y, type: 'endpoint' });
        const next = ent.points[i + 1];
        if (next) pts.push({ x: (p.x + next.x) / 2, y: (p.y + next.y) / 2, type: 'midpoint' });
      });
    } else if (ent.type === 'rectangle') {
      const corners = [
        { x: ent.x, y: ent.y }, { x: ent.x + ent.width, y: ent.y },
        { x: ent.x + ent.width, y: ent.y + ent.height }, { x: ent.x, y: ent.y + ent.height },
      ];
      corners.forEach((c) => pts.push({ x: c.x, y: c.y, type: 'endpoint' }));
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        pts.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, type: 'midpoint' });
      }
    } else if (ent.type === 'circle') {
      pts.push({ x: ent.cx, y: ent.cy, type: 'center' });
      pts.push({ x: ent.cx + ent.radius, y: ent.cy, type: 'quadrant' });
      pts.push({ x: ent.cx - ent.radius, y: ent.cy, type: 'quadrant' });
      pts.push({ x: ent.cx, y: ent.cy + ent.radius, type: 'quadrant' });
      pts.push({ x: ent.cx, y: ent.cy - ent.radius, type: 'quadrant' });
    } else if (ent.type === 'arc') {
      pts.push({ x: ent.cx, y: ent.cy, type: 'center' });
      pts.push({ x: ent.cx + ent.radius * Math.cos(ent.startAngle), y: ent.cy + ent.radius * Math.sin(ent.startAngle), type: 'endpoint' });
      pts.push({ x: ent.cx + ent.radius * Math.cos(ent.endAngle), y: ent.cy + ent.radius * Math.sin(ent.endAngle), type: 'endpoint' });
    } else if (ent.type === 'text') {
      pts.push({ x: ent.x, y: ent.y, type: 'endpoint' });
    }
  }
  return pts;
}

function cadFindObjectSnap(screenX, screenY) {
  if (!cadState.objectSnap) return null;
  let best = null;
  let bestDist = CAD_SNAP_PIXEL_RADIUS;
  for (const c of cadCollectSnapCandidates()) {
    const s = cadWorldToScreen(c.x, c.y);
    const d = Math.hypot(s.x - screenX, s.y - screenY);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

function cadComputeCursorPoint(screenX, screenY) {
  const objSnap = cadFindObjectSnap(screenX, screenY);
  if (objSnap) return { x: objSnap.x, y: objSnap.y, snapType: objSnap.type };
  const world = cadScreenToWorld(screenX, screenY);
  if (cadState.gridSnap) {
    const spacing = cadNiceGridSpacing(cadState.view.zoom);
    return { x: Math.round(world.x / spacing) * spacing, y: Math.round(world.y / spacing) * spacing, snapType: 'grid' };
  }
  return { x: world.x, y: world.y, snapType: null };
}

function cadDrawSnapMarker(ctx) {
  if (!cadCursorPoint || !cadCursorPoint.snapType || !isCadDrawTool(cadState.tool)) return;
  const s = cadWorldToScreen(cadCursorPoint.x, cadCursorPoint.y);
  const type = cadCursorPoint.snapType;
  ctx.save();
  if (type === 'grid') {
    ctx.fillStyle = '#9aa6b0';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.strokeStyle = '#e08a1e';
  ctx.lineWidth = 1.5;
  const sz = 6;
  if (type === 'endpoint') {
    ctx.strokeRect(s.x - sz, s.y - sz, sz * 2, sz * 2);
  } else if (type === 'midpoint') {
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - sz); ctx.lineTo(s.x + sz, s.y + sz); ctx.lineTo(s.x - sz, s.y + sz); ctx.closePath();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(s.x, s.y, sz, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------- Draw tools ----------
// Each tool is a small click-state-machine: cadDrawPoints accumulates clicked (snapped)
// points until there are enough to commit an entity, then clears (or, for line, chains
// into the next segment - matches AutoCAD's LINE command).

function cadActiveLayerIdOrDefault() {
  const scene = cadState.current.sceneData;
  if (cadState.activeLayerId && scene.layers.some((l) => l.id === cadState.activeLayerId)) return cadState.activeLayerId;
  return scene.layers[0].id;
}

function cadAddEntity(entity) {
  cadState.current.sceneData.entities.push(entity);
  cadPushCommand({ type: 'add', entity: cadCloneEntity(entity) });
  cadMarkDirty();
  cadRender();
}

function cadFindEntityById(id) {
  return cadState.current.sceneData.entities.find((e) => e.id === id);
}

function cadDeleteSelection() {
  if (!cadState.selection.length || !cadState.current) return;
  const scene = cadState.current.sceneData;
  const ids = new Set(cadState.selection);
  const deleted = scene.entities.filter((e) => ids.has(e.id));
  if (!deleted.length) return;
  scene.entities = scene.entities.filter((e) => !ids.has(e.id));
  cadPushCommand({ type: 'delete', entities: deleted.map(cadCloneEntity) });
  cadState.selection = [];
  renderCadPropertiesPanel();
  cadMarkDirty();
  cadRender();
}

function cadHandleDrawClick(pt) {
  if (!pt) return;
  const scene = cadState.current.sceneData;
  const layer = scene.layers.find((l) => l.id === cadActiveLayerIdOrDefault());
  if (layer && layer.locked) { toast('The active layer is locked - unlock it or pick another layer first.', 'error'); return; }
  const tool = cadState.tool;
  if (tool === 'line') cadHandleLineClick(pt);
  else if (tool === 'polyline') cadHandlePolylineClick(pt);
  else if (tool === 'rectangle') cadHandleRectangleClick(pt);
  else if (tool === 'circle') cadHandleCircleClick(pt);
  else if (tool === 'arc') cadHandleArcClick(pt);
  else if (tool === 'text') cadHandleTextClick(pt);
  else if (tool === 'dimension') cadHandleDimensionClick(pt);
}

function cadHandleLineClick(pt) {
  cadDrawPoints.push(pt);
  if (cadDrawPoints.length === 2) {
    const [a, b] = cadDrawPoints;
    cadAddEntity({ id: cadGenId(), type: 'line', layerId: cadActiveLayerIdOrDefault(), x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    cadDrawPoints = [b]; // chain into the next segment, Esc ends the chain
  }
  cadRender();
}

function cadHandlePolylineClick(pt) {
  cadDrawPoints.push(pt);
  cadRender();
}

function cadCommitPolyline() {
  if (cadDrawPoints.length >= 2) {
    cadAddEntity({ id: cadGenId(), type: 'polyline', layerId: cadActiveLayerIdOrDefault(), points: cadDrawPoints.map((p) => ({ x: p.x, y: p.y })), closed: false });
  }
  cadDrawPoints = [];
  cadRender();
}

function cadHandleRectangleClick(pt) {
  cadDrawPoints.push(pt);
  if (cadDrawPoints.length === 2) {
    const [a, b] = cadDrawPoints;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const width = Math.abs(b.x - a.x), height = Math.abs(b.y - a.y);
    if (width > 0 && height > 0) {
      cadAddEntity({ id: cadGenId(), type: 'rectangle', layerId: cadActiveLayerIdOrDefault(), x, y, width, height, rotation: 0 });
    }
    cadDrawPoints = [];
  }
  cadRender();
}

function cadHandleCircleClick(pt) {
  cadDrawPoints.push(pt);
  if (cadDrawPoints.length === 2) {
    const [c, r] = cadDrawPoints;
    const radius = Math.hypot(r.x - c.x, r.y - c.y);
    if (radius > 0) cadAddEntity({ id: cadGenId(), type: 'circle', layerId: cadActiveLayerIdOrDefault(), cx: c.x, cy: c.y, radius });
    cadDrawPoints = [];
  }
  cadRender();
}

function cadHandleArcClick(pt) {
  cadDrawPoints.push(pt);
  if (cadDrawPoints.length === 3) {
    const [c, s, e] = cadDrawPoints;
    const radius = Math.hypot(s.x - c.x, s.y - c.y);
    // Always CCW from start to end angle in world space, matching DXF's ARC convention -
    // see cadDrawEntity's arc branch for how that's rendered back through the y-flip.
    const startAngle = Math.atan2(s.y - c.y, s.x - c.x);
    const endAngle = Math.atan2(e.y - c.y, e.x - c.x);
    if (radius > 0) cadAddEntity({ id: cadGenId(), type: 'arc', layerId: cadActiveLayerIdOrDefault(), cx: c.x, cy: c.y, radius, startAngle, endAngle });
    cadDrawPoints = [];
  }
  cadRender();
}

function cadHandleTextClick(pt) {
  const content = window.prompt('Text:', '');
  cadDrawPoints = [];
  if (content === null || !content.trim()) return;
  cadAddEntity({ id: cadGenId(), type: 'text', layerId: cadActiveLayerIdOrDefault(), x: pt.x, y: pt.y, content: content.trim(), height: 150, rotation: 0 });
}

function cadHandleDimensionClick(pt) {
  cadDrawPoints.push(pt);
  if (cadDrawPoints.length === 3) {
    const [p1, p2, p3] = cadDrawPoints;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const offset = (p3.x - p1.x) * nx + (p3.y - p1.y) * ny; // signed distance of p3 from the line
    cadAddEntity({ id: cadGenId(), type: 'dimension', layerId: cadActiveLayerIdOrDefault(), kind: 'linear', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, offset, text: null });
    cadDrawPoints = [];
  }
  cadRender();
}

function cadDrawToolPreview(ctx) {
  if (!cadCursorPoint || !cadState.current) return;
  const tool = cadState.tool;
  if (!isCadDrawTool(tool) || !cadDrawPoints.length) return;
  const zoom = cadState.view.zoom;
  ctx.save();
  ctx.strokeStyle = '#186a9c';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);

  if (tool === 'rectangle' && cadDrawPoints.length === 1) {
    const a = cadDrawPoints[0], b = cadCursorPoint;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const s1 = cadWorldToScreen(x, y + h);
    const s2 = cadWorldToScreen(x + w, y);
    ctx.strokeRect(s1.x, s1.y, s2.x - s1.x, s2.y - s1.y);
  } else if (tool === 'circle' && cadDrawPoints.length === 1) {
    const c = cadDrawPoints[0];
    const r = Math.hypot(cadCursorPoint.x - c.x, cadCursorPoint.y - c.y);
    const s = cadWorldToScreen(c.x, c.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * zoom, 0, Math.PI * 2);
    ctx.stroke();
  } else if (tool === 'arc' && cadDrawPoints.length === 1) {
    const c = cadDrawPoints[0];
    const r = Math.hypot(cadCursorPoint.x - c.x, cadCursorPoint.y - c.y);
    const s = cadWorldToScreen(c.x, c.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * zoom, 0, Math.PI * 2);
    ctx.stroke();
  } else if (tool === 'arc' && cadDrawPoints.length === 2) {
    const [c, sp] = cadDrawPoints;
    const radius = Math.hypot(sp.x - c.x, sp.y - c.y);
    const startAngle = Math.atan2(sp.y - c.y, sp.x - c.x);
    const endAngle = Math.atan2(cadCursorPoint.y - c.y, cadCursorPoint.x - c.x);
    const s = cadWorldToScreen(c.x, c.y);
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius * zoom, -startAngle, -endAngle, true);
    ctx.stroke();
  } else if (tool === 'line' || tool === 'polyline' || tool === 'dimension') {
    ctx.beginPath();
    cadDrawPoints.forEach((p, i) => {
      const s = cadWorldToScreen(p.x, p.y);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    const s = cadWorldToScreen(cadCursorPoint.x, cadCursorPoint.y);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

// ---------- Bounds (used by Zoom Extents) ----------

function cadEntityBounds(ent) {
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

function cadComputeSceneBounds(scene) {
  const layerById = new Map(scene.layers.map((l) => [l.id, l]));
  let bounds = null;
  for (const ent of scene.entities) {
    const layer = layerById.get(ent.layerId);
    if (!layer || !layer.visible) continue;
    const b = cadEntityBounds(ent);
    if (!b) continue;
    bounds = bounds
      ? { minX: Math.min(bounds.minX, b.minX), maxX: Math.max(bounds.maxX, b.maxX), minY: Math.min(bounds.minY, b.minY), maxY: Math.max(bounds.maxY, b.maxY) }
      : b;
  }
  return bounds;
}

// ---------- Selection, hit-testing, move ----------

function cadPointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function cadAngleWithinArc(angle, start, end) {
  const TWO_PI = Math.PI * 2;
  const norm = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
  angle = norm(angle); start = norm(start); end = norm(end);
  return start <= end ? (angle >= start && angle <= end) : (angle >= start || angle <= end);
}

// Screen-space pixel tolerance, converted to world units per the current zoom so hit-testing
// feels consistent whether zoomed in tight or looking at the whole drawing.
function cadHitTestEntity(ent, worldX, worldY, worldTolerance) {
  if (ent.type === 'line') {
    return cadPointToSegmentDist(worldX, worldY, ent.x1, ent.y1, ent.x2, ent.y2) <= worldTolerance;
  }
  if (ent.type === 'polyline') {
    for (let i = 0; i < ent.points.length - 1; i++) {
      const a = ent.points[i], b = ent.points[i + 1];
      if (cadPointToSegmentDist(worldX, worldY, a.x, a.y, b.x, b.y) <= worldTolerance) return true;
    }
    if (ent.closed && ent.points.length > 2) {
      const a = ent.points[ent.points.length - 1], b = ent.points[0];
      if (cadPointToSegmentDist(worldX, worldY, a.x, a.y, b.x, b.y) <= worldTolerance) return true;
    }
    return false;
  }
  if (ent.type === 'rectangle') {
    const corners = [
      { x: ent.x, y: ent.y }, { x: ent.x + ent.width, y: ent.y },
      { x: ent.x + ent.width, y: ent.y + ent.height }, { x: ent.x, y: ent.y + ent.height },
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      if (cadPointToSegmentDist(worldX, worldY, a.x, a.y, b.x, b.y) <= worldTolerance) return true;
    }
    return false;
  }
  if (ent.type === 'circle') {
    return Math.abs(Math.hypot(worldX - ent.cx, worldY - ent.cy) - ent.radius) <= worldTolerance;
  }
  if (ent.type === 'arc') {
    const dist = Math.hypot(worldX - ent.cx, worldY - ent.cy);
    if (Math.abs(dist - ent.radius) > worldTolerance) return false;
    return cadAngleWithinArc(Math.atan2(worldY - ent.cy, worldX - ent.cx), ent.startAngle, ent.endAngle);
  }
  if (ent.type === 'text') {
    const w = (ent.content ? ent.content.length : 1) * ent.height * 0.6;
    return worldX >= ent.x - worldTolerance && worldX <= ent.x + w + worldTolerance
      && worldY >= ent.y - worldTolerance && worldY <= ent.y + ent.height + worldTolerance;
  }
  if (ent.type === 'dimension') {
    const dx = ent.x2 - ent.x1, dy = ent.y2 - ent.y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const off = ent.offset || 0;
    return cadPointToSegmentDist(worldX, worldY, ent.x1 + nx * off, ent.y1 + ny * off, ent.x2 + nx * off, ent.y2 + ny * off) <= worldTolerance;
  }
  return false;
}

function cadFindEntityAt(screenX, screenY) {
  const scene = cadState.current.sceneData;
  const layerById = new Map(scene.layers.map((l) => [l.id, l]));
  const world = cadScreenToWorld(screenX, screenY);
  const tolerance = 6 / cadState.view.zoom;
  for (let i = scene.entities.length - 1; i >= 0; i--) {
    const ent = scene.entities[i];
    const layer = layerById.get(ent.layerId);
    if (!layer || !layer.visible || layer.locked) continue;
    if (cadHitTestEntity(ent, world.x, world.y, tolerance)) return ent;
  }
  return null;
}

function cadRectsIntersect(a, b) {
  return !(b.minX > a.maxX || b.maxX < a.minX || b.minY > a.maxY || b.maxY < a.minY);
}

// Any-intersect marquee (not AutoCAD's direction-sensitive fully-inside-vs-crossing
// distinction) - simpler, and bounding-box-based rather than exact geometry, both
// reasonable v1 simplifications for a rubber-band select.
function cadEntitiesInMarquee(screenRect) {
  const scene = cadState.current.sceneData;
  const layerById = new Map(scene.layers.map((l) => [l.id, l]));
  const c1 = cadScreenToWorld(screenRect.x1, screenRect.y1);
  const c2 = cadScreenToWorld(screenRect.x2, screenRect.y2);
  const worldRect = { minX: Math.min(c1.x, c2.x), maxX: Math.max(c1.x, c2.x), minY: Math.min(c1.y, c2.y), maxY: Math.max(c1.y, c2.y) };
  const ids = [];
  for (const ent of scene.entities) {
    const layer = layerById.get(ent.layerId);
    if (!layer || !layer.visible || layer.locked) continue;
    const b = cadEntityBounds(ent);
    if (b && cadRectsIntersect(worldRect, b)) ids.push(ent.id);
  }
  return ids;
}

function cadTranslateEntityGeometry(ent, dx, dy) {
  const t = cadCloneEntity(ent);
  if (t.type === 'line' || t.type === 'dimension') {
    t.x1 += dx; t.y1 += dy; t.x2 += dx; t.y2 += dy;
  } else if (t.type === 'polyline') {
    t.points = t.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  } else if (t.type === 'rectangle') {
    t.x += dx; t.y += dy;
  } else if (t.type === 'circle' || t.type === 'arc') {
    t.cx += dx; t.cy += dy;
  } else if (t.type === 'text') {
    t.x += dx; t.y += dy;
  }
  return t;
}

function cadZoomExtents() {
  const canvas = document.getElementById('cadCanvas');
  if (!canvas || !cadState.current) return;
  const rect = canvas.getBoundingClientRect();
  const bounds = cadComputeSceneBounds(cadState.current.sceneData);
  if (bounds) {
    const w = Math.max(bounds.maxX - bounds.minX, 1);
    const h = Math.max(bounds.maxY - bounds.minY, 1);
    const zoom = cadClamp(Math.min((rect.width - 80) / w, (rect.height - 80) / h), CAD_MIN_ZOOM, CAD_MAX_ZOOM);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    cadState.view.zoom = zoom;
    cadState.view.panX = rect.width / 2 - cx * zoom;
    cadState.view.panY = rect.height / 2 + cy * zoom;
  } else {
    cadState.view.zoom = CAD_DEFAULT_ZOOM;
    cadState.view.panX = rect.width / 2;
    cadState.view.panY = rect.height / 2;
  }
  cadRender();
}

document.getElementById('cadZoomExtentsBtn').addEventListener('click', cadZoomExtents);

// ---------- Pan + zoom interaction ----------

(function setupCadCanvasInteraction() {
  const canvas = document.getElementById('cadCanvas');

  canvas.addEventListener('wheel', (e) => {
    if (!cadState.current) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldBefore = cadScreenToWorld(mx, my);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    cadState.view.zoom = cadClamp(cadState.view.zoom * factor, CAD_MIN_ZOOM, CAD_MAX_ZOOM);
    cadState.view.panX = mx - worldBefore.x * cadState.view.zoom;
    cadState.view.panY = my + worldBefore.y * cadState.view.zoom;
    cadRender();
  }, { passive: false });

  function shouldPan(e) {
    return e.button === 1 || cadState.tool === 'pan' || (e.button === 0 && cadState.spaceDown);
  }

  function restCursor() {
    canvas.style.cursor = cadState.tool === 'pan' ? 'grab' : (cadState.tool === 'select' ? 'default' : 'crosshair');
  }

  let cadMouseDownPos = null;

  canvas.addEventListener('mousedown', (e) => {
    if (!cadState.current) return;
    if (shouldPan(e)) {
      e.preventDefault();
      cadState.panDrag = { startScreenX: e.clientX, startScreenY: e.clientY, startPanX: cadState.view.panX, startPanY: cadState.view.panY };
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;

    if (cadState.tool === 'select') {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const hit = cadFindEntityAt(sx, sy);
      if (hit) {
        if (!cadState.selection.includes(hit.id)) {
          cadState.selection = e.shiftKey ? [...cadState.selection, hit.id] : [hit.id];
        } else if (e.shiftKey) {
          cadState.selection = cadState.selection.filter((id) => id !== hit.id);
        }
        renderCadPropertiesPanel();
        if (cadState.selection.length) {
          cadMoveDrag = {
            anchor: cadScreenToWorld(sx, sy),
            entries: cadState.selection.map((id) => ({ id, before: cadCloneEntity(cadFindEntityById(id)) })),
          };
        }
      } else {
        if (!e.shiftKey) { cadState.selection = []; renderCadPropertiesPanel(); }
        cadMarquee = { x1: sx, y1: sy, x2: sx, y2: sy };
      }
      cadRender();
      return;
    }

    cadMouseDownPos = { x: e.clientX, y: e.clientY };
  });

  // Cursor/snap tracking, live tool-preview - separate from the pan drag above (window-level
  // so panning stays smooth even if the cursor leaves the canvas mid-drag).
  canvas.addEventListener('mousemove', (e) => {
    if (!cadState.current || cadState.panDrag) return;
    const rect = canvas.getBoundingClientRect();
    cadCursorPoint = cadComputeCursorPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (isCadDrawTool(cadState.tool)) cadRender();
  });

  window.addEventListener('mousemove', (e) => {
    if (cadState.panDrag) {
      cadState.view.panX = cadState.panDrag.startPanX + (e.clientX - cadState.panDrag.startScreenX);
      cadState.view.panY = cadState.panDrag.startPanY + (e.clientY - cadState.panDrag.startScreenY);
      cadRender();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (cadMoveDrag) {
      const world = cadScreenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const dx = world.x - cadMoveDrag.anchor.x, dy = world.y - cadMoveDrag.anchor.y;
      const scene = cadState.current.sceneData;
      for (const entry of cadMoveDrag.entries) {
        const idx = scene.entities.findIndex((ent) => ent.id === entry.id);
        if (idx !== -1) scene.entities[idx] = cadTranslateEntityGeometry(entry.before, dx, dy);
      }
      cadRender();
      return;
    }
    if (cadMarquee) {
      cadMarquee.x2 = e.clientX - rect.left;
      cadMarquee.y2 = e.clientY - rect.top;
      cadRender();
    }
  });

  // A left-click that didn't move (beyond a small jitter tolerance) commits a draw-tool
  // point; one that did was a pan/select-drag, not a click. Deliberately not using the
  // native 'click' event, since that alone can't tell those two apart.
  window.addEventListener('mouseup', (e) => {
    if (cadState.panDrag) {
      cadState.panDrag = null;
      restCursor();
      cadMouseDownPos = null;
      return;
    }

    if (cadMoveDrag) {
      const rect = canvas.getBoundingClientRect();
      const world = cadScreenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const dx = world.x - cadMoveDrag.anchor.x, dy = world.y - cadMoveDrag.anchor.y;
      if (Math.hypot(dx, dy) > 1e-6) {
        const changes = cadMoveDrag.entries.map((entry) => ({ id: entry.id, before: entry.before, after: cadTranslateEntityGeometry(entry.before, dx, dy) }));
        cadPushCommand({ type: 'edit', changes });
        cadMarkDirty();
      }
      cadMoveDrag = null;
      cadRender();
      return;
    }

    if (cadMarquee) {
      const ids = cadEntitiesInMarquee(cadMarquee);
      cadState.selection = e.shiftKey ? [...new Set([...cadState.selection, ...ids])] : ids;
      cadMarquee = null;
      renderCadPropertiesPanel();
      cadRender();
      return;
    }

    if (e.button !== 0 || !cadMouseDownPos) return;
    const moved = Math.hypot(e.clientX - cadMouseDownPos.x, e.clientY - cadMouseDownPos.y) > 3;
    cadMouseDownPos = null;
    if (moved || !cadState.current || !isCadDrawTool(cadState.tool)) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) return;
    cadHandleDrawClick(cadComputeCursorPoint(sx, sy));
  });

  canvas.addEventListener('dblclick', () => {
    if (cadState.tool === 'polyline' && cadDrawPoints.length) cadCommitPolyline();
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (cadState.tool === 'polyline' && cadDrawPoints.length) cadCommitPolyline();
  });
})();
