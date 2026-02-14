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

    const { selectedIdxs, omegas, omegasSmoothed } = workerResult;

    drawOmegaGraph(omegas, omegasSmoothed, selectedIdxs);
    drawThumbnails(selectedIdxs, frames.rgba, w, h);

    log(`抽出フレーム選択完了。Zip生成中…（${selectedIdxs.length}枚）`);

    // Zip化（解析解像度の画像をそのまま出力：最短ルート）
    const zip = new JSZip();
    const outCanvas = document.createElement("canvas");
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext("2d");

    for (let k = 0; k < selectedIdxs.length; k++) {
      const idx = selectedIdxs[k];
      const imgData = frames.rgba[idx];
      outCtx.putImageData(imgData, 0, 0);

      const blob = await new Promise((res) => outCanvas.toBlob(res, "image/png"));
      zip.file(`${String(k).padStart(4, "0")}.png`, blob);
      if (k % 10 === 0) log(`Zip生成中… ${k}/${selectedIdxs.length}`);
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
  return { w, h, gray, rgba };
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

function drawOmegaGraph(omegas, omegasSmoothed, selectedIdxs) {
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
