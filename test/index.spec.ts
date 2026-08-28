import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('worker', () => {
  it.each([
    ['GET', 'https://example.com/'],
    ['POST', 'https://example.com/youtube/websub'],
    ['DELETE', 'https://example.com/anything?query=value'],
  ])('returns 404 for %s %s', async (method, url) => {
    const response = await exports.default.fetch(url, { method });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: 404, error: 'Not Found' });
  });
});
