/**
 * vr.js – Mundo Virtual
 *
 * O que acontece aqui:
 *  1. Conecta ao servidor e entra na sala "vr"
 *  2. Recebe "vr_avatars" a cada frame processado pela câmera
 *  3. Para cada pessoa detectada: cria ou atualiza um avatar 3D
 *  4. Remove avatares de quem saiu do frame da câmera
 *
 * Conceito de mapeamento (explicar na apresentação):
 *  - Pixel X da câmera  → posição X no mundo 3D  (-5 esq / +5 dir)
 *  - Tamanho do rosto   → posição Z (profundidade) e escala do avatar
 *  - Rosto grande       = pessoa perto  → avatar maior, Z mais negativo
 *  - Rosto pequeno      = pessoa longe → avatar menor, Z mais positivo
 */

"use strict";

// ── Aguarda o A-Frame carregar antes de qualquer manipulação ─────────────────
// Isso evita erros de "elemento não encontrado" durante a inicialização da cena
document.querySelector("a-scene").addEventListener("loaded", inicializar);

// ── Estado ────────────────────────────────────────────────────────────────────
let idsAtivos = new Set();  // IDs dos avatares presentes na cena agora

// ── Referências DOM ───────────────────────────────────────────────────────────
const wsStatus      = document.getElementById("wsStatus");
const avatarCountEl = document.getElementById("avatarCount");
const contentor     = document.getElementById("avatares");      // pai dos avatares na cena
const textoEspera   = document.getElementById("textoEspera");  // aviso inicial

// ── Criação e atualização de avatares ─────────────────────────────────────────

/**
 * Cria ou atualiza o avatar de uma pessoa na cena A-Frame.
 *
 * Estrutura HTML gerada para cada avatar:
 *
 *   <a-entity id="avatar-pessoa_0" position="x y z" scale="s s s">
 *     <a-sphere>                    ← cabeça (cor da pessoa)
 *     <a-cylinder position="0 -0.75 0">  ← corpo
 *     <a-text look-at="[camera]">   ← nome flutuando, sempre virado para o usuário
 *   </a-entity>
 *
 * @param {Object} av  - dados do avatar: {id, nome, x, y, z, scale, cor}
 */
