// The GitHub feed services inside workerd, the Workers runtime, for test/workers-runtime.test.mjs.
// GitHub is simulated here, so nothing leaves the machine. Each simulated request is built with the
// Request constructor from the services' own fetch arguments: that is where the runtime rejects an
// option it does not implement, as fetch() itself does.
import { getGithubIssues } from '../../src/services/github.ts';
import { getGithubDiscussions } from '../../src/services/github-discussions.ts';
import { forgetFeeds } from '../../src/services/feed-cache.ts';

const REPOSITORY = 'https://github.com/thomasthanos/nexusmods-bypass';
const issue = { number: 34, title: 'Changing the download folder', html_url: `${REPOSITORY}/issues/34`, state: 'open',
  labels: [{ name: 'question' }], created_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-22T11:00:00Z', comments: 2 };
// GitHub's own shape: every discussion carries its body as escaped HTML.
const entry = (number) => `<entry><id>tag:github.com,2008:Discussion/${number}</id><link type="text/html" rel="alternate" href="${REPOSITORY}/discussions/${number}"/><title>Discussion ${number}</title><updated>2026-10-22T11:${String(number).padStart(2, '0')}:00+00:00</updated><content type="html">${'&lt;p&gt;Steps &amp;amp; logs&lt;/p&gt;'.repeat(100)}</content><author><name>octocat</name></author></entry>`;
const atom = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US"><id>tag:github.com,2008:${REPOSITORY}/discussions</id><title>Discussions</title><updated>2026-10-22T11:30:00+00:00</updated>${Array.from({ length: 25 }, (_, index) => entry(index + 1)).join('')}</feed>`;

const upstream = { status: 200, requests: [] };

async function github(input, init) {
  const request = new Request(input, init);
  upstream.requests.push({ url: request.url, redirect: request.redirect });
  if (upstream.status !== 200) return new Response(null, { status: upstream.status, headers: upstream.status < 400 ? { location: 'https://elsewhere.invalid/' } : {} });
  if (request.url.startsWith('https://api.github.com/repos/thomasthanos/nexusmods-bypass/issues?')) return Response.json([issue]);
  if (request.url === `${REPOSITORY}/discussions.atom`) return new Response(atom, { headers: { 'content-type': 'application/atom+xml; charset=utf-8' } });
  return new Response(null, { status: 404 });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/upstream') {
      upstream.status = Number(url.searchParams.get('status'));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/access') {
      // Workers fronted by Cloudflare Access: the Cache API stores and returns nothing.
      const nothing = { match: async () => undefined, put: async () => {} };
      Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: nothing, open: async () => nothing } });
      forgetFeeds();
      return new Response(null, { status: 204 });
    }
    const now = () => Number(url.searchParams.get('now'));
    const settle = (promise) => promise.catch((error) => ({ error: String(error) }));
    const [issues, discussions] = await Promise.all([settle(getGithubIssues({ now, fetch: github })), settle(getGithubDiscussions({ now, fetch: github }))]);
    return Response.json({ issues, discussions, requests: upstream.requests.splice(0) });
  }
};
