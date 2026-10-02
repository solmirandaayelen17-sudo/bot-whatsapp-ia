// VENTA DE FICHAS para autolavados: precios, ventas y avisos.
//
// Cómo funciona: el cliente pide fichas por WhatsApp desde su bahía, el bot le
// manda el link de pago y, cuando el pago se aprueba, el sistema solo:
//   1. anota la venta en la caja del día,
//   2. le avisa al cliente que ya le llevan las fichas,
//   3. le avisa al encargado a qué bahía ir y cuántas llevar.
// El encargado no cobra ni anota nada.
//
// POR QUÉ el precio lo calcula el código: con combos (3 fichas más baratas que
// 3 sueltas) es fácil equivocarse. La IA solo dice "3 fichas, bahía 5"; el
// código arma la combinación más barata y el total.

import { formatearPesos } from "../datos/productos.js";

// La forma más barata de comprar `cantidad` fichas con los combos disponibles.
// precios: [{ cantidad: 1, precio: 4000 }, { cantidad: 3, precio: 11000 }, ...]
// Devuelve { total, detalle: [{ cantidad, precio, veces }] } o null si no se puede.
export function mejorPrecio(precios, cantidad) {
  const mejor = Array(cantidad + 1).fill(null);
  mejor[0] = { total: 0, usados: [] };
  for (let n = 1; n <= cantidad; n++) {
    for (const p of precios) {
      const antes = n - p.cantidad >= 0 ? mejor[n - p.cantidad] : null;
      if (!antes) continue;
      const total = antes.total + p.precio;
      if (!mejor[n] || total < mejor[n].total) mejor[n] = { total, usados: [...antes.usados, p] };
    }
  }
  if (!mejor[cantidad]) return null;
  const veces = new Map();
  for (const p of mejor[cantidad].usados) veces.set(p, (veces.get(p) ?? 0) + 1);
  const detalle = [...veces].map(([p, v]) => ({ cantidad: p.cantidad, precio: p.precio, veces: v })).sort((a, b) => b.cantidad - a.cantidad);
  return { total: mejor[cantidad].total, detalle };
}

export function describirCombinacion(detalle) {
  return detalle
    .map(({ cantidad, veces }) => (cantidad === 1 ? `${veces} ${veces === 1 ? "ficha suelta" : "fichas sueltas"}` : `${veces} ${veces === 1 ? "combo" : "combos"} de ${cantidad}`))
    .join(" + ");
}

export const fichasTexto = (n) => `${n} ${n === 1 ? "ficha" : "fichas"}`;

// La lista de precios como la ve el cliente: "1 ficha: $4.000 · 3 fichas: $11.000".
export function listaDePrecios(precios) {
  return [...precios].sort((a, b) => a.cantidad - b.cantidad).map((p) => `${fichasTexto(p.cantidad)}: ${formatearPesos(p.precio)}`).join(" · ");
}

export const horaArgentina = (fecha) =>
  fecha.toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false });

// Los textos que manda el sistema cuando se aprueba un pago.
export function avisosDePagoAprobado(venta) {
  const fin = venta.telefono ? ` (…${String(venta.telefono).slice(-4)})` : "";
  return {
    cliente: `¡Pago aprobado! ✅\nYa te llevan ${fichasTexto(venta.fichas)} a la bahía ${venta.bahia}. ¡Buen lavado! 🚗`,
    encargado: {
      titulo: `Llevar ${fichasTexto(venta.fichas)} a la BAHÍA ${venta.bahia}`,
      detalle: `Pagado ✓ ${formatearPesos(venta.total)} · Pedido ${venta.id} · ${venta.cliente || "Cliente"}${fin}`,
    },
  };
}

// El LIBRO de ventas y gastos del autolavado.
//
// clave: de quién es la caja. En un negocio real hay una sola (la del negocio).
// En la demo pública cada visitante tiene la suya, así nadie ve las compras de otro.
// semilla(ahora): datos de ejemplo con los que arranca una caja nueva (solo en la demo).
export function crearLibroDeFichas({ claveDe = (ctx, empresa) => empresa.id, semilla = null, maximoDeCajas = 2000 } = {}) {
  const cajas = new Map(); // clave -> { pendientes: Map, ventas: [], gastos: [], historial: [] }

  function caja(clave) {
    if (!cajas.has(clave)) {
      if (cajas.size >= maximoDeCajas) cajas.delete(cajas.keys().next().value); // se olvida la más vieja
      const base = semilla ? semilla(new Date()) : {};
      cajas.set(clave, { pendientes: new Map(), ventas: base.ventas ?? [], gastos: base.gastos ?? [], historial: base.historial ?? [] });
    }
    return cajas.get(clave);
  }

  return {
    claveDe,
    caja,
    registrarPendiente(clave, venta) {
      caja(clave).pendientes.set(venta.id, { ...venta, estado: "esperando pago" });
    },
    pendiente(clave, id) {
      return caja(clave).pendientes.get(id) ?? caja(clave).ventas.find((v) => v.id === id) ?? null;
    },
    // Marca la venta como pagada y la pasa a la caja. Si ya estaba pagada no la
    // anota dos veces (Mercado Pago a veces avisa más de una vez el mismo pago).
    aprobar(clave, id, ahora = new Date()) {
      const c = caja(clave);
      const yaPagada = c.ventas.find((v) => v.id === id);
      if (yaPagada) return { venta: yaPagada, repetido: true };
      const venta = c.pendientes.get(id);
      if (!venta) return null;
      c.pendientes.delete(id);
      const pagada = { ...venta, estado: "pagado", pagadaEn: ahora, hora: horaArgentina(ahora), propia: true };
      c.ventas.push(pagada);
      return { venta: pagada, repetido: false };
    },
    agregarGasto(clave, gasto) {
      caja(clave).gastos.push(gasto);
    },
  };
}

// Cuántos autos hubo: compras del mismo teléfono en la misma bahía con menos de
// 20 minutos de diferencia son el mismo auto (compró fichas de nuevo).
export function contarAutos(ventas) {
  const ultimas = new Map();
  let autos = 0;
  for (const v of [...ventas].sort((a, b) => minutos(a.hora) - minutos(b.hora))) {
    const quien = `${v.telefono}|${v.bahia}`;
    const antes = ultimas.get(quien);
    if (antes === undefined || minutos(v.hora) - antes > 20) autos++;
    ultimas.set(quien, minutos(v.hora));
  }
  return autos;
}

export function minutos(hora) {
  const [h, m] = String(hora).split(":").map(Number);
  return h * 60 + m;
}

