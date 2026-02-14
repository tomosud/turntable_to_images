// Worker (classic)
// OpenCV.js を読み込み → Farneback → グリッド中央値で ω → 積分で θ → 等角度でインデックス選択

let cvReady = false;

function postLog(text) {
  self.postMessage({ type: "log", text });
}

async function loadOpenCV() {
  if (cvReady) return;

  postLog("OpenCV.js 読み込み中…");
  try {
    importScripts("https://docs.opencv.org/4.x/opencv.js");
  } catch (e) {
    throw new Error(
      "OpenCV.js の CDN 読み込みに失敗しました。" +
      "opencv.js と opencv.wasm をプロジェクトフォルダに配置し、" +
      "importScripts を './opencv.js' に変更してください。" +
      " 元エラー: " + e.message
    );
  }

  // importScripts は同期的。WASM が既に初期化済みなら cv.Mat が存在する。
  // まだなら onRuntimeInitialized コールバックを待つ。
  if (!(typeof cv !== "undefined" && cv.Mat)) {
    await new Promise((resolve) => {
      const existing = cv["onRuntimeInitialized"];
      cv["onRuntimeInitialized"] = () => {
        if (existing) existing();
        resolve();
      };
    });
  }

  cvReady = true;
  postLog("OpenCV.js Ready");
}

function median(arr) {
  // arr: Float64Array or Array<number>
  const a = Array.from(arr);
  a.sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return (n % 2) ? a[mid] : (a[mid - 1] + a[mid]) * 0.5;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type !== "run") return;

  try {
    await loadOpenCV();

    const { w, h, grayFrames, cx, cy, N, gridStep, minR } = msg;
    const frameCount = grayFrames.length;
    if (frameCount < 3) throw new Error("フレームが少なすぎます。strideを1にしてみてください。");

    postLog(`解析中… frameCount=${frameCount}, gridStep=${gridStep}`);

    // Farneback params（速さ優先でそこそこ堅い）
    const pyr_scale = 0.5;
    const levels = 3;
    const winsize = 31;
    const iterations = 3;
    const poly_n = 7;
    const poly_sigma = 1.5;
    const flags = 0;

    let prev = new cv.Mat(h, w, cv.CV_8UC1);
    prev.data.set(grayFrames[0]);

    const omegas = new Float64Array(frameCount);
    omegas[0] = 0.0;

    // 事前にグリッド点を作る
    const pts = [];
    for (let y = Math.floor(gridStep / 2); y < h; y += gridStep) {
      for (let x = Math.floor(gridStep / 2); x < w; x += gridStep) {
        const dx = x - cx;
        const dy = y - cy;
        const r = Math.hypot(dx, dy);
        if (r < minR) continue;
        // 接線単位ベクトル t = (-dy, dx)/r
        const tx = -dy / r;
        const ty = dx / r;
        pts.push({ x, y, r, tx, ty });
      }
    }
    if (pts.length < 50) throw new Error("有効グリッド点が少なすぎます（minRやgridStepを調整）。");

    const flow = new cv.Mat(); // CV_32FC2

    for (let i = 1; i < frameCount; i++) {
      const cur = new cv.Mat(h, w, cv.CV_8UC1);
      cur.data.set(grayFrames[i]);

      cv.calcOpticalFlowFarneback(prev, cur, flow, pyr_scale, levels, winsize, iterations, poly_n, poly_sigma, flags);

      // flow.data32F: [fx,fy, fx,fy, ...]
      const data = flow.data32F;
      const samples = [];

      for (const p of pts) {
        const idx = (p.y * w + p.x) * 2;
        const fx = data[idx];
        const fy = data[idx + 1];
        const vt = fx * p.tx + fy * p.ty;  // 接線方向成分
        const omega = vt / p.r;            // rad/frame 近似
        samples.push(omega);
      }

      // 中央値で頑健に
      omegas[i] = median(samples);

      prev.delete();
      prev = cur;

      if (i % 10 === 0) postLog(`解析中… ${i}/${frameCount}`);
    }

    flow.delete();
    prev.delete();

    // 角速度の軽い平滑化（移動平均）— S字を潰しすぎない程度
    const smoothW = 9;
    const omegasS = new Float64Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      let sum = 0, cnt = 0;
      for (let k = -Math.floor(smoothW/2); k <= Math.floor(smoothW/2); k++) {
        const j = i + k;
        if (j < 0 || j >= frameCount) continue;
        sum += omegas[j];
        cnt++;
      }
      omegasS[i] = sum / Math.max(1, cnt);
    }

    // 積分してθ
    const theta = new Float64Array(frameCount);
    theta[0] = 0.0;
    for (let i = 1; i < frameCount; i++) {
      theta[i] = theta[i - 1] + omegasS[i];
    }

    // 1周（全尺）想定なので 2π に正規化
    const total = theta[frameCount - 1];
    if (Math.abs(total) < 1e-6) throw new Error("回転量がほぼ0です（中心ズレ/特徴不足/解析解像度が低すぎる可能性）。");

    for (let i = 0; i < frameCount; i++) theta[i] = theta[i] * (2.0 * Math.PI / total);

    // 等角度ターゲットに最も近いフレームを拾う
    const targets = [];
    for (let k = 0; k < N; k++) targets.push((2.0 * Math.PI * k) / N);

    const selectedIdxs = [];
    for (const t of targets) {
      let bestI = 0;
      let bestD = Infinity;
      for (let i = 0; i < frameCount; i++) {
        const d = Math.abs(theta[i] - t);
        if (d < bestD) { bestD = d; bestI = i; }
      }
      selectedIdxs.push(bestI);
    }

    postLog("フレーム選択完了。Zip生成に移ります…");
    self.postMessage({ type: "result", selectedIdxs });

  } catch (e) {
    self.postMessage({ type: "error", error: e?.message ?? String(e) });
  }
};
