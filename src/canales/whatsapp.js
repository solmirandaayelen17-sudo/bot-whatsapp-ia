// Canal WHATSAPP (API oficial de Meta, "Cloud API").
//
// Cómo funciona:
//   1. Un cliente escribe al número del negocio.
//   2. Meta le manda ese mensaje a nuestro servidor (a esto se le llama WEBHOOK:
//      "Meta nos avisa", en vez de que nosotros preguntemos todo el tiempo).
//   3. Buscamos de qué empresa es ese número, le pasamos el texto al procesador
//      y mandamos la respuesta con la API de Meta.

import crypto from "node:crypto";
import express from "express";
import { mensajeDeError, pistaDeError } from "../nucleo/errores.js";

const VERSION_API = process.env.WHATSAPP_API_VERSION || "v25.0";
const LIMITE_TEXTO = 4096; // WhatsApp no acepta mensajes de texto más largos
export const LIMITE_AUDIO_BYTES = 14 * 1024 * 1024; // Gemini acepta hasta 20 MB por pedido (el audio va en base64)

// Lo que el bot contesta cuando no puede usar el mensaje.
export const RESPUESTAS = {
  soloTexto: "Por ahora solo puedo leer mensajes de texto. ¿Me lo escribís?",
  sinFotos: "Por ahora puedo leer mensajes y escuchar audios, pero no ver fotos, videos ni stickers. ¿Me lo escribís?",
  audioLargo: "Uy, el audio es muy largo para mí. ¿Me lo resumís en uno más corto o por escrito?",
  audioError: "Perdón, no pude escuchar tu audio. ¿Me lo escribís?",
  audioInaudible: "No llegué a entender el audio. ¿Me lo repetís o me lo escribís?",
};

// POR QUÉ marcar los audios: así la IA sabe que el texto viene de una
// transcripción automática y, si algo no tiene sentido, pregunta en vez de adivinar.
export const PREFIJO_AUDIO = "(Audio del cliente, pasado a texto)";

// POR QUÉ verificar la firma: cualquiera que conozca la dirección de tu servidor
// podría mandarle mensajes falsos. Meta firma cada aviso con el "App Secret" de
// tu app; si la firma no coincide, lo descartamos.
export function firmaValida(cuerpoCrudo, firmaHeader, appSecret) {
  if (!Buffer.isBuffer(cuerpoCrudo) || !appSecret) return false;
  if (typeof firmaHeader !== "string" || !firmaHeader.startsWith("sha256=")) return false;
  const esperada = crypto.createHmac("sha256", appSecret).update(cuerpoCrudo).digest();
  const recibida = Buffer.from(firmaHeader.slice("sha256=".length), "hex");
  return recibida.length === esperada.length && crypto.timingSafeEqual(recibida, esperada);
}

// Meta manda un JSON con mucho envoltorio. Esto saca solo lo que nos importa.
// Los avisos de "entregado/leído" (statuses) no traen mensajes y se ignoran.
export function extraerMensajes(aviso) {
  const salida = [];
  for (const entrada of aviso?.entry ?? []) {
    for (const cambio of entrada.changes ?? []) {
      if (cambio.field !== "messages") continue;
      const v = cambio.value ?? {};
      const contacto = v.contacts?.[0];
      for (const m of v.messages ?? []) {
        let texto = null;
        if (m.type === "text") texto = m.text?.body ?? null;
        else if (m.type === "button") texto = m.button?.text ?? null;
        else if (m.type === "interactive") {
          texto = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
        }
        salida.push({
          phoneNumberId: v.metadata?.phone_number_id,
          de: m.from,
          nombre: contacto?.profile?.name,
          id: m.id,
          tipo: m.type,
          texto,
          audio: m.type === "audio" && m.audio?.id ? { id: m.audio.id, mimeType: m.audio.mime_type } : null,
        });
      }
    }
  }
  return salida;
}

// POR QUÉ: los celulares argentinos llegan como 549 + característica + número.
// En modo de prueba, Meta solo deja responder al número tal como lo cargaste en
// la lista de destinatarios, SIN el 9. En producción acepta los dos formatos,
// así que sacarlo no rompe nada.
export function normalizarDestino(numero) {
  const soloDigitos = String(numero).replace(/\D/g, "");
  return /^549\d{10}$/.test(soloDigitos) ? "54" + soloDigitos.slice(3) : soloDigitos;
}

export async function enviarTextoWhatsApp({ empresa, para, texto }) {
  const token = process.env[empresa.whatsapp.tokenEnv];
  if (!token) throw new Error(`Falta ${empresa.whatsapp.tokenEnv} en el .env (token de WhatsApp de ${empresa.id}).`);
  const url = `https://graph.facebook.com/${VERSION_API}/${empresa.whatsapp.phoneNumberId}/messages`;
  const respuesta = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizarDestino(para),
      type: "text",
      text: { preview_url: false, body: texto.slice(0, LIMITE_TEXTO) },
    }),
  });
  if (!respuesta.ok) {
    throw new Error(`WhatsApp respondió ${respuesta.status}: ${await respuesta.text()}`);
  }
}

