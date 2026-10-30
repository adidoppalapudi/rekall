import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const origin = 'https://example.test';
const workerSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function createCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (resource: string | Request) => (typeof resource === 'string' ? resource : resource.url);

  return {
    async open(name: string) {
      let store = stores.get(name);
      if (!store) stores.set(name, (store = new Map()));
      return {
        async match(resource: string | Request) {
          return store.get(keyOf(resource))?.clone();
        },
        async put(resource: string | Request, response: Response) {
          store.set(keyOf(resource), response.clone());
        },
        async keys() {
          return [...store.keys()].map((url) => new Request(url));
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async match(resource: string | Request) {
      for (const store of stores.values()) {
        const response = store.get(keyOf(resource));
        if (response) return response.clone();
      }
      return undefined;
    },
  };
}

function createWorkerHarness() {
  const listeners = new Map<string, (event: any) => void>();
  const caches = createCacheStorage();
  const requested: string[] = [];
  let claimed = false;
  let skippedWaiting = false;
  const html = [
    '<link rel="icon" href="./icons/icon.svg">',
    '<link rel="manifest" href="./manifest.webmanifest">',
    '<script src="./assets/app.js"></script>',
    '<link rel="stylesheet" href="./assets/app.css">',
    '<link rel="prefetch" href="./assets/nature.enyalie-abc123.json">',
  ].join('');
  const fetch = async (resource: RequestInfo | URL) => {
    const url =
      typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
    requested.push(url);
    return new Response(url.endsWith('/enyalie/') ? html : `asset ${url}`, { status: 200 });
  };
  const self = {
    registration: { scope: `${origin}/enyalie/` },
    location: { origin },
    clients: {
      async claim() {
        claimed = true;
      },
    },
    async skipWaiting() {
      skippedWaiting = true;
    },
    addEventListener(name: string, listener: (event: any) => void) {
      listeners.set(name, listener);
    },
  };

  runInNewContext(workerSource, { self, caches, fetch, URL, Request, Response, setTimeout, clearTimeout });

  return {
    caches,
    listeners,
    requested,
    get claimed() {
      return claimed;
    },
    get skippedWaiting() {
      return skippedWaiting;
    },
  };
}

async function dispatchLifecycle(listener: (event: any) => void) {
  let work: Promise<unknown> = Promise.resolve();
  listener({ waitUntil(promise: Promise<unknown>) { work = Promise.resolve(promise); } });
  await work;
}

describe('Enyalië installation path and service worker', () => {
  it('resolves the manifest identity, start URL, and scope under /enyalie/', () => {
    const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
    const manifestUrl = new URL(`${origin}/enyalie/manifest.webmanifest`);

    expect(new URL(manifest.id, manifestUrl).pathname).toBe('/enyalie/');
    expect(new URL(manifest.start_url, manifestUrl).pathname).toBe('/enyalie/');
    expect(new URL(manifest.scope, manifestUrl).pathname).toBe('/enyalie/');
    expect(manifest.name).toBe('Enyalië');
    expect(manifest.short_name).toBe('Enyalië');
  });

  it('pre-caches the app shell within the /enyalie/ service-worker scope', async () => {
    const worker = createWorkerHarness();
    const install = worker.listeners.get('install');
    expect(install).toBeDefined();
    if (!install) return;

    await dispatchLifecycle(install);

    expect(worker.skippedWaiting).toBe(true);
    expect(worker.requested).toContain(`${origin}/enyalie/`);
    expect(worker.requested).toContain(`${origin}/enyalie/icons/icon.svg`);
    expect(worker.requested).not.toContain(`${origin}/icons/icon.svg`);
    expect(await worker.caches.keys()).toEqual(['enyalie-v5']);
    const cache = await worker.caches.open('enyalie-v5');
    expect(await cache.match(`${origin}/enyalie/`)).toBeDefined();
    expect(await cache.match(`${origin}/enyalie/manifest.webmanifest`)).toBeDefined();
    expect(await cache.match(`${origin}/enyalie/assets/nature.enyalie-abc123.json`)).toBeDefined();
  });

  it('cleans previous app caches and claims the new app scope on activation', async () => {
    const worker = createWorkerHarness();
    await worker.caches.open('enyalie-v5');
    await worker.caches.open('enyalie-v1');
    await worker.caches.open('unrelated-cache');

    const activate = worker.listeners.get('activate');
    expect(activate).toBeDefined();
    if (!activate) return;
    await dispatchLifecycle(activate);

    expect(await worker.caches.keys()).toEqual(['enyalie-v5', 'unrelated-cache']);
    expect(worker.claimed).toBe(true);
  });
});
