// Pruebas de los cobros con Mercado Pago, sin conectarse a Mercado Pago.

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
import { armarPreferencia, crearLinkMercadoPago, fechaConZonaArgentina } from "../src/pagos/mercadoPago.js";

const LINK = "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=123-abc";
const herramientasConCobro = ["buscar_productos", "tomar_pedidos", "derivar_a_humano", "cobrar_mercado_pago"];

function empresaDePrueba(id, herramientas = herramientasConCobro) {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), `bot-${id}-`));
  fs.copyFileSync(path.join(RAIZ, "datos/gomeria-demo/productos.csv"), path.join(carpeta, "productos.csv"));
  const base = JSON.parse(fs.readFileSync(path.join(RAIZ, "empresas/gomeria-demo.json"), "utf8"));
  return { empresa: validarEmpresa({ ...base, id, herramientas, datos: { tipo: "local", carpeta } }, id), carpeta };
}
const leerPedidos = (carpeta) => filasAObjetos(parsearCsv(fs.readFileSync(path.join(carpeta, "pedidos.csv"), "utf8")));
const cotizar = { name: "cotizar_pedido", args: { items: [{ codigo: "CUB-17565R14", cantidad: 2 }], modalidad: "retira en el local" }, id: "c1" };
const confirmar = { name: "confirmar_pedido", args: { nombre_cliente: "Ana" }, id: "k1" };

// IA simulada que usa las herramientas del guion pero, al responder, NO copia
// el link (como pasa a veces con una IA real que resume).
class IaQueResume extends FakeToolCallingModel {
  bindTools(tools) {
    const copia = new IaQueResume({ toolCalls: this.toolCalls, indexRef: this.indexRef });
    copia.tools = [...this.tools, ...tools];
    return copia;
  }
  async _generate(...args) {
    const r = await super._generate(...args);
    const m = r.generations[0].message;
    if (!m.tool_calls?.length) {
      const content = "¡Listo! Tu pedido quedó anotado.";
      return { generations: [{ text: content, message: new AIMessage({ content, id: m.id }) }], llmOutput: {} };
    }
    return r;
  }
}

test("la preferencia lleva los precios en pesos, el número de pedido y vence en 48 horas", () => {
  const ahora = new Date("2026-10-01T15:00:00Z");
  const p = armarPreferencia({
    empresa: { id: "gomeria" },
    pedido: { id: "P-ABC123", lineas: [{ codigo: "CUB-1", nombre: "Cubierta 175/65 R14", cantidad: 2, precio: 99000 }] },
    ahora,
  });
  assert.deepEqual(p.items, [{ id: "CUB-1", title: "Cubierta 175/65 R14", quantity: 2, unit_price: 99000, currency_id: "ARS" }]);
  assert.equal(p.external_reference, "P-ABC123");
  assert.equal(p.expires, true);
  assert.equal(p.expiration_date_from, "2026-10-01T12:00:00.000-03:00");
  assert.equal(p.expiration_date_to, "2026-10-03T12:00:00.000-03:00");
  assert.equal(fechaConZonaArgentina(new Date("2026-01-01T02:30:00Z")), "2025-12-31T23:30:00.000-03:00");
});

test("el link se pide a Mercado Pago con el token de la empresa", async () => {
  const fetchOriginal = globalThis.fetch;
  process.env.MP_TOKEN_PRUEBA = "APP_USR-123";
  let pedido;
  globalThis.fetch = async (url, init) => {
    pedido = { url: String(url), init };
    return Response.json({ id: "123-abc", init_point: LINK, sandbox_init_point: "https://sandbox..." });
  };
  try {
    const empresa = { id: "gomeria", mercadoPago: { tokenEnv: "MP_TOKEN_PRUEBA" } };
    const r = await crearLinkMercadoPago({ empresa, pedido: { id: "P-1", lineas: [{ codigo: "A", nombre: "A", cantidad: 1, precio: 10 }] } });
    assert.deepEqual(r, { link: LINK, id: "123-abc" });
    assert.equal(pedido.url, "https://api.mercadopago.com/checkout/preferences");
    assert.equal(pedido.init.headers.Authorization, "Bearer APP_USR-123");
    assert.equal(JSON.parse(pedido.init.body).external_reference, "P-1");

    globalThis.fetch = async () => new Response('{"message":"invalid access token"}', { status: 401 });
    await assert.rejects(() => crearLinkMercadoPago({ empresa, pedido: { id: "P-2", lineas: [] } }), /401/);

    delete process.env.MP_TOKEN_PRUEBA;
    await assert.rejects(() => crearLinkMercadoPago({ empresa, pedido: { id: "P-3", lineas: [] } }), /Falta MP_TOKEN_PRUEBA/);
  } finally {
    globalThis.fetch = fetchOriginal;
    delete process.env.MP_TOKEN_PRUEBA;
  }
});

