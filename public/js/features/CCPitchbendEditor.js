/**
 * CCPitchbendEditor - Control Change and Pitchbend editor synchronized with the piano roll
 *
 * Features:
 * - Edit CC1, CC2, CC5, CC7, CC10, CC11, CC74, CC77, pitchbend
 * - Tools: select, move, line, continuous draw
 * - Horizontal synchronization with the piano roll
 * - Honors the time grid and zoom
 * - Filter by selected channel
 *
 * Extends BaseLaneEditor — shared scaffolding (constructor, listeners,
 * RAF, history, conversions, destroy) lives there; this file owns the
 * CC/pitchbend-specific data ops, hit-test, value clamping (different
 * for CC vs PB), staircase rendering, line preview with curves and the
 * cursor tooltip overlay.
 *
 * Public surface preserved for the MidiEditor consumers:
 *   - constructor(container, options)
 *   - setCC, setChannel, setNote, setCurveType, setDrawDensity, setTool
 *   - loadEvents, getEvents, clear, syncWith
 *   - selectedEvents (alias of base selectedIds)
 *   - events (read AND direct mutation in MidiEditorEditActions:287)
 *   - deleteSelected, resize, destroy, element, renderThrottled
 */

class CCPitchbendEditor extends BaseLaneEditor {
  constructor(container, options = {}) {
    super(container, options);

    this.events = [];

    this.currentCC = 'cc1'; // 'cc1'..'cc77', 'pitchbend', 'aftertouch', 'polyAftertouch'
    this.currentNote = null; // For poly aftertouch
    this.drawDensityMultiplier = 1;

    // Pixel cache for selection-rect preview (same pattern as
    // Velocity — selectionStart + last mouse pos).
    this.lastMouseX = undefined;
    this.lastMouseY = undefined;
    this.selectionStart = null;

    this.init();

    // The base's createUI() adds canvas + element. We need to layer
    // the tooltip overlay on top, in the same parent.
    this._installTooltip();

    // Sub-feature: Canvas paint pipeline (audit §1.3).
    this.renderer =
      typeof CCPitchbendEditorRenderer !== 'undefined' ? new CCPitchbendEditorRenderer(this) : null;
    // Sub-feature: mouse + keyboard interactions (audit §1.3).
    this.interactions =
      typeof CCPitchbendEditorInteractions !== 'undefined'
        ? new CCPitchbendEditorInteractions(this)
        : null;
  }

  // -----------------------------------------------------------------
  // Back-compat alias
  // -----------------------------------------------------------------
  get selectedEvents() {
    return this.selectedIds;
  }

  // =================================================================
  // BaseLaneEditor hooks
  // =================================================================

  _className() {
    return 'cc-pitchbend-editor';
  }
  _dataField() {
    return 'events';
  }
  _idOf(item) {
    return item ? item.id : undefined;
  }

  _valueToY(value) {
    const margin = 6;
    const drawH = this.canvas.height - margin * 2;
    const normalized = this.currentCC === 'pitchbend' ? (value + 8192) / 16384 : value / 127;
    return margin + drawH - normalized * drawH;
  }

  _yToValue(y) {
    const margin = 6;
    const drawH = this.canvas.height - margin * 2;
    const normalized = 1 - (y - margin) / drawH;
    if (this.currentCC === 'pitchbend') {
      return Math.max(-8192, Math.min(8191, Math.round(normalized * 16384 - 8192)));
    }
    return Math.max(0, Math.min(127, Math.round(normalized * 127)));
  }

  _installTooltip() {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'cc-editor-tooltip';
    this.tooltip.style.cssText = `
            position: absolute;
            background: rgba(0,0,0,0.85);
            color: #fff;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-family: monospace;
            pointer-events: none;
            display: none;
            z-index: 10;
            white-space: nowrap;
        `;
    // Layer it inside the editor element (same parent as the canvas).
    if (this.element) this.element.appendChild(this.tooltip);
  }

  cancelInteractions() {
    super.cancelInteractions();
    this.selectionStart = null;
    this.lastMouseX = undefined;
    this.lastMouseY = undefined;
  }

  // =================================================================
  // Filter setters
  // =================================================================

  setCC(ccType) {
    this.currentCC = ccType;
    this.cancelInteractions();
    this.gridDirty = true; // Value-axis labels differ CC vs PB.
    this.renderThrottled();
  }

  setChannel(channel) {
    this.currentChannel = channel;
    this.cancelInteractions();
    this.renderThrottled();
  }

