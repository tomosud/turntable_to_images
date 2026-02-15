const $ = (id) => document.getElementById(id);

const fileEl = $("file");
const runEl = $("run");
const statusEl = $("status");
const canvas = $("preview");
const ctx = canvas.getContext("2d");
const graphContainer = $("graphContainer");
const graphCanvas = $("graph");
const graphCtx = graphCanvas.getContext("2d");

const numEl = $("num");
const longSideEl = $("longSide");
const strideEl = $("stride");
const gridEl = $("grid");
const minREl = $("minR");

// Debug state
let debugState = null; // { w, h, rgbaFrames, gridPts, flows, medianOmegas }

// Graph state (for redraw with cursor)
let graphState = null; // { omegas, omegasSmoothed, selectedIdxs }

function log(msg) {
  statusEl.textContent = msg;
}

fileEl.addEventListener("change", async () => {
  if (!fileEl.files?.length) return;
  runEl.disabled = false;
  log("動画を読み込みます…");
  const file = fileEl.files[0];
  const { firstFrameImageData, w, h } = await captureFirstFrame(file, Number(longSideEl.value));
  canvas.width = w;
  canvas.height = h;
  ctx.putImageData(firstFrameImageData, 0, 0);
  log(`ロード完了。解析解像度: ${w}x${h}`);
});

runEl.addEventListener("click", async () => {
  if (!fileEl.files?.length) return;

  runEl.disabled = true;
  try {
    const file = fileEl.files[0];
    const N = Number(numEl.value);
    const longSide = Number(longSideEl.value);
    const stride = Number(strideEl.value);
    const gridStep = Number(gridEl.value);
    const minR = Number(minREl.value);

    log("フレーム抽出中…（動画を再生しながら吸い出します）");
    const frames = await captureFramesFromVideo(file, longSide, stride, (p) => {
      log(`フレーム抽出中… ${p}`);
    });

    const w = frames.w, h = frames.h;
    const cx = w / 2;
    const cy = h / 2;

    log(`解析開始… frames=${frames.gray.length} / ${w}x${h}\nOpenCV.jsをWorkerでロードします…`);

    const worker = new Worker("./worker.js");

    const workerResult = await new Promise((resolve, reject) => {
      worker.onerror = (e) => {
        e.preventDefault();
        worker.terminate();
        reject(new Error("Workerの読み込みに失敗: " + (e.message || "不明なエラー")));
      };

      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === "log") {
          log(msg.text);
        } else if (msg.type === "result") {
          worker.terminate();
          resolve(msg);
        } else if (msg.type === "error") {
          worker.terminate();
          reject(new Error(msg.error));
        }
      };

      worker.postMessage({
        type: "run",
        w, h,
        grayFrames: frames.gray,
        cx, cy,
        N,
        gridStep,
        minR,
      });
    });

    const { selectedIdxs, omegas, omegasSmoothed, debug } = workerResult;

    drawOmegaGraph(omegas, omegasSmoothed, selectedIdxs);
    drawThumbnails(selectedIdxs, frames.rgba, w, h);

    // デバッグ可視化を初期化
    if (debug) {
      initDebugView(w, h, frames.rgba, debug.gridPts, debug.flows, omegas, selectedIdxs);
    }

    log(`抽出フレーム選択完了。元解像度でフレームを再取得中…（${selectedIdxs.length}枚）`);

    // 選択されたフレームのタイムスタンプを集めて元解像度でキャプチャ
    const selectedTimestamps = selectedIdxs.map((idx) => frames.timestamps[idx]);
    const fullRes = await captureFullResFrames(file, selectedTimestamps, (done, total) => {
      log(`元解像度フレーム取得中… ${done}/${total}`);
    });

    log(`Zip生成中…（${selectedIdxs.length}枚, ${fullRes.ow}x${fullRes.oh}）`);
    const zip = new JSZip();

    for (let k = 0; k < fullRes.blobs.length; k++) {
      zip.file(`${String(k).padStart(4, "0")}.png`, fullRes.blobs[k]);
      if (k % 10 === 0) log(`Zip生成中… ${k}/${fullRes.blobs.length}`);
    }

    const zipBlob = await zip.generateAsync({ type: "blob" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(zipBlob);
    const baseName = file.name.replace(/\.[^.]+$/, "");
    const zipName = baseName + "_frames.zip";
    a.download = zipName;
    a.click();
    URL.revokeObjectURL(a.href);

    log(`完了。${zipName} をダウンロードしました。`);
  } catch (err) {
    console.error(err);
    log(`エラー: ${err.message}`);
  } finally {
    runEl.disabled = false;
  }
});

