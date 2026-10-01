// Pruebas de los audios: transcripción (sin llamar a Google) y el camino
// completo por el webhook con el simulador.

import test from "node:test";
import assert from "node:assert/strict";
import { crearTranscriptor, limpiarTranscripcion, tipoDeAudioParaGemini } from "../src/agente/audio.js";
import { crearSimulador } from "../src/canales/simuladorWhatsApp.js";
import { descargarMediaWhatsApp, LIMITE_AUDIO_BYTES, PREFIJO_AUDIO, RESPUESTAS } from "../src/canales/whatsapp.js";

const empresa = { id: "demo", nombre: "Demo", whatsapp: { phoneNumberId: "PNID-DEMO", tokenEnv: "TOKEN_PRUEBA_AUDIO" } };
const NOTA = { datos: Buffer.from("audio de prueba"), mimeType: "audio/ogg; codecs=opus" };

test("los tipos de audio de WhatsApp se pasan al formato de Gemini", () => {
  assert.equal(tipoDeAudioParaGemini("audio/ogg; codecs=opus"), "audio/ogg");
  assert.equal(tipoDeAudioParaGemini("audio/mp4"), "audio/m4a");
  assert.equal(tipoDeAudioParaGemini("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(tipoDeAudioParaGemini(undefined), "audio/ogg");
});

test("la transcripción se limpia y '[inaudible]' queda vacía", () => {
  assert.equal(limpiarTranscripcion('"Hola, ¿tienen cubiertas?"'), "Hola, ¿tienen cubiertas?");
  assert.equal(limpiarTranscripcion("Transcripción: quiero dos"), "quiero dos");
  assert.equal(limpiarTranscripcion("[inaudible]"), "");
  assert.equal(limpiarTranscripcion("  "), "");
});

test("el audio va a Gemini como inlineData y, si el modelo falla, se usa el de respaldo", async () => {
  const recibidos = [];
  const modelo = (respuesta) => ({
    invoke: async (mensajes) => {
      recibidos.push(mensajes[0].content);
      if (respuesta instanceof Error) throw respuesta;
      return { content: respuesta };
    },
  });
  const transcribir = crearTranscriptor({ crearModelos: () => [modelo(new Error("503 overloaded")), modelo("Quiero 2 cubiertas")] });
  const original = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await transcribir(NOTA), "Quiero 2 cubiertas");
  } finally {
    console.warn = original;
  }
  assert.equal(recibidos.length, 2);
  const media = recibidos[0].find((p) => p.type === "media");
  assert.equal(media.mimeType, "audio/ogg");
  assert.equal(Buffer.from(media.data, "base64").toString(), "audio de prueba");
});

