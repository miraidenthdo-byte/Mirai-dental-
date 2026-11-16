// 実データ検証用：CBCT の一部を切り出した Int16 の生データ（0.19mm 等方、スライス番号の増える向き＝頭側）で歯をダブルクリック→枠の自動設定→解析し、
// 上下判定・咬合面・対合歯の混入（opp）・矢状断の重ね合わせ（TAG_sag.json）・3D画像（TAG_a/b.png）を出力する。患者データはリポジトリに含めない
// 使い方: VOL=volped.bin:380:320:251 VOLDIR=データの場所 node test/realct-check.js '{"seed":[x,y,z],"sag":[y0,y1,z0,z1,"x"],"sagc":[x]}' TAG
const { chromium } = require(process.env.PW || '/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const o = JSON.parse(process.argv[2] || '{}'), tag = process.argv[3] || 'p';
const [VF, NX, NY, NZ] = (process.env.VOL || 'volped.bin:380:320:251').split(':'); o.__vf = VF; o.__d = [+NX, +NY, +NZ];
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--max-old-space-size=4096'] });
  const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  p.on('console', (m) => { if (m.type() === 'log') console.log('LOG', m.text()); });
  await p.route('**/' + VF, (r) => r.fulfill({ body: fs.readFileSync((process.env.VOLDIR || __dirname) + '/' + VF), contentType: 'application/octet-stream' }));
  await p.addInitScript((d) => { window.DEBUG_SEP = 1; Object.assign(window, d); }, JSON.parse(process.env.DBG || '{}'));
  await p.goto(process.env.HTML || 'file://' + require('path').resolve(__dirname, '../index.html'));
  const pre = await p.evaluate(async (o) => {
    const buf = await (await fetch('http://x.local/' + o.__vf + '')).arrayBuffer();
    const [nx, ny, nz] = o.__d, a = new Int16Array(buf), slices = [];
    for (let z = 0; z < nz; z++) slices.push(a.slice(z * nx * ny, (z + 1) * nx * ny));
    setVolume({ nx, ny, nz, sx: 0.19, sy: 0.19, sz: 0.19, slices, desc: 'ped', dirs: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], origin: [0, 0, 0] }, 'ped');
    if (o.tooth) { const t = document.getElementById('toothNo'); t.value = o.tooth; t.dispatchEvent(new Event('change')); }
    if (o.auto) document.getElementById('autoExtract').checked = true;
    const ok = selectToothAt(o.seed);
    const r = { ok, jaw: $('jaw').value, zO: S.occl && S.occl.zO, seed: S.seed, roi: [roiX.value, roiY.value, roiUp.value, roiDn.value], shift: S.shift };
    if (!o.auto && !o.noExtract) runExtract();
    return r;
  }, o);
  console.log('PRE', JSON.stringify(pre));
  await p.waitForTimeout(800);
  for (let k = 0; k < 5; k++) { await p.waitForTimeout(800); await p.waitForFunction(() => !S.busy && !S.rerun, null, { timeout: 600000 }); }
  const r = await p.evaluate(() => {
    // 対合歯の混入：咬合面マップより反対側にある歯ラベルの割合
    let tot = 0, opp = 0, zmin = 1e9, zmax = -1;
    const oc = S.occl, below = $('jaw').value === 'lower' ? (supSign() > 0) : (supSign() < 0);
    const v = S.vol, [sx, sy] = S.seed, R = 90;
    for (let z = 0; z < v.nz; z++) for (let y = Math.max(0, sy - R); y < Math.min(v.ny, sy + R); y++) for (let x = Math.max(0, sx - R); x < Math.min(v.nx, sx + R); x++) {
      const L = S.seg.labelAt(x, y, z); if (L < 1 || L > 3) continue; tot++; zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
      if (oc && oc.zO != null && opposingJaw(oc, below, x, y, z)) opp++; }
    return { tilt: [tiltX.value, tiltY.value], roi: [roiX.value, roiY.value, roiUp.value, roiDn.value], stats: $('segStats').innerText.replace(/\n/g, ' '), status: $('status').innerText, tot, opp, z: [zmin, zmax] };
  });
  console.log('RES', JSON.stringify(r));
  if (o.sag) {
    const sg = await p.evaluate((o) => { const v = S.vol, out = []; const [y0, y1, z0, z1, ax] = o.sag;
      for (const c of o.sagc) { const rows = []; for (let z = z1; z >= z0; z--) { const r = []; for (let t = y0; t < y1; t++) { const [x, y] = ax === 'x' ? [c, t] : [t, c]; r.push(v.slices[z][y * v.nx + x], S.seg.labelAt(x, y, z)); } rows.push(r); } out.push(rows); } return out; }, o);
    fs.writeFileSync(tag + '_sag.json', JSON.stringify(sg));
  }
  for (const [nm, view] of [['a', 'front'], ['b', 'side']]) {
    await p.evaluate((v) => renderer.setView(v), view);
    await p.waitForTimeout(2500); await p.locator('#cv3d').screenshot({ path: `${tag}_${nm}.png`, timeout: 180000 });
  }
  await b.close();
})();
