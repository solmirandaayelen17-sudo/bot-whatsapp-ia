// Arma avisos IGUALES a los que manda Meta cuando alguien escribe al número
// del negocio, y los firma como los firma Meta.
//
// POR QUÉ: así podemos probar el webhook completo (firma, lectura del aviso,
// empresa por número, IA, planilla y respuesta) sin depender de Meta. Lo usan
// el simulador (npm run simulador) y las pruebas.

import crypto from "node:crypto";

// Firma el cuerpo con el App Secret, igual que Meta en el header X-Hub-Signature-256.
export function firmarCuerpo(cuerpo, appSecret) {
  return "sha256=" + crypto.createHmac("sha256", appSecret).update(cuerpo).digest("hex");
}

// Devuelve un aviso con el mismo formato que Meta (whatsapp_business_account).
// tipo "text" lleva texto; "audio" simula una nota de voz (sin el archivo).
export function armarAvisoDeMeta({ phoneNumberId, de, nombre, texto, tipo = "text", id = nuevoIdDeMensaje() }) {
  const mensaje = { from: de, id, timestamp: String(Math.floor(Date.now() / 1000)), type: tipo };
  if (tipo === "text") mensaje.text = { body: texto };
  if (tipo === "audio") mensaje.audio = { mime_type: "audio/ogg; codecs=opus", id: "audio-simulado", voice: true };
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA-SIMULADA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: nombre }, wa_id: de }],
              messages: [mensaje],
            },
          },
        ],
      },
    ],
  };
}

export function nuevoIdDeMensaje() {
  return "wamid.SIMULADO." + crypto.randomBytes(8).toString("hex");
}
