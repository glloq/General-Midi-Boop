/**
 * CCPitchbendEditorInteractions — mouse + keyboard interaction state machine
 * for CCPitchbendEditor. Extracted per audit §1.3 (god-class split).
 *
 * Owns:
 *   - `handleMouseDown(e)` — dispatches to draw/move/line/select tools.
 *   - `handleMouseMove(e)` — drag handling, tooltip update, draw-density gating.
 *   - `handleMouseUp(e)` — close out draw/move/line/select interactions.
 *   - `handleMouseLeave(e)` — hide tooltip + cancel draw.
 *   - `handleKeyDown(e)` — Ctrl+A / Ctrl+Z / Ctrl+Y / Delete shortcuts.
 *
 * Accessed via `ccPitchbendEditor.interactions`. CCPitchbendEditor keeps
 * thin delegates so external callers (BaseLaneEditor event wiring) are
 * unchanged.
 */
class CCPitchbendEditorInteractions {
  /** @param {CCPitchbendEditor} parent */
  constructor(parent) {
    this.parent = parent;
  }

  handleMouseDown(e) {
    const rect = this.parent.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ticks = this.parent.xToTicks(x);
    const value = this.parent._yToValue(y);

    switch (this.parent.currentTool) {
      case 'draw':
        this.parent.isDrawing = true;
        this.parent.lastDrawPosition = { x, y };
        this.parent.lastDrawTicks = this.parent.snapToGrid(ticks);
        this.parent.addEvent(ticks, value, this.parent.currentChannel, false);
        this.parent.renderThrottled();
        break;

      case 'line':
        if (!this.parent.lineStart) {
          this.parent.lineStart = { ticks, value };
        } else {
          this.parent.createLine(
            this.parent.lineStart.ticks,
            this.parent.lineStart.value,
            ticks,
            value
          );
          this.parent.lineStart = null;
        }
        break;

      case 'select': {
        const clicked = this.parent.getEventAtPosition(x, y);
        if (clicked) {
          if (e.shiftKey) {
            if (this.parent.selectedIds.has(clicked.id)) this.parent.selectedIds.delete(clicked.id);
            else this.parent.selectedIds.add(clicked.id);
          } else {
            this.parent.selectedIds.clear();
            this.parent.selectedIds.add(clicked.id);
          }
          this.parent.dragStart = { x, y, ticks, value };
        } else {
          if (!e.shiftKey) this.parent.selectedIds.clear();
          this.parent.selectionStart = { x, y };
        }
        this.parent.renderThrottled();
        break;
      }

      case 'move': {
        const moveEvent = this.parent.getEventAtPosition(x, y);
        if (moveEvent) {
          if (!this.parent.selectedIds.has(moveEvent.id)) {
            this.parent.selectedIds.clear();
            this.parent.selectedIds.add(moveEvent.id);
          }
          this.parent.dragStart = { x, y, ticks, value };
        }
        this.parent.renderThrottled();
        break;
      }
    }
  }

  handleMouseMove(e) {
    const rect = this.parent.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ticks = this.parent.xToTicks(x);
    const value = this.parent._yToValue(y);

    this.parent.lastMouseX = x;
    this.parent.lastMouseY = y;

    if (this.parent.isDrawing && this.parent.currentTool === 'draw') {
      const snappedTicks = this.parent.snapToGrid(ticks);
      const advanced =
        this.parent.lastDrawTicks === null ||
        Math.abs(snappedTicks - this.parent.lastDrawTicks) >=
          this.parent.options.grid * this.parent.drawDensityMultiplier;
      if (advanced) {
        this.parent.addEvent(ticks, value, this.parent.currentChannel, false);
        this.parent.lastDrawTicks = snappedTicks;
        this.parent.lastDrawPosition = { x, y };
        this.parent.renderThrottled();
      }
    } else if (
      this.parent.dragStart &&
      (this.parent.currentTool === 'select' || this.parent.currentTool === 'move')
    ) {
      if (this.parent.selectedIds.size > 0) {
        const deltaTicks = this.parent.xToTicks(x) - this.parent.dragStart.ticks;
        const deltaValue = this.parent._yToValue(y) - this.parent.dragStart.value;
        Array.from(this.parent.selectedIds).forEach((id) => {
          const event = this.parent.events.find((ev) => ev.id === id);
          if (event) {
            event.ticks = Math.max(0, this.parent.snapToGrid(event.ticks + deltaTicks));
            event.value = this.parent.clampValue(event.value + deltaValue);
          }
        });
        this.parent.dragStart = { x, y, ticks, value };
        this.parent.renderThrottled();
      }
    } else if (this.parent.selectionStart || this.parent.lineStart) {
      this.parent.renderThrottled();
    }

    this.parent.updateTooltip(x, y, ticks, value);
  }

  handleMouseUp(e) {
    if (this.parent.isDrawing) {
      this.parent.isDrawing = false;
      this.parent.lastDrawPosition = null;
      this.parent.lastDrawTicks = null;
      this.parent.saveState();
    }
    if (this.parent.selectionStart) {
      const rect = this.parent.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.parent.selectInRect(this.parent.selectionStart.x, this.parent.selectionStart.y, x, y);
      this.parent.selectionStart = null;
    }
    if (this.parent.dragStart) {
      this.parent.saveState();
      this.parent.dragStart = null;
    }
    this.parent.renderThrottled();
  }

  handleMouseLeave(e) {
    this.handleMouseUp(e);
    if (this.parent.tooltip) this.parent.tooltip.style.display = 'none';
  }

  handleKeyDown(e) {
    if (!this.parent.element || this.parent.element.offsetParent === null) return;

    if ((e.key === 'Delete' || e.key === 'Backspace') && this.parent.selectedIds.size > 0) {
      this.parent.removeEvents(Array.from(this.parent.selectedIds));
    } else if (e.key === 'Escape') {
      this.parent.selectedIds.clear();
      this.parent.lineStart = null;
      this.parent.renderThrottled();
    } else if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') {
        this.parent.undo();
        e.preventDefault();
      } else if (e.key === 'y' || (e.shiftKey && e.key === 'Z')) {
        this.parent.redo();
        e.preventDefault();
      } else if (e.key === 'a') {
        this.parent.selectAll();
        e.preventDefault();
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.CCPitchbendEditorInteractions = CCPitchbendEditorInteractions;
}
