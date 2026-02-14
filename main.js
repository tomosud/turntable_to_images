const $ = (id) => document.getElementById(id);

const fileEl = $("file");
const runEl = $("run");
const statusEl = $("status");
const canvas = $("preview");
const ctx = canvas.getContext("2d");

const numEl = $("num");
const longSideEl = $("longSide");
const strideEl = $("stride");
const gridEl = $("grid");
const minREl = $("minR");

let center = null; // {x,y} in preview canvas coords (analysis resolution)
let cleanPreviewImageData = null;

function log(msg) {
  statusEl.textContent = msg;
}

function drawCross(x, y) {
  ctx.save();
  ctx.strokeStyle = "red";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 10, y);
  ctx.lineTo(x + 10, y);
  ctx.moveTo(x, y - 10);
  ctx.lineTo(x, y + 10);
  ctx.stroke();
  ctx.restore();
}

canvas.addEventListener("click", (e) => {
  if (!cleanPreviewImageData) return;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);
  center = { x, y };
  ctx.putImageData(cleanPreviewImageData, 0, 0);
  drawCross(x, y);
  log(`中心指定: (${x.toFixed(1)}, ${y.toFixed(1)})`);
});

fileEl.addEventListener("change", async () => {
  if (!fileEl.files?.length) return;
  runEl.disabled = false;
  log("動画を読み込みます…");
  // 先頭フレームを表示するために軽くキャプチャ
  const file = fileEl.files[0];
  const { firstFrameImageData, w, h } = await captureFirstFrame(file, Number(longSideEl.value));
  canvas.width = w;
  canvas.height = h;
  ctx.putImageData(firstFrameImageData, 0, 0);
  cleanPreviewImageData = firstFrameImageData;
  center = null;
  log(`ロード完了。解析解像度: ${w}x${h}。キャンバスをクリックで中心指定。`);
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
    // 中心未指定なら画面中心
    const cx = center ? center.x : w / 2;
    const cy = center ? center.y : h / 2;

    log(`解析開始… frames=${frames.gray.length} / ${w}x${h}\nOpenCV.jsをWorkerでロードします…`);

    const worker = new Worker("./worker.js");

    const selectedIdxs = await new Promise((resolve, reject) => {
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
          resolve(msg.selectedIdxs);
        } else if (msg.type === "error") {
          worker.terminate();
          reject(new Error(msg.error));
        }
      };

      worker.postMessage({
        type: "run",
        w, h,
        grayFrames: frames.gray, // Array<Uint8Array>
        cx, cy,
        N,
        gridStep,
        minR,
      });
    });

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
    a.download = "frames.zip";
    a.click();
    URL.revokeObjectURL(a.href);

    log("完了。frames.zip をダウンロードしました。");
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
