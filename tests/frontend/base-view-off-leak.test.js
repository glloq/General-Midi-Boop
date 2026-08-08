// tests/frontend/base-view-off-leak.test.js
//
// Audit C minor: BaseView.off() removed the listener from the EventBus but left
// its unsub closure in eventSubscriptions, so repeated on()/off() cycles in a
// long-lived view accumulated dead closures (which destroy() later invoked as
// no-ops). off() now drops the matching tracked subscription too.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(resolve(__dirname, '../../public/js/core/BaseView.js'), 'utf8');
new Function(source)();
const BaseView = /** @type {any} */ (globalThis.window.BaseView);

// Minimal EventBus stub that tracks live listeners per event.
function makeBus() {
  const listeners = new Map();
  const bus = {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return () => bus.off(event, cb);
    },
    off(event, cb) {
      const arr = listeners.get(event);
      if (!arr) return;
      const i = arr.indexOf(cb);
      if (i !== -1) arr.splice(i, 1);
    },
    once: () => () => {},
    emit: () => {},
    count: (event) => (listeners.get(event) || []).length
  };
  return bus;
}

describe('BaseView.off() subscription hygiene (audit C)', () => {
  let bus;
  let view;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    document.body.innerHTML = '<div id="c"></div>';
    bus = makeBus();
    view = new BaseView('c', bus);
  });

  it('off() removes the listener from the bus AND the tracked subscription', () => {
    const h = () => {};
    view.on('evt', h);
    expect(view.eventSubscriptions).toHaveLength(1);
    expect(bus.count('evt')).toBe(1);

    view.off('evt', h);
    expect(bus.count('evt')).toBe(0);
    expect(view.eventSubscriptions).toHaveLength(0);
  });

  it('repeated on/off cycles do not grow eventSubscriptions', () => {
    const h = () => {};
    for (let i = 0; i < 20; i++) {
      view.on('evt', h);
      view.off('evt', h);
    }
    expect(view.eventSubscriptions).toHaveLength(0);
    expect(bus.count('evt')).toBe(0);
  });

  it('off() drops only the matching subscription, leaving others intact', () => {
    const a = () => {};
    const b = () => {};
    view.on('evt', a);
    view.on('other', b);
    view.off('evt', a);
    expect(view.eventSubscriptions).toHaveLength(1);
    expect(bus.count('evt')).toBe(0);
    expect(bus.count('other')).toBe(1);
  });
});
