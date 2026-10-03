// El SISTEMA REAL del autolavado (lo que en la demo se simula con botones).
//
// - Cuando Mercado Pago aprueba un pago de fichas: se anota en la pestaña Ventas
//   de la planilla y les llega un WhatsApp al cliente y al encargado.
// - El dueño le escribe al mismo número del bot: si manda la foto de una factura,
//   se carga en Gastos; si escribe "balance", recibe el balance del día.
// - Todas las noches (22 h por defecto) el dueño recibe el balance solo.
//
// La caja vive en la planilla del negocio (Ventas y Gastos): el dueño la ve y la
// puede corregir, y no se pierde nada si el servidor se reinicia.

import { hoyEnArgentina, sumarDias } from "../agenda/horarios.js";
import { horaArgentina, avisosDePagoAprobado, contarAutos, fichasTexto, minutos } from "./ventas.js";
import { armarBalance } from "./balance.js";
import { mensajeDeFacturaLeida } from "./factura.js";
import { formatearPesos, parsearNumero } from "../datos/productos.js";
import { mensajeDeError } from "../nucleo/errores.js";

// El mismo número escrito distinto ("5492975551234", "54 297 555-1234") es el mismo.
export function mismoNumero(a, b) {
  const x = String(a ?? "").replace(/\D/g, "");
  const y = String(b ?? "").replace(/\D/g, "");
  return x.length >= 8 && y.length >= 8 && x.slice(-10) === y.slice(-10);
}

const numero = (v) => {
  const n = parsearNumero(v);
  return Number.isFinite(n) ? n : 0;
};
const aVenta = (f) => ({ ...f, bahia: numero(f.bahia), fichas: numero(f.fichas), total: numero(f.total) });
const aGasto = (f) => ({ ...f, total: numero(f.total) });

// Lee la caja de la planilla: las ventas y gastos de hoy y la historia de las
// últimas 3 semanas (por día), que es lo que necesita el balance.
export async function leerCaja(fuente, ahora = new Date()) {
  const hoy = hoyEnArgentina(ahora);
  const [ventas, gastos] = await Promise.all([fuente.listarRegistros("Ventas"), fuente.listarRegistros("Gastos")]);
  const v = ventas.map(aVenta);
  const g = gastos.map(aGasto);
  const historial = [];
  for (let d = 21; d >= 1; d--) {
    const fecha = sumarDias(hoy, -d);
    const delDia = v.filter((x) => x.fecha === fecha);
    // Los días sin ventas cargadas (cerrado, o antes de empezar a usar el sistema) no cuentan.
    if (delDia.length === 0) continue;
    historial.push({
      fecha,
      autos: contarAutos(delDia),
      ingresos: delDia.reduce((t, x) => t + x.total, 0),
      gastosVariables: g.filter((x) => x.fecha === fecha).reduce((t, x) => t + x.total, 0),
    });
  }
  return { ventas: v.filter((x) => x.fecha === hoy), gastos: g.filter((x) => x.fecha === hoy), historial };
}

export async function balanceDelDia({ empresa, fuente, ahora = new Date() }) {
  const caja = await leerCaja(fuente, ahora);
  return armarBalance({ empresa, ...caja, ahora });
}

// ---- Avisos al encargado y al dueño ----
//
// POR QUÉ las plantillas: WhatsApp solo deja mandar mensajes libres a quien te
// escribió en las últimas 24 horas. El cliente acaba de escribir, así que a él sí.
// El encargado y el dueño puede que no: para ellos se usan plantillas aprobadas
// por Meta (fichas.plantillas). Sin plantillas se manda texto común, que llega
// solo si escribieron en las últimas 24 h (por ejemplo un "hola" al empezar el turno).
export function crearAvisosDelNegocio({ enviarTexto, enviarPlantilla }) {
  async function mandar({ empresa, para, texto, plantilla, parametros }) {
    if (!para) return;
    const p = empresa.fichas?.plantillas ?? {};
    if (plantilla && p[plantilla]) {
      await enviarPlantilla({ empresa, para, nombre: p[plantilla], idioma: p.idioma ?? "es_AR", parametros });
    } else {
      await enviarTexto({ empresa, para, texto });
    }
  }
  return {
    alEncargado: (empresa, venta, avisos) =>
      mandar({
        empresa,
        para: empresa.fichas.encargado,
        texto: `🧽 *${avisos.encargado.titulo}*\n${avisos.encargado.detalle}`,
        plantilla: "aviso",
        parametros: [fichasTexto(venta.fichas), String(venta.bahia), formatearPesos(venta.total), venta.id],
      }),
    alDueno: (empresa, balance) =>
      mandar({
        empresa,
        para: empresa.fichas.dueno,
        texto: [balance.texto, balance.alerta?.texto].filter(Boolean).join("\n\n"),
        plantilla: "balance",
        parametros: [
          formatearPesos(balance.numeros.ingresos),
          String(balance.numeros.autos),
          balance.numeros.resultado >= 0 ? `ganancia de ${formatearPesos(balance.numeros.resultado)}` : `pérdida de ${formatearPesos(-balance.numeros.resultado)}`,
        ],
      }),
  };
}

