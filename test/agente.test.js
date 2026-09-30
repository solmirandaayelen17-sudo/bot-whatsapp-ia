// Pruebas del agente completo con una IA SIMULADA (FakeToolCallingModel).
//
// POR QUÉ simulada: así probamos que las herramientas, la memoria, las pausas y
// la separación entre empresas funcionan, sin gastar cuota de Gemini y con
// resultados siempre iguales. La IA de verdad la probás con: npm run consola

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeToolCallingModel, AIMessage } from "langchain";
import { validarEmpresa, RAIZ } from "../src/config/empresas.js";
import { crearProcesador } from "../src/nucleo/procesador.js";
import { crearFuente } from "../src/datos/crearFuente.js";
import { parsearCsv, filasAObjetos } from "../src/datos/csv.js";
import { armarPrompt } from "../src/agente/prompt.js";

function empresaDePrueba(id) {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), `bot-${id}-`));
  fs.copyFileSync(path.join(RAIZ, "datos/gomeria-demo/productos.csv"), path.join(carpeta, "productos.csv"));
  const base = JSON.parse(fs.readFileSync(path.join(RAIZ, "empresas/gomeria-demo.json"), "utf8"));
  return { empresa: validarEmpresa({ ...base, id, datos: { tipo: "local", carpeta } }, id), carpeta };
}

// Guion de la IA simulada: en cada paso, qué herramienta "decide" usar.
// Una lista vacía significa "ya no uso herramientas, respondo".
function iaQueUsa(...pasos) {
  return () => new FakeToolCallingModel({ toolCalls: pasos });
}

test("el agente usa buscar_productos y responde con datos reales de la planilla", async () => {
  const { empresa } = empresaDePrueba("prueba-busqueda");
  const { procesar } = crearProcesador({
    crearModelo: iaQueUsa([{ name: "buscar_productos", args: { consulta: "175/65" }, id: "t1" }], []),
    crearFuente,
  });
  const respuesta = await procesar({ empresa, telefono: "549111", texto: "tienen 175/65?" });
  // La IA simulada repite lo que vio: si aparece el precio, la herramienta leyó la planilla.
  assert.match(respuesta, /Cubierta 175\/65 R14/);
  assert.match(respuesta, /\$95\.000/);
});

const cotizar = (items, id = "c1") => ({ name: "cotizar_pedido", args: { items, modalidad: "retira en el local" }, id });
const confirmar = (id = "k1") => ({ name: "confirmar_pedido", args: { nombre_cliente: "Ana" }, id });
const leerPedidos = (carpeta) => filasAObjetos(parsearCsv(fs.readFileSync(path.join(carpeta, "pedidos.csv"), "utf8")));

test("un pedido se cotiza en un mensaje y se anota cuando el cliente confirma en el siguiente", async () => {
  const { empresa, carpeta } = empresaDePrueba("prueba-pedido");
  const { procesar } = crearProcesador({
    // Mensaje 1: cotiza y responde. Mensaje 2: confirma y responde.
    crearModelo: iaQueUsa([cotizar([{ codigo: "CUB-17565R14", cantidad: 2 }])], [], [confirmar()], []),
    crearFuente,
  });
  const cotizacion = await procesar({ empresa, telefono: "5492974000000", texto: "quiero 2, retiro en el local" });
  assert.match(cotizacion, /\$190\.000/);
  assert.equal(fs.existsSync(path.join(carpeta, "pedidos.csv")), false); // todavía no se anotó nada

  const confirmacion = await procesar({ empresa, telefono: "5492974000000", texto: "sí, confirmo" });
  assert.match(confirmacion, /P-/);
  const pedidos = leerPedidos(carpeta);
  assert.equal(pedidos.length, 1);
  assert.equal(pedidos[0].telefono, "5492974000000");
  assert.equal(pedidos[0].total, "190000");
  assert.equal(pedidos[0].estado, "nuevo (a confirmar)");
});

