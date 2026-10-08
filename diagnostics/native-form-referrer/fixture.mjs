import http from 'node:http';
import { once } from 'node:events';

// A standards fixture, not an import or copy of a production authentication server.
const CSRF = 'synthetic-form-csrf';
const SESSION = 'synthetic_session=synthetic-only';
const CODE = 'synthetic-code-marker';
const STATE = 'synthetic-state-marker';
const MAX_BODY = 4096;

function page(body, script = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic form diagnostic</title><body>${script ? `<script>${script}</script>` : ''}${body}</body></html>`;
}

function form(action, title) {
  return `<h1>${title}</h1><form action="${action}" method="post"><input type="hidden" name="csrf" value="${CSRF}"><input type="hidden" name="payload" value="synthetic-body-marker"><button type="submit">Submit synthetic form</button></form>`;
}

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Synthetic request exceeds body limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFixture() {
  let sourceOrigin;
  let destinationOrigin;
  const observations = { submissions: [], cleanup: [], destinations: [] };

  function headers(policy) {
    return {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': policy,
      'X-Content-Type-Options': 'nosniff',
      // Chromium can apply form-action to redirects. Permit only these two
      // dynamically allocated loopback origins, including their exact ports.
      'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; form-action ${sourceOrigin} ${destinationOrigin}; base-uri 'none'; frame-ancestors 'none'`,
    };
  }

  function observe(request, body, expectedPath) {
    const referrer = request.headers.referer;
    return {
      method_is_post: request.method === 'POST',
      method_is_get: request.method === 'GET',
      origin_is_null: request.headers.origin === 'null',
      origin_is_exact: request.headers.origin === sourceOrigin,
      origin_is_absent: request.headers.origin === undefined,
      origin_is_other: request.headers.origin !== undefined && request.headers.origin !== 'null' && request.headers.origin !== sourceOrigin,
      referrer_is_absent: referrer === undefined,
      referrer_is_clean_source_path: referrer === sourceOrigin + expectedPath,
      referrer_has_synthetic_marker: Boolean(referrer && (referrer.includes(CODE) || referrer.includes(STATE))),
      body_is_present: body.length > 0,
      cookie_is_present: request.headers.cookie !== undefined,
      synthetic_cookie_is_present: request.headers.cookie?.split(';').some(value => value.trim() === SESSION) ?? false,
    };
  }

  async function sourceHandler(request, response) {
    const url = new URL(request.url, sourceOrigin);
    if (request.method === 'GET' && (url.pathname === '/form' || url.pathname === '/error')) {
      const isError = url.pathname === '/error';
      const policy = isError ? 'no-referrer' : url.searchParams.get('policy');
      if (!['no-referrer', 'same-origin'].includes(policy)) {
        response.writeHead(400, headers('no-referrer')).end('Unknown synthetic policy');
        return;
      }
      response.writeHead(200, { ...headers(policy), 'Set-Cookie': `${SESSION}; HttpOnly; SameSite=Strict; Path=/` });
      const cleanPath = isError ? '/error' : '/form';
      const content = isError ? '<h1>Synthetic error cleanup</h1><a href="/cleanup">Clean up synthetic error</a>' : form('/submit', 'Synthetic native form');
      response.end(page(content, `history.replaceState(null, '', '${cleanPath}');`));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/cleanup') {
      observations.cleanup.push(observe(request, await bodyOf(request), '/error'));
      response.writeHead(200, headers('no-referrer')).end(page('<h1>Synthetic cleanup complete</h1>'));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/submit') {
      const body = await bodyOf(request);
      const entry = observe(request, body, '/form');
      // Reject missing, opaque/null, and foreign origins without exceptions.
      const strictOrigin = request.headers.origin === sourceOrigin;
      const fields = new URLSearchParams(body);
      const csrf = entry.synthetic_cookie_is_present && fields.getAll('csrf').length === 1 && fields.get('csrf') === CSRF;
      Object.assign(entry, { strict_origin_accepted: strictOrigin, csrf_accepted: csrf, accepted: strictOrigin && csrf });
      observations.submissions.push(entry);
      if (!entry.accepted) {
        response.writeHead(403, headers('no-referrer')).end(page('<h1>Synthetic request rejected</h1>'));
      } else {
        // No credentials, form body, or source URL are copied into the redirect.
        response.writeHead(303, { ...headers('no-referrer'), Location: destinationOrigin + '/landing' }).end();
      }
      return;
    }
    response.writeHead(404, headers('no-referrer')).end('Synthetic route not found');
  }

  async function destinationHandler(request, response) {
    const url = new URL(request.url, destinationOrigin);
    if (request.method === 'GET' && url.pathname === '/foreign-form') {
      response.writeHead(200, headers('origin')).end(page(form(sourceOrigin + '/submit', 'Synthetic foreign-origin form')));
      return;
    }
    if (url.pathname === '/landing') {
      const body = await bodyOf(request);
      observations.destinations.push(observe(request, body, '/form'));
      response.writeHead(200, headers('no-referrer')).end(page('<h1>Synthetic destination</h1>'));
      return;
    }
    response.writeHead(404, headers('no-referrer')).end('Synthetic route not found');
  }

  function server(handler) {
    const instance = http.createServer((request, response) => {
      void handler(request, response).catch(() => {
        response.writeHead(500, headers('no-referrer')).end('Synthetic fixture failure');
      });
    });
    instance.requestTimeout = 5000;
    instance.headersTimeout = 5000;
    return instance;
  }
  const source = server(sourceHandler);
  const destination = server(destinationHandler);
  // Different loopback hosts are necessary: cookies ignore port boundaries.
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  sourceOrigin = `http://127.0.0.1:${source.address().port}`;
  try {
    destination.listen(0, '127.0.0.2');
    await once(destination, 'listening');
  } catch (error) {
    source.closeAllConnections();
    await new Promise(resolve => source.close(resolve));
    throw error;
  }
  destinationOrigin = `http://127.0.0.2:${destination.address().port}`;
  return {
    sourceOrigin,
    destinationOrigin,
    markers: { code: CODE, state: STATE },
    observations,
    close: () => Promise.all([source, destination].map(instance => {
      instance.closeAllConnections();
      return new Promise(resolve => instance.close(resolve));
    })),
  };
}
