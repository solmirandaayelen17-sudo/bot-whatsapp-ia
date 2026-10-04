// Pruebas de la central de derivaciones: la dueña atiende las charlas derivadas
// desde su WhatsApp, a través del bot. Sin Meta ni IA de verdad.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeToolCallingModel } from "langchain";
import { validarEmpresa, cargarEmpresas, RAIZ } from "../src/config/empresas.js";
import { crearProcesador } from "../src/nucleo/procesador.js";
import { crearPausas } from "../src/nucleo/pausas.js";
import { crearCentralDeDerivaciones } from "../src/nucleo/derivaciones.js";
import { crearFuente } from "../src/datos/crearFuente.js";
import { armarPrompt } from "../src/agente/prompt.js";
import { extraerMensajes } from "../src/canales/whatsapp.js";

const DUENA = "5492975000001";
const CLIENTE = "5492974001234";

function empresaDePrueba(extra = {}) {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "bot-derivar-"));
  fs.copyFileSync(path.join(RAIZ, "datos/gomeria-demo/productos.csv"), path.join(carpeta, "productos.csv"));
  const base = JSON.parse(fs.readFileSync(path.join(RAIZ, "empresas/gomeria-demo.json"), "utf8"));
  return validarEmpresa(
    { ...base, id: "prueba-derivar", herramientas: ["buscar_productos", "derivar_a_humano"], datos: { tipo: "local", carpeta }, derivacion: { pausaMinutos: 60, avisarA: DUENA }, ...extra },
    "prueba",
  );
}

// WhatsApp de mentira: guarda lo que se manda y devuelve un id por mensaje.
function whatsappFalso() {
  const enviados = [];
  return {
    enviados,
    enviarTexto: async ({ para, texto }) => {
      enviados.push({ para, texto });
      return `wamid.${enviados.length}`;
    },
  };
}

function armar(empresa) {
  const wa = whatsappFalso();
  const pausas = crearPausas();
  const central = crearCentralDeDerivaciones({ enviarTexto: wa.enviarTexto, pausas });
  const { procesar } = crearProcesador({
    crearModelo: () => new FakeToolCallingModel({ toolCalls: [[{ name: "derivar_a_humano", args: { motivo: "Quiere contratar el bot para su peluquería" }, id: "t1" }], []] }),
    crearFuente,
    pausas,
    alDerivar: central.avisar,
  });
  const respuestas = [];
  const deLaDuena = (texto, extra = {}) => central.atender(empresa, { de: DUENA, texto, ...extra }, async (t) => respuestas.push(t));
  return { wa, pausas, central, procesar, respuestas, deLaDuena };
}

