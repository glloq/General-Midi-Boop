/**
 * @file tests/e2e/lib/runner.mjs
 * @description A ~150-line test runner, deliberately dependency-free.
 *
 * Why not `@playwright/test`? Because the harness must run from a checkout
 * that has no Playwright in `node_modules` (see `lib/playwright.mjs`), and
 * because an audit harness benefits from being able to record a **step-by-step
 * ledger** (`step()` / `evidence()`) rather than only pass/fail: a scenario
 * that dies at step 6 of 10 should still report which five steps passed.
 *
 * API:
 *   suite('name', fn)        - group
 *   test('name', fn)         - a case; `fn` receives a {@link TestContext}
 *   ctx.step(label, fn)      - a recorded sub-step; failure fails the test but
 *                              the ledger keeps every previous step's result
 *   ctx.evidence(label, val) - attach a value to the report
 *   expect(actual)           - .toBe / .toEqual / .toBeTruthy / .toContain /
 *                              .toBeGreaterThan / .toBeLessThan / .toMatch
 */

/** @typedef {{name:string, status:'PASS'|'FAIL'|'SKIP', ms:number, error?:string, steps:Array, evidence:Array}} TestResult */

const suites = [];
let current = null;

/**
 * Declare a suite.
 * @param {string} name
 * @param {(...a:any)=>any} fn
 */
export function suite(name, fn) {
  const s = { name, tests: [], before: null, after: null };
  suites.push(s);
  const prev = current;
  current = s;
  fn();
  current = prev;
}

/**
 * Declare a test case.
 * @param {string} name
 * @param {(ctx: TestContext)=>Promise<any>} fn
 * @param {{skip?:boolean|string, timeoutMs?:number}} [opts]
 */
export function test(name, fn, opts = {}) {
  if (!current) throw new Error('test() must be called inside suite()');
  current.tests.push({ name, fn, opts });
}

/** Hook run once before the suite's tests. @param {Function} fn */
export function before(fn) {
  if (current) current.before = fn;
}

/** Hook run once after the suite's tests. @param {Function} fn */
export function after(fn) {
  if (current) current.after = fn;
}

/** Per-test recording context handed to each test function. */
export class TestContext {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    /** @type {Array<{label:string,status:string,ms:number,error?:string,note?:string}>} */
    this.steps = [];
    /** @type {Array<{label:string,value:any}>} */
    this.evidence = [];
    /** Free-form bag shared between steps of the same test. */
    this.state = {};
  }

  /**
   * Run and record a named step. Rethrows so the test fails, but the ledger
   * keeps the step marked FAIL with its message — that is what turns a broken
   * scenario into a precise finding instead of a red blob.
   *
   * @template T
   * @param {string} label
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  async step(label, fn) {
    const t0 = Date.now();
    try {
      const out = await fn();
      this.steps.push({ label, status: 'PASS', ms: Date.now() - t0 });
      return out;
    } catch (err) {
      this.steps.push({
        label,
        status: 'FAIL',
        ms: Date.now() - t0,
        error: err && err.message ? err.message : String(err)
      });
      throw err;
    }
  }

  /**
   * Record a step that is expected to be informative rather than blocking:
   * a failure is captured as WARN and does NOT fail the test.
   * @param {string} label
   * @param {() => Promise<any>|any} fn
   */
  async softStep(label, fn) {
    const t0 = Date.now();
    try {
      const out = await fn();
      this.steps.push({ label, status: 'PASS', ms: Date.now() - t0 });
      return out;
    } catch (err) {
      this.steps.push({
        label,
        status: 'WARN',
        ms: Date.now() - t0,
        error: err && err.message ? err.message : String(err)
      });
      return null;
    }
  }

  /**
   * Attach evidence (a measurement, a dump, a screenshot path) to the report.
   * @param {string} label
   * @param {any} value
   */
  evidenceAdd(label, value) {
    this.evidence.push({ label, value });
  }
}

/** Minimal assertion helper. @param {any} actual */
export function expect(actual) {
  const fail = (msg) => {
    throw new Error(msg);
  };
  return {
    toBe(exp) {
      if (actual !== exp) fail(`expected ${JSON.stringify(exp)}, got ${JSON.stringify(actual)}`);
    },
    toEqual(exp) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(exp);
      if (a !== b) fail(`expected ${b}, got ${a}`);
    },
    toBeTruthy(hint) {
      if (!actual)
        fail(`expected truthy${hint ? ` (${hint})` : ''}, got ${JSON.stringify(actual)}`);
    },
    toBeFalsy(hint) {
      if (actual) fail(`expected falsy${hint ? ` (${hint})` : ''}, got ${JSON.stringify(actual)}`);
    },
    toContain(sub) {
      const ok = Array.isArray(actual) ? actual.includes(sub) : String(actual).includes(sub);
      if (!ok)
        fail(`expected ${JSON.stringify(actual).slice(0, 300)} to contain ${JSON.stringify(sub)}`);
    },
    toBeGreaterThan(n) {
      if (!(actual > n)) fail(`expected ${actual} > ${n}`);
    },
    toBeLessThan(n) {
      if (!(actual < n)) fail(`expected ${actual} < ${n}`);
    },
    toMatch(re) {
      if (!re.test(String(actual)))
        fail(`expected ${JSON.stringify(String(actual)).slice(0, 300)} to match ${re}`);
    }
  };
}

/**
 * Execute every declared suite.
 *
 * @param {Object} deps - passed verbatim to before/after hooks and tests.
 * @param {(line:string)=>void} [log]
 * @returns {Promise<{results: TestResult[], failed: number, passed: number}>}
 */
export async function run(deps, log = (l) => process.stdout.write(l + '\n')) {
  /** @type {TestResult[]} */
  const results = [];
  for (const s of suites) {
    log(`\n▶ ${s.name}`);
    if (s.before) await s.before(deps);
    for (const t of s.tests) {
      if (t.opts.skip) {
        log(`  ○ SKIP  ${t.name} — ${typeof t.opts.skip === 'string' ? t.opts.skip : ''}`);
        results.push({
          suite: s.name,
          name: t.name,
          status: 'SKIP',
          ms: 0,
          steps: [],
          evidence: []
        });
        continue;
      }
      const ctx = new TestContext(t.name);
      const t0 = Date.now();
      let status = 'PASS';
      let error;
      try {
        await withTimeout(t.fn(ctx, deps), t.opts.timeoutMs ?? 180000, t.name);
      } catch (err) {
        status = 'FAIL';
        error = err && err.stack ? err.stack : String(err);
      }
      const ms = Date.now() - t0;
      results.push({
        suite: s.name,
        name: t.name,
        status,
        ms,
        error,
        steps: ctx.steps,
        evidence: ctx.evidence
      });
      log(`  ${status === 'PASS' ? '✔' : '✘'} ${status}  ${t.name}  (${ms}ms)`);
      for (const st of ctx.steps) {
        const mark = st.status === 'PASS' ? '·' : st.status === 'WARN' ? '!' : '✘';
        log(`      ${mark} ${st.label}${st.error ? ` — ${st.error.split('\n')[0]}` : ''}`);
      }
      if (error) log(`      ↳ ${error.split('\n').slice(0, 4).join('\n        ')}`);
    }
    if (s.after) await s.after(deps);
  }
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  return { results, failed, passed };
}

/** @param {Promise<any>} p @param {number} ms @param {string} label */
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`test timed out after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

/** Reset registry (used by run.mjs between spec files if ever needed). */
export function reset() {
  suites.length = 0;
}
