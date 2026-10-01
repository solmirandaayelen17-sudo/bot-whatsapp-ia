// AUDIOS: pasa una nota de voz a texto con Gemini.
//
// POR QUÉ con Gemini y no con otro servicio (Whisper, etc.): Gemini ya escucha
// audios, así que usamos la misma clave y el mismo plan gratis. Una nota de voz
// de 1 minuto son unos 1.900 "tokens", parecido a un mensaje de texto largo.
//
// El audio se transcribe y después el bot lo trata como un mensaje escrito:
// busca productos, toma pedidos, deriva, todo igual.

import { HumanMessage } from "@langchain/core/messages";
import { crearModeloGemini, nombreModeloPrincipal, nombresModelosRespaldo } from "./modelo.js";
import { textoDeMensaje } from "../nucleo/procesador.js";
import { mensajeDeError } from "../nucleo/errores.js";

const INSTRUCCION = `Transcribí esta nota de voz de WhatsApp tal cual la dice la persona, en el idioma en que habla (normalmente español de Argentina).
Devolvé SOLO la transcripción: sin comillas, sin explicaciones y sin describir el audio.
Si no se escucha ninguna voz o no se entiende nada, devolvé exactamente: [inaudible]`;

// Meta manda cosas como "audio/ogg; codecs=opus". Gemini quiere el tipo solo
// ("audio/ogg") y llama distinto a algunos formatos.
const EQUIVALENTES = { "audio/mp4": "audio/m4a", "audio/x-m4a": "audio/m4a", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav" };
export function tipoDeAudioParaGemini(mimeType) {
  const base = String(mimeType || "audio/ogg").split(";")[0].trim().toLowerCase();
  return EQUIVALENTES[base] ?? base;
}

// Limpia lo que a veces agrega la IA: comillas alrededor, "Transcripción:", espacios.
export function limpiarTranscripcion(texto) {
  const limpio = String(texto ?? "")
    .trim()
    .replace(/^transcripci[oó]n:\s*/i, "")
    .replace(/^["“'«]+|["”'»]+$/g, "")
    .trim();
  if (!limpio || /^\[?inaudible\]?\.?$/i.test(limpio)) return "";
  return limpio;
}

// Devuelve una función transcribir({ datos, mimeType }) -> texto ("" si no se entiende).
// Prueba el modelo principal y, si falla, los de respaldo.
export function crearTranscriptor({
  crearModelos = () => [nombreModeloPrincipal(), ...nombresModelosRespaldo()].map((n) => crearModeloGemini(n)),
} = {}) {
  let modelos = null; // se crean la primera vez que llega un audio
  return async function transcribir({ datos, mimeType }) {
    if (!Buffer.isBuffer(datos) || datos.length === 0) throw new Error("El audio llegó vacío.");
    modelos ??= crearModelos();
    const mensaje = new HumanMessage({
      content: [
        { type: "text", text: INSTRUCCION },
        { type: "media", mimeType: tipoDeAudioParaGemini(mimeType), data: datos.toString("base64") },
      ],
    });
    let ultimoError;
    for (const [i, modelo] of modelos.entries()) {
      try {
        const respuesta = await modelo.invoke([mensaje]);
        return limpiarTranscripcion(textoDeMensaje(respuesta));
      } catch (error) {
        ultimoError = error;
        if (i < modelos.length - 1) console.warn(`[audio] Falló la transcripción (${mensajeDeError(error)}); pruebo con el modelo de respaldo.`);
      }
    }
    throw ultimoError;
  };
}