test("al confirmar, el cliente recibe el link con los precios de la planilla, aunque la IA no lo copie", async () => {
  const { empresa, carpeta } = empresaDePrueba("prueba-cobro");
  const pedidosAMP = [];
  const { procesar } = crearProcesador({
    crearModelo: () => new IaQueResume({ toolCalls: [[cotizar], [], [confirmar], []] }),
    crearFuente,
    cobros: {
      crearLink: async ({ pedido }) => {
        pedidosAMP.push(pedido);
        return { link: LINK, id: "123-abc" };
      },
    },
  });
  await procesar({ empresa, telefono: "5492974000000", texto: "quiero 2" });
  const respuesta = await procesar({ empresa, telefono: "5492974000000", texto: "sí, confirmo" });

  assert.match(respuesta, /¡Listo! Tu pedido quedó anotado\./);
  assert.ok(respuesta.endsWith(LINK), "el link tiene que llegar completo al final");
  // El precio sale de la planilla (95.000 en el CSV de prueba), no de la IA.
  assert.deepEqual(pedidosAMP[0].lineas, [{ codigo: "CUB-17565R14", nombre: "Cubierta 175/65 R14", cantidad: 2, precio: 95000 }]);
  const [fila] = leerPedidos(carpeta);
  assert.equal(fila.id, pedidosAMP[0].id);
  assert.equal(fila.pago, LINK);
  assert.equal(fila.estado, "esperando pago");
});

test("si Mercado Pago falla, el pedido se anota igual y no se inventa ningún link", async () => {
  const { empresa, carpeta } = empresaDePrueba("prueba-cobro-falla");
  const { procesar } = crearProcesador({
    crearModelo: () => new FakeToolCallingModel({ toolCalls: [[cotizar], [], [confirmar], []] }),
    crearFuente,
    cobros: {
      crearLink: async () => {
        throw new Error("Mercado Pago respondió 500");
      },
    },
  });
  const errorOriginal = console.error;
  console.error = () => {};
  try {
    await procesar({ empresa, telefono: "549111", texto: "quiero 2" });
    const respuesta = await procesar({ empresa, telefono: "549111", texto: "sí" });
    assert.match(respuesta, /no se pudo generar el link de pago/);
    assert.doesNotMatch(respuesta, /mercadopago\.com/);
  } finally {
    console.error = errorOriginal;
  }
  const [fila] = leerPedidos(carpeta);
  assert.equal(fila.estado, "nuevo (a confirmar)");
  assert.equal(fila.pago, "");
});

test("sin cobrar_mercado_pago no se pide ningún link", async () => {
  const { empresa } = empresaDePrueba("prueba-sin-cobro", ["buscar_productos", "tomar_pedidos"]);
  let llamadas = 0;
  const { procesar } = crearProcesador({
    crearModelo: () => new FakeToolCallingModel({ toolCalls: [[cotizar], [], [confirmar], []] }),
    crearFuente,
    cobros: { crearLink: async () => (llamadas++, { link: LINK }) },
  });
  await procesar({ empresa, telefono: "549333", texto: "quiero 2" });
  await procesar({ empresa, telefono: "549333", texto: "sí" });
  assert.equal(llamadas, 0);
});

test("la configuración de cobros se valida y tiene valores por defecto", () => {
  const base = JSON.parse(fs.readFileSync(path.join(RAIZ, "empresas/gomeria-demo.json"), "utf8"));
  assert.throws(
    () => validarEmpresa({ ...base, herramientas: ["buscar_productos", "cobrar_mercado_pago"] }, "x.json"),
    /tomar_pedidos/,
  );
  const sinNada = validarEmpresa({ ...base, herramientas: undefined, mercadoPago: undefined }, "y.json");
  assert.deepEqual(sinNada.herramientas, ["buscar_productos", "tomar_pedidos", "derivar_a_humano"]);
  assert.equal(sinNada.mercadoPago.tokenEnv, "MERCADOPAGO_ACCESS_TOKEN");
});