test("si la IA quiere confirmar en el mismo mensaje en que cotizó, el código lo frena", async () => {
  const { empresa, carpeta } = empresaDePrueba("prueba-apurada");
  const { procesar } = crearProcesador({
    crearModelo: iaQueUsa([cotizar([{ codigo: "CUB-17565R14", cantidad: 4 }])], [confirmar()], []),
    crearFuente,
  });
  const respuesta = await procesar({ empresa, telefono: "549999", texto: "dale, las quiero" });
  assert.match(respuesta, /todavía no vio el total/);
  assert.equal(fs.existsSync(path.join(carpeta, "pedidos.csv")), false);
});

test("un pedido sin stock NO se cotiza ni se anota aunque la IA lo intente", async () => {
  const { empresa, carpeta } = empresaDePrueba("prueba-sin-stock");
  const { procesar } = crearProcesador({
    crearModelo: iaQueUsa([cotizar([{ codigo: "CUB-19555R16", cantidad: 1 }])], []),
    crearFuente,
  });
  const respuesta = await procesar({ empresa, telefono: "549222", texto: "quiero una 195/55" });
  assert.match(respuesta, /No se puede armar este pedido/);
  assert.equal(fs.existsSync(path.join(carpeta, "pedidos.csv")), false);
});

// Una IA con respuestas guionadas, para simular que Gemini devuelve un turno vacío.
class IaGuionada extends FakeToolCallingModel {
  constructor(respuestas) {
    super({});
    this.respuestas = respuestas;
    this.paso = 0;
  }
  bindTools() {
    return this;
  }
  async _generate() {
    const content = this.respuestas[this.paso++] ?? "";
    return { generations: [{ text: content, message: new AIMessage({ content }) }], llmOutput: {} };
  }
}

test("si la IA responde vacío, NO se repite una respuesta vieja: se le pide de nuevo", async () => {
  const { empresa } = empresaDePrueba("prueba-vacia");
  const { procesar } = crearProcesador({
    // turno 1 -> "Primera respuesta"; turno 2 -> vacío y, al pedírsela de nuevo, "Segunda respuesta"
    crearModelo: () => new IaGuionada(["Primera respuesta", "", "Segunda respuesta"]),
    crearFuente,
  });
  const avisoOriginal = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await procesar({ empresa, telefono: "549123", texto: "hola" }), "Primera respuesta");
    assert.equal(await procesar({ empresa, telefono: "549123", texto: "¿y con colocación?" }), "Segunda respuesta");
  } finally {
    console.warn = avisoOriginal;
  }
});

test("después de derivar a una persona, el bot se queda callado en esa conversación", async () => {
  const { empresa, carpeta } = empresaDePrueba("prueba-derivar");
  const { procesar, pausas } = crearProcesador({
    crearModelo: iaQueUsa([{ name: "derivar_a_humano", args: { motivo: "Quiere reclamar por una cubierta" }, id: "t1" }], []),
    crearFuente,
  });
  const primera = await procesar({ empresa, telefono: "549333", nombre: "Caro", texto: "quiero hacer un reclamo" });
  assert.ok(primera);
  assert.equal(await procesar({ empresa, telefono: "549333", texto: "hola?" }), null);
  // Otra persona del mismo negocio sigue siendo atendida
  assert.notEqual(await procesar({ empresa, telefono: "549444", texto: "hola" }), null);
  const derivaciones = filasAObjetos(parsearCsv(fs.readFileSync(path.join(carpeta, "derivaciones.csv"), "utf8")));
  assert.equal(derivaciones[0].cliente, "Caro");
  pausas.reanudar(`${empresa.id}:549333`);
  assert.notEqual(await procesar({ empresa, telefono: "549333", texto: "sigo acá" }), null);
});