  setNote(note) {
    this.currentNote = note;
    this.cancelInteractions();
    this.renderThrottled();
  }

  setDrawDensity(multiplier) {
    this.drawDensityMultiplier = multiplier;
  }

  // =================================================================
  // Value clamping (depends on currentCC)
  // =================================================================

  clampValue(value) {
    return this.currentCC === 'pitchbend'
      ? Math.max(-8192, Math.min(8191, value))
      : Math.max(0, Math.min(127, value));
  }

  // =================================================================
  // Event mutations
  // =================================================================

  addEvent(ticks, value, channel = this.currentChannel, autoSave = true) {
    const snappedTicks = this.snapToGrid(ticks);
    const existing = this.events.find(
      (e) => e.ticks === snappedTicks && e.type === this.currentCC && e.channel === channel
    );
    if (existing) {
      existing.value = this.clampValue(value);
      if (autoSave) this.renderThrottled();
      return existing;
    }

    const event = {
      type: this.currentCC,
      ticks: snappedTicks,
      value: this.clampValue(value),
      channel: channel,
      id: Date.now() + Math.random()
    };
    if (this.currentCC === 'polyAftertouch' && this.currentNote !== null) {
      event.note = this.currentNote;
    }
    this.events.push(event);

    if (autoSave) {
      this.saveState();
      this.renderThrottled();
    }
    return event;
  }

  removeEvents(eventIds) {
    this.events = this.events.filter((e) => !eventIds.includes(e.id));
    this.selectedIds.clear();
    this.saveState();
    this.renderThrottled();
  }

  moveEvents(eventIds, deltaTicks, deltaValue) {
    eventIds.forEach((id) => {
      const event = this.events.find((e) => e.id === id);
      if (event) {
        event.ticks = Math.max(0, this.snapToGrid(event.ticks + deltaTicks));
        event.value = this.clampValue(event.value + deltaValue);
      }
    });
    this.saveState();
    this.renderThrottled();
  }

  deleteSelected() {
    if (this.selectedIds.size === 0) return;
    this.events = this.events.filter((event) => !this.selectedIds.has(event.id));
    this.selectedIds.clear();
    this.saveState();
    if (typeof this.options.onChange === 'function') {
      try {
        this.options.onChange();
      } catch (_) {
        /* best-effort */
      }
    }
    this.renderThrottled();
  }

  // =================================================================
  // Filtering
  // =================================================================

  getFilteredEvents() {
    return this.events.filter((event) => {
      if (event.type !== this.currentCC || event.channel !== this.currentChannel) return false;
      if (this.currentCC === 'polyAftertouch' && this.currentNote !== null) {
        return event.note === this.currentNote;
      }
      return true;
    });
  }

  _getVisibleData() {
    return this.getFilteredEvents();
  }

  // =================================================================
  // Hit-test
  // =================================================================

  getEventAtPosition(x, y, threshold = 5) {
    return this.getFilteredEvents().find((event) => {
      const ex = this.ticksToX(event.ticks);
      const ey = this._valueToY(event.value);
      return Math.abs(ex - x) <= threshold && Math.abs(ey - y) <= threshold;
    });
  }

  selectInRect(x1, y1, x2, y2) {
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const top = Math.min(y1, y2);
    const bottom = Math.max(y1, y2);
    this.getFilteredEvents().forEach((event) => {
      const ex = this.ticksToX(event.ticks);
      const ey = this._valueToY(event.value);
      if (ex >= left && ex <= right && ey >= top && ey <= bottom) {
        this.selectedIds.add(event.id);
      }
    });
  }

  selectAll() {
    this.selectedIds.clear();
    this.getFilteredEvents().forEach((event) => this.selectedIds.add(event.id));
    this.renderThrottled();
  }

  // =================================================================
  // Tool handlers
  // =================================================================

  // Delegates to interactions sub-feature (extracted per audit §1.3)
  handleMouseDown(e) {
    return this.interactions?.handleMouseDown(e);
  }
  handleMouseMove(e) {
    return this.interactions?.handleMouseMove(e);
  }
  handleMouseUp(e) {
    return this.interactions?.handleMouseUp(e);
  }
  handleMouseLeave(e) {
    return this.interactions?.handleMouseLeave(e);
  }
  handleKeyDown(e) {
    return this.interactions?.handleKeyDown(e);
  }

