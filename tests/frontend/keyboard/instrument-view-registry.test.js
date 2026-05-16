// tests/frontend/keyboard/instrument-view-registry.test.js
// Unit tests for InstrumentView base class + InstrumentViewRegistry.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const win = {};
function load(relativePath) {
  const src = readFileSync(resolve(__dirname, relativePath), 'utf8');
  new Function('window', src)(win);
}

beforeAll(() => {
  load('../../../public/js/features/keyboard/InstrumentView.js');
  load('../../../public/js/features/keyboard/InstrumentViewRegistry.js');
});

const InstrumentView = () => win.InstrumentView;
const Registry = () => win.InstrumentViewRegistry;
const registry = () => win.instrumentViews;

describe('InstrumentView — abstract base', () => {
  it('is exposed on window', () => {
    expect(typeof InstrumentView()).toBe('function');
  });

  it('has static defaults', () => {
    expect(InstrumentView().viewKind).toBe('abstract');
    expect(typeof InstrumentView().emoji).toBe('string');
  });

  it('mount sets ctx and mounted, throws on double-mount', () => {
    const v = new (InstrumentView())();
    expect(v.mounted).toBe(false);
    v.mount({ host: null, state: {}, backend: {}, eventBus: {}, i18n: { t: x => x }, capabilities: {}, options: {} });
    expect(v.mounted).toBe(true);
    let err = null;
    try { v.mount({}); } catch (e) { err = e; }
    expect(err).not.toBe(null);
  });

  it('unmount clears ctx and is idempotent', () => {
    const v = new (InstrumentView())();
    v.mount({});
    v.unmount();
    expect(v.mounted).toBe(false);
    v.unmount(); // should not throw
    expect(v.mounted).toBe(false);
  });

  it('willPlayNote returns the input unchanged by default', () => {
    const v = new (InstrumentView())();
    const r = v.willPlayNote(60, 80, { foo: 'bar' });
    expect(r).toEqual({ midi: 60, velocity: 80, opts: { foo: 'bar' } });
  });

  it('toolbarGroups is no longer part of the view contract', () => {
    const v = new (InstrumentView())();
    expect(typeof v.toolbarGroups).toBe('undefined');
  });

  it('_t falls back when no translation is available', () => {
    const v = new (InstrumentView())();
    v.mount({ i18n: { t: (k) => k } });   // i18n echoes the key → miss
    expect(v._t('some.key', 'Fallback')).toBe('Fallback');
    v.unmount();
    expect(v._t('some.key', 'Fallback')).toBe('Fallback'); // no ctx → fallback
  });
});

describe('InstrumentViewRegistry — register / get', () => {
  it('singleton instance exposed as window.instrumentViews', () => {
    expect(typeof registry()).toBe('object');
    expect(typeof registry().register).toBe('function');
  });

  it('register requires a viewKind', () => {
    const r = new (Registry())();
    let err = null;
    try { r.register(class Foo {}); } catch (e) { err = e; }
    expect(err).not.toBe(null);
  });

  it('rejects "abstract" viewKind', () => {
    const r = new (Registry())();
    class Abs { static viewKind = 'abstract'; }
    let err = null;
    try { r.register(Abs); } catch (e) { err = e; }
    expect(err).not.toBe(null);
  });

  it('get returns the registered class', () => {
    const r = new (Registry())();
    class MyView { static viewKind = 'mock'; }
    r.register(MyView);
    expect(r.get('mock')).toBe(MyView);
    expect(r.kinds()).toContain('mock');
  });
});

describe('InstrumentViewRegistry — rules & resolve', () => {
  it('first matching rule wins', () => {
    const r = new (Registry())();
    class A { static viewKind = 'a'; }
    class B { static viewKind = 'b'; }
    r.register(A).register(B);
    r.addRule(c => c.x === 1, 'a')
     .addRule(c => c.x === 1, 'b'); // never reached
    expect(r.resolve({ x: 1 }).viewKind).toBe('a');
  });

  it('falls back when no rule matches', () => {
    const r = new (Registry())();
    class P { static viewKind = 'piano'; }
    class O { static viewKind = 'other'; }
    r.register(P).register(O);
    r.addRule(c => c.x === 999, 'other');
    expect(r.resolve({ x: 1 }).viewKind).toBe('piano');
    expect(r.resolve({ x: 1 }).ViewClass).toBe(P);
  });

  it('falls back with custom default', () => {
    const r = new (Registry())();
    class O { static viewKind = 'other'; }
    r.register(O);
    expect(r.resolve({}, 'other').ViewClass).toBe(O);
  });

  it('options propagate through resolve', () => {
    const r = new (Registry())();
    class W { static viewKind = 'wind'; }
    r.register(W);
    r.addRule(c => c.gm === 65, 'wind', { breath: true });
    expect(r.resolve({ gm: 65 }).options.breath).toBe(true);
  });

  it('resolveByKind looks up directly without running predicates', () => {
    const r = new (Registry())();
    class X { static viewKind = 'x'; }
    r.register(X);
    expect(r.resolveByKind('x').ViewClass).toBe(X);
    expect(r.resolveByKind('x', { foo: 1 }).options.foo).toBe(1);
  });

  it('addRule requires function predicate + viewKind', () => {
    const r = new (Registry())();
    let err1 = null, err2 = null;
    try { r.addRule(null, 'piano'); } catch (e) { err1 = e; }
    try { r.addRule(() => true, ''); } catch (e) { err2 = e; }
    expect(err1).not.toBe(null);
    expect(err2).not.toBe(null);
  });

  it('reset clears classes + rules', () => {
    const r = new (Registry())();
    class Y { static viewKind = 'y'; }
    r.register(Y);
    r.addRule(() => true, 'y');
    r.reset();
    expect(r.kinds()).toHaveLength(0);
  });
});