// IA que repite todo lo que ve (así sabemos qué recuerda). Como Gemini, le da a
// cada respuesta un identificador nuevo; la simulada base repite siempre el mismo.
class IaEco extends FakeToolCallingModel {
  bindTools() {
    return this;
  }
  async _generate(mensajes, opciones, run) {
    const resultado = await super._generate(mensajes, opciones, run);
    resultado.generations[0].message.id = undefined;
    return resultado;
  }
}

test("la memoria recuerda la charla y no mezcla clientes ni empresas", async () => {
  const a = empresaDePrueba("empresa-a").empresa;
  const b = empresaDePrueba("empresa-b").empresa;
  const { procesar } = crearProcesador({ crearModelo: () => new IaEco({ toolCalls: [[]] }), crearFuente });
  await procesar({ empresa: a, telefono: "549555", texto: "me llamo Dani" });
  const mismaCharla = await procesar({ empresa: a, telefono: "549555", texto: "¿cómo me llamo?" });
  const otraEmpresa = await procesar({ empresa: b, telefono: "549555", texto: "¿cómo me llamo?" });
  assert.match(mismaCharla, /Dani/); // la IA simulada ve el historial de ESTA charla
  assert.doesNotMatch(otraEmpresa, /Dani/); // otra empresa, otra memoria
});

// Una IA que siempre falla, como si Gemini estuviera caído o sin cuota.
class IaCaida extends FakeToolCallingModel {
  bindTools() {
    return this;
  }
  async _generate() {
    throw new Error("sin conexión");
  }
}

test("si la IA falla, el cliente recibe un mensaje amable y no un error", async () => {
  const { empresa } = empresaDePrueba("prueba-error");
  const { procesar } = crearProcesador({
    crearModelo: () => new IaCaida(),
    crearFuente,
  });
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    assert.match(await procesar({ empresa, telefono: "549666", texto: "hola" }), /problema técnico/);
  } finally {
    console.error = errorOriginal;
  }
});

test("si el modelo principal falla, responde el de respaldo", async () => {
  const { empresa } = empresaDePrueba("prueba-respaldo");
  const { procesar } = crearProcesador({
    crearModelo: () => new IaCaida(),
    crearRespaldos: () => [new FakeToolCallingModel({ toolCalls: [] })],
    crearFuente,
  });
  const respuesta = await procesar({ empresa, telefono: "549777", texto: "hola, ¿están abiertos?" });
  assert.doesNotMatch(respuesta, /problema técnico/);
  assert.match(respuesta, /están abiertos/);
});

test("los errores de Gemini se traducen a una pista clara", async () => {
  const { pistaDeError, mensajeDeError } = await import("../src/nucleo/errores.js");
  const e400 = new Error("[GoogleGenerativeAI Error]: Error fetching from https://x: [400 Bad Request] API key not valid. Please pass a valid API key.");
  assert.match(pistaDeError(e400), /clave de Gemini no es válida/);
  assert.doesNotMatch(mensajeDeError(e400), /^\[GoogleGenerativeAI Error\]/);
  assert.match(pistaDeError(new Error("[503 Service Unavailable] The model is overloaded")), /saturado/);
  assert.match(pistaDeError(new Error("[404 Not Found] models/x is not found")), /modelo no existe/);
  // Errores de Google Sheets
  assert.match(pistaDeError(new Error("The caller does not have permission")), /no está compartida/);
  assert.match(pistaDeError(new Error("Could not load the default credentials.")), /llave de la cuenta de servicio/);
  assert.match(pistaDeError(new Error("Unable to parse range: Productos")), /pestaña/);
});

test("las instrucciones incluyen las reglas clave y los datos del negocio", () => {
  const { empresa } = empresaDePrueba("prueba-prompt");
  const prompt = armarPrompt(empresa, new Date("2026-09-29T15:00:00Z"));
  assert.match(prompt, /Hablá SOLO de Gomería La Demo/);
  assert.match(prompt, /sos el asistente virtual/);
  assert.match(prompt, /Lunes a viernes/);
  assert.match(prompt, /martes, 29 de septiembre, 12:00/); // 15:00 UTC = 12:00 en Argentina
});