// Los audios no vienen en el aviso: Meta manda un id. Con ese id se pide la
// dirección del archivo y después se descarga (las dos cosas con el token).
export async function descargarMediaWhatsApp({ empresa, mediaId }) {
  const token = process.env[empresa.whatsapp.tokenEnv];
  if (!token) throw new Error(`Falta ${empresa.whatsapp.tokenEnv} en el .env (token de WhatsApp de ${empresa.id}).`);
  const auth = { Authorization: `Bearer ${token}` };
  const info = await fetch(`https://graph.facebook.com/${VERSION_API}/${mediaId}`, { headers: auth });
  if (!info.ok) throw new Error(`WhatsApp respondió ${info.status} al pedir el audio: ${await info.text()}`);
  const { url, mime_type, file_size } = await info.json();
  if (file_size > LIMITE_AUDIO_BYTES) return { datos: null, mimeType: mime_type, tamano: file_size };
  const archivo = await fetch(url, { headers: auth });
  if (!archivo.ok) throw new Error(`WhatsApp respondió ${archivo.status} al descargar el audio.`);
  const datos = Buffer.from(await archivo.arrayBuffer());
  return { datos, mimeType: mime_type, tamano: datos.length };
}

export function crearRouterWhatsApp({
  empresasPorNumero,
  procesar,
  enviarTexto = enviarTextoWhatsApp,
  descargarMedia = descargarMediaWhatsApp,
  transcribir = null, // si no se pasa, los audios reciben el aviso de "solo texto"
  verifyToken,
  appSecret,
}) {
  const router = express.Router();

  // POR QUÉ recordar los ids: si tardamos en contestarle a Meta, reenvía el mismo
  // aviso. Sin esto, el cliente recibiría la respuesta dos veces.
  const vistos = new Map();
  function yaLoVimos(id) {
    const ahora = Date.now();
    if (vistos.size > 5000) {
      for (const [k, t] of vistos) if (ahora - t > 60 * 60_000) vistos.delete(k);
    }
    if (vistos.has(id)) return true;
    vistos.set(id, ahora);
    return false;
  }

  // Paso único de configuración: cuando cargás la URL del webhook en Meta, Meta
  // pregunta "¿sos vos?" mandando tu token de verificación. Si coincide, le
  // devolvemos el "challenge" y queda conectado.
  router.get("/webhook", (req, res) => {
    const modo = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const desafio = req.query["hub.challenge"];
    if (modo === "subscribe" && token === verifyToken) return res.status(200).send(String(desafio));
    return res.sendStatus(403);
  });

  // Acá llegan los mensajes. express.raw guarda el cuerpo tal cual llegó, que es
  // lo que hace falta para verificar la firma.
  router.post("/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    if (!firmaValida(req.body, req.get("x-hub-signature-256"), appSecret)) {
      return res.sendStatus(401);
    }
    // POR QUÉ contestar 200 enseguida: Meta espera respuesta rápida. La IA puede
    // tardar unos segundos, así que primero decimos "recibido" y después
    // procesamos.
    res.sendStatus(200);

    let aviso;
    try {
      aviso = JSON.parse(req.body.toString("utf8"));
    } catch {
      return;
    }
    for (const mensaje of extraerMensajes(aviso)) {
      manejar(mensaje).catch((error) => console.error("[whatsapp] Error manejando mensaje:", error));
    }
  });

  async function manejar(m) {
    if (!m.id || yaLoVimos(m.id)) return;
    const empresa = empresasPorNumero.get(m.phoneNumberId);
    if (!empresa) {
      console.warn(`[whatsapp] Llegó un mensaje al número ${m.phoneNumberId}, pero ninguna empresa lo tiene configurado.`);
      return;
    }
    const responder = (texto) => enviarTexto({ empresa, para: m.de, texto });

    let texto = m.texto;
    let transcripcion = null;
    if (!texto && m.audio && transcribir) {
      transcripcion = await escuchar(empresa, m);
      if (transcripcion.respuesta) return responder(transcripcion.respuesta);
      texto = `${PREFIJO_AUDIO}\n${transcripcion.texto}`;
    }
    if (!texto) {
      // Fotos, stickers, videos (o audios, si no está activada la transcripción).
      return responder(transcribir ? RESPUESTAS.sinFotos : RESPUESTAS.soloTexto);
    }
    const respuesta = await procesar({
      empresa,
      telefono: m.de,
      nombre: m.nombre,
      texto,
      transcripcion: transcripcion?.texto ?? null,
    });
    if (respuesta) await responder(respuesta);
  }

  // Descarga y transcribe un audio. Devuelve { texto } o, si no se pudo,
  // { respuesta } con lo que hay que contestarle al cliente.
  async function escuchar(empresa, m) {
    try {
      const audio = await descargarMedia({ empresa, mediaId: m.audio.id });
      if (!audio.datos || audio.datos.length > LIMITE_AUDIO_BYTES) return { respuesta: RESPUESTAS.audioLargo };
      const texto = await transcribir({ datos: audio.datos, mimeType: audio.mimeType || m.audio.mimeType });
      return texto ? { texto } : { respuesta: RESPUESTAS.audioInaudible };
    } catch (error) {
      console.error(`[whatsapp] No pude transcribir el audio de ${m.de}: ${mensajeDeError(error)}`);
      const pista = pistaDeError(error);
      if (pista) console.error(`  -> ${pista}`);
      return { respuesta: RESPUESTAS.audioError };
    }
  }

  return router;
}
