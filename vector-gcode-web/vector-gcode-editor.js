import {
  arrangeOnSheetsTight,
  bounds,
  generateGcode,
  groupConnectedPaths,
  measureSegment,
  parseVectorFile,
  transformPaths
} from './vector-gcode-core.js';

const styles = `
:host { display: block; color: #17202a; font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
:host(:focus) { outline: 2px solid #3276d8; outline-offset: 3px; }
* { box-sizing: border-box; }
.editor { border: 1px solid #d9e0e7; border-radius: 12px; overflow: hidden; background: #fff; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px; border-bottom: 1px solid #e5eaf0; background: #f8fafc; }
button, .file-button { border: 1px solid #c7d2de; border-radius: 7px; padding: 7px 11px; background: #fff; color: #17202a; cursor: pointer; font: inherit; }
button:hover, .file-button:hover { border-color: #3276d8; background: #f1f6ff; }
button.primary { border-color: #2463bd; background: #2463bd; color: #fff; }
button.primary:hover { background: #1b4f9b; }
input[type=file] { display: none; }
.toolbar-spacer { flex: 1; }
.sheet-indicator { min-width: 74px; color: #52606d; text-align: center; font-size: 12px; }
.body { display: grid; grid-template-columns: 290px minmax(420px, 1fr); min-height: 570px; }
.panel { padding: 14px; border-right: 1px solid #e5eaf0; overflow: auto; }
.preview { min-width: 0; padding: 14px; background: #f3f6fa; }
.preview-layout { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; height: 100%; }
.sheet-overview { min-width: 0; padding: 9px; border: 1px solid #d9e0e7; border-radius: 8px; background: #fff; overflow: auto; }
.sheet-overview-title { margin: 0 0 8px; font-weight: 650; }
.sheet-overview-list { display: grid; gap: 8px; }
.sheet-card { display: grid; gap: 4px; width: 100%; border: 1px solid #d9e0e7; border-radius: 7px; padding: 5px; background: #fff; cursor: pointer; color: #52606d; font: inherit; text-align: left; }
.sheet-card:hover, .sheet-card.active { border-color: #3276d8; background: #f1f6ff; }
.sheet-thumb { display: block; width: 100%; height: 76px; border: 1px solid #e5eaf0; background: #fff; }
.sheet-card-label { font-size: 11px; }
.preview-main { min-width: 0; }
.section { padding-bottom: 14px; margin-bottom: 14px; border-bottom: 1px solid #e5eaf0; }
.section:last-child { border-bottom: 0; }
.section-title { margin: 0 0 9px; font-weight: 650; }
.hint { color: #617080; font-size: 12px; }
.object-list { display: grid; gap: 6px; max-height: 180px; overflow: auto; }
.object { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid #d9e0e7; border-radius: 7px; cursor: pointer; }
.object.selected { border-color: #3276d8; background: #f1f6ff; }
.object-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.object-format { margin-left: auto; color: #617080; font-size: 11px; text-transform: uppercase; }
.empty { color: #617080; font-size: 12px; padding: 8px 0; }
.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
label { display: grid; gap: 4px; color: #52606d; font-size: 12px; }
input[type=number], select { width: 100%; border: 1px solid #c7d2de; border-radius: 6px; padding: 6px 7px; color: #17202a; background: #fff; font: inherit; }
.field-wide { grid-column: 1 / -1; }
.inline { display: flex; gap: 8px; align-items: center; }
.inline > * { flex: 1; }
.canvas-wrap { position: relative; width: 100%; height: 390px; border: 1px solid #d9e0e7; border-radius: 8px; background: #fff; overflow: hidden; }
canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
canvas.dragging { cursor: grabbing; }
canvas.pan-dragging { cursor: grabbing; }
canvas.measure-mode { cursor: crosshair; }
.measure-button.active { border-color: #2463bd; background: #e8f1ff; color: #1552a2; }
.canvas-label { position: absolute; top: 9px; left: 10px; padding: 2px 6px; border-radius: 4px; color: #617080; background: rgba(255,255,255,.85); font-size: 11px; }
.output { margin-top: 12px; }
textarea { display: block; width: 100%; height: 145px; resize: vertical; border: 1px solid #d9e0e7; border-radius: 8px; padding: 9px; background: #111827; color: #d1fae5; font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
.status { min-height: 18px; margin-top: 8px; color: #52606d; font-size: 12px; }
.status.error { color: #b42318; }
@media (max-width: 1000px) { .body { grid-template-columns: 1fr; } .panel { border-right: 0; border-bottom: 1px solid #e5eaf0; } }
@media (max-width: 700px) { .preview-layout { grid-template-columns: 1fr; } .sheet-overview { max-height: 150px; } .sheet-overview-list { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); } }
`;

const UI_MM_PER_CM = 10;

function inputValue(root, name, fallback) {
  const element = root.querySelector(`[data-option="${name}"]`);
  return element ? Number(element.value) : fallback;
}

function optionValue(root, name, fallback) {
  const element = root.querySelector(`[data-option="${name}"]`);
  return element ? element.value : fallback;
}

class VectorGcodeEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.objects = [];
    this.selectedId = null;
    this.activeSheet = 0;
    this.sheets = [{ sheetIndex: 0, itemCount: 0 }];
    this.globalTransform = { scale: 1, rotate: 0 };
    this.nextId = 1;
    this.clipboard = null;
    this.pasteCount = 0;
    this.tabIndex = 0;
    this.rendered = false;
    this.measureMode = false;
    this.measurement = { first: null, second: null };
    this.measureSnap = null;
    this.viewZoom = 1;
    this.viewPan = { x: 0, y: 0 };
  }

  connectedCallback() {
    if (!this.rendered) this.render();
  }

  render() {
    this.rendered = true;
    this.shadowRoot.innerHTML = `<style>${styles}</style>
      <div class="editor">
        <div class="toolbar">
          <label class="file-button">导入 DXF / SVG<input data-files type="file" accept=".dxf,.svg,image/svg+xml" multiple></label>
          <button data-arrange>自动排布</button>
          <button data-fit>适应版面</button>
          <button data-prev-sheet disabled>上一版面</button>
          <span class="sheet-indicator" data-sheet-indicator>版面 1 / 1</span>
          <button data-next-sheet disabled>下一版面</button>
          <button class="measure-button" data-measure>测量线段</button>
          <button data-clear>清空</button>
          <button data-copy disabled>复制板片</button>
          <button data-paste disabled>粘贴板片</button>
          <span class="toolbar-spacer"></span>
          <button class="primary" data-generate>生成 G-code</button>
          <button data-download disabled>下载 .nc</button>
        </div>
        <div class="body">
          <aside class="panel">
            <div class="section">
              <p class="section-title">文件与排布</p>
              <div class="object-list" data-objects><div class="empty">请导入 DXF 或 SVG 文件</div></div>
              <div class="fields" data-transform-fields hidden>
                <label>比例<input data-transform="scale" type="number" min="0.0001" step="0.01" value="1"></label>
                <label>旋转 (°)<input data-transform="rotate" type="number" step="1" value="0"></label>
              </div>
              <div class="hint">选中组成部分后可独立设置比例和旋转，位置通过预览拖动调整。</div>
            </div>
            <div class="section">
              <p class="section-title">整体变换</p>
              <div class="fields" data-global-transform-fields>
                <label>整体比例<input data-global-transform="scale" type="number" min="0.0001" step="0.01" value="1"></label>
                <label>整体旋转 (°)<input data-global-transform="rotate" type="number" step="1" value="0"></label>
              </div>
              <div class="hint">同步作用于所有导入组成部分；修改后会自动重新排版。</div>
            </div>
            <div class="section">
              <p class="section-title">自动排布参数</p>
              <div class="fields">
                <label>图形间距 (cm)<input data-option="spacing" type="number" min="0" step="0.1" value="0"></label>
                <label>版面宽度 (cm)<input data-option="sheetWidth" type="number" min="0.1" step="1" value="120"></label>
                <label>版面高度 (cm)<input data-option="sheetHeight" type="number" min="0.1" step="1" value="120"></label>
                <label>排版方向<select data-option="direction"><option value="horizontal">横向优先</option><option value="vertical">纵向优先</option></select></label>
              </div>
              <div class="hint">排版和拖动单位为 cm；自动排版会优先填满所选方向，G-code 参数仍为 mm。</div>
            </div>
            <div class="section">
              <p class="section-title">G-code 参数</p>
              <div class="fields">
                <label>安全 Z (mm)<input data-option="safeZ" type="number" step="0.1" value="5"></label>
                <label>下刀 Z (mm)<input data-option="cutZ" type="number" step="0.1" value="-1"></label>
                <label>下刀速度<input data-option="plungeFeed" type="number" min="0.01" step="1" value="100"></label>
                <label>走刀速度<input data-option="cutFeed" type="number" min="0.01" step="1" value="500"></label>
                <label>小数位<input data-option="decimals" type="number" min="0" max="6" step="1" value="3"></label>
              </div>
              <div class="hint">单位固定为 mm；输出 G21/G90；不输出主轴、激光或 M3/M5 指令。</div>
            </div>
            <div class="status" data-status></div>
          </aside>
          <main class="preview">
            <div class="preview-layout">
              <aside class="sheet-overview">
                <p class="sheet-overview-title">版面总览</p>
                <div class="sheet-overview-list" data-sheet-overview></div>
              </aside>
              <div class="preview-main">
                <div class="canvas-wrap"><canvas data-canvas></canvas><span class="canvas-label">预览 / 单位：cm</span></div>
                <div class="hint">在线框上拖动图形；空白处按住鼠标左键平移预览，滚轮缩放。</div>
                <div class="output"><textarea data-output readonly placeholder="生成 G-code 后显示在这里"></textarea></div>
              </div>
            </div>
          </main>
        </div>
      </div>`;
    this.bindEvents();
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.shadowRoot.querySelector('.canvas-wrap'));
    this.refreshSheetControls();
    this.draw();
  }

  bindEvents() {
    const root = this.shadowRoot;
    root.querySelector('[data-files]').addEventListener('change', event => this.importFiles(event.target.files));
    root.querySelector('[data-clear]').addEventListener('click', () => this.clear());
    root.querySelector('[data-arrange]').addEventListener('click', () => this.layoutAutomatically());
    root.querySelector('[data-fit]').addEventListener('click', () => this.fitView());
    root.querySelector('[data-prev-sheet]').addEventListener('click', () => this.changeSheet(-1));
    root.querySelector('[data-next-sheet]').addEventListener('click', () => this.changeSheet(1));
    root.querySelector('[data-measure]').addEventListener('click', () => this.toggleMeasure());
    root.querySelector('[data-generate]').addEventListener('click', () => this.generate());
    root.querySelector('[data-download]').addEventListener('click', () => this.download());
    root.querySelector('[data-copy]').addEventListener('click', () => this.copySelected());
    root.querySelector('[data-paste]').addEventListener('click', () => this.pasteClipboard());
    this.addEventListener('keydown', event => this.handleKeyboard(event));
    const canvas = root.querySelector('[data-canvas]');
    canvas.addEventListener('pointerdown', event => this.startDrag(event));
    canvas.addEventListener('pointermove', event => this.drag(event));
    canvas.addEventListener('pointermove', event => this.updateMeasureSnap(event));
    canvas.addEventListener('pointerup', event => this.endDrag(event));
    canvas.addEventListener('pointercancel', event => this.endDrag(event));
    canvas.addEventListener('click', event => this.measureClick(event));
    canvas.addEventListener('wheel', event => this.zoomAtPointer(event), { passive: false });
    canvas.addEventListener('pointerleave', () => {
      if (this.measureSnap) {
        this.measureSnap = null;
        this.draw();
      }
    });
    root.querySelector('[data-objects]').addEventListener('click', event => {
      const item = event.target.closest('[data-object-id]');
      if (item) {
        this.selectedId = Number(item.dataset.objectId);
        const selectedObject = this.objects.find(value => value.id === this.selectedId);
        if (selectedObject) this.activeSheet = selectedObject.transform.sheetIndex ?? 0;
        this.refreshSheetControls();
        this.refreshObjectList();
        this.refreshTransformFields();
        this.draw();
      }
    });
    root.querySelector('[data-transform-fields]').addEventListener('input', event => {
      const field = event.target.dataset.transform;
      if (!field) return;
      const selected = this.objects.find(item => item.id === this.selectedId);
      if (!selected) return;
       const value = Number(event.target.value);
       selected.transform[field] = field === 'x' || field === 'y' ? value * UI_MM_PER_CM : value;
      this.draw();
      this.emit('layout-changed', this.getState());
    });
    root.querySelector('[data-global-transform-fields]').addEventListener('input', event => {
      const field = event.target.dataset.globalTransform;
      if (!field) return;
      this.globalTransform[field] = Number(event.target.value);
      this.layoutAutomatically(false);
      this.emit('layout-changed', this.getState());
    });
    root.querySelectorAll('[data-option]').forEach(element => {
      element.addEventListener('input', () => this.draw());
      element.addEventListener('change', () => this.draw());
    });
  }

  async importFiles(fileList) {
    const files = [...fileList];
    for (const file of files) {
      try {
        await this.loadFile(file.name, await file.text());
      } catch (error) {
        this.setStatus(`${file.name}：${error.message}`, true);
      }
    }
    this.shadowRoot.querySelector('[data-files]').value = '';
  }

  async loadFile(name, text) {
    const parsed = parseVectorFile(name, text, { tolerance: 0.2 });
    if (!parsed.paths.length) throw new Error('没有识别到可转换的路径。DXF 请使用 ASCII 格式。');
    const groups = groupConnectedPaths(parsed.paths);
    const commonTransform = { x: 0, y: 0, scale: 1, rotate: 0 };
    const items = groups.map((group, index) => ({
      id: this.nextId++,
      name: `${name}${groups.length > 1 ? ` #${index + 1}` : ''}`,
      format: parsed.format,
      component: true,
      closed: true,
      paths: group.paths,
      transform: { ...commonTransform }
    }));
    this.objects.push(...items);
    this.layoutAutomatically(false);
    if (this.selectedId === null && items.length) this.selectedId = items[0].id;
    this.refreshObjectList();
    this.refreshTransformFields();
    this.refreshGlobalFields();
    this.draw();
    this.setStatus(`已载入 ${items.length} 个图形组成部分，可单独拖动。`);
    this.emit('file-loaded', { items: items.map(item => this.publicObject(item)) });
    return items.map(item => this.publicObject(item));
  }

  clear() {
    this.objects = [];
    this.selectedId = null;
    this.clipboard = null;
    this.pasteCount = 0;
    this.activeSheet = 0;
    this.sheets = [{ sheetIndex: 0, itemCount: 0 }];
    this.globalTransform = { scale: 1, rotate: 0 };
    this.measurement = { first: null, second: null };
    this.measureSnap = null;
    this.viewZoom = 1;
    this.viewPan = { x: 0, y: 0 };
    this.refreshSheetControls();
    this.refreshObjectList();
    this.refreshTransformFields();
    this.refreshGlobalFields();
    this.shadowRoot.querySelector('[data-output]').value = '';
    this.shadowRoot.querySelector('[data-download]').disabled = true;
    this.draw();
    this.setStatus('已清空。');
    this.emit('cleared', {});
  }

  handleKeyboard(event) {
    const source = event.composedPath()[0];
    if (source && ['INPUT', 'TEXTAREA', 'SELECT'].includes(source.tagName)) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'c' && this.copySelected()) event.preventDefault();
    if (key === 'v' && this.pasteClipboard()) event.preventDefault();
  }

  clonePaths(paths) {
    return paths.map(pathValue => ({
      ...pathValue,
      points: pathValue.points.map(point => ({ ...point }))
    }));
  }

  copySelected() {
    const selected = this.objects.find(item => item.id === this.selectedId);
    if (!selected) {
      this.setStatus('请先选择要复制的板片。', true);
      return false;
    }
    this.clipboard = {
      name: selected.name,
      format: selected.format,
      component: selected.component,
      closed: selected.closed,
      paths: this.clonePaths(selected.paths),
      transform: { ...selected.transform }
    };
    this.pasteCount = 0;
    this.refreshClipboardControls();
    this.setStatus(`已复制“${selected.name}”，现在可以粘贴副本。`);
    return true;
  }

  pasteClipboard() {
    if (!this.clipboard) {
      this.setStatus('请先复制一个板片。', true);
      return false;
    }
    this.pasteCount += 1;
    const source = this.clipboard;
    const offset = this.pasteCount * UI_MM_PER_CM;
    const pasted = {
      id: this.nextId++,
      name: `${source.name} 副本 ${this.pasteCount}`,
      format: source.format,
      component: source.component,
      closed: source.closed,
      paths: this.clonePaths(source.paths),
      transform: {
        ...source.transform,
        x: Number(source.transform.x || 0) + offset,
        y: Number(source.transform.y || 0) + offset
      }
    };
    this.objects.push(pasted);
    this.selectedId = pasted.id;
    this.activeSheet = pasted.transform.sheetIndex ?? this.activeSheet;
    this.refreshSheetSummary();
    this.refreshSheetControls();
    this.refreshObjectList();
    this.refreshTransformFields();
    this.draw();
    this.emit('layout-changed', this.getState());
    this.setStatus(`已粘贴“${pasted.name}”，副本已错开 ${offset / UI_MM_PER_CM} cm。`);
    return true;
  }

  refreshSheetSummary() {
    const counts = new Map();
    this.objects.forEach(item => {
      const sheetIndex = Math.max(0, Math.trunc(Number(item.transform.sheetIndex ?? 0)));
      counts.set(sheetIndex, (counts.get(sheetIndex) || 0) + 1);
    });
    const maxSheet = counts.size ? Math.max(...counts.keys()) : 0;
    this.sheets = Array.from({ length: maxSheet + 1 }, (_, sheetIndex) => ({
      sheetIndex,
      itemCount: counts.get(sheetIndex) || 0
    }));
  }

  layoutAutomatically(announce = true) {
    const arranged = arrangeOnSheetsTight(this.objects, {
      spacing: inputValue(this.shadowRoot, 'spacing', 0) * UI_MM_PER_CM,
      sheetWidth: inputValue(this.shadowRoot, 'sheetWidth', 120) * UI_MM_PER_CM,
      sheetHeight: inputValue(this.shadowRoot, 'sheetHeight', 120) * UI_MM_PER_CM,
      direction: optionValue(this.shadowRoot, 'direction', 'horizontal'),
      globalTransform: this.globalTransform
    });
    this.objects = arranged.items;
    this.sheets = arranged.sheets.length ? arranged.sheets : [{ sheetIndex: 0, itemCount: 0 }];
    this.activeSheet = Math.min(this.activeSheet, this.sheets.length - 1);
    this.viewZoom = 1;
    this.viewPan = { x: 0, y: 0 };
    this.refreshSheetControls();
    this.refreshTransformFields();
    this.refreshGlobalFields();
    this.draw();
    if (announce) {
      this.emit('layout-changed', this.getState());
      const overflowMessage = arranged.overflow ? ` 有 ${arranged.overflow} 个图形超出版面。` : '';
      this.setStatus(`已自动排版：${arranged.direction === 'horizontal' ? '横向' : '纵向'}优先，间距 ${arranged.spacing / UI_MM_PER_CM} cm。${overflowMessage}`);
    }
  }

  refreshSheetControls() {
    if (!this.rendered) return;
    const count = Math.max(1, this.sheets.length);
    this.activeSheet = Math.max(0, Math.min(this.activeSheet, count - 1));
    this.shadowRoot.querySelector('[data-sheet-indicator]').textContent = `版面 ${this.activeSheet + 1} / ${count}`;
    this.shadowRoot.querySelector('[data-prev-sheet]').disabled = this.activeSheet === 0;
    this.shadowRoot.querySelector('[data-next-sheet]').disabled = this.activeSheet === count - 1;
    this.refreshSheetOverview();
  }

  refreshSheetOverview() {
    if (!this.rendered) return;
    const list = this.shadowRoot.querySelector('[data-sheet-overview]');
    list.replaceChildren();
    const sheets = this.sheets.length ? this.sheets : [{ sheetIndex: 0, itemCount: 0 }];
    sheets.forEach(sheet => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `sheet-card${sheet.sheetIndex === this.activeSheet ? ' active' : ''}`;
      card.dataset.sheetIndex = sheet.sheetIndex;
      const canvas = document.createElement('canvas');
      canvas.className = 'sheet-thumb';
      canvas.dataset.sheetThumbnail = sheet.sheetIndex;
      const label = document.createElement('span');
      label.className = 'sheet-card-label';
      label.textContent = `版面 ${sheet.sheetIndex + 1}（${sheet.itemCount} 个）`;
      card.append(canvas, label);
      card.addEventListener('click', () => {
        this.activeSheet = sheet.sheetIndex;
        this.refreshSheetControls();
        this.fitView(false);
      });
      list.appendChild(card);
    });
    this.drawSheetOverviewCanvases();
  }

  drawSheetOverviewCanvases() {
    if (!this.rendered) return;
    const sheetWidth = inputValue(this.shadowRoot, 'sheetWidth', 120) * UI_MM_PER_CM;
    const sheetHeight = inputValue(this.shadowRoot, 'sheetHeight', 120) * UI_MM_PER_CM;
    this.shadowRoot.querySelectorAll('[data-sheet-thumbnail]').forEach(canvas => {
      const width = 136;
      const height = 76;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      const context = canvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      const padding = 4;
      const scale = Math.min((width - padding * 2) / sheetWidth, (height - padding * 2) / sheetHeight);
      const toCanvas = value => ({ x: padding + value.x * scale, y: height - padding - value.y * scale });
      context.strokeStyle = '#aab7c4';
      context.setLineDash([3, 2]);
      context.strokeRect(padding, padding, sheetWidth * scale, sheetHeight * scale);
      context.setLineDash([]);
      const sheetIndex = Number(canvas.dataset.sheetThumbnail);
      const paths = this.transformedPaths(this.objects.filter(item => (item.transform.sheetIndex ?? 0) === sheetIndex));
      context.strokeStyle = '#2463bd';
      context.lineWidth = 1;
      context.lineJoin = 'round';
      for (const pathValue of paths) {
        context.beginPath();
        pathValue.points.forEach((value, index) => {
          const point = toCanvas(value);
          if (index === 0) context.moveTo(point.x, point.y);
          else context.lineTo(point.x, point.y);
        });
        context.stroke();
      }
    });
  }

  changeSheet(delta) {
    const nextSheet = Math.max(0, Math.min(this.activeSheet + delta, this.sheets.length - 1));
    if (nextSheet === this.activeSheet) return;
    this.activeSheet = nextSheet;
    this.refreshSheetControls();
    this.fitView(false);
  }

  fitView(announce = true) {
    this.viewZoom = 1;
    this.viewPan = { x: 0, y: 0 };
    this.draw();
    if (announce) this.setStatus('已适应版面。');
  }

  zoomAtPointer(event) {
    event.preventDefault();
    const currentMetrics = this.viewMetrics();
    if (!currentMetrics) return;
    const rectangle = event.currentTarget.getBoundingClientRect();
    const pixelX = event.clientX - rectangle.left;
    const pixelY = event.clientY - rectangle.top;
    const before = this.canvasWorldPoint(event, currentMetrics);
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nextZoom = Math.max(0.2, Math.min(20, this.viewZoom * factor));
    if (nextZoom === this.viewZoom) return;
    this.viewZoom = nextZoom;
    const nextMetrics = this.viewMetrics();
    this.viewPan.x = (pixelX - nextMetrics.baseOffsetX) / nextMetrics.scale - (before.x - nextMetrics.box.minX);
    this.viewPan.y = (nextMetrics.height - nextMetrics.baseOffsetY - pixelY) / nextMetrics.scale - (before.y - nextMetrics.box.minY);
    this.draw();
  }

  generate() {
    try {
      const sortedObjects = [...this.objects].sort((first, second) => (first.transform.sheetIndex ?? 0) - (second.transform.sheetIndex ?? 0)).map(item => ({ ...item, transform: this.effectiveTransform(item) }));
      const result = generateGcode(sortedObjects, {
        safeZ: inputValue(this.shadowRoot, 'safeZ', 5),
        cutZ: inputValue(this.shadowRoot, 'cutZ', -1),
        plungeFeed: inputValue(this.shadowRoot, 'plungeFeed', 100),
        cutFeed: inputValue(this.shadowRoot, 'cutFeed', 500),
        decimals: inputValue(this.shadowRoot, 'decimals', 3)
      });
      this.shadowRoot.querySelector('[data-output]').value = result.code;
      this.shadowRoot.querySelector('[data-download]').disabled = false;
      this.lastGcode = result.code;
      this.setStatus(`已生成 ${result.pathCount} 条路径。`);
      this.emit('gcode-generated', { ...result, state: this.getState() });
    } catch (error) {
      this.setStatus(error.message, true);
    }
  }

  toggleMeasure() {
    this.measureMode = !this.measureMode;
    const button = this.shadowRoot.querySelector('[data-measure]');
    const canvas = this.shadowRoot.querySelector('[data-canvas]');
    button.classList.toggle('active', this.measureMode);
    canvas.classList.toggle('measure-mode', this.measureMode);
    if (this.measureMode) {
      this.measurement = { first: null, second: null };
      this.measureSnap = null;
      this.setStatus('测量模式：点击起点，再点击终点。');
    } else {
      this.measurement = { first: null, second: null };
      this.measureSnap = null;
      this.setStatus('已退出测量模式。');
    }
    this.draw();
  }

  snapMeasurePoint(value, metrics) {
    const tolerance = 8 / metrics.scale;
    let nearest = { point: value, kind: null, distance: tolerance };
    const consider = (candidate, kind) => {
      const currentDistance = Math.hypot(candidate.x - value.x, candidate.y - value.y);
      if (currentDistance < nearest.distance) nearest = { point: { x: candidate.x, y: candidate.y }, kind, distance: currentDistance };
    };
    for (const pathValue of metrics.paths) {
      const points = pathValue.points;
      for (let index = 0; index < points.length; index += 1) {
        if (index === 0 || index === points.length - 1) consider(points[index], '端点');
        if (index < points.length - 1) {
          const next = points[index + 1];
          const deltaX = next.x - points[index].x;
          const deltaY = next.y - points[index].y;
          const lengthSquared = deltaX ** 2 + deltaY ** 2;
          if (!lengthSquared) continue;
          consider({ x: (points[index].x + next.x) / 2, y: (points[index].y + next.y) / 2 }, '中点');
          const ratio = Math.max(0, Math.min(1, ((value.x - points[index].x) * deltaX + (value.y - points[index].y) * deltaY) / lengthSquared));
          consider({ x: points[index].x + deltaX * ratio, y: points[index].y + deltaY * ratio }, ratio === 0 || ratio === 1 ? '端点' : '线段');
        }
      }
    }
    return nearest;
  }

  updateMeasureSnap(event) {
    if (!this.measureMode || this.dragState) return;
    const metrics = this.viewMetrics();
    if (!metrics) return;
    const value = this.canvasWorldPoint(event, metrics);
    const snapped = this.snapMeasurePoint(value, metrics);
    const previous = this.measureSnap;
    this.measureSnap = snapped.kind ? snapped : null;
    if (this.measureSnap?.kind && (!previous || previous.kind !== this.measureSnap.kind)) {
      this.setStatus(`已吸附到${this.measureSnap.kind}，点击确认测量点。`);
    }
    this.draw();
  }

  measureClick(event) {
    if (!this.measureMode || this.dragState) return;
    const metrics = this.viewMetrics();
    if (!metrics) {
      this.setStatus('请先导入图形，再进行测量。', true);
      return;
    }
    const snapped = this.snapMeasurePoint(this.canvasWorldPoint(event, metrics), metrics);
    const value = snapped.point;
    if (this.measurement.first && this.measurement.second) {
      this.measurement = { first: value, second: null };
      this.setStatus('已重新选择起点，请点击终点。');
    } else if (!this.measurement.first) {
      this.measurement.first = value;
      this.setStatus(`起点：X ${(value.x / UI_MM_PER_CM).toFixed(3)} cm，Y ${(value.y / UI_MM_PER_CM).toFixed(3)} cm。请点击终点。`);
    } else {
      this.measurement.second = value;
      const length = measureSegment(this.measurement.first, value);
      this.setStatus(`线段长度：${(length / UI_MM_PER_CM).toFixed(3)} cm；ΔX：${((value.x - this.measurement.first.x) / UI_MM_PER_CM).toFixed(3)} cm；ΔY：${((value.y - this.measurement.first.y) / UI_MM_PER_CM).toFixed(3)} cm。`);
      this.emit('measurement-changed', {
        first: { x: this.measurement.first.x / UI_MM_PER_CM, y: this.measurement.first.y / UI_MM_PER_CM },
        second: { x: this.measurement.second.x / UI_MM_PER_CM, y: this.measurement.second.y / UI_MM_PER_CM },
        distance: length / UI_MM_PER_CM,
        unit: 'cm'
      });
    }
    this.draw();
  }

  download() {
    if (!this.lastGcode) return;
    const blob = new Blob([this.lastGcode], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'vector-output.nc';
    link.click();
    URL.revokeObjectURL(url);
  }

  refreshObjectList() {
    const list = this.shadowRoot.querySelector('[data-objects]');
    list.replaceChildren();
    if (!this.objects.length) {
      list.innerHTML = '<div class="empty">请导入 DXF 或 SVG 文件</div>';
      this.refreshClipboardControls();
      return;
    }
    this.objects.forEach(item => {
      const row = document.createElement('div');
      row.className = `object${item.id === this.selectedId ? ' selected' : ''}`;
      row.dataset.objectId = item.id;
      const name = document.createElement('span');
      name.className = 'object-name';
      name.textContent = item.name;
      const format = document.createElement('span');
      format.className = 'object-format';
      format.textContent = `${item.format} · P${(item.transform.sheetIndex ?? 0) + 1}`;
      row.append(name, format);
      list.appendChild(row);
    });
    this.refreshClipboardControls();
  }

  refreshClipboardControls() {
    if (!this.rendered) return;
    const selected = this.objects.some(item => item.id === this.selectedId);
    this.shadowRoot.querySelector('[data-copy]').disabled = !selected;
    this.shadowRoot.querySelector('[data-paste]').disabled = !this.clipboard;
  }

  refreshTransformFields() {
    const fields = this.shadowRoot.querySelector('[data-transform-fields]');
    const selected = this.objects.find(item => item.id === this.selectedId);
    fields.hidden = !selected;
    if (!selected) return;
    fields.querySelectorAll('[data-transform]').forEach(input => {
      const field = input.dataset.transform;
      const value = selected.transform[field] ?? 0;
      input.value = field === 'x' || field === 'y' ? value / UI_MM_PER_CM : value;
    });
  }

  refreshGlobalFields() {
    if (!this.rendered) return;
    this.shadowRoot.querySelectorAll('[data-global-transform]').forEach(input => {
      input.value = this.globalTransform[input.dataset.globalTransform] ?? 0;
    });
  }

  visibleObjects() {
    return this.objects.filter(item => (item.transform.sheetIndex ?? 0) === this.activeSheet);
  }

  effectiveTransform(item) {
    return {
      ...item.transform,
      scale: Number(item.transform.scale ?? 1) * this.globalTransform.scale,
      rotate: Number(item.transform.rotate ?? 0) + this.globalTransform.rotate
    };
  }

  transformedPaths(objects = this.visibleObjects()) {
    return objects.flatMap(item => transformPaths(item.paths, this.effectiveTransform(item)));
  }

  viewMetrics() {
    const canvas = this.shadowRoot.querySelector('[data-canvas]');
    const wrapper = canvas.parentElement;
    const width = Math.max(1, wrapper.clientWidth);
    const height = Math.max(1, wrapper.clientHeight);
    const paths = this.transformedPaths();
    const sheetWidth = inputValue(this.shadowRoot, 'sheetWidth', 120) * UI_MM_PER_CM;
    const sheetHeight = inputValue(this.shadowRoot, 'sheetHeight', 120) * UI_MM_PER_CM;
    const sheetPath = { points: [{ x: 0, y: 0 }, { x: sheetWidth, y: 0 }, { x: sheetWidth, y: sheetHeight }, { x: 0, y: sheetHeight }] };
    const box = bounds([...paths, sheetPath]);
    const padding = 32;
    const baseScale = Math.min((width - padding * 2) / Math.max(box.width, 1), (height - padding * 2) / Math.max(box.height, 1));
    const scale = baseScale * this.viewZoom;
    const baseOffsetX = padding + ((width - padding * 2) - box.width * baseScale) / 2;
    const baseOffsetY = padding + ((height - padding * 2) - box.height * baseScale) / 2;
    const offsetX = baseOffsetX + this.viewPan.x * scale;
    const offsetY = baseOffsetY + this.viewPan.y * scale;
    return { width, height, paths, box, scale, baseOffsetX, baseOffsetY, offsetX, offsetY, sheetWidth, sheetHeight };
  }

  canvasWorldPoint(event, metrics) {
    const rectangle = event.currentTarget.getBoundingClientRect();
    const pixelX = event.clientX - rectangle.left;
    const pixelY = event.clientY - rectangle.top;
    return {
      x: metrics.box.minX + (pixelX - metrics.offsetX) / metrics.scale,
      y: metrics.box.minY + (metrics.height - metrics.offsetY - pixelY) / metrics.scale
    };
  }

  objectAt(worldPoint) {
    const metrics = this.viewMetrics();
    const tolerance = 8 / (metrics?.scale || 1);
    const candidates = [...this.visibleObjects()].sort((first, second) => Number(second.closed) - Number(first.closed));
    let nearestItem = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const item of candidates) {
      const itemPaths = this.transformedPaths([item]);
      const itemBox = bounds(itemPaths);
      if (worldPoint.x >= itemBox.minX - tolerance && worldPoint.x <= itemBox.maxX + tolerance && worldPoint.y >= itemBox.minY - tolerance && worldPoint.y <= itemBox.maxY + tolerance) {
        for (const pathValue of itemPaths) {
          for (let index = 0; index < pathValue.points.length - 1; index += 1) {
            const first = pathValue.points[index];
            const second = pathValue.points[index + 1];
            const deltaX = second.x - first.x;
            const deltaY = second.y - first.y;
            const lengthSquared = deltaX ** 2 + deltaY ** 2;
            const ratio = lengthSquared ? Math.max(0, Math.min(1, ((worldPoint.x - first.x) * deltaX + (worldPoint.y - first.y) * deltaY) / lengthSquared)) : 0;
            const closestX = first.x + deltaX * ratio;
            const closestY = first.y + deltaY * ratio;
            const currentDistance = Math.hypot(worldPoint.x - closestX, worldPoint.y - closestY);
            if (currentDistance < nearestDistance) {
              nearestDistance = currentDistance;
              nearestItem = item;
            }
          }
        }
      }
    }
    return nearestDistance <= tolerance ? nearestItem : null;
  }

  startDrag(event) {
    if (this.measureMode) return;
    this.focus({ preventScroll: true });
    const metrics = this.viewMetrics();
    if (!metrics) return;
    const selected = this.objectAt(this.canvasWorldPoint(event, metrics));
    if (!selected) {
      this.panState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        panX: this.viewPan.x,
        panY: this.viewPan.y,
        scale: metrics.scale
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.classList.add('pan-dragging');
      return;
    }
    this.selectedId = selected.id;
    this.refreshObjectList();
    this.refreshTransformFields();
    this.dragState = {
      id: selected.id,
      pointerId: event.pointerId,
      start: this.canvasWorldPoint(event, metrics),
      x: selected.transform.x,
      y: selected.transform.y,
      metrics
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add('dragging');
  }

  drag(event) {
    if (this.panState && event.pointerId === this.panState.pointerId) {
      this.viewPan.x = this.panState.panX + (event.clientX - this.panState.startX) / this.panState.scale;
      this.viewPan.y = this.panState.panY - (event.clientY - this.panState.startY) / this.panState.scale;
      this.draw();
      return;
    }
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
    const item = this.objects.find(value => value.id === this.dragState.id);
    if (!item) return;
    const current = this.canvasWorldPoint(event, this.dragState.metrics);
    item.transform.x = this.dragState.x + current.x - this.dragState.start.x;
    item.transform.y = this.dragState.y + current.y - this.dragState.start.y;
    this.refreshTransformFields();
    this.draw();
    this.emit('layout-changed', this.getState());
  }

  endDrag(event) {
    if (this.panState && event.pointerId === this.panState.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      event.currentTarget.classList.remove('pan-dragging');
      this.panState = null;
      this.draw();
      return;
    }
    if (!this.dragState || event.pointerId !== this.dragState.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.classList.remove('dragging');
    this.dragState = null;
    this.draw();
  }

  draw() {
    if (!this.rendered) return;
    const canvas = this.shadowRoot.querySelector('[data-canvas]');
    const wrapper = canvas.parentElement;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, wrapper.clientWidth);
    const height = Math.max(1, wrapper.clientHeight);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    const currentMetrics = this.dragState?.metrics || this.viewMetrics();
    if (!currentMetrics) return;
    const { box, scale, offsetX, offsetY, sheetWidth, sheetHeight } = currentMetrics;
    const paths = this.dragState ? this.transformedPaths() : currentMetrics.paths;
    const toCanvas = value => ({
      x: offsetX + (value.x - box.minX) * scale,
      y: height - offsetY - (value.y - box.minY) * scale
    });
    const sheetTopLeft = toCanvas({ x: 0, y: sheetHeight });
    const sheetBottomRight = toCanvas({ x: sheetWidth, y: 0 });
    context.strokeStyle = '#9aa8b6';
    context.lineWidth = 1;
    context.setLineDash([5, 4]);
    context.strokeRect(sheetTopLeft.x, sheetTopLeft.y, sheetBottomRight.x - sheetTopLeft.x, sheetBottomRight.y - sheetTopLeft.y);
    context.setLineDash([]);
    context.strokeStyle = '#2463bd';
    context.lineWidth = 1.5;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    for (const pathValue of paths) {
      context.beginPath();
      pathValue.points.forEach((value, index) => {
        const x = offsetX + (value.x - box.minX) * scale;
        const y = height - offsetY - (value.y - box.minY) * scale;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    }
    if (this.measurement.first) {
      const first = toCanvas(this.measurement.first);
      const second = this.measurement.second ? toCanvas(this.measurement.second) : first;
      context.save();
      context.strokeStyle = '#d92d20';
      context.fillStyle = '#d92d20';
      context.lineWidth = 2;
      context.setLineDash([6, 4]);
      context.beginPath();
      context.moveTo(first.x, first.y);
      context.lineTo(second.x, second.y);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      context.arc(first.x, first.y, 4, 0, Math.PI * 2);
      context.fill();
      if (this.measurement.second) {
        context.beginPath();
        context.arc(second.x, second.y, 4, 0, Math.PI * 2);
        context.fill();
        const middleX = (first.x + second.x) / 2;
        const middleY = (first.y + second.y) / 2;
        context.font = '12px system-ui';
        context.fillText(`${(measureSegment(this.measurement.first, this.measurement.second) / UI_MM_PER_CM).toFixed(3)} cm`, middleX + 7, middleY - 7);
      }
      context.restore();
    }
    if (this.measureMode && this.measureSnap) {
      const snap = toCanvas(this.measureSnap.point);
      context.save();
      context.strokeStyle = '#07883d';
      context.fillStyle = '#07883d';
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(snap.x, snap.y, 6, 0, Math.PI * 2);
      context.stroke();
      context.beginPath();
      context.moveTo(snap.x - 9, snap.y);
      context.lineTo(snap.x + 9, snap.y);
      context.moveTo(snap.x, snap.y - 9);
      context.lineTo(snap.x, snap.y + 9);
      context.stroke();
      context.font = '11px system-ui';
      context.fillText(this.measureSnap.kind, snap.x + 9, snap.y - 9);
      context.restore();
    }
    context.fillStyle = '#617080';
    context.font = '11px system-ui';
    context.fillText(`版面 ${(sheetWidth / UI_MM_PER_CM).toFixed(2)} × ${(sheetHeight / UI_MM_PER_CM).toFixed(2)} cm`, 10, height - 10);
    this.drawSheetOverviewCanvases();
  }

  setStatus(message, isError = false) {
    const element = this.shadowRoot.querySelector('[data-status]');
    element.textContent = message;
    element.classList.toggle('error', isError);
  }

  publicObject(item) {
    const { sheetIndex = 0, ...layoutTransform } = item.transform;
    return {
      id: item.id,
      name: item.name,
      format: item.format,
      component: Boolean(item.component),
      closed: Boolean(item.closed),
      pathCount: item.paths.length,
      sheetIndex,
      transform: { ...layoutTransform, x: item.transform.x / UI_MM_PER_CM, y: item.transform.y / UI_MM_PER_CM },
      unit: 'cm'
    };
  }

  getState() {
    return { unit: 'cm', globalTransform: { ...this.globalTransform }, activeSheet: this.activeSheet, sheetCount: this.sheets.length, objects: this.objects.map(item => this.publicObject(item)) };
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }
}

customElements.define('vector-gcode-editor', VectorGcodeEditor);

export { VectorGcodeEditor };
