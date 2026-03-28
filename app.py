"""
Servidor – Realidade Mista: Câmera Real → Avatares Virtuais
Disciplina: AR/VR e Visão Computacional

Fluxo:
  1. camera.html captura frames da webcam e envia via Socket.IO ("cv_frame")
  2. Este servidor detecta rostos com OpenCV Haar Cascade
  3. Cada rosto vira um avatar com posição mapeada para coordenadas 3D
  4. Os avatares são emitidos em tempo real para vr.html ("vr_avatars")
  5. A cena A-Frame em vr.html exibe cada pessoa como um objeto 3D
"""

import base64
import logging
import math

import cv2
import numpy as np
from flask import Flask, render_template
from flask_socketio import SocketIO, emit, join_room

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["SECRET_KEY"] = "projeto-arvrcv-secret"

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="eventlet",
    logger=False,
    engineio_logger=False,
)

# Carrega o classificador Haar para detecção frontal de rostos
# (arquivo incluído no próprio OpenCV, não precisa baixar nada)
FACE_CASCADE = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)

# ---------------------------------------------------------------------------
# Paleta de cores por índice de pessoa
# BGR  → para desenhar no frame OpenCV
# HEX  → para usar no A-Frame (HTML)
# ---------------------------------------------------------------------------
PERSON_COLORS_BGR = [
    (255,  80,  80),   # azul-claro
    ( 80, 220,  80),   # verde
    ( 80,  80, 255),   # vermelho
    (255, 220,  80),   # ciano
    (200,  80, 255),   # violeta
    ( 80, 255, 220),   # amarelo-esverdeado
]

PERSON_COLORS_HEX = [
    "#FF5050",
    "#50DC50",
    "#5050FF",
    "#50DCF0",
    "#C850FF",
    "#50FFD0",
]

# ---------------------------------------------------------------------------
# Rastreamento estável de rostos entre frames
#
# Problema sem tracker: o OpenCV não garante ordem de detecção consistente.
# Se dois rostos mudam de posição relativa, "Pessoa 1" e "Pessoa 2" trocam,
# causando piscar de avatares na cena VR.
#
# Solução: manter um dicionário de rostos "vistos" e associar cada nova
# detecção ao rosto mais próximo do frame anterior (distância de centroide).
# ---------------------------------------------------------------------------
_tracker      = {}   # {id: {"cx", "cy", "slot", "ausente"}}
_proximo_id   = 0    # contador para gerar IDs únicos crescentes

DIST_MAXIMA   = 120  # pixels — distância máxima para considerar o mesmo rosto
FRAMES_SUMIR  = 8    # frames sem aparecer antes de remover da memória


def _associar_faces(faces_detectadas):
    """
    Recebe lista de (x, y, w, h) e retorna lista de dicts com id e slot de cor
    estáveis entre frames consecutivos.
    """
    global _proximo_id

    # Incrementa contador de ausência de todos; será zerado ao reencontrar
    for entry in _tracker.values():
        entry["ausente"] += 1

    resultado = []

    for (x, y, w, h) in faces_detectadas:
        cx = x + w // 2
        cy = y + h // 2

        # Procura o rosto rastreado mais próximo dentro do limiar
        melhor_id   = None
        melhor_dist = DIST_MAXIMA + 1

        for fid, entry in _tracker.items():
            d = math.hypot(cx - entry["cx"], cy - entry["cy"])
            if d < melhor_dist:
                melhor_dist = d
                melhor_id   = fid

        if melhor_id is not None:
            # Mesmo rosto do frame anterior: atualiza posição
            _tracker[melhor_id]["cx"]      = cx
            _tracker[melhor_id]["cy"]      = cy
            _tracker[melhor_id]["ausente"] = 0
            resultado.append({"id": melhor_id, "slot": _tracker[melhor_id]["slot"]})
        else:
            # Rosto novo: registra com slot de cor e ID únicos
            slot = _proximo_id % len(PERSON_COLORS_HEX)
            fid  = _proximo_id
            _proximo_id += 1
            _tracker[fid] = {"cx": cx, "cy": cy, "slot": slot, "ausente": 0}
            resultado.append({"id": fid, "slot": slot})

    # Remove rostos que sumiram por muitos frames consecutivos
    for fid in [k for k, v in _tracker.items() if v["ausente"] > FRAMES_SUMIR]:
        del _tracker[fid]

    return resultado


# ---------------------------------------------------------------------------
# Rotas HTTP
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    """Página inicial com links para câmera e cena VR."""
    return render_template("index.html")


@app.route("/camera")
def camera():
    """Painel de câmera – mundo real com detecção facial."""
    return render_template("camera.html")


@app.route("/vr")
def vr():
    """Cena A-Frame – mundo virtual com avatares 3D."""
    return render_template("vr.html")


# ---------------------------------------------------------------------------
# Eventos Socket.IO – Câmera
# ---------------------------------------------------------------------------
@socketio.on("join_camera")
def on_join_camera():
    """Cliente da câmera entra na sala 'camera'."""
    join_room("camera")
    emit("camera_ready", {"message": "Servidor pronto para processar frames."})
    logger.info("Cliente de câmera conectado.")


@socketio.on("join_vr")
def on_join_vr():
    """Cliente da cena VR entra na sala 'vr'."""
    join_room("vr")
    logger.info("Cliente VR conectado.")