  updateTooltip(x, y, ticks, value) {
    if (!this.tooltip) return;
    let valueStr;
    switch (this.currentCC) {
      case 'pitchbend':
        valueStr = `PB: ${value}`;
        break;
      case 'aftertouch':
        valueStr = `AT: ${value}`;
        break;
      case 'polyAftertouch':
        valueStr = `PAT: ${value}`;
        break;
      default:
        valueStr = `Val: ${value}`;
    }
    const ppq = this.options.timebase || 480;
    const beat = Math.floor(ticks / ppq);
    const measure = Math.floor(beat / 4) + 1;
    const beatInMeasure = (beat % 4) + 1;
    const tickInBeat = ticks % ppq;
    const timeStr = `${measure}:${beatInMeasure}:${String(tickInBeat).padStart(3, '0')}`;

    this.tooltip.textContent = `${timeStr}  ${valueStr}`;
    this.tooltip.style.display = 'block';
    this.tooltip.style.left = `${x + 12}px`;
    this.tooltip.style.top = `${y - 24}px`;
  }

  // =================================================================
  // Line creation with curves
  // =================================================================

  createLine(startTicks, startValue, endTicks, endValue) {
    const minTicks = Math.min(startTicks, endTicks);
    const maxTicks = Math.max(startTicks, endTicks);
    const ticksRange = maxTicks - minTicks;
    const valueRange = endValue - startValue;

    for (let t = minTicks; t <= maxTicks; t += this.options.grid) {
      const progress = ticksRange > 0 ? (t - minTicks) / ticksRange : 0;
      const curveProgress = this.applyCurve(progress);
      const value = Math.round(startValue + valueRange * curveProgress);
      this.addEvent(t, value, this.currentChannel, false);
    }

    const lastGridTick =
      Math.floor((maxTicks - minTicks) / this.options.grid) * this.options.grid + minTicks;
    if (lastGridTick < maxTicks) {
      this.addEvent(
        maxTicks,
        Math.round(startValue + valueRange * (ticksRange > 0 ? 1 : 0)),
        this.currentChannel,
        false
      );
    }

    this.saveState();
    this.renderThrottled();
  }

  // =================================================================
  // Sync
  // =================================================================

  syncWith(pianoRoll) {
    const oldXRange = this.options.xrange;
    const oldXOffset = this.options.xoffset;
    const oldGrid = this.options.grid;

    this.options.xrange = pianoRoll.xrange;
    this.options.xoffset = pianoRoll.xoffset;
    this.options.grid = pianoRoll.grid;
    this.options.timebase = pianoRoll.timebase;

    if (
      oldXRange !== this.options.xrange ||
      oldXOffset !== this.options.xoffset ||
      oldGrid !== this.options.grid
    ) {
      this.gridDirty = true;
    }
    this.renderThrottled();
  }

  // =================================================================
  // Import / Export
  // =================================================================

  loadEvents(events) {
    this.events = events.map((e) => ({
      ...e,
      id: e.id || Date.now() + Math.random()
    }));
    // Initialize history without triggering onChange (loading existing
    // events is not a user modification).
    this.history = [this._snapshotData()];
    this.historyIndex = 0;
    this.renderThrottled();
  }

  getEvents() {
    return this.events;
  }

  clear() {
    this.events = [];
    this.selectedIds.clear();
    this.history = [this._snapshotData()];
    this.historyIndex = 0;
    this.renderThrottled();
    if (typeof this.options.onChange === 'function') {
      try {
        this.options.onChange();
      } catch (_) {
        /* best-effort */
      }
    }
  }

  // =================================================================
  // Render — overrides base.render() to add the staircase rendering,
  // center line, selection rect (selectionStart + lastMouseX/Y), and
  // line preview with curve interpolation.
  // =================================================================

  // Delegates to renderer sub-feature (extracted per audit §1.3)
  render() {
    return this.renderer?.render();
  }
  _renderCenterLine() {
    return this.renderer?.renderCenterLine();
  }
  _renderGridToBuffer() {
    return this.renderer?.renderGridToBuffer();
  }
  _renderData() {
    return this.renderer?.renderData();
  }

  // The legacy notifyChange contract (CC's `_doSaveState` used to emit
  // `onChange()` with NO args; preserve that for back-compat).
  notifyChange() {
    if (typeof this.options.onChange === 'function') {
      try {
        this.options.onChange();
      } catch (_) {
        /* best-effort */
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.CCPitchbendEditor = CCPitchbendEditor;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CCPitchbendEditor;
}
