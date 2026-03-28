/**
 * camera.js – Mundo Real
 *
 * Responsabilidades:
 *  1. Acessa a webcam via getUserMedia
 *  2. Captura frames em intervalos controlados (FPS ajustável)
 *  3. Envia cada frame ao servidor via Socket.IO ("cv_frame")
 *  4. Exibe o frame processado (anotado com bounding boxes) devolvido pelo servidor
 *  5. Atualiza o painel de posições VR e o contador de rostos
 */

"use strict";

// ── Estado ──────────────────────────────────────────────────────────────────
let socket        = null;
let camStream     = null;
let captureTimer  = null;
let aguardando    = false;   // evita enviar novo frame antes de receber o resultado
let frameCount    = 0;
let ultimoFps     = Date.now();

// ── Elementos DOM ────────────────────────────────────────────────────────────
const video       = document.getElementById("video");
const canvas      = document.getElementById("captureCanvas");
const resultImg   = document.getElementById("resultImg");
const noSignal    = document.getElementById("noSignal");
const noResult    = document.getElementById("noResult");
const fpsBadge    = document.getElementById("fpsBadge");
const fpsRange    = document.getElementById("fpsRange");
const fpsVal      = document.getElementById("fpsVal");
const btnStart    = document.getElementById("btnStart");
const btnStop     = document.getElementById("btnStop");
const logPanel    = document.getElementById("logPanel");
const faceCountEl = document.getElementById("faceCount");
const vrList      = document.getElementById("vrList");
const wsStatus    = document.getElementById("wsStatus");

// ── Utilitários ──────────────────────────────────────────────────────────────

/** Adiciona uma linha ao log com timestamp. */
function log(msg, tipo = "info") {
  const p    = document.createElement("p");
  p.className = tipo;
  p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logPanel.appendChild(p);
  logPanel.scrollTop = logPanel.scrollHeight;
  // Mantém o log enxuto (máx. 60 linhas)
  if (logPanel.children.length > 60) logPanel.removeChild(logPanel.firstChild);
}

// ── FPS slider ───────────────────────────────────────────────────────────────
fpsRange.addEventListener("input", () => {
  fpsVal.textContent = fpsRange.value;
  if (captureTimer) reiniciarLoop();
});

// ── Câmera ───────────────────────────────────────────────────────────────────

/** Solicita acesso à câmera e inicia o loop de captura. */
async function iniciarCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    });
    video.srcObject      = camStream;
    video.style.display  = "block";
    noSignal.style.display = "none";
    fpsBadge.style.display = "block";
    btnStart.disabled    = true;
    btnStop.disabled     = false;
    log("Câmera iniciada.");
    iniciarLoop();
  } catch (err) {
    log(`Erro ao acessar câmera: ${err.message}`, "error");
  }
}

/** Para a câmera e o loop de captura. */
function pararCamera() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  clearInterval(captureTimer);
  captureTimer = null;
  video.style.display    = "none";
  video.srcObject        = null;
  noSignal.style.display = "flex";
  fpsBadge.style.display = "none";
  btnStart.disabled      = false;
  btnStop.disabled       = true;
  log("Câmera parada.");
}

function iniciarLoop() {
  const fps      = parseInt(fpsRange.value, 10);
  const intervalo = Math.floor(1000 / fps);
  captureTimer   = setInterval(capturarEEnviar, intervalo);
}

function reiniciarLoop() {
  clearInterval(captureTimer);
  iniciarLoop();
}

/** Captura um frame do vídeo e envia ao servidor. */
function capturarEEnviar() {
  // Não envia novo frame enquanto aguarda resultado do anterior
  if (!socket || !socket.connected || aguardando) return;
  if (!camStream || video.readyState < 2) return;

  const ctx    = canvas.getContext("2d");
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  aguardando = true;
  socket.emit("cv_frame", { image: canvas.toDataURL("image/jpeg", 0.8) });
}

// ── Painel de posições VR ─────────────────────────────────────────────────────

/**
 * Atualiza a lista lateral com as coordenadas VR de cada rosto detectado.
 * @param {Array} detections - lista de {nome, vr_x, vr_y, vr_z, scale, cor}
 */
function atualizarPainelVR(detections) {
  faceCountEl.textContent = detections.length;

  if (detections.length === 0) {
    vrList.innerHTML = '<p class="muted">Aguardando rostos…</p>';
    return;
  }

  vrList.innerHTML = detections.map(d => `
    <div class="vr-item" style="border-left: 3px solid ${d.cor}">
      <strong style="color:${d.cor}">${d.nome}</strong>
      <div class="vr-coords">
        <span title="posição horizontal">X: ${d.vr_x}</span>
        <span title="altura">Y: ${d.vr_y}</span>
        <span title="profundidade estimada">Z: ${d.vr_z}</span>
        <span title="escala do avatar">⇔ ${d.scale}</span>
      </div>
      <div class="vr-pixel">pixel: (${d.px}, ${d.py})</div>
    </div>
  `).join("");
}

// ── Socket.IO ────────────────────────────────────────────────────────────────

function inicializarSocket() {
  socket = io({ transports: ["websocket"] });

  // Conectado ao servidor
  socket.on("connect", () => {
    wsStatus.textContent = "🟢 Conectado";
    wsStatus.className   = "ws-status connected";
    log("Conectado ao servidor.");
    socket.emit("join_camera");   // entra na sala "camera"
  });

  // Desconectado
  socket.on("disconnect", () => {
    wsStatus.textContent = "⚫ Desconectado";
    wsStatus.className   = "ws-status";
    log("Desconectado do servidor.", "warning");
    aguardando = false;
  });

  // Servidor confirmou que está pronto
  socket.on("camera_ready", ({ message }) => {
    log(`Servidor: ${message}`);
  });

  /**
   * Resultado do processamento:
   *   data.image      → frame anotado em base64
   *   data.total      → número de rostos detectados
   *   data.detections → [{nome, px, py, vr_x, vr_y, vr_z, scale, cor}]
   */
  socket.on("cv_result", (data) => {
    aguardando = false;

    // Exibe o frame anotado pelo OpenCV
    resultImg.src         = data.image;
    resultImg.style.display = "block";
    noResult.style.display  = "none";

    // Atualiza painel de posições VR
    atualizarPainelVR(data.detections || []);

    // Contador de FPS
    frameCount++;
    const agora = Date.now();
    if (agora - ultimoFps >= 1000) {
      fpsBadge.textContent = `${frameCount} fps`;
      frameCount    = 0;
      ultimoFps     = agora;
    }
  });
}

// ── Inicialização ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", inicializarSocket);
