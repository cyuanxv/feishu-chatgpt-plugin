# Synthetic native-form Referrer-Policy diagnostic

This standalone fixture checks Chromium's native HTML form behavior. It does not import application code, contact a provider, or establish that any deployed application is fixed. Every request value is synthetic. Request evidence contains only Boolean classifications, never raw headers, bodies, cookies, or request URLs.

## What one run checks

- Identical same-origin POST forms served with `no-referrer` versus `same-origin`: the first must naturally send `Origin: null` and receive 403 despite valid synthetic CSRF; the second must naturally send the exact source origin and receive 303.
- The 303 response keeps `Referrer-Policy: no-referrer`. The second loopback host must receive GET with no body, Referer, or source cookie.
- Missing, incorrect, and duplicate CSRF form values still receive 403. A native form from the other loopback origin still receives 403.
- An error page keeps `no-referrer`, removes synthetic code/state from its URL, and sends no Referer on a same-origin cleanup navigation.
- Chromium launches with `chromiumSandbox: true`; its actual process arguments contain no sandbox-disabling switches, and `chrome://sandbox` reports an active Seccomp-BPF sandbox. Any unavailable or unverifiable sandbox fails the diagnostic.

No Origin or Referer header is constructed or overridden by the browser harness. Forms submit through the browser's ordinary button activation. The synthetic cookie is host-only: cookies do not isolate by port, so the two HTTP servers bind to different loopback hosts, `127.0.0.1` and `127.0.0.2`. Cookie isolation is independent of Referrer-Policy. This HTTP fixture does not validate production TLS, secure cookies, actual authentication, or a real provider.

## Local run in an authorized cloud environment

From this directory, run `npm ci --ignore-scripts --no-audit --no-fund`, then `SYNTHETIC_CHROMIUM_PATH=/usr/bin/google-chrome node test.mjs` using an already installed official Chrome/Chromium binary. No browser download, system package change, sandbox permission change, or fallback without a sandbox is part of this test. The result is `evidence/result.json`, at most 64 KiB. No traces, HARs, screenshots, or videos are created.

## Exactly one CI run, branch only

This diagnostic is for the exact branch `diagnostic/native-form-referrer-20261008`, with no pull request and no merge. The existing validation workflow's push trigger excludes only that branch; its pull-request trigger and every existing job remain intact. The new workflow's push trigger includes only that branch. It has one ordinary `ubuntu-22.04` job, an eight-minute timeout, no matrix, schedule, dispatch, workflow chaining, cache, deployment, or automatic retry. Artifacts retain one result JSON for one day.

The reviewed baseline is public main commit `b21af26a6313492b68b04cf5fce293d2e8e59cea`, tree `602003fa7f7db7f7b0cd37c5c7a536b6d809c684`. Recheck the public main SHA, workflow directory, branch absence, and lack of a PR for that exact branch immediately before publication. If they differ, stop and review the changed trigger surface.

After the independent review and final authorization, use this mutation order:

1. Create Git blobs for exactly the frozen changed files, then create a Git tree with the reviewed public tree as its base. Verify the returned tree matches the reviewed candidate tree. Creating unattached objects does not publish a branch or trigger push CI.
2. Create a Git commit with the reviewed public main commit as its sole parent and the completed candidate tree. Read that commit back and verify its tree and parent.
3. Call GitHub `create_branch` once with the exact branch name and the completed commit's SHA. This single ref creation is the only push event. Do not create the branch at main first, and do not subsequently update the branch.
4. Observe that exact commit's workflow runs until the one diagnostic run reaches a terminal state. Do not open a PR, rerun, dispatch, update a ref, or merge. An uncertain branch-creation response requires a read of its ref and runs, never a blind retry.

This trigger plan governs actions performed by this diagnostic; it cannot prevent a separate human from independently pushing or rerunning. The run-attempt guard prevents the test job executing on reruns. Future pushes require a fresh review against the one-run scope.

## Cost and primary references

GitHub lists standard hosted runner usage in public repositories as free. The job explicitly requires this repository to remain public. No paid API/model/provider is called. At the published $0.25/GiB-month artifact rate, even the authorization's larger 10 MiB cap for one day is below $0.0001; this workflow enforces 64 KiB instead. Expected billed compute is $0 and conservative artifact cost is below $0.0001, within the $0.10 stage limit. No other workflow may be started under this plan.

- [GitHub Actions billing and storage pricing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub runner rates and per-job minute rounding](https://docs.github.com/en/billing/reference/actions-runner-pricing)
- [Official Ubuntu 22.04 runner browser inventory](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2204-Readme.md)
- [Playwright launch sandbox option](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox)
- [Fetch Standard: appending the request Origin header](https://fetch.spec.whatwg.org/#append-a-request-origin-header)

Pricing and runner documentation checked 2026-10-08. The preinstalled browser version is recorded by the diagnostic because hosted runner images can change.
