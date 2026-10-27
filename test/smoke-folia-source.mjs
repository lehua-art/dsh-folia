// 冒烟：不启 DSH，直接调 /inventory 的 handler，验证站点数据源真的并进来了。
import { registerInventoryRoutes } from '../lib/routes/inventory.js';

const routes = [];
const webServer = { register: (r) => { routes.push(r); return () => {}; } };

registerInventoryRoutes(webServer, {
  disposers: [],
  base: '/folia',
  mediaOriginApi: { observeAdapter() {} },
  buildInventory: async () => ({
    wallpapers: [{
      id: 'local-1', title: '本机壁纸', type: 'image', contentrating: null,
      playable: true, media: '/folia/media/abc', mediaExt: '.jpg', preview: null,
      frameUrl: null, schemeColor: null, sceneLiveSrc: null, sceneVideo: null,
      sceneAudio: null, propsUrl: null, liveFrame: null,
    }],
    total: 1,
    portableCount: 1,
    installDir: '/x',
  }),
  componentsProbe: () => null,
});

const route = routes[0];
console.log('注册的路由:', route.kind, route.path);

const headers = {};
const res = {
  statusCode: 200,
  setHeader: (k, v) => { headers[k] = v; },
  end: (body) => { res.body = body; },
};

const t0 = Date.now();
await route.handler({}, res);
const ms = Date.now() - t0;

const j = JSON.parse(res.body);
console.log('耗时:', ms, 'ms');
console.log('HTTP 头:', JSON.stringify(headers));
console.log('total:', j.total, ' portableCount:', j.portableCount, ' wallpapers:', j.wallpapers.length);
const remote = j.wallpapers.filter((w) => w.source === 'folia');
console.log('站点条目:', remote.length);
for (const r of remote.slice(0, 5)) {
  console.log('  ', r.id, '|', r.type, '|', r.mediaExt, '|', r.title);
  console.log('     media:', r.media);
}
const local = j.wallpapers.filter((w) => w.source !== 'folia');
console.log('本机条目仍在:', local.length, local.map((w) => w.id).join(','));
