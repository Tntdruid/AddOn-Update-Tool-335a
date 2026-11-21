'use strict';

const USER_AGENT = 'AddonUpdateTool-335a';

class HttpError extends Error {
  constructor(message, status, info = {}) {
    super(message);
    this.status = status;
    Object.assign(this, info);
  }
}

/**
 * Small HTTP client with per-host tokens and ETag caching.
 * Conditional requests that return 304 do not count against GitHub's rate limit,
 * so repeated update checks are almost free.
 */
class HttpClient {
  /**
   * @param {{fetch?:typeof fetch, tokens?:Record<string,string>, etagCache?:Record<string,{etag:string, body:any}>}} opts
   */
  constructor(opts = {}) {
    this.fetch = opts.fetch || globalThis.fetch;
    this.tokens = opts.tokens || {};
    this.etagCache = opts.etagCache || {};
    this.rateLimit = null;
  }

  headersFor(url, extra = {}) {
    const host = new URL(url).hostname;
    const headers = { 'User-Agent': USER_AGENT, ...extra };
    const token = this.tokens[host] || (host === 'api.github.com' || host === 'codeload.github.com' ? this.tokens['github.com'] : null);
    if (token) {
      if (host.endsWith('github.com')) headers.Authorization = `Bearer ${token}`;
      else if (host.includes('gitlab')) headers['PRIVATE-TOKEN'] = token;
      else headers.Authorization = `token ${token}`;
    }
    if (host === 'api.github.com') {
      headers.Accept = headers.Accept || 'application/vnd.github+json';
      headers['X-GitHub-Api-Version'] = '2022-11-28';
    }
    return headers;
  }

  async json(url) {
    const cached = this.etagCache[url];
    const headers = this.headersFor(url, cached ? { 'If-None-Match': cached.etag } : {});
    const res = await this.fetch(url, { headers });
    this.trackRateLimit(res);
    if (res.status === 304 && cached) return cached.body;
    if (!res.ok) throw await this.error(url, res);
    const body = await res.json();
    const etag = res.headers.get('etag');
    if (etag) this.etagCache[url] = { etag, body };
    return body;
  }

  async buffer(url) {
    const res = await this.fetch(url, { headers: this.headersFor(url), redirect: 'follow' });
    this.trackRateLimit(res);
    if (!res.ok) throw await this.error(url, res);
    return new Uint8Array(await res.arrayBuffer());
  }

  trackRateLimit(res) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining == null) return;
    this.rateLimit = {
      remaining: Number(remaining),
      limit: Number(res.headers.get('x-ratelimit-limit')),
      reset: Number(res.headers.get('x-ratelimit-reset')) * 1000,
    };
  }

  async error(url, res) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body && (body.message || body.error) ? `: ${body.message || body.error}` : '';
    } catch {
      /* not JSON */
    }
    if ((res.status === 403 || res.status === 429) && this.rateLimit && this.rateLimit.remaining === 0) {
      const when = new Date(this.rateLimit.reset).toLocaleTimeString();
      return new HttpError(`API rate limit reached (resets ${when}). Add a token in Settings to raise it.`, res.status, {
        rateLimited: true,
      });
    }
    if (res.status === 404) return new HttpError(`Not found (private repo or wrong URL/branch)`, 404);
    return new HttpError(`HTTP ${res.status} for ${url}${detail}`, res.status);
  }
}

/** Run async tasks with a concurrency limit, returning results in order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { HttpClient, HttpError, mapLimit };
