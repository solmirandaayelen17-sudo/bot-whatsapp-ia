// Pruebas del SISTEMA REAL del autolavado: aviso de pago de Mercado Pago,
// planilla (Ventas, Gastos, Pagos), WhatsApp al cliente, al encargado y al dueño,
// y el balance de la noche. Sin internet: Mercado Pago y WhatsApp son de mentira.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { validarEmpresa } from "../src/config/empresas.js";
import { crearFuenteLocal } from "../src/datos/fuenteLocal.js";
import { crearRouterMercadoPago } from "../src/pagos/avisosDePago.js";
import { firmaMercadoPagoValida, armarPreferencia } from "../src/pagos/mercadoPago.js";
import { crearAvisosDelNegocio, crearAtencionDelNegocio, programarBalanceDiario, leerCaja, mismoNumero, AYUDA_DUENO } from "../src/fichas/sistema.js";
import { extraerMensajes } from "../src/canales/whatsapp.js";

const ENCARGADO = "5492975550001";
const DUENO = "5492975550002";

function negocio(extra = {}) {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "lavadero-"));
  const empresa = validarEmpresa({
    id: "lavadero",
    nombre: "Lavadero Test",
    rubro: "autolavado",
    negocio: { horarios: "todos los días" },
    datos: { tipo: "local", carpeta },
    herramientas: ["vender_fichas"],
    fichas: {
      bahias: 6,
      precios: [{ cantidad: 1, precio: 4000 }, { cantidad: 3, precio: 11000 }],
      encargado: ENCARGADO,
      dueno: DUENO,
      gastosFijosMensuales: [{ concepto: "Todo", monto: 3000000 }],
      ...extra,
    },
  });
  const fuente = crearFuenteLocal(carpeta);
  return { empresa, fuente, crearFuente: () => fuente };
}

function whatsappDeMentira() {
  const enviados = [];
  return {
    enviados,
    enviarTexto: async ({ para, texto }) => enviados.push({ para, texto }),
    enviarPlantilla: async ({ para, nombre, parametros }) => enviados.push({ para, plantilla: nombre, parametros }),
  };
}

const pagoDeFichas = (estado = "approved") => ({
  id: "9001",
  estado,
  pedido: "F-ABC",
  monto: 11000,
  datos: { empresa: "lavadero", tipo: "fichas", bahia: 5, fichas: 3, telefono: "5492971112222", cliente: "Ana" },
});

test("la firma de los avisos de Mercado Pago se verifica", () => {
  const secreto = "clave-secreta";
  const firmado = "id:9001;request-id:req-1;ts:1704908010;";
  const v1 = crypto.createHmac("sha256", secreto).update(firmado).digest("hex");
  assert.equal(firmaMercadoPagoValida({ dataId: "9001", requestId: "req-1", firma: `ts=1704908010,v1=${v1}`, secreto }), true);
  assert.equal(firmaMercadoPagoValida({ dataId: "9002", requestId: "req-1", firma: `ts=1704908010,v1=${v1}`, secreto }), false);
  assert.equal(firmaMercadoPagoValida({ dataId: "9001", requestId: "req-1", firma: "cualquier cosa", secreto }), false);
});

test("el link de pago lleva los datos de la venta y la dirección de avisos", () => {
  const { empresa } = negocio();
  const p = armarPreferencia({
    empresa,
    pedido: { id: "F-1", lineas: [{ codigo: "FICHAS", nombre: "3 fichas", cantidad: 1, precio: 11000 }], datos: { tipo: "fichas", bahia: 5 } },
    entorno: { URL_PUBLICA: "https://bot.up.railway.app/" },
  });
  assert.deepEqual(p.metadata, { tipo: "fichas", bahia: 5, empresa: "lavadero", pedido: "F-1" });
  assert.equal(p.notification_url, "https://bot.up.railway.app/webhooks/mercadopago/lavadero");
  assert.equal(armarPreferencia({ empresa, pedido: { id: "F-2", lineas: [] }, entorno: {} }).notification_url, undefined);
});

