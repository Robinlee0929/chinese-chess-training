export const ALLOWED_ORIGIN = 'https://robinlee0929.github.io';
export const MAX_REQUEST_BYTES = 1024;
export const MAX_RESPONSE_BYTES = 1024;

export function allowedOrigin(origin) {
  return origin === ALLOWED_ORIGIN;
}

export function reply(status, origin, body = null, extraHeaders = {}) {
  let serialized = body === null ? null : JSON.stringify(body);
  if (serialized !== null && new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) {
    status = 500;
    serialized = null;
  }
  const headers = new Headers(extraHeaders);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Vary', headers.has('Access-Control-Max-Age')
    ? 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers' : 'Origin');
  if (allowedOrigin(origin)) headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  if (serialized !== null) headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(serialized, { status, headers });
}

export function preflight(request, origin, method) {
  const requestedMethod = request.headers.get('Access-Control-Request-Method');
  const requestedHeaders = request.headers.get('Access-Control-Request-Headers');
  const validHeaders = requestedHeaders === null || requestedHeaders.trim() === ''
    || requestedHeaders.trim().toLowerCase() === 'content-type';
  if (requestedMethod !== method || !validHeaders) return reply(403, origin, null, { 'Access-Control-Max-Age': '0' });
  return reply(204, origin, null, { 'Access-Control-Allow-Methods': `${method}, OPTIONS`,
    'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '0' });
}

export function bodyHeaderStatus(headers) {
  if (headers.has('Content-Encoding')) return 415;
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers.get('Content-Type') ?? '')) return 415;
  const length = headers.get('Content-Length');
  if (length !== null && !/^\d+$/u.test(length)) return 400;
  if (length !== null && Number(length) > MAX_REQUEST_BYTES) return 413;
  return 200;
}

export async function readBody(request, signal) {
  if (!request.body) return { status: 400 };
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); return { status: 400 }; }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) return { status: 400 };
      if (done) break;
      if (!(value instanceof Uint8Array)) { cancel(); return { status: 400 }; }
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) { cancel(); return { status: 413 }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    // Preserve BOM so it is rejected as non-JSON; never repair malformed UTF-8.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { status: 200, text };
  } catch {
    return { status: 400 };
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
