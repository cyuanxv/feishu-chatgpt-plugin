import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { chromium } from 'playwright-core';
import { startFixture } from './fixture.mjs';
import { failureCategory } from './failure-category.mjs';

const output = new URL('./evidence/', import.meta.url);
const fixture = await startFixture();
let browser;
let stage = 'sandboxed-browser-launch';
const checks = [];
const summary = { synthetic_only: true, chromium_sandbox: true, provider_calls: 0, passed: false, checks };
const watchdog = setTimeout(() => { process.exitCode = 1; void browser?.close(); void fixture.close(); }, 90000);

function check(name, condition) {
  checks.push({ name, passed: Boolean(condition) });
  assert.ok(condition, name);
}

try {
  const executablePath = process.env.SYNTHETIC_CHROMIUM_PATH || '/usr/bin/google-chrome';
  await access(executablePath, constants.X_OK);
  browser = await chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: true,
    // CDP Browser.getBrowserCommandLine requires this flag; Playwright 1.62
    // no longer includes it in its default Chromium arguments.
    args: ['--enable-automation'],
    timeout: 20000,
    // Never inherit account tokens, proxies, browser profiles, or provider config.
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  summary.browser_version = browser.version();
  stage = 'sandbox-create-cdp-session';
  const session = await browser.newBrowserCDPSession();
  stage = 'sandbox-read-browser-command-line';
  const command = await session.send('Browser.getBrowserCommandLine');
  stage = 'sandbox-validate-browser-command-line';
  check('browser-command-line-is-string-array', Array.isArray(command.arguments) && command.arguments.every(argument => typeof argument === 'string'));
  check('browser-command-enables-automation', command.arguments.includes('--enable-automation'));
  const sandboxDisablers = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-namespace-sandbox', '--disable-seccomp-filter-sandbox'];
  check('browser-command-has-no-sandbox-disablers', !command.arguments.some(argument => sandboxDisablers.some(flag => argument === flag || argument.startsWith(flag + '='))));
  stage = 'sandbox-detach-cdp-session';
  await session.detach();
  stage = 'sandbox-create-report-page';
  const sandboxPage = await browser.newPage();
  stage = 'sandbox-navigate-report-page';
  await sandboxPage.goto('chrome://sandbox', { timeout: 5000 });
  stage = 'sandbox-read-report-page';
  const sandboxText = await sandboxPage.locator('body').innerText();
  stage = 'sandbox-assert-active-seccomp';
  summary.seccomp_bpf_active = /Seccomp-BPF sandbox\s+Yes/i.test(sandboxText);
  check('browser-reports-active-seccomp-sandbox', summary.seccomp_bpf_active);
  stage = 'sandbox-close-report-page';
  await sandboxPage.close();
  stage = 'fixture-create-browser-context';
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  const allowedOrigins = new Set([fixture.sourceOrigin, fixture.destinationOrigin]);
  let nonLoopbackAttempt = false;
  await context.route('**/*', async route => {
    if (allowedOrigins.has(new URL(route.request().url()).origin)) await route.continue();
    else { nonLoopbackAttempt = true; await route.abort(); }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  let pageError = false;
  page.on('pageerror', () => { pageError = true; });

  async function openForm(policy) {
    const query = new URLSearchParams({ policy, ...fixture.markers });
    const response = await page.goto(fixture.sourceOrigin + '/form?' + query);
    check(`document-policy-${policy}`, response.headers()['referrer-policy'] === policy);
    check(`clean-url-${policy}`, page.url() === fixture.sourceOrigin + '/form');
  }
  async function submit(path = '/submit') {
    const responsePromise = page.waitForResponse(response => response.url() === fixture.sourceOrigin + path && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Submit synthetic form', exact: true }).click();
    return responsePromise;
  }

  stage = 'native-no-referrer-control';
  await openForm('no-referrer');
  const oldResponse = await submit();
  const old = fixture.observations.submissions.at(-1);
  check('no-referrer-native-post-origin-null', old.method_is_post && old.origin_is_null && old.referrer_is_absent && old.body_is_present);
  check('no-referrer-valid-csrf-still-rejected', old.csrf_accepted && !old.strict_origin_accepted && !old.accepted && oldResponse.status() === 403);
  check('rejection-does-not-redirect', fixture.observations.destinations.length === 0);

  stage = 'native-same-origin-form';
  await openForm('same-origin');
  const newResponse = await submit();
  await page.waitForURL(fixture.destinationOrigin + '/landing');
  const current = fixture.observations.submissions.at(-1);
  const destination = fixture.observations.destinations.at(-1);
  check('same-origin-native-post-exact-origin', current.method_is_post && current.origin_is_exact && current.referrer_is_clean_source_path && !current.referrer_has_synthetic_marker);
  check('same-origin-valid-csrf-accepted', current.strict_origin_accepted && current.csrf_accepted && current.accepted && current.synthetic_cookie_is_present);
  check('redirect-303-and-no-referrer', newResponse.status() === 303 && newResponse.headers()['referrer-policy'] === 'no-referrer');
  check('destination-get-without-body-referrer-cookie', fixture.observations.destinations.length === 1 && destination.method_is_get && !destination.body_is_present && destination.referrer_is_absent && !destination.cookie_is_present);

  stage = 'same-origin-csrf-controls';
  for (const invalid of ['missing', 'wrong', 'duplicate']) {
    await openForm('same-origin');
    await page.locator('input[name="csrf"]').evaluate((input, mode) => {
      if (mode === 'missing') input.remove();
      else if (mode === 'wrong') input.value = 'synthetic-wrong-csrf';
      else input.after(input.cloneNode(true));
    }, invalid);
    const response = await submit();
    const entry = fixture.observations.submissions.at(-1);
    check(`csrf-${invalid}-rejected`, entry.origin_is_exact && entry.strict_origin_accepted && !entry.csrf_accepted && !entry.accepted && response.status() === 403);
  }

  stage = 'foreign-origin-control';
  await page.goto(fixture.destinationOrigin + '/foreign-form');
  const foreignResponse = await submit();
  const foreign = fixture.observations.submissions.at(-1);
  check('foreign-native-origin-rejected', foreign.method_is_post && foreign.origin_is_other && !foreign.strict_origin_accepted && !foreign.accepted && foreignResponse.status() === 403);

  stage = 'error-page-cleanup';
  const errorResponse = await page.goto(fixture.sourceOrigin + '/error?' + new URLSearchParams(fixture.markers));
  check('error-page-keeps-no-referrer-policy', errorResponse.headers()['referrer-policy'] === 'no-referrer');
  check('error-page-url-cleaned', page.url() === fixture.sourceOrigin + '/error');
  const cleanupPromise = page.waitForResponse(response => response.url() === fixture.sourceOrigin + '/cleanup');
  await page.getByRole('link', { name: 'Clean up synthetic error', exact: true }).click();
  const cleanupResponse = await cleanupPromise;
  const cleanup = fixture.observations.cleanup.at(-1);
  check('error-same-origin-cleanup-has-no-referrer-leak', cleanup.method_is_get && cleanup.referrer_is_absent && !cleanup.referrer_has_synthetic_marker && !cleanup.body_is_present && cleanupResponse.status() === 200);
  check('only-accepted-form-reached-destination', fixture.observations.destinations.length === 1);
  check('no-off-fixture-page-requests-or-page-errors', !nonLoopbackAttempt && !pageError);
  summary.passed = true;
} catch (error) {
  // Avoid dumping request objects, headers, user environment, or browser launch logs.
  summary.failure_stage = stage;
  summary.failure_category = failureCategory(error);
  summary.sandbox_environment_blocked = summary.failure_category === 'sandbox_environment';
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  const cleanupResults = await Promise.allSettled([browser?.close(), fixture.close()]);
  summary.cleanup_failed = cleanupResults.some(result => result.status === 'rejected');
  if (summary.cleanup_failed) { summary.passed = false; process.exitCode = 1; }
  summary.observations = fixture.observations;
  const bytes = JSON.stringify(summary, null, 2) + '\n';
  assert.ok(Buffer.byteLength(bytes) <= 64 * 1024, 'Evidence exceeds 64 KiB');
  await mkdir(output, { recursive: true });
  await writeFile(new URL('result.json', output), bytes);
  console.log(JSON.stringify({ passed: summary.passed, failure_stage: summary.failure_stage, failure_category: summary.failure_category, checks: checks.length, evidence_bytes: Buffer.byteLength(bytes) }));
}
