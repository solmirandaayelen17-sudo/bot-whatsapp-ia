// Pruebas del AUTOLAVADO: venta de fichas, caja, facturas por foto y balance.
// Sin Mercado Pago ni IA de verdad.

import test from "node:test";
import assert from "node:assert/strict";
import { validarEmpresa } from "../src/config/empresas.js";
import { mejorPrecio, describirCombinacion, crearLibroDeFichas, contarAutos, avisosDePagoAprobado } from "../src/fichas/ventas.js";
import { armarBalance, proyectar } from "../src/fichas/balance.js";
import { interpretarRespuesta } from "../src/fichas/factura.js";
import { datosDeEjemplo } from "../src/fichas/datosDeEjemplo.js";
import { crearHerramientas } from "../src/agente/herramientas.js";
import { crearSimulador } from "../src/canales/simuladorWhatsApp.js";
import { crearAppDemo } from "../src/canales/demoWeb.js";
import { rutasDeAutolavado, cobrosDeDemo, PAGINA_AUTOLAVADO } from "../src/canales/demoAutolavado.js";

const empresa = validarEmpresa({
  id: "lavadero",
  nombre: "Lavadero Test",
  rubro: "autolavado",
  negocio: { horarios: "todos los días" },
  datos: { tipo: "local", carpeta: "datos/x" },
  herramientas: ["vender_fichas"],
  fichas: {
    bahias: 6,
    precios: [{ cantidad: 1, precio: 4000 }, { cantidad: 3, precio: 11000 }, { cantidad: 5, precio: 17500 }],
    gastosFijosMensuales: [{ concepto: "Todo", monto: 4500000 }],
    reserva: 2000000,
  },
});

test("el precio de las fichas es siempre la combinación más barata", () => {
  const precios = empresa.fichas.precios;
  assert.equal(mejorPrecio(precios, 1).total, 4000);
  assert.equal(mejorPrecio(precios, 3).total, 11000);
  assert.equal(mejorPrecio(precios, 4).total, 15000);
  // 6 fichas: 5 + 1 ($21.500) sale menos que 3 + 3 ($22.000).
  const seis = mejorPrecio(precios, 6);
  assert.equal(seis.total, 21500);
  assert.equal(describirCombinacion(seis.detalle), "1 combo de 5 + 1 ficha suelta");
  assert.equal(mejorPrecio(precios, 10).total, 35000);
});

test("la configuración pide bahías y precios, con precio para una ficha suelta", () => {
  const base = { id: "x", nombre: "x", rubro: "x", negocio: { horarios: "h" }, datos: { tipo: "local", carpeta: "d" } };
  assert.throws(() => validarEmpresa({ ...base, herramientas: ["vender_fichas"] }), /hace falta la sección "fichas"/);
  assert.throws(() => validarEmpresa({ ...base, fichas: { bahias: 4, precios: [{ cantidad: 3, precio: 9000 }] } }), /1 ficha suelta/);
  assert.equal(empresa.fichas.maximoPorCompra, 10);
});

