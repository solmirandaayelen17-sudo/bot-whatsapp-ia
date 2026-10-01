// Pruebas del simulador: el aviso que arma tiene que pasar por el webhook real
// igual que uno de Meta. Se usa un "procesar" falso, sin IA.

import test from "node:test";
import assert from "node:assert/strict";
import { crearSimulador } from "../src/canales/simuladorWhatsApp.js";
import { armarAvisoDeMeta } from "../src/canales/avisoMeta.js";
import { extraerMensajes } from "../src/canales/whatsapp.js";

const empresa = { id: "demo", nombre: "Demo", whatsapp: { phoneNumberId: "PNID-DEMO", tokenEnv: "X" } };

test("el aviso armado se lee igual que uno de Meta", () => {
  const aviso = armarAvisoDeMeta({ phoneNumberId: "P1", de: "5492974000000", nombre: "Ana", texto: "hola" });
  const [m] = extraerMensajes(aviso);
  assert.equal(m.texto, "hola");
  assert.equal(m.phoneNumberId, "P1");
  assert.equal(m.nombre, "Ana");
  assert.match(m.id, /^wamid\./);
});

test("el mensaje pasa por el webhook y vuelve la respuesta, sin el 9 argentino", async () => {
  const llamadas = [];
  const sim = await crearSimulador({
    empresa,
    procesar: async (datos) => {
      llamadas.push(datos);
      return `recibí: ${datos.texto}`;
    },
  });
  try {
    assert.equal(await sim.verificarWebhook(), true);
    const r = await sim.mandar({ texto: "tienen 175/65 R14?" });
    assert.equal(r.estado, 200);
    assert.equal(r.tipo, "respuesta");
    assert.equal(r.texto, "recibí: tienen 175/65 R14?");
    assert.equal(r.para, "542974000000");
    assert.equal(llamadas[0].empresa, empresa);
    assert.equal(llamadas[0].telefono, "5492974000000");
  } finally {
    await sim.cerrar();
  }
});

test("el aviso repetido no se contesta dos veces y la firma falsa se rechaza", async () => {
  let veces = 0;
  const sim = await crearSimulador({
    empresa,
    procesar: async () => {
      veces++;
      return "ok";
    },
  });
  try {
    await sim.mandar({ texto: "hola" });
    const repetido = await sim.repetirUltimo(300);
    assert.equal(repetido.tipo, "sin-respuesta");
    const trucho = await sim.mandarTrucho("hola", 300);
    assert.equal(trucho.estado, 401);
    assert.equal(veces, 1);
  } finally {
    await sim.cerrar();
  }
});

test("audio, pausa y conversación nueva", async () => {
  const sim = await crearSimulador({
    empresa: { id: "demo", nombre: "Demo", whatsapp: { phoneNumberId: "" } },
    procesar: async ({ telefono }) => (telefono.endsWith("1") ? "otro cliente" : null),
  });
  try {
    assert.equal(sim.phoneNumberId, "SIMULADO-demo");
    const audio = await sim.mandar({ tipo: "audio" });
    assert.match(audio.texto, /solo puedo leer mensajes de texto/);
    const pausa = await sim.mandar({ texto: "quiero hablar con alguien" });
    assert.equal(pausa.tipo, "pausa");
    assert.equal(sim.nuevaConversacion(), "5492974000001");
    const otro = await sim.mandar({ texto: "hola" });
    assert.equal(otro.texto, "otro cliente");
  } finally {
    await sim.cerrar();
  }
});