// ---- Pago de fichas aprobado ----
// pago: lo que devolvió Mercado Pago ({ id, pedido, monto, datos: { bahia, fichas, telefono, cliente } }).
//
// POR QUÉ los avisos salen aunque falle la planilla: el cliente ya pagó y está
// esperando en la bahía. Si Google no responde (o falta la pestaña Ventas), el
// encargado igual tiene que llevarle las fichas. El error queda en los registros
// para cargar esa venta a mano.
// avisados: las ventas ya avisadas ("empresa:pedido"), por si la planilla no deja ver lo anotado.
export async function registrarVentaPagada({ empresa, fuente, pago, enviarTexto, avisos, avisados = new Set(), ahora = new Date() }) {
  const id = String(pago.pedido);
  const clave = `${empresa.id}:${id}`;
  if (avisados.has(clave)) return { repetido: true };
  let anotadas = [];
  try {
    anotadas = await fuente.listarRegistros("Ventas");
  } catch (error) {
    console.error(`[fichas] No pude leer la pestaña Ventas de ${empresa.id}: ${mensajeDeError(error)}`);
  }
  if (anotadas.some((v) => String(v.id) === id)) return { repetido: true };
  const d = pago.datos ?? {};
  const venta = {
    id,
    fecha: hoyEnArgentina(ahora),
    hora: horaArgentina(ahora),
    telefono: String(d.telefono ?? ""),
    cliente: String(d.cliente ?? ""),
    bahia: numero(d.bahia),
    fichas: numero(d.fichas),
    total: pago.monto,
    id_pago: pago.id,
  };
  let anotada = true;
  try {
    await fuente.agregarRegistro("Ventas", venta);
  } catch (error) {
    anotada = false;
    console.error(`[fichas] ¡OJO! No pude anotar en la planilla la venta ${id} (${fichasTexto(venta.fichas)}, bahía ${venta.bahia}, ${formatearPesos(venta.total)}, pago ${pago.id}): ${mensajeDeError(error)}. Los avisos salen igual; cargala a mano.`);
  }
  if (avisados.size > 5000) avisados.clear();
  avisados.add(clave);
  const textos = avisosDePagoAprobado(venta);
  // Si falla un aviso, la venta igual queda anotada (y se avisa por consola).
  if (venta.telefono) await enviarTexto({ empresa, para: venta.telefono, texto: textos.cliente }).catch((e) => console.error(`[fichas] No pude avisarle al cliente: ${mensajeDeError(e)}`));
  await avisos.alEncargado(empresa, venta, textos).catch((e) => console.error(`[fichas] No pude avisarle al encargado: ${mensajeDeError(e)}`));
  return { repetido: false, venta, textos, anotada };
}

// ---- Pago de un pedido o un turno (otros negocios) ----
export async function registrarPagoDePedido({ empresa, fuente, pago, enviarTexto, ahora = new Date() }) {
  const anotados = await fuente.listarRegistros("Pagos");
  if (anotados.some((p) => String(p.id_pago) === String(pago.id))) return { repetido: true };
  const d = pago.datos ?? {};
  await fuente.agregarRegistro("Pagos", {
    fecha: hoyEnArgentina(ahora),
    hora: horaArgentina(ahora),
    pedido: String(pago.pedido),
    telefono: String(d.telefono ?? ""),
    cliente: String(d.cliente ?? ""),
    total: pago.monto,
    id_pago: String(pago.id),
  });
  const que = d.tipo === "turno" ? "tu turno quedó pago" : `tu pedido ${pago.pedido} quedó pago`;
  const texto = `¡Recibimos tu pago de ${formatearPesos(pago.monto)}! ✅ ${que.charAt(0).toUpperCase() + que.slice(1)}. ¡Gracias!`;
  if (d.telefono) await enviarTexto({ empresa, para: d.telefono, texto }).catch((e) => console.error(`[pagos] No pude avisarle al cliente: ${mensajeDeError(e)}`));
  return { repetido: false, texto };
}

// ---- El dueño y el encargado le escriben al bot ----

export const AYUDA_DUENO = [
  "Hola 👋 Soy el asistente de tu autolavado. Podés:",
  "📷 Mandarme la *foto de una factura* y la cargo en Gastos.",
  "📊 Escribir *balance* para ver cómo va el día.",
  "✍️ Escribir *gasto trapos 8000* para cargar un gasto sin factura.",
].join("\n");