test("pago de fichas aprobado: se anota una sola vez y les llega el WhatsApp al cliente y al encargado", async () => {
  const { empresa, fuente, crearFuente } = negocio();
  const wa = whatsappDeMentira();
  const avisos = crearAvisosDelNegocio(wa);
  let consultas = 0;
  const router = crearRouterMercadoPago({
    empresasPorId: new Map([["lavadero", empresa]]),
    crearFuente,
    enviarTexto: wa.enviarTexto,
    avisos,
    consultarPago: async () => (consultas++, pagoDeFichas()),
  });
  // Mercado Pago avisa dos veces casi juntas por el mismo pago.
  await Promise.all([router.procesarPago(empresa, "9001"), router.procesarPago(empresa, "9001")]);
  await router.procesarPago(empresa, "9001"); // y otra vez más tarde

  const ventas = await fuente.listarRegistros("Ventas");
  assert.equal(ventas.length, 1);
  assert.equal(ventas[0].id, "F-ABC");
  assert.equal(ventas[0].bahia, "5");
  assert.equal(ventas[0].total, "11000");
  assert.equal(ventas[0].id_pago, "9001");
  assert.equal(consultas, 3);
  assert.equal(wa.enviados.length, 2);
  assert.equal(wa.enviados[0].para, "5492971112222");
  assert.match(wa.enviados[0].texto, /Ya te llevan 3 fichas a la bahía 5/);
  assert.equal(wa.enviados[1].para, ENCARGADO);
  assert.match(wa.enviados[1].texto, /Llevar 3 fichas a la BAHÍA 5/);
});

test("si la planilla falla, al encargado igual le llega el aviso (una sola vez)", async () => {
  const { empresa } = negocio();
  const rota = {
    listarRegistros: async () => { throw new Error("Unable to parse range: Ventas"); },
    agregarRegistro: async () => { throw new Error("Unable to parse range: Ventas"); },
  };
  const wa = whatsappDeMentira();
  const router = crearRouterMercadoPago({
    empresasPorId: new Map([["lavadero", empresa]]),
    crearFuente: () => rota,
    enviarTexto: wa.enviarTexto,
    avisos: crearAvisosDelNegocio(wa),
    consultarPago: async () => ({ ...pagoDeFichas(), id: "9999", pedido: "F-SINPLANILLA" }),
  });
  const error = console.error;
  const errores = [];
  console.error = (m) => errores.push(String(m));
  try {
    await router.procesarPago(empresa, "9999");
    await router.procesarPago(empresa, "9999"); // Mercado Pago avisa de nuevo
  } finally {
    console.error = error;
  }
  assert.equal(wa.enviados.length, 2, "un aviso al cliente y uno al encargado, sin repetir");
  assert.equal(wa.enviados[1].para, ENCARGADO);
  assert.ok(errores.some((m) => /No pude anotar en la planilla la venta F-SINPLANILLA/.test(m)));
});

test("un pago pendiente o rechazado no se anota", async () => {
  const { empresa, fuente, crearFuente } = negocio();
  const wa = whatsappDeMentira();
  const router = crearRouterMercadoPago({
    empresasPorId: new Map([["lavadero", empresa]]),
    crearFuente,
    enviarTexto: wa.enviarTexto,
    avisos: crearAvisosDelNegocio(wa),
    consultarPago: async () => pagoDeFichas("pending"),
  });
  assert.deepEqual(await router.procesarPago(empresa, "9001"), { anotado: false, motivo: "pending" });
  assert.equal((await fuente.listarRegistros("Ventas")).length, 0);
  assert.equal(wa.enviados.length, 0);
});

test("con plantillas de Meta, al encargado le llega la plantilla con los datos", async () => {
  const { empresa, crearFuente } = negocio({ plantillas: { aviso: "aviso_fichas", idioma: "es_AR" } });
  const wa = whatsappDeMentira();
  const router = crearRouterMercadoPago({
    empresasPorId: new Map([["lavadero", empresa]]),
    crearFuente,
    enviarTexto: wa.enviarTexto,
    avisos: crearAvisosDelNegocio(wa),
    consultarPago: async () => pagoDeFichas(),
  });
  await router.procesarPago(empresa, "9001");
  assert.deepEqual(wa.enviados[1], { para: ENCARGADO, plantilla: "aviso_fichas", parametros: ["3 fichas", "5", "$11.000", "F-ABC"] });
});

