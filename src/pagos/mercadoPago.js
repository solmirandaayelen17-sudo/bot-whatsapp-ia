// COBROS con Mercado Pago (Checkout Pro).
//
// Cómo funciona: cuando el cliente confirma un pedido, le pedimos a Mercado
// Pago una "preferencia" (el pedido con sus productos y precios) y nos devuelve
// un link. El cliente lo abre y paga como quiera (tarjeta, dinero en cuenta, etc.).
//
// POR QUÉ el link lo arma el código y no la IA: los precios salen de la
// cotización validada contra la planilla. La IA no puede cambiar el monto.
//
// Cada negocio cobra en SU cuenta de Mercado Pago: el token de cada empresa va
// en el .env (el nombre de la variable se elige en el JSON de la empresa).

const API = "https://api.mercadopago.com";
export const HORAS_DE_VALIDEZ = 48;

// Mercado Pago pide las fechas con zona horaria, por ejemplo
// "2026-10-01T15:30:00.000-03:00". Argentina no cambia de hora en el año.
export function fechaConZonaArgentina(fecha) {
  const local = new Date(fecha.getTime() - 3 * 60 * 60_000);
  return local.toISOString().replace("Z", "-03:00");
}

// pedido: { id, lineas: [{ codigo, nombre, cantidad, precio }] }
export function armarPreferencia({ empresa, pedido, ahora = new Date() }) {
  return {
    items: pedido.lineas.map((l) => ({
      id: String(l.codigo),
      title: String(l.nombre).slice(0, 250),
      quantity: l.cantidad,
      unit_price: Number(l.precio),
      currency_id: "ARS",
    })),
    // Con esto, en Mercado Pago cada pago queda unido al número de pedido de la planilla.
    external_reference: pedido.id,
    // El link vence: así nadie paga dentro de un mes con precios viejos.
    expires: true,
    expiration_date_from: fechaConZonaArgentina(ahora),
    expiration_date_to: fechaConZonaArgentina(new Date(ahora.getTime() + HORAS_DE_VALIDEZ * 60 * 60_000)),
    metadata: { empresa: empresa.id, pedido: pedido.id },
  };
}

function tokenDe(empresa) {
  const nombre = empresa.mercadoPago?.tokenEnv || "MERCADOPAGO_ACCESS_TOKEN";
  const token = process.env[nombre]?.trim();
  if (!token) throw new Error(`Falta ${nombre} en el .env (token de Mercado Pago de ${empresa.id}).`);
  return token;
}

// Devuelve { link, id }. El link (init_point) es el que se le manda al cliente.
export async function crearLinkMercadoPago({ empresa, pedido, ahora = new Date() }) {
  const respuesta = await fetch(`${API}/checkout/preferences`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenDe(empresa)}`, "Content-Type": "application/json" },
    body: JSON.stringify(armarPreferencia({ empresa, pedido, ahora })),
  });
  if (!respuesta.ok) {
    throw new Error(`Mercado Pago respondió ${respuesta.status}: ${(await respuesta.text()).slice(0, 300)}`);
  }
  const datos = await respuesta.json();
  if (!datos.init_point) throw new Error("Mercado Pago no devolvió el link de pago (init_point).");
  return { link: datos.init_point, id: datos.id };
}

// Para el diagnóstico: comprueba el token sin crear nada.
export async function verificarCuentaMercadoPago(empresa) {
  const respuesta = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${tokenDe(empresa)}` } });
  if (!respuesta.ok) throw new Error(`Mercado Pago respondió ${respuesta.status}: ${(await respuesta.text()).slice(0, 200)}`);
  const datos = await respuesta.json();
  return { usuario: datos.nickname ?? String(datos.id ?? "?"), pais: datos.site_id ?? "?" };
}