test("el pedido a Google lleva el audio en el formato correcto (sin conexión real)", async () => {
  const fetchOriginal = globalThis.fetch;
  const claveOriginal = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "clave-de-prueba";
  let cuerpo;
  globalThis.fetch = async (_url, init) => {
    cuerpo = JSON.parse(init.body);
    const respuesta = { candidates: [{ content: { role: "model", parts: [{ text: "“Hola, ¿abren el sábado?”" }] }, finishReason: "STOP" }] };
    return new Response(JSON.stringify(respuesta), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const { crearModeloGemini } = await import("../src/agente/modelo.js");
    const transcribir = crearTranscriptor({ crearModelos: () => [crearModeloGemini("modelo-de-prueba")] });
    assert.equal(await transcribir(NOTA), "Hola, ¿abren el sábado?");
    const partes = cuerpo.contents[0].parts;
    assert.equal(partes[1].inlineData.mimeType, "audio/ogg");
    assert.equal(Buffer.from(partes[1].inlineData.data, "base64").toString(), "audio de prueba");
  } finally {
    globalThis.fetch = fetchOriginal;
    if (claveOriginal === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = claveOriginal;
  }
});

test("el audio de WhatsApp se descarga en dos pasos con el token", async () => {
  const fetchOriginal = globalThis.fetch;
  process.env.TOKEN_PRUEBA_AUDIO = "token-123";
  const pedidos = [];
  globalThis.fetch = async (url, init) => {
    pedidos.push({ url: String(url), auth: init?.headers?.Authorization });
    if (String(url).includes("graph.facebook.com")) {
      return Response.json({ url: "https://lookaside.fbsbx.com/audio-123", mime_type: "audio/ogg; codecs=opus", file_size: 15 });
    }
    return new Response(Buffer.from("audio de prueba"));
  };
  try {
    const r = await descargarMediaWhatsApp({ empresa, mediaId: "MEDIA-1" });
    assert.equal(r.datos.toString(), "audio de prueba");
    assert.equal(r.mimeType, "audio/ogg; codecs=opus");
    assert.match(pedidos[0].url, /graph\.facebook\.com\/v\d+\.\d+\/MEDIA-1$/);
    assert.deepEqual(
      pedidos.map((p) => p.auth),
      ["Bearer token-123", "Bearer token-123"],
    );
  } finally {
    globalThis.fetch = fetchOriginal;
    delete process.env.TOKEN_PRUEBA_AUDIO;
  }
});

async function conSimulador(transcribir, prueba) {
  const llamadas = [];
  const sim = await crearSimulador({
    empresa,
    transcribir,
    procesar: async (datos) => {
      llamadas.push(datos);
      return "¡Sí! Tenemos la 175/65 R14.";
    },
  });
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    await prueba(sim, llamadas);
  } finally {
    console.error = errorOriginal;
    await sim.cerrar();
  }
}

test("una nota de voz se transcribe y el bot la responde como un mensaje escrito", async () => {
  await conSimulador(async ({ datos, mimeType }) => {
    assert.equal(datos.toString(), "audio de prueba");
    assert.equal(mimeType, "audio/ogg; codecs=opus");
    return "Hola, ¿tienen cubiertas para un Gol?";
  }, async (sim, llamadas) => {
    const r = await sim.mandar({ tipo: "audio", audio: NOTA });
    assert.equal(r.tipo, "respuesta");
    assert.equal(r.texto, "¡Sí! Tenemos la 175/65 R14.");
    assert.equal(r.transcripcion, "Hola, ¿tienen cubiertas para un Gol?");
    assert.equal(llamadas[0].texto, `${PREFIJO_AUDIO}\nHola, ¿tienen cubiertas para un Gol?`);
    assert.equal(llamadas[0].transcripcion, "Hola, ¿tienen cubiertas para un Gol?");
    // El mensaje siguiente, escrito, ya no arrastra la transcripción anterior.
    const escrito = await sim.mandar({ texto: "dale" });
    assert.equal(escrito.transcripcion, undefined);
  });
});

test("si el audio no se entiende, falla o es muy largo, el bot lo dice con amabilidad", async () => {
  await conSimulador(async () => "", async (sim, llamadas) => {
    assert.equal((await sim.mandar({ tipo: "audio", audio: NOTA })).texto, RESPUESTAS.audioInaudible);
    assert.equal(llamadas.length, 0);
  });
  await conSimulador(async () => {
    throw new Error("quota exceeded");
  }, async (sim) => {
    assert.equal((await sim.mandar({ tipo: "audio", audio: NOTA })).texto, RESPUESTAS.audioError);
  });
  await conSimulador(async () => "no debería llegar acá", async (sim, llamadas) => {
    const enorme = { datos: Buffer.alloc(LIMITE_AUDIO_BYTES + 1), mimeType: "audio/ogg" };
    assert.equal((await sim.mandar({ tipo: "audio", audio: enorme })).texto, RESPUESTAS.audioLargo);
    assert.equal(llamadas.length, 0);
  });
});

test("con audios activados, una foto recibe el aviso de que no ve imágenes", async () => {
  await conSimulador(async () => "x", async (sim) => {
    assert.equal((await sim.mandar({ tipo: "image" })).texto, RESPUESTAS.sinFotos);
  });
});