test("el pago de un pedido común se anota en Pagos y le avisa al cliente", async () => {
  const { empresa, fuente, crearFuente } = negocio();
  const wa = whatsappDeMentira();
  const router = crearRouterMercadoPago({
    empresasPorId: new Map([["lavadero", empresa]]),
    crearFuente,
    enviarTexto: wa.enviarTexto,
    avisos: crearAvisosDelNegocio(wa),
    consultarPago: async () => ({ id: "77", estado: "approved", pedido: "P-XYZ", monto: 198000, datos: { tipo: "pedido", telefono: "5492973334444", cliente: "Juan" } }),
  });
  await router.procesarPago(empresa, "77");
  await router.procesarPago(empresa, "77");
  const pagos = await fuente.listarRegistros("Pagos");
  assert.equal(pagos.length, 1);
  assert.equal(pagos[0].pedido, "P-XYZ");
  assert.equal(wa.enviados.length, 1);
  assert.match(wa.enviados[0].texto, /Recibimos tu pago de \$198\.000.*Tu pedido P-XYZ quedó pago/);
});

test("el webhook responde rápido, ignora lo que no es un pago y descarta firmas falsas", async () => {
  const { empresa, crearFuente } = negocio();
  const wa = whatsappDeMentira();
  const consultados = [];
  const app = express();
  app.use(
    crearRouterMercadoPago({
      empresasPorId: new Map([["lavadero", empresa]]),
      crearFuente,
      enviarTexto: wa.enviarTexto,
      avisos: crearAvisosDelNegocio(wa),
      consultarPago: async ({ id }) => (consultados.push(id), pagoDeFichas("pending")),
      entorno: { MERCADOPAGO_WEBHOOK_SECRET: "secreto" },
    }),
  );
  const servidor = await new Promise((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  const base = `http://127.0.0.1:${servidor.address().port}/webhooks/mercadopago`;
  const post = (ruta, cuerpo, headers = {}) => fetch(base + ruta, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(cuerpo) });
  try {
    assert.equal((await post("/otra-empresa?type=payment&data.id=1", {})).status, 404);
    assert.equal((await post("/lavadero?type=merchant_order&data.id=1", {})).status, 200);
    assert.equal((await post("/lavadero?type=payment&data.id=55", { type: "payment", data: { id: "55" } }, { "x-signature": "ts=1,v1=00", "x-request-id": "r" })).status, 401);
    assert.equal((await post("/lavadero?type=payment&data.id=56", { type: "payment", data: { id: "56" } })).status, 200);
    await new Promise((ok) => setTimeout(ok, 50));
    assert.deepEqual(consultados, ["56"]);
  } finally {
    await new Promise((ok) => {
      servidor.close(ok);
      servidor.closeAllConnections();
    });
  }
});

test("el dueño carga facturas por foto, gastos escritos y pide el balance; el encargado recibe un ok", async () => {
  const { empresa, fuente, crearFuente } = negocio();
  const ahora = () => new Date("2026-10-02T21:00:00Z"); // 18:00 en Argentina
  await fuente.agregarRegistro("Ventas", { id: "F-1", fecha: "2026-10-02", hora: "17:10", telefono: "1", cliente: "A", bahia: 2, fichas: 3, total: 11000, id_pago: "1" });
  const atender = crearAtencionDelNegocio({
    crearFuente,
    descargarMedia: async () => ({ datos: Buffer.from("foto"), mimeType: "image/jpeg" }),
    leerFactura: async () => ({ esFactura: true, proveedor: "Química del Sur", fecha: "", concepto: "shampoo", total: 48000 }),
    ahora,
  });
  const respuestas = [];
  const responder = async (t) => respuestas.push(t);

  assert.equal(await atender(empresa, { de: DUENO, imagen: { id: "m1", mimeType: "image/jpeg" } }, responder), true);
  assert.match(respuestas.at(-1), /Leí la factura ✅[\s\S]*\$48\.000/);
  assert.equal(await atender(empresa, { de: DUENO, texto: "gasto trapos 8.000" }, responder), true);
  assert.match(respuestas.at(-1), /Cargué \*trapos\* por \*\$8\.000\*/);
  const gastos = await fuente.listarRegistros("Gastos");
  assert.deepEqual(gastos.map((g) => [g.concepto, g.total, g.origen]), [["shampoo", "48000", "foto por WhatsApp"], ["trapos", "8000", "escrito por WhatsApp"]]);

  assert.equal(await atender(empresa, { de: DUENO, texto: "Balance" }, responder), true);
  assert.match(respuestas.at(-1), /Balance de hoy[\s\S]*Entró: \*\$11\.000\*[\s\S]*compras \$56\.000/);
  assert.equal(await atender(empresa, { de: DUENO, texto: "hola" }, responder), true);
  assert.equal(respuestas.at(-1), AYUDA_DUENO);

  assert.equal(await atender(empresa, { de: "5402975550001", texto: "hola" }, responder), true); // el encargado, escrito sin el 9
  assert.match(respuestas.at(-1), /Te aviso por acá/);
  assert.equal(await atender(empresa, { de: "5492979999999", texto: "quiero fichas" }, responder), false); // un cliente: sigue al bot
});

test("la caja de la planilla arma la historia por día para la alerta", async () => {
  const { fuente } = negocio();
  for (const [fecha, hora, total] of [["2026-09-30", "10:00", 4000], ["2026-09-30", "11:00", 11000], ["2026-10-01", "12:00", 4000], ["2026-10-02", "09:00", 11000]]) {
    await fuente.agregarRegistro("Ventas", { id: `F-${fecha}${hora}`, fecha, hora, telefono: hora, cliente: "", bahia: 1, fichas: 1, total, id_pago: "" });
  }
  await fuente.agregarRegistro("Gastos", { fecha: "2026-09-30", hora: "09:00", proveedor: "", concepto: "x", total: 5000, origen: "" });
  const caja = await leerCaja(fuente, new Date("2026-10-02T20:00:00Z"));
  assert.equal(caja.ventas.length, 1);
  assert.deepEqual(caja.historial, [
    { fecha: "2026-09-30", autos: 2, ingresos: 15000, gastosVariables: 5000 },
    { fecha: "2026-10-01", autos: 1, ingresos: 4000, gastosVariables: 0 },
  ]);
});

test("el balance de la noche se manda una vez, a la hora configurada", async () => {
  const { empresa, crearFuente } = negocio({ horaBalance: "22:00" });
  const wa = whatsappDeMentira();
  let momento = new Date("2026-10-03T00:30:00Z"); // 21:30 en Argentina
  const reloj = programarBalanceDiario({ empresas: [empresa], crearFuente, avisos: crearAvisosDelNegocio(wa), ahora: () => momento, cadaMs: 10_000_000 });
  try {
    await reloj.revisar();
    assert.equal(wa.enviados.length, 0);
    momento = new Date("2026-10-03T01:05:00Z"); // 22:05
    await reloj.revisar();
    await reloj.revisar();
    assert.equal(wa.enviados.length, 1);
    assert.equal(wa.enviados[0].para, DUENO);
    assert.match(wa.enviados[0].texto, /Balance de hoy/);
  } finally {
    reloj.detener();
  }
});

test("las fotos de WhatsApp llegan con su id, y los números se comparan bien", () => {
  const [m] = extraerMensajes({
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1" }, messages: [{ id: "w1", from: DUENO, type: "image", image: { id: "img-9", mime_type: "image/jpeg" } }] } }] }],
  });
  assert.deepEqual(m.imagen, { id: "img-9", mimeType: "image/jpeg" });
  assert.equal(m.texto, null);
  assert.equal(mismoNumero("5492975550002", "54 297 555-0002"), true);
  assert.equal(mismoNumero("5492975550002", "5492975550003"), false);
});