// ---- helpers ----

async function captureFirstFrame(file, longSide) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = URL.createObjectURL(file);

  await videoLoaded(video);

  const { w, h } = fitToLongSide(video.videoWidth, video.videoHeight, longSide);

  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cctx = c.getContext("2d");
  video.currentTime = 0;
  await seeked(video, 0);
  cctx.drawImage(video, 0, 0, w, h);
  const img = cctx.getImageData(0, 0, w, h);

  URL.revokeObjectURL(video.src);
  return { firstFrameImageData: img, w, h };
}

async function captureFramesFromVideo(file, longSide, stride, onProgress) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = URL.createObjectURL(file);

  await videoLoaded(video);

  const { w, h } = fitToLongSide(video.videoWidth, video.videoHeight, longSide);

  // 解析用キャンバス（縮小）
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const cctx = c.getContext("2d", { willReadFrequently: true });

  const gray = [];
  const rgba = [];
  const timestamps = [];

  let frameCount = 0;
  let kept = 0;

  // 再生して requestVideoFrameCallback で吸い出す（5秒程度ならこれで十分）
  video.currentTime = 0;
  await video.play();

  const done = new Promise((resolve) => {
    video.onended = () => resolve();
  });

  const step = (now, metadata) => {
    // stride間引き
    if (frameCount % stride === 0) {
      cctx.drawImage(video, 0, 0, w, h);
      const img = cctx.getImageData(0, 0, w, h);
      rgba.push(img);
      timestamps.push(video.currentTime);

      // グレースケール化（OpenCV側に渡す用）
      const g = new Uint8Array(w * h);
      const d = img.data;
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        // 速さ優先: (0.299R+0.587G+0.114B) の近似
        g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      }
      gray.push(g);
      kept++;
    }

    frameCount++;
    if (onProgress && frameCount % 15 === 0) {
      onProgress(`captured=${kept} (raw=${frameCount}) / t=${video.currentTime.toFixed(2)}s`);
    }

    if (!video.ended) {
      video.requestVideoFrameCallback(step);
    }
  };

  video.requestVideoFrameCallback(step);
  await done;

  URL.revokeObjectURL(video.src);
  return { w, h, gray, rgba, timestamps };
}

async function captureFullResFrames(file, timestamps, onProgress) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = URL.createObjectURL(file);

  await videoLoaded(video);

  const ow = video.videoWidth;
  const oh = video.videoHeight;
  const c = document.createElement("canvas");
  c.width = ow;
  c.height = oh;
  const cctx = c.getContext("2d", { willReadFrequently: true });

  const blobs = [];
  for (let i = 0; i < timestamps.length; i++) {
    await seeked(video, timestamps[i]);
    cctx.drawImage(video, 0, 0, ow, oh);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    blobs.push(blob);
    if (onProgress) onProgress(i + 1, timestamps.length);
  }

  URL.revokeObjectURL(video.src);
  return { ow, oh, blobs };
}

function fitToLongSide(w, h, longSide) {
  const s = longSide / Math.max(w, h);
  return { w: Math.max(2, Math.round(w * s)), h: Math.max(2, Math.round(h * s)) };
}

function videoLoaded(video) {
  return new Promise((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("動画の読み込みに失敗しました"));
  });
}

function seeked(video, t) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error("seek失敗")); };
    const cleanup = () => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onErr);
    video.currentTime = t;
  });
}

