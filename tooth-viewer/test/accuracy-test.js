// 精度検証スクリプト：正解ラベル付きの合成ファントムで、歯・根管の抽出精度を測定する
//   使い方: node tooth-viewer/test/accuracy-test.js
//   必要: playwright（npm i -D playwright）と Chromium
const path = require('path');
const { chromium } = require('playwright');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const CASES = [
  { name: '第一大臼歯 0.15mm', tooth: 1, demo: { s: 0.15, noise: 110 } },
  { name: '小臼歯(2根管→合流) 0.15mm', tooth: 0, demo: { s: 0.15, noise: 110 } },
  { name: '単根歯(側枝あり) 0.15mm', tooth: 2, demo: { s: 0.15, noise: 110 } },
  { name: '第一大臼歯 0.10mm', tooth: 1, demo: { s: 0.10, noise: 150 } },
  { name: '第一大臼歯 0.20mm 高ノイズ', tooth: 1, demo: { s: 0.20, noise: 200 } },
  { name: '第一大臼歯 0.25mm', tooth: 1, demo: { s: 0.25, noise: 110 } },
];

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const rows = [];
  for (const c of CASES) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
    await page.goto(PAGE);
    await page.evaluate((o) => (window.DEMO_OPTS = o), c.demo);
    await page.click('#demoBtn');
    await page.waitForFunction(() => !document.getElementById('extractBtn').disabled, null, { timeout: 120000 });
    await page.evaluate((ti) => {
      const xs = [9.0, 17.8, 26.4], s = S.vol.sx;
      setSeed([Math.round(xs[ti] / s), Math.round(13 / s), Math.round(24 / s)]);
    }, c.tooth);
    await page.click('#autoTh');
    await page.click('#extractBtn');
    await page.waitForFunction(() => document.getElementById('empty3d').style.display === 'none', null, { timeout: 180000 });
    const r = await page.evaluate((ti) => {
      const F = S.seg.fine, v = S.vol, s = v.sx, { nx, ny, nz, sp, origin } = F;
      let tp = 0, fp = 0, fn = 0, ctp = 0, cfp = 0, cfn = 0;
      const gl = new Uint8Array(nx * ny * nz);
      for (let z = 0, i = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) {
        const g = v.gt(origin[0] + x * sp[0] + s / 2, origin[1] + y * sp[1] + s / 2, origin[2] + z * sp[2] + s / 2, ti);
        gl[i] = g;
        const L = F.labels[i], pt = L >= 1 && L <= 3, gt = g > 0;
        if (pt && gt) tp++; else if (pt) fp++; else if (gt) fn++;
        if (L === 3 && g === 3) ctp++; else if (L === 3) cfp++; else if (g === 3) cfn++;
      }
      const minPx = Math.max(2, Math.round(0.02 / (sp[0] * sp[1])));
      let agree = 0, tot = 0;
      for (let z = 0; z < nz; z++) {
        const g = count2D(gl, nx, ny, z, 3, minPx); if (!g) continue;
        tot++; if (g === count2D(F.labels, nx, ny, z, 3, minPx)) agree++;
      }
      const dice = (a, b, c) => 2 * a / (2 * a + b + c);
      return { tooth: dice(tp, fp, fn), canal: dice(ctp, cfp, cfn), recall: ctp / (ctp + cfn), precision: ctp / (ctp + cfp), count: agree / tot };
    }, c.tooth);
    rows.push({ case: c.name, '歯 Dice': r.tooth.toFixed(3), '根管 Dice': r.canal.toFixed(3), '根管 再現率': r.recall.toFixed(3), '根管 適合率': r.precision.toFixed(3), '断面根管数一致': (r.count * 100).toFixed(0) + '%' });
    await page.close();
  }
  console.table(rows);
  await browser.close();
})();