@socketio.on("cv_frame")
def on_cv_frame(data):
    """
    Recebe um frame da câmera, detecta rostos e emite os resultados.

    Entrada:
        data["image"]  → frame em base64 (JPEG)

    Saída (emit):
        "cv_result"   → imagem anotada + lista de detecções  (para câmera)
        "vr_avatars"  → lista de avatares com posição 3D     (para cena VR)
    """
    image_b64 = data.get("image", "")
    if not image_b64:
        return

    try:
        # ── Decodifica base64 → numpy array ──────────────────────────────
        _, encoded = image_b64.split(",", 1) if "," in image_b64 else ("", image_b64)
        frame = cv2.imdecode(
            np.frombuffer(base64.b64decode(encoded), dtype=np.uint8),
            cv2.IMREAD_COLOR,
        )
        if frame is None:
            return

        frame_h, frame_w = frame.shape[:2]
        resultado         = frame.copy()

        # ── Detecta rostos ───────────────────────────────────────────────
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # Equalização de histograma: melhora contraste em ambientes com
        # iluminação ruim ou não uniforme, ajudando o classificador Haar
        gray = cv2.equalizeHist(gray)

        faces = FACE_CASCADE.detectMultiScale(
            gray,
            scaleFactor=1.1,   # passo entre escalas (1.1 = preciso, igual ao projeto base)
            minNeighbors=8,    # candidatos precisam de 8 vizinhos confirmados (↑ = menos falsos positivos)
            minSize=(80, 80),  # ignora detecções menores que 80x80 px (fundo, objetos)
            maxSize=(500, 500),# ignora detecções absurdamente grandes
            flags=cv2.CASCADE_SCALE_IMAGE,
        )

        vr_avatars  = []   # enviado para vr.html
        detections  = []   # enviado de volta para camera.html

        # Converte numpy.int32 → int nativo antes de qualquer operação
        faces_int = [(int(x), int(y), int(w), int(h)) for x, y, w, h in faces] \
                    if len(faces) > 0 else []

        # Associa cada detecção a um ID estável via rastreamento por centroide
        rastreados = _associar_faces(faces_int)

        for (x, y, w, h), info in zip(faces_int, rastreados):
            cor_bgr = PERSON_COLORS_BGR[info["slot"]]
            cor_hex = PERSON_COLORS_HEX[info["slot"]]
            nome    = f"Pessoa {info['slot'] + 1}"

            # Centro do rosto em pixels
            cx = x + w // 2
            cy = y + h // 2

            # ── Mapeamento 2D → 3D ───────────────────────────────────────
            # O frame da câmera é tratado como uma janela 2D.
            # Convertemos a posição normalizada (0–1) para o espaço VR.
            #
            #   vr_x  : -5 (esquerda) até +5 (direita)
            #   vr_y  : altura fixa no nível dos olhos (1.6 m)
            #   vr_z  : profundidade simulada pelo tamanho do rosto
            #           → rosto maior  = mais perto (z menor / mais negativo)
            #           → rosto menor  = mais longe (z maior / mais positivo)
            #   scale : tamanho do avatar proporcional ao rosto

            vr_x     = round((cx / frame_w - 0.5) * 10,  2)  # -5 a +5
            vr_y     = 1.6                                      # altura fixa
            vr_z     = round(-(w / frame_w) * 10 + 4,    2)   # -6 (perto) a +4 (longe)
            vr_scale = round((w / frame_w) * 5,          2)   # 0.1 a 5

            # ── Anotação no frame (bounding box colorido) ────────────────
            cv2.rectangle(resultado, (x, y), (x + w, y + h), cor_bgr, 2)

            # Nome acima do rosto
            cv2.putText(
                resultado, nome,
                (x, y - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.65, cor_bgr, 2,
            )

            # Coordenadas VR abaixo do rosto
            coord_text = f"VR({vr_x}, {vr_y}, {vr_z})"
            cv2.putText(
                resultado, coord_text,
                (x, y + h + 18),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, cor_bgr, 1,
            )

            vr_avatars.append({
                "id":    f"pessoa_{info['id']}",
                "nome":  nome,
                "x":     vr_x,
                "y":     vr_y,
                "z":     vr_z,
                "scale": vr_scale,
                "cor":   cor_hex,
            })

            detections.append({
                "nome":  nome,
                "px":    cx, "py": cy,
                "vr_x":  vr_x,
                "vr_y":  vr_y,
                "vr_z":  vr_z,
                "scale": vr_scale,
                "cor":   cor_hex,
            })

        # ── Codifica frame anotado → base64 ──────────────────────────────
        _, buffer    = cv2.imencode(".jpg", resultado, [cv2.IMWRITE_JPEG_QUALITY, 80])
        result_b64   = "data:image/jpeg;base64," + base64.b64encode(buffer).decode()

        # ── Envia resultado para a câmera ─────────────────────────────────
        emit("cv_result", {
            "image":      result_b64,
            "total":      len(faces_int),
            "detections": detections,
        })

        # ── Emite avatares para a cena VR ─────────────────────────────────
        # Sempre envia (mesmo lista vazia) para remover avatares ausentes
        socketio.emit("vr_avatars", vr_avatars, to="vr")

    except Exception as exc:
        logger.exception("Erro ao processar frame: %s", exc)


# ---------------------------------------------------------------------------
# Inicialização
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    logger.info("Servidor iniciando em http://0.0.0.0:5000")
    socketio.run(app, host="0.0.0.0", port=5000, debug=False)