function drawOmegaGraph(omegas, omegasSmoothed, selectedIdxs, cursorFrame) {
  graphState = { omegas, omegasSmoothed, selectedIdxs };
  graphContainer.style.display = "";

  const W = graphCanvas.width;
  const H = graphCanvas.height;
  const pad = { top: 10, bottom: 20, left: 45, right: 10 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  graphCtx.clearRect(0, 0, W, H);

  const allVals = omegas.concat(omegasSmoothed);
  let minV = Math.min(...allVals);
  let maxV = Math.max(...allVals);
  if (maxV - minV < 1e-9) { minV -= 0.01; maxV += 0.01; }
  const margin = (maxV - minV) * 0.05;
  minV -= margin;
  maxV += margin;

  const n = omegas.length;
  const xOf = (i) => pad.left + (i / (n - 1)) * plotW;
  const yOf = (v) => pad.top + plotH - ((v - minV) / (maxV - minV)) * plotH;

  // axes
  graphCtx.strokeStyle = "#999";
  graphCtx.lineWidth = 1;
  graphCtx.beginPath();
  graphCtx.moveTo(pad.left, pad.top);
  graphCtx.lineTo(pad.left, H - pad.bottom);
  graphCtx.lineTo(W - pad.right, H - pad.bottom);
  graphCtx.stroke();

  // y-axis labels
  graphCtx.fillStyle = "#666";
  graphCtx.font = "10px system-ui";
  graphCtx.textAlign = "right";
  graphCtx.textBaseline = "middle";
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = minV + (maxV - minV) * (i / yTicks);
    const y = yOf(v);
    graphCtx.fillText(v.toFixed(3), pad.left - 4, y);
    graphCtx.strokeStyle = "#e0e0e0";
    graphCtx.beginPath();
    graphCtx.moveTo(pad.left, y);
    graphCtx.lineTo(W - pad.right, y);
    graphCtx.stroke();
  }

  // x-axis label
  graphCtx.fillStyle = "#666";
  graphCtx.textAlign = "center";
  graphCtx.textBaseline = "top";
  graphCtx.fillText("frame", W / 2, H - pad.bottom + 6);

  // selected frame markers
  for (let k = 0; k < selectedIdxs.length; k++) {
    const idx = selectedIdxs[k];
    const x = xOf(idx);
    graphCtx.strokeStyle = "rgba(255, 80, 80, 0.45)";
    graphCtx.lineWidth = 1;
    graphCtx.beginPath();
    graphCtx.moveTo(x, pad.top);
    graphCtx.lineTo(x, pad.top + plotH);
    graphCtx.stroke();
    // frame number label at bottom
    graphCtx.fillStyle = "rgba(255, 80, 80, 0.6)";
    graphCtx.font = "8px system-ui";
    graphCtx.textAlign = "center";
    graphCtx.textBaseline = "bottom";
    graphCtx.fillText(String(k), x, pad.top + plotH - 2);
  }

  // raw omegas (thin, light)
  graphCtx.strokeStyle = "rgba(200, 200, 200, 0.7)";
  graphCtx.lineWidth = 1;
  graphCtx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xOf(i), y = yOf(omegas[i]);
    i === 0 ? graphCtx.moveTo(x, y) : graphCtx.lineTo(x, y);
  }
  graphCtx.stroke();

  // smoothed omegas (bold, blue)
  graphCtx.strokeStyle = "#2060c0";
  graphCtx.lineWidth = 2;
  graphCtx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xOf(i), y = yOf(omegasSmoothed[i]);
    i === 0 ? graphCtx.moveTo(x, y) : graphCtx.lineTo(x, y);
  }
  graphCtx.stroke();

  // debug cursor line (green, bold)
  if (cursorFrame != null && cursorFrame >= 0 && cursorFrame < n) {
    const cx = xOf(cursorFrame);
    graphCtx.strokeStyle = "rgba(0, 220, 80, 0.8)";
    graphCtx.lineWidth = 2;
    graphCtx.beginPath();
    graphCtx.moveTo(cx, pad.top);
    graphCtx.lineTo(cx, pad.top + plotH);
    graphCtx.stroke();
    // frame label
    graphCtx.fillStyle = "rgba(0, 220, 80, 0.9)";
    graphCtx.font = "10px system-ui";
    graphCtx.textAlign = "center";
    graphCtx.textBaseline = "bottom";
    graphCtx.fillText(`F${cursorFrame}`, cx, pad.top - 1);
    // omega value dot
    const vy = yOf(omegasSmoothed[cursorFrame]);
    graphCtx.fillStyle = "rgba(0, 220, 80, 0.9)";
    graphCtx.beginPath();
    graphCtx.arc(cx, vy, 3, 0, Math.PI * 2);
    graphCtx.fill();
  }

  // legend
  graphCtx.lineWidth = 1;
  const lx = pad.left + 8;
  const ly = pad.top + 6;
  graphCtx.strokeStyle = "rgba(200,200,200,0.7)";
  graphCtx.beginPath(); graphCtx.moveTo(lx, ly + 4); graphCtx.lineTo(lx + 20, ly + 4); graphCtx.stroke();
  graphCtx.fillStyle = "#999";
  graphCtx.textAlign = "left";
  graphCtx.textBaseline = "middle";
  graphCtx.fillText("raw", lx + 24, ly + 4);

  graphCtx.strokeStyle = "#2060c0";
  graphCtx.lineWidth = 2;
  graphCtx.beginPath(); graphCtx.moveTo(lx, ly + 18); graphCtx.lineTo(lx + 20, ly + 18); graphCtx.stroke();
  graphCtx.fillStyle = "#2060c0";
  graphCtx.fillText("smoothed", lx + 24, ly + 18);
}

