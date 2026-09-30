// Pruebas del canal WhatsApp sin conectarse a Meta: se simula lo que Meta manda.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { crearRouterWhatsApp, extraerMensajes, firmaValida, normalizarDestino } from "../src/canales/whatsapp.js";

const SECRETO = "secreto-de-prueba";
const firmar = (cuerpo) => "sha256=" + crypto.createHmac("sha256", SECRETO).update(cuerpo).digest("hex");

function avisoDeMeta({ id = "wamid.1", texto = "hola", tipo = "text", numero = "PNID-1" } = {}) {
  const mensaje = { from: "5492974000000", id, timestamp: "1", type: tipo };
  if (tipo === "text") mensaje.text = { body: texto };
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: numero },
              contacts: [{ profile: { name: "Ana" }, wa_id: "5492974000000" }],
              messages: [mensaje],
            },
          },
        ],
      },
    ],
  };
}

async function levantar(opciones) {
  const app = express();
  app.use(crearRouterWhatsApp({ verifyToken: "mi-token", appSecret: SECRETO, ...opciones }));
  const servidor = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  return { base, cerrar: () => new Promise((ok) => servidor.close(ok)) };
}

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

test("la firma de Meta se valida y una firma trucha se rechaza", () => {
  const cuerpo = Buffer.from('{"a":1}');
  assert.equal(firmaValida(cuerpo, firmar(cuerpo), SECRETO), true);
  assert.equal(firmaValida(cuerpo, "sha256=" + "0".repeat(64), SECRETO), false);
  assert.equal(firmaValida(cuerpo, undefined, SECRETO), false);
});

test("se extrae el mensaje y se ignoran los avisos de estado", () => {
  const [m] = extraerMensajes(avisoDeMeta({ texto: "tienen cubiertas?" }));
  assert.equal(m.texto, "tienen cubiertas?");
  assert.equal(m.nombre, "Ana");
  assert.equal(m.phoneNumberId, "PNID-1");
  const estado = { entry: [{ changes: [{ field: "messages", value: { statuses: [{ status: "read" }] } }] }] };
  assert.deepEqual(extraerMensajes(estado), []);
});

test("a los celulares argentinos se les saca el 9 para responder", () => {
  assert.equal(normalizarDestino("5492974000000"), "542974000000");
  assert.equal(normalizarDestino("+54 9 11 1234-5678"), "541112345678");
  assert.equal(normalizarDestino("5215512345678"), "5215512345678");
});

test("la verificación del webhook responde el challenge solo con el token correcto", async () => {
  const { base, cerrar } = await levantar({ empresasPorNumero: new Map(), procesar: async () => null });
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=mi-token&hub.challenge=123`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "123");
  const mal = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=123`);
  assert.equal(mal.status, 403);
  await cerrar();
});

test("un mensaje firmado llega a la empresa correcta, se responde una sola vez y sin firma se rechaza", async () => {
  const empresa = { id: "demo", whatsapp: { phoneNumberId: "PNID-1", tokenEnv: "X" } };
  const recibidos = [];
  const enviados = [];
  const { base, cerrar } = await levantar({
    empresasPorNumero: new Map([["PNID-1", empresa]]),
    procesar: async (m) => {
      recibidos.push(m);
      return `eco: ${m.texto}`;
    },
    enviarTexto: async (e) => enviados.push(e),
  });

  const cuerpo = JSON.stringify(avisoDeMeta({ id: "wamid.A", texto: "hola" }));
  const enviar = (headers) => fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: cuerpo });

  assert.equal((await enviar({})).status, 401);
  assert.equal((await enviar({ "x-hub-signature-256": firmar(cuerpo) })).status, 200);
  // Meta reintenta el mismo aviso: no se tiene que responder dos veces
  assert.equal((await enviar({ "x-hub-signature-256": firmar(cuerpo) })).status, 200);
  await esperar(50);

  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].empresa, empresa);
  assert.equal(recibidos[0].telefono, "5492974000000");
  assert.deepEqual(enviados, [{ empresa, para: "5492974000000", texto: "eco: hola" }]);
  await cerrar();
});

test("un audio recibe el aviso de 'solo texto' y un número desconocido se ignora", async () => {
  const empresa = { id: "demo", whatsapp: { phoneNumberId: "PNID-1", tokenEnv: "X" } };
  const enviados = [];
  let procesados = 0;
  const { base, cerrar } = await levantar({
    empresasPorNumero: new Map([["PNID-1", empresa]]),
    procesar: async () => {
      procesados++;
      return "x";
    },
    enviarTexto: async (e) => enviados.push(e),
  });
  for (const aviso of [avisoDeMeta({ id: "wamid.B", tipo: "audio" }), avisoDeMeta({ id: "wamid.C", numero: "OTRO" })]) {
    const cuerpo = JSON.stringify(aviso);
    await fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": firmar(cuerpo) }, body: cuerpo });
  }
  await esperar(50);
  assert.equal(procesados, 0);
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].texto, /solo puedo leer mensajes de texto/);
  await cerrar();
});