function upsertAvatar(av) {
  const elId = `avatar-${av.id}`;
  let el     = document.getElementById(elId);

  if (!el) {
    // ── Primeira vez: cria a entidade completa ────────────────────────

    el = document.createElement("a-entity");
    el.setAttribute("id", elId);

    // Cabeça — esfera com a cor única da pessoa
    const cabeca = document.createElement("a-sphere");
    cabeca.setAttribute("radius", "0.4");
    cabeca.setAttribute(
      "material",
      // emissive faz a cor aparecer mesmo sem muita luz
      `color: ${av.cor}; emissive: ${av.cor}; emissiveIntensity: 0.4; roughness: 0.5`
    );
    cabeca.setAttribute("shadow", "cast: true");
    el.appendChild(cabeca);

    // Olhos (dois pontos escuros na frente)
    const olhoEsq = document.createElement("a-sphere");
    olhoEsq.setAttribute("position", "-0.15 0.1 0.35");
    olhoEsq.setAttribute("radius",   "0.07");
    olhoEsq.setAttribute("material", "color: #111; emissive: #000");
    el.appendChild(olhoEsq);

    const olhoDir = document.createElement("a-sphere");
    olhoDir.setAttribute("position", "0.15 0.1 0.35");
    olhoDir.setAttribute("radius",   "0.07");
    olhoDir.setAttribute("material", "color: #111; emissive: #000");
    el.appendChild(olhoDir);

    // Corpo — cilindro abaixo da cabeça
    const corpo = document.createElement("a-cylinder");
    corpo.setAttribute("position", "0 -0.75 0");
    corpo.setAttribute("height",   "0.9");
    corpo.setAttribute("radius",   "0.22");
    corpo.setAttribute("material", `color: ${av.cor}; roughness: 0.7; emissive: ${av.cor}; emissiveIntensity: 0.15`);
    corpo.setAttribute("shadow",   "cast: true");
    el.appendChild(corpo);

    // Nome flutuante acima da cabeça
    // O componente look-at (biblioteca externa) mantém o texto virado para a câmera
    const nomeEl = document.createElement("a-text");
    nomeEl.setAttribute("class",     "avatar-nome");
    nomeEl.setAttribute("value",     av.nome);
    nomeEl.setAttribute("align",     "center");
    nomeEl.setAttribute("color",     "#FFFFFF");
    nomeEl.setAttribute("position",  "0 0.85 0");
    nomeEl.setAttribute("scale",     "1.8 1.8 1.8");
    nomeEl.setAttribute("look-at",   "[camera]");  // requer aframe-look-at-component
    el.appendChild(nomeEl);

    // Sombra no chão (círculo escuro embaixo do avatar)
    const sombra = document.createElement("a-circle");
    sombra.setAttribute("position", "0 -1.22 0");
    sombra.setAttribute("rotation", "-90 0 0");
    sombra.setAttribute("radius",   "0.3");
    sombra.setAttribute("material", `color: ${av.cor}; opacity: 0.2; emissive: ${av.cor}`);
    el.appendChild(sombra);

    contentor.appendChild(el);
  }

  // ── A cada frame: atualiza posição e escala ───────────────────────
  el.setAttribute("position", `${av.x} ${av.y} ${av.z}`);
  el.setAttribute("scale",    `${av.scale} ${av.scale} ${av.scale}`);

  // Atualiza o nome (pode mudar se o ID de pessoa mudar)
  const nomeEl = el.querySelector(".avatar-nome");
  if (nomeEl) nomeEl.setAttribute("value", av.nome);
}

/**
 * Remove avatares de pessoas que não aparecem no evento atual.
 * Isso acontece quando alguém sai do campo de visão da câmera.
 *
 * @param {Set<string>} idsRecebidos - IDs presentes no último evento
 */
function removerAusentes(idsRecebidos) {
  idsAtivos.forEach(id => {
    if (!idsRecebidos.has(id)) {
      const el = document.getElementById(`avatar-${id}`);
      if (el) el.parentNode.removeChild(el);
    }
  });
  idsAtivos = new Set(idsRecebidos);
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────

function inicializar() {
  const socket = io({ transports: ["websocket"] });

  socket.on("connect", () => {
    wsStatus.textContent = "🟢 Conectado";
    wsStatus.className   = "ws-status connected";
    // Entra na sala "vr" para receber o evento "vr_avatars"
    socket.emit("join_vr");
  });

  socket.on("disconnect", () => {
    wsStatus.textContent = "⚫ Desconectado";
    wsStatus.className   = "ws-status";
  });

  /**
   * Evento principal — recebido a cada frame com rostos detectados.
   *
   * Payload: [ {id, nome, x, y, z, scale, cor}, ... ]
   *
   * Lista vazia = nenhum rosto no frame atual → remove todos os avatares.
   */
  socket.on("vr_avatars", (avatares) => {
    const idsRecebidos = new Set();

    // Oculta o texto de espera assim que o primeiro avatar aparecer
    if (avatares.length > 0 && textoEspera) {
      textoEspera.setAttribute("visible", "false");
    } else if (avatares.length === 0 && textoEspera) {
      textoEspera.setAttribute("visible", "true");
    }

    // Cria ou atualiza cada avatar
    avatares.forEach(av => {
      upsertAvatar(av);
      idsRecebidos.add(av.id);
    });

    // Remove avatares de quem saiu do frame
    removerAusentes(idsRecebidos);

    // Atualiza o contador no HUD da navbar
    avatarCountEl.textContent = avatares.length;
  });
}