test("vender_fichas valida la bahía, arma el link y deja la venta esperando el pago", async () => {
  const libro = crearLibroDeFichas();
  const links = [];
  const cobros = { crearLink: async ({ pedido }) => (links.push(pedido), { link: `https://pago/${pedido.id}`, id: "1" }) };
  const [vender] = crearHerramientas({ empresa, fuente: {}, pausas: {}, pendientes: {}, cobros, libroFichas: libro });
  assert.equal(vender.name, "vender_fichas");

  const mala = JSON.parse(await vender.invoke({ bahia: 9, cantidad: 3 }));
  assert.equal(mala.ok, false);
  assert.match(mala.instruccion, /de la 1 a la 6/);
  assert.equal(JSON.parse(await vender.invoke({ bahia: 2, cantidad: 40 })).ok, false);

  const ok = JSON.parse(await vender.invoke({ bahia: 5, cantidad: 3 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.total, "$11.000");
  assert.equal(ok.link_de_pago, `https://pago/${ok.pedido}`);
  assert.equal(links[0].lineas[0].precio, 11000);
  // Todavía no está en la caja: falta que se apruebe el pago.
  const caja = libro.caja(empresa.id);
  assert.equal(caja.ventas.length, 0);
  assert.equal(libro.pendiente(empresa.id, ok.pedido).estado, "esperando pago");
});

test("al aprobarse el pago, la venta pasa a la caja una sola vez y salen los avisos", () => {
  const libro = crearLibroDeFichas();
  libro.registrarPendiente("caja", { id: "F-1", bahia: 5, fichas: 3, total: 11000, cliente: "Ana", telefono: "5492971234567" });
  const r = libro.aprobar("caja", "F-1", new Date("2026-10-02T21:42:00Z"));
  assert.equal(r.repetido, false);
  assert.equal(r.venta.hora, "18:42");
  assert.equal(libro.caja("caja").ventas.length, 1);
  // Mercado Pago a veces avisa dos veces: no se anota de nuevo.
  assert.equal(libro.aprobar("caja", "F-1").repetido, true);
  assert.equal(libro.caja("caja").ventas.length, 1);
  assert.equal(libro.aprobar("caja", "NO-EXISTE"), null);

  const avisos = avisosDePagoAprobado(r.venta);
  assert.match(avisos.cliente, /Ya te llevan 3 fichas a la bahía 5/);
  assert.equal(avisos.encargado.titulo, "Llevar 3 fichas a la BAHÍA 5");
  assert.match(avisos.encargado.detalle, /Pagado ✓ \$11\.000 · Pedido F-1 · Ana \(…4567\)/);
});

test("el mismo auto comprando de nuevo en la misma bahía cuenta una sola vez", () => {
  const v = (hora, telefono, bahia) => ({ hora, telefono, bahia });
  assert.equal(contarAutos([v("10:00", "A", 1), v("10:12", "A", 1), v("10:50", "A", 1), v("10:05", "B", 2)]), 3);
});

test("el balance suma, calcula la ganancia y avisa si el negocio viene bajando", () => {
  const datos = datosDeEjemplo(empresa, new Date("2026-10-02T23:00:00Z"));
  const b = armarBalance({ empresa, ...datos, ahora: new Date("2026-10-02T23:00:00Z") });
  const n = b.numeros;
  assert.equal(n.ingresos, datos.ventas.reduce((t, x) => t + x.total, 0));
  assert.equal(n.fijosDia, 150000);
  assert.equal(n.resultado, n.ingresos - n.fijosDia - 22000);
  assert.match(b.texto, /Balance de hoy/);
  assert.match(b.texto, /Ganancia del día/);
  assert.equal(b.alerta.nivel, "atencion");
  assert.match(b.alerta.texto, /bajaste de 29 a 20 autos por día/);
  assert.match(b.alerta.texto, /se termina tu reserva/);
  assert.match(b.alerta.texto, /martes son tus días más flojos/);

  // Si el negocio viene estable, no hay alarma.
  const estable = datos.historial.map((d) => ({ ...d, autos: 25, ingresos: 25 * 9300 }));
  assert.equal(armarBalance({ empresa, ...datos, historial: estable }).alerta.nivel, "bien");

  // Un día flojo muestra la pérdida.
  const flojo = armarBalance({ empresa, ventas: datos.ventas.slice(0, 3), gastos: [], historial: datos.historial });
  assert.match(flojo.texto, /Pérdida del día/);
  assert.match(flojo.texto, /te faltaron/);
});

test("la proyección dice cuándo se empieza a perder y cuándo se termina la reserva", () => {
  const p = proyectar({ autosHoy: 20, cambioPorSemana: -4, ticket: 10000, costoDiario: 150000, reserva: 1000000 });
  assert.equal(p.empiezaAPerder, 2); // 20 - 8 = 12 autos: 120.000 < 150.000
  assert.ok(p.seTerminaLaReserva > p.empiezaAPerder);
  const sinPerder = proyectar({ autosHoy: 30, cambioPorSemana: 0, ticket: 10000, costoDiario: 150000, reserva: 0 });
  assert.deepEqual(sinPerder, { empiezaAPerder: null, seTerminaLaReserva: null });
});

test("la lectura de facturas acepta solo respuestas con sentido", () => {
  assert.deepEqual(interpretarRespuesta('```json\n{"es_factura": true, "proveedor": "Química del Sur", "fecha": "2026-10-02", "concepto": "shampoo", "total": "48.000,00"}\n```'), {
    esFactura: true,
    proveedor: "Química del Sur",
    fecha: "2026-10-02",
    concepto: "shampoo",
    total: 48000,
  });
  assert.deepEqual(interpretarRespuesta('{"es_factura": false}'), { esFactura: false });
  assert.deepEqual(interpretarRespuesta('{"es_factura": true, "total": 0}'), { esFactura: false });
  assert.equal(interpretarRespuesta("no sé qué es esto"), null);
});

test("la página del autolavado: pago de prueba, aviso al encargado, caja, factura y balance", async () => {
  const libro = crearLibroDeFichas({ claveDe: (ctx) => ctx.telefono, semilla: (a) => datosDeEjemplo(empresa, a) });
  const sim = await crearSimulador({ empresa, procesar: async () => "ok" });
  const facturas = [];
  const leerFactura = async ({ mimeType }) => (facturas.push(mimeType), { esFactura: true, proveedor: "Química del Sur", fecha: "", concepto: "shampoo", total: 48000 });
  const app = crearAppDemo({ empresa, sim, pagina: PAGINA_AUTOLAVADO, rutas: rutasDeAutolavado({ empresa, libro, leerFactura }) });
  const servidor = await new Promise((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    assert.match(await (await fetch(base + "/")).text(), /Demo autolavado · Zaivum IA/);
    const { sesion, telefono } = await (await fetch(base + "/api/sesion", { method: "POST" })).json();
    const post = (ruta, cuerpo, tipo = "application/json") =>
      fetch(base + ruta, { method: "POST", headers: { "Content-Type": tipo, "X-Demo-Sesion": sesion }, body: cuerpo });

    // La caja de cada visitante arranca con ventas de ejemplo.
    const antes = await (await post("/api/caja")).json();
    assert.equal(antes.cantidad, 21);

    // El bot dejó una venta esperando el pago (como haría vender_fichas).
    const { link } = await cobrosDeDemo.crearLink({ pedido: { id: "F-77" } });
    assert.match(link, /pref_id=DEMO-F-77/);
    libro.registrarPendiente(telefono, { id: "F-77", bahia: 5, fichas: 3, total: 11000, detalle: "1 combo de 3", cliente: "Ana", telefono });
    assert.deepEqual(await (await post("/api/pedido", JSON.stringify({ pedido: "F-77" }))).json(), {
      pedido: "F-77", bahia: 5, fichas: 3, total: 11000, detalle: "1 combo de 3", pagado: false,
    });

    const pago = await (await post("/api/pagar", JSON.stringify({ pedido: "F-77" }))).json();
    assert.equal(pago.tipo, "aprobado");
    assert.match(pago.cliente, /Pago aprobado/);
    assert.equal(pago.encargado.titulo, "Llevar 3 fichas a la BAHÍA 5");
    assert.equal(pago.caja.cantidad, 22);
    assert.equal(pago.caja.ventas[0].propia, true); // la compra del visitante, primera y resaltada
    assert.equal((await (await post("/api/pagar", JSON.stringify({ pedido: "F-77" }))).json()).tipo, "ya-pagado");

    // Otro visitante no ve esta compra ni la puede pagar.
    const otro = await (await fetch(base + "/api/sesion", { method: "POST" })).json();
    const r = await fetch(base + "/api/pagar", { method: "POST", headers: { "Content-Type": "application/json", "X-Demo-Sesion": otro.sesion }, body: '{"pedido":"F-77"}' });
    assert.equal(r.status, 404);

    const factura = await (await post("/api/factura-ejemplo")).json();
    assert.equal(factura.tipo, "factura");
    assert.match(factura.texto, /Química del Sur/);
    assert.equal((await post("/api/factura", Buffer.from("foto"), "image/jpeg")).status, 200);
    assert.deepEqual(facturas, ["image/png", "image/jpeg"]);
    assert.equal((await post("/api/factura", Buffer.from("x"), "application/pdf")).status, 400);

    const balance = await (await post("/api/balance")).json();
    assert.match(balance.texto, /Autos: \*22\*/);
    assert.match(balance.texto, /compras \$118\.000/); // 22.000 de ejemplo + 2 facturas de 48.000
    assert.match(balance.alerta, /Atención/);
  } finally {
    await new Promise((ok) => {
      servidor.close(ok);
      servidor.closeAllConnections();
    });
    await sim.cerrar();
  }
});
