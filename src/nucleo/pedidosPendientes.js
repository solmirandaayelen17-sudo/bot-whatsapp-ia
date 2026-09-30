// Pedidos COTIZADOS que esperan que el cliente diga "sí".
//
// POR QUÉ: un pedido se toma en dos pasos. Primero se cotiza (el cliente ve el
// detalle y el total) y recién en un mensaje POSTERIOR del cliente se puede
// confirmar. Guardamos en qué "turno" de la charla se cotizó: si la IA intenta
// confirmar en el mismo turno, el código lo rechaza. Así es imposible anotar un
// pedido que el cliente no vio, aunque la IA se apure.
//
// Vive en memoria y vence sola a las 2 horas (una cotización vieja puede tener
// precios desactualizados).

const VENCE_EN_MS = 2 * 60 * 60_000;

export function crearPedidosPendientes(ahora = () => Date.now()) {
  const pendientes = new Map();
  return {
    guardar(hiloId, cotizacion) {
      pendientes.set(hiloId, { ...cotizacion, creadoEn: ahora() });
    },
    obtener(hiloId) {
      const p = pendientes.get(hiloId);
      if (!p) return null;
      if (ahora() - p.creadoEn > VENCE_EN_MS) {
        pendientes.delete(hiloId);
        return null;
      }
      return p;
    },
    borrar(hiloId) {
      pendientes.delete(hiloId);
    },
  };
}
