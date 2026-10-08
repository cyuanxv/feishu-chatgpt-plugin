import test from 'node:test';
import assert from 'node:assert/strict';
import { failureCategory } from './failure-category.mjs';

test('diagnostic failures expose only fixed categories even when messages contain synthetic private values', () => {
  const sentinel = 'synthetic-secret-code-cookie-url';
  const cases = [
    [new Error('Protocol error (Browser.getBrowserCommandLine): ' + sentinel), 'protocol_error'],
    [Object.assign(new Error(sentinel), { name: 'TimeoutError' }), 'timeout'],
    [new Error('Target page, context or browser has been closed ' + sentinel), 'browser_closed'],
    [new Error('Operation not permitted ' + sentinel), 'sandbox_environment'],
    [Object.assign(new Error(sentinel), { code: 'ERR_ASSERTION' }), 'assertion_failed'],
    [new TypeError(sentinel), 'type_error'],
    [new Error(sentinel), 'unclassified_error'],
    [null, 'unclassified_error'],
  ];
  for (const [input, expected] of cases) {
    const result = failureCategory(input);
    assert.equal(result, expected);
    assert(!JSON.stringify(result).includes(sentinel));
  }
});