function drawThumbnails(selectedIdxs, rgbaFrames, w, h) {
  const container = $("thumbsContainer");
  const thumbsEl = $("thumbs");
  container.style.display = "";
  thumbsEl.innerHTML = "";

  const thumbH = 80;
  const thumbW = Math.round((w / h) * thumbH);

  for (let k = 0; k < selectedIdxs.length; k++) {
    const idx = selectedIdxs[k];
    const imgData = rgbaFrames[idx];

    const c = document.createElement("canvas");
    c.width = thumbW;
    c.height = thumbH;
    c.title = `#${k} (frame ${idx})`;
    c.dataset.frameIdx = idx;
    c.style.transition = "outline 0.1s";

    const tctx = c.getContext("2d");
    // draw full-size to offscreen, then scale down
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d").putImageData(imgData, 0, 0);
    tctx.drawImage(tmp, 0, 0, thumbW, thumbH);

    thumbsEl.appendChild(c);
  }
}

// ---- Debug Visualization ----

function initDebugView(w, h, rgbaFrames, gridPts, flows, medianOmegas, selectedIdxs) {
  const container = $("debugContainer");
  container.style.display = "";

  const dbgCanvas = $("debugCanvas");
  dbgCanvas.width = w;
  dbgCanvas.height = h;

  const slider = $("debugSlider");
  const frameLabel = $("debugFrameLabel");
  const arrowScaleSlider = $("debugArrowScale");
  const arrowScaleLabel = $("debugArrowScaleLabel");

  // flows配列はフレーム1～N-1に対応 (index 0 = frame 1)
  const maxFrame = flows.length; // = frameCount - 1
  slider.min = 1;
  slider.max = maxFrame;
  slider.value = 1;
  frameLabel.textContent = "1";

  debugState = { w, h, rgbaFrames, gridPts, flows, medianOmegas, selectedIdxs };

  const redraw = () => {
    drawDebugFrame();
    // グラフ上にもカーソル表示
    if (graphState) {
      const { omegas, omegasSmoothed, selectedIdxs } = graphState;
      drawOmegaGraph(omegas, omegasSmoothed, selectedIdxs, Number(slider.value));
    }
    // サムネイルハイライト
    highlightThumbnail(Number(slider.value));
  };

  slider.addEventListener("input", () => {
    frameLabel.textContent = slider.value;
    redraw();
  });
  arrowScaleSlider.addEventListener("input", () => {
    arrowScaleLabel.textContent = arrowScaleSlider.value;
    redraw();
  });
  $("debugShowGrid").addEventListener("change", redraw);
  $("debugShowFlow").addEventListener("change", redraw);
  $("debugShowSpeed").addEventListener("change", redraw);

  redraw();
}