// Devuelve una función atender(empresa, mensaje, responder) -> true si el
// mensaje era del dueño o del encargado (y ya se contestó). Si no, false y el
// mensaje sigue al bot de clientes.
export function crearAtencionDelNegocio({ crearFuente, leerFactura, descargarMedia, ahora = () => new Date() }) {
  return async function atender(empresa, m, responder) {
    const f = empresa.fichas;
    if (!f) return false;

    if (f.encargado && mismoNumero(m.de, f.encargado)) {
      await responder("👍 Listo. Te aviso por acá cada vez que haya que llevar fichas a una bahía.");
      return true;
    }
    if (!f.dueno || !mismoNumero(m.de, f.dueno)) return false;

    const fuente = crearFuente(empresa);
    const texto = (m.texto ?? "").trim();
    const contestar = async (t) => {
      await responder(t);
      return true;
    };

    if (m.imagen) {
      if (!leerFactura) return contestar("Por ahora no puedo leer fotos.");
      try {
        const img = await descargarMedia({ empresa, mediaId: m.imagen.id });
        if (!img.datos) return contestar("La foto es muy pesada. Mandámela de nuevo, un poco más chica.");
        const factura = await leerFactura({ datos: img.datos, mimeType: img.mimeType || m.imagen.mimeType });
        if (!factura.esFactura) return contestar("No me parece una factura, o no se lee el total 🤔 Probá con otra foto, bien derecha y con buena luz.");
        const ya = await leerCaja(fuente, ahora());
        await fuente.agregarRegistro("Gastos", {
          fecha: hoyEnArgentina(ahora()),
          hora: horaArgentina(ahora()),
          proveedor: factura.proveedor,
          concepto: factura.concepto,
          total: factura.total,
          origen: "foto por WhatsApp",
        });
        const deHoy = ya.gastos.reduce((t, g) => t + g.total, 0) + factura.total;
        await responder(mensajeDeFacturaLeida(factura, deHoy));
      } catch (error) {
        console.error(`[fichas] No pude leer la factura del dueño: ${mensajeDeError(error)}`);
        await responder("No pude leer la foto. Probá de nuevo en un rato.");
      }
      return true;
    }

    if (/\b(balance|resumen|caja|cierre|c[oó]mo vamos)\b/i.test(texto)) {
      const b = await balanceDelDia({ empresa, fuente, ahora: ahora() });
      await responder([b.texto, b.alerta?.texto].filter(Boolean).join("\n\n"));
      return true;
    }

    const gasto = texto.match(/^gasto\s+(.+?)\s+\$?\s*([\d.,]+)$/i);
    if (gasto) {
      const total = numero(gasto[2]);
      if (total <= 0) return contestar("No entendí el monto. Escribilo así: *gasto trapos 8000*");
      await fuente.agregarRegistro("Gastos", {
        fecha: hoyEnArgentina(ahora()),
        hora: horaArgentina(ahora()),
        proveedor: "",
        concepto: gasto[1],
        total,
        origen: "escrito por WhatsApp",
      });
      await responder(`Listo ✅ Cargué *${gasto[1]}* por *${formatearPesos(total)}* en los gastos de hoy.`);
      return true;
    }

    await responder(AYUDA_DUENO);
    return true;
  };
}

// ---- El balance de todas las noches ----
// Cada minuto revisa la hora. Entre la hora del balance (22:00 por defecto) y
// media hora después, si todavía no lo mandó hoy, se lo manda al dueño.
// POR QUÉ una ventana de media hora: si el servidor se reinicia a las 22:10 igual
// lo manda, pero si se reinicia a medianoche no manda uno atrasado.
export function programarBalanceDiario({ empresas, crearFuente, avisos, ahora = () => new Date(), cadaMs = 60_000 }) {
  const enviados = new Map(); // empresa.id -> fecha del último balance enviado
  async function revisar() {
    const momento = ahora();
    const hoy = hoyEnArgentina(momento);
    const ya = minutos(horaArgentina(momento));
    for (const empresa of empresas) {
      const f = empresa.fichas;
      if (!f?.dueno || enviados.get(empresa.id) === hoy) continue;
      const inicio = minutos(f.horaBalance ?? "22:00");
      if (ya < inicio || ya > inicio + 30) continue;
      enviados.set(empresa.id, hoy);
      try {
        const balance = await balanceDelDia({ empresa, fuente: crearFuente(empresa), ahora: momento });
        await avisos.alDueno(empresa, balance);
        console.log(`[fichas] Balance del día enviado al dueño de ${empresa.id}.`);
      } catch (error) {
        console.error(`[fichas] No pude mandar el balance de ${empresa.id}: ${mensajeDeError(error)}`);
      }
    }
  }
  const reloj = setInterval(() => revisar().catch(() => {}), cadaMs);
  reloj.unref?.();
  return { revisar, detener: () => clearInterval(reloj) };
}