test("al derivar, a la dueña le llega el aviso con el resumen y el código", async () => {
  const empresa = empresaDePrueba();
  const { wa, procesar } = armar(empresa);
  await procesar({ empresa, telefono: CLIENTE, nombre: "Juli", texto: "quiero contratarlo" });
  const aviso = wa.enviados.find((e) => e.para === DUENA);
  assert.ok(aviso, "no le llegó el aviso a la dueña");
  assert.match(aviso.texto, /#1234/);
  assert.match(aviso.texto, /Juli/);
  assert.match(aviso.texto, /peluquería/);
});

test("la dueña contesta con #código, el cliente lo recibe y el bot sigue callado", async () => {
  const empresa = empresaDePrueba();
  const { wa, procesar, respuestas, deLaDuena } = armar(empresa);
  await procesar({ empresa, telefono: CLIENTE, nombre: "Juli", texto: "quiero contratarlo" });
  assert.equal(await deLaDuena("#1234 Hola Juli, soy Sol. ¿Qué horarios tenés?"), true);
  assert.deepEqual(wa.enviados.at(-1), { para: CLIENTE, texto: "Hola Juli, soy Sol. ¿Qué horarios tenés?" });
  assert.match(respuestas.at(-1), /Enviado/);
  assert.equal(await procesar({ empresa, telefono: CLIENTE, texto: "de 9 a 18" }), null);
});

test("deslizar para responder el aviso también le llega al cliente", async () => {
  const empresa = empresaDePrueba();
  const { wa, procesar, deLaDuena } = armar(empresa);
  await procesar({ empresa, telefono: CLIENTE, nombre: "Juli", texto: "quiero contratarlo" });
  const idDelAviso = `wamid.${wa.enviados.findIndex((e) => e.para === DUENA) + 1}`;
  await deLaDuena("¡Hola! Ya te escribo", { respondeA: idDelAviso });
  assert.deepEqual(wa.enviados.at(-1), { para: CLIENTE, texto: "¡Hola! Ya te escribo" });
});

test("lo que escribe el cliente mientras está derivado le llega a la dueña", async () => {
  const empresa = empresaDePrueba();
  const { wa, procesar, central } = armar(empresa);
  await procesar({ empresa, telefono: CLIENTE, nombre: "Juli", texto: "quiero contratarlo" });
  await central.reenviar(empresa, { de: CLIENTE }, "¿me llamás?");
  assert.deepEqual(wa.enviados.at(-1), { para: DUENA, texto: "💬 #1234 Juli: ¿me llamás?" });
  // De un cliente sin charla derivada, no se reenvía nada.
  const antes = wa.enviados.length;
  await central.reenviar(empresa, { de: "5492979999999" }, "hola");
  assert.equal(wa.enviados.length, antes);
});

test("con '#código listo' el bot vuelve a atender a ese cliente", async () => {
  const empresa = empresaDePrueba();
  const { procesar, respuestas, deLaDuena, central } = armar(empresa);
  await procesar({ empresa, telefono: CLIENTE, nombre: "Juli", texto: "quiero contratarlo" });
  await deLaDuena("#1234 listo");
  assert.match(respuestas.at(-1), /vuelve a atender/);
  assert.equal(central.abiertas(empresa).length, 0);
  assert.notEqual(await procesar({ empresa, telefono: CLIENTE, texto: "hola de nuevo" }), null);
});

test("si la dueña escribe sin código, ve las charlas abiertas; y los demás números siguen al bot", async () => {
  const empresa = empresaDePrueba();
  const { procesar, respuestas, deLaDuena, central } = armar(empresa);
  await deLaDuena("hola");
  assert.match(respuestas.at(-1), /No hay charlas/);
  await procesar({ empresa, telefono: CLIENTE, nombre: "Juli", texto: "quiero contratarlo" });
  await deLaDuena("¿qué hay?");
  assert.match(respuestas.at(-1), /#1234\* Juli/);
  assert.equal(await central.atender(empresa, { de: CLIENTE, texto: "hola" }, async () => {}), false);
});

test("después de un reinicio, con el número completo igual se puede contestar", async () => {
  const empresa = empresaDePrueba();
  const { wa, respuestas, deLaDuena } = armar(empresa);
  await deLaDuena("#1234 hola");
  assert.match(respuestas.at(-1), /No encuentro/);
  await deLaDuena(`#${CLIENTE} Hola, perdón la demora`);
  assert.deepEqual(wa.enviados.at(-1), { para: CLIENTE, texto: "Hola, perdón la demora" });
});

test("sin número para avisar, la central no hace nada (los otros bots siguen igual)", async () => {
  const empresa = empresaDePrueba({ derivacion: { pausaMinutos: 60 } });
  const wa = whatsappFalso();
  const central = crearCentralDeDerivaciones({ enviarTexto: wa.enviarTexto, pausas: crearPausas() });
  await central.avisar(empresa, { telefono: CLIENTE, nombre: "Juli", motivo: "x", hiloId: "h" });
  assert.equal(wa.enviados.length, 0);
  assert.equal(await central.atender(empresa, { de: DUENA, texto: "hola" }, async () => {}), false);
});

test("si el texto no llega (más de 24 h), el aviso sale con la plantilla", async () => {
  const empresa = empresaDePrueba({ derivacion: { pausaMinutos: 60, avisarA: DUENA, plantilla: "aviso_derivacion" } });
  const plantillas = [];
  const central = crearCentralDeDerivaciones({
    enviarTexto: async () => {
      throw new Error("WhatsApp respondió 400: fuera de la ventana de 24 horas");
    },
    enviarPlantilla: async (p) => {
      plantillas.push(p);
      return "wamid.p1";
    },
    pausas: crearPausas(),
  });
  await central.avisar(empresa, { telefono: CLIENTE, nombre: "Juli", motivo: "Quiere el bot", hiloId: "h" });
  assert.equal(plantillas[0].nombre, "aviso_derivacion");
  assert.deepEqual(plantillas[0].parametros, [`Juli (+${CLIENTE})`, "Quiere el bot", "1234"]);
});

test("el número de la dueña y el del bot se pueden leer de variables", () => {
  process.env.PRUEBA_AVISOS = "+54 9 297 500-0001";
  process.env.PRUEBA_NUMERO = "123456789";
  try {
    const e = empresaDePrueba({ whatsapp: { phoneNumberIdEnv: "PRUEBA_NUMERO" }, derivacion: { avisarAEnv: "PRUEBA_AVISOS" } });
    assert.equal(e.derivacion.avisarA, DUENA);
    assert.equal(e.derivacion.pausaMinutos, 120);
    assert.equal(e.whatsapp.phoneNumberId, "123456789");
  } finally {
    delete process.env.PRUEBA_AVISOS;
    delete process.env.PRUEBA_NUMERO;
  }
});

test("si la dueña desliza para responder, se lee de qué mensaje era", () => {
  const aviso = { entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "P" }, messages: [{ from: DUENA, id: "w2", type: "text", text: { body: "hola" }, context: { id: "wamid.1" } }] } }] }] };
  assert.equal(extraerMensajes(aviso)[0].respondeA, "wamid.1");
});

test("el bot de Zaivum carga bien y vende siguiendo los pilares", () => {
  const zaivum = cargarEmpresas().porId.get("zaivum");
  assert.ok(zaivum);
  const prompt = armarPrompt(zaivum);
  assert.match(prompt, /CÓMO VENDÉS/);
  assert.match(prompt, /UNA sola cosa/);
  assert.doesNotMatch(prompt, /\d+ ?%/); // nada de porcentajes
});