function drawDebugFrame() {
  if (!debugState) return;
  const { w, h, rgbaFrames, gridPts, flows, medianOmegas } = debugState;

  const dbgCanvas = $("debugCanvas");
  const dctx = dbgCanvas.getContext("2d");
  const frameIdx = Number($("debugSlider").value); // 1-based (flows[0] = frame 1)
  const flowIdx = frameIdx - 1;
  const arrowScale = Number($("debugArrowScale").value);
  const showGrid = $("debugShowGrid").checked;
  const showFlow = $("debugShowFlow").checked;
  const showSpeed = $("debugShowSpeed").checked;

  // 背景: 該当フレームの映像を半透明で描画
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  tmp.getContext("2d").putImageData(rgbaFrames[frameIdx], 0, 0);
  dctx.clearRect(0, 0, w, h);
  dctx.globalAlpha = 0.4;
  dctx.drawImage(tmp, 0, 0);
  dctx.globalAlpha = 1.0;

  const flow = flows[flowIdx];
  if (!flow) return;

  const medianOmega = medianOmegas[frameIdx];

  // omega の範囲を計算（色分け用）
  let minOmega = Infinity, maxOmega = -Infinity;
  for (let i = 0; i < flow.omega.length; i++) {
    const o = flow.omega[i];
    if (o < minOmega) minOmega = o;
    if (o > maxOmega) maxOmega = o;
  }

  for (let i = 0; i < gridPts.length; i++) {
    const pt = gridPts[i];
    const fx = flow.fx[i];
    const fy = flow.fy[i];
    const omega = flow.omega[i];

    // 速度色分け: 中央値からの乖離度で色付け
    // 中央値に近い = 緑, 乖離 = 赤
    const deviation = Math.abs(omega - medianOmega);
    const maxDev = Math.max(Math.abs(maxOmega - medianOmega), Math.abs(minOmega - medianOmega), 1e-9);
    const devRatio = Math.min(deviation / maxDev, 1.0);

    if (showSpeed) {
      // 背景にドットの速度ヒートマップ
      const r = Math.round(255 * devRatio);
      const g = Math.round(255 * (1 - devRatio));
      dctx.fillStyle = `rgba(${r}, ${g}, 60, 0.5)`;
      dctx.beginPath();
      dctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      dctx.fill();
    }

    if (showGrid) {
      // グリッド点を小さい白い点で表示
      dctx.fillStyle = "rgba(255, 255, 255, 0.8)";
      dctx.beginPath();
      dctx.arc(pt.x, pt.y, 1.5, 0, Math.PI * 2);
      dctx.fill();
    }

    if (showFlow) {
      // フロー矢印を描画
      const endX = pt.x + fx * arrowScale;
      const endY = pt.y + fy * arrowScale;

      // 矢印の色: 中央値に近い=シアン、乖離=マゼンタ
      const cr = Math.round(200 * devRatio + 50);
      const cg = Math.round(200 * (1 - devRatio));
      const cb = Math.round(200);
      dctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.7)`;
      dctx.lineWidth = 1;

      // 線
      dctx.beginPath();
      dctx.moveTo(pt.x, pt.y);
      dctx.lineTo(endX, endY);
      dctx.stroke();

      // 矢じり
      const mag = Math.hypot(fx, fy) * arrowScale;
      if (mag > 2) {
        const angle = Math.atan2(fy, fx);
        const headLen = Math.min(mag * 0.35, 5);
        dctx.beginPath();
        dctx.moveTo(endX, endY);
        dctx.lineTo(
          endX - headLen * Math.cos(angle - 0.5),
          endY - headLen * Math.sin(angle - 0.5)
        );
        dctx.moveTo(endX, endY);
        dctx.lineTo(
          endX - headLen * Math.cos(angle + 0.5),
          endY - headLen * Math.sin(angle + 0.5)
        );
        dctx.stroke();
      }
    }
  }

  // 中心点の表示
  const cx = w / 2, cy = h / 2;
  dctx.strokeStyle = "rgba(255, 255, 0, 0.6)";
  dctx.lineWidth = 1;
  dctx.beginPath();
  dctx.arc(cx, cy, Number(minREl.value), 0, Math.PI * 2);
  dctx.stroke();
  // 十字
  dctx.beginPath();
  dctx.moveTo(cx - 8, cy); dctx.lineTo(cx + 8, cy);
  dctx.moveTo(cx, cy - 8); dctx.lineTo(cx, cy + 8);
  dctx.stroke();

  // 情報テキスト
  dctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  dctx.font = "11px monospace";
  dctx.textAlign = "left";
  dctx.textBaseline = "top";
  dctx.fillText(`Frame ${frameIdx}  |  median \u03c9 = ${medianOmega.toFixed(5)} rad/f  |  pts = ${gridPts.length}`, 4, 4);

  // 凡例
  dctx.fillStyle = "rgba(0, 255, 80, 0.8)";
  dctx.fillRect(4, 20, 8, 8);
  dctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  dctx.fillText("= near median", 16, 19);

  dctx.fillStyle = "rgba(255, 0, 60, 0.8)";
  dctx.fillRect(4, 33, 8, 8);
  dctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  dctx.fillText("= outlier (deviation from median)", 16, 32);
}

function highlightThumbnail(cursorFrame) {
  if (!debugState) return;
  const { selectedIdxs } = debugState;
  const thumbs = $("thumbs").querySelectorAll("canvas");

  // カーソルが属する区間の抽出フレームを探す
  // selectedIdxs[k] <= cursorFrame < selectedIdxs[k+1] なら k をハイライト
  let matchK = 0;
  for (let k = 0; k < selectedIdxs.length; k++) {
    if (selectedIdxs[k] <= cursorFrame) {
      matchK = k;
    }
  }

  thumbs.forEach((c, k) => {
    if (k === matchK) {
      c.style.outline = "3px solid #00dc50";
      c.style.outlineOffset = "1px";
      c.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    } else {
      c.style.outline = "";
      c.style.outlineOffset = "";
    }
  });
}
