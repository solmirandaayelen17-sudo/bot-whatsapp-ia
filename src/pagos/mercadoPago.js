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

import crypto from "node:crypto";

const API = "https://api.mercadopago.com";
export const HORAS_DE_VALIDEZ = 48;

// Mercado Pago pide las fechas con zona horaria, por ejemplo
// "2026-10-01T15:30:00.000-03:00". Argentina no cambia de hora en el año.
export function fechaConZonaArgentina(fecha) {
  const local = new Date(fecha.getTime() - 3 * 60 * 60_000);
  return local.toISOString().replace("Z", "-03:00");
}

// La dirección donde Mercado Pago avisa cuando se aprueba un pago. Hace falta
// que el servidor esté en internet (URL_PUBLICA, por ejemplo la de Railway).
export function direccionDeAvisos(empresa, entorno = process.env) {
  const base = entorno.URL_PUBLICA?.trim().replace(/\/+$/, "");
  return base ? `${base}/webhooks/mercadopago/${empresa.id}` : null;
}

// pedido: { id, lineas: [{ codigo, nombre, cantidad, precio }], datos? }
// datos: lo que hace falta saber cuando se aprueba el pago (teléfono del cliente,
// bahía, fichas...). Viaja dentro del pago, así no se pierde aunque el servidor
// se reinicie entre que el cliente recibe el link y paga.
export function armarPreferencia({ empresa, pedido, ahora = new Date(), entorno = process.env }) {
  const avisos = direccionDeAvisos(empresa, entorno);
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
    metadata: { ...(pedido.datos ?? {}), empresa: empresa.id, pedido: pedido.id },
    ...(avisos ? { notification_url: avisos } : {}),
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
  const usuario = datos.nickname ?? String(datos.id ?? "?");
  // Las cuentas de prueba de Mercado Pago se llaman TESTUSER… y traen la etiqueta "test_user".
  const prueba = /^TEST/i.test(usuario) || (Array.isArray(datos.tags) && datos.tags.includes("test_user"));
  return { usuario, pais: datos.site_id ?? "?", prueba };
}

// Para la DEMO PÚBLICA: solo arma links si el token es de una cuenta de PRUEBA.
//
// POR QUÉ: cualquiera puede tocar "Pagar" en la demo. Con una cuenta de prueba,
// Mercado Pago no deja pagar con plata ni tarjetas reales (el pago se rechaza).
// Si por error se carga el token de una cuenta real, la demo no arma ningún
// link, así nadie paga de verdad un pedido de mentira.
export function crearCobrosSoloDePrueba({ verificar = verificarCuentaMercadoPago, crear = crearLinkMercadoPago } = {}) {
  const revisadas = new Map(); // empresa.id -> promesa de { usuario, prueba }

  function revisar(empresa) {
    if (!revisadas.has(empresa.id)) {
      const consulta = verificar(empresa);
      consulta.catch(() => revisadas.delete(empresa.id)); // si falló la consulta, se vuelve a intentar
      revisadas.set(empresa.id, consulta);
    }
    return revisadas.get(empresa.id);
  }

  return {
    revisar,
    async crearLink({ empresa, pedido }) {
      const cuenta = await revisar(empresa);
      if (!cuenta.prueba) {
        throw new Error(
          `la demo pública no arma links con la cuenta REAL de Mercado Pago "${cuenta.usuario}". Poné el token de la cuenta de prueba.`,
        );
      }
      return crear({ empresa, pedido });
    },
  };
}

// ---- Avisos de pago (webhook de Mercado Pago) ----

// Pregunta a Mercado Pago cómo está un pago. POR QUÉ preguntar en vez de creerle
// al aviso: el aviso solo dice "mirá el pago 123". El estado real (aprobado o
// no, el monto, el pedido) lo sacamos de Mercado Pago con el token del negocio,
// así nadie puede inventar un "pago aprobado" mandándonos un aviso falso.
export async function consultarPagoMercadoPago({ empresa, id }) {
  const respuesta = await fetch(`${API}/v1/payments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${tokenDe(empresa)}` } });
  if (!respuesta.ok) throw new Error(`Mercado Pago respondió ${respuesta.status} al consultar el pago ${id}: ${(await respuesta.text()).slice(0, 200)}`);
  const p = await respuesta.json();
  return {
    id: String(p.id),
    estado: p.status, // "approved" = aprobado
    pedido: p.external_reference ?? p.metadata?.pedido ?? "",
    monto: Number(p.transaction_amount) || 0,
    datos: p.metadata ?? {},
  };
}

// Mercado Pago firma cada aviso con la "clave secreta" de webhooks de tu app.
// Header x-signature: "ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a5e839"
// Lo firmado es "id:<data.id>;request-id:<x-request-id>;ts:<ts>;".
export function firmaMercadoPagoValida({ dataId, requestId, firma, secreto }) {
  if (!secreto || typeof firma !== "string") return false;
  const partes = Object.fromEntries(firma.split(",").map((p) => p.trim().split("=", 2)));
  if (!partes.ts || !partes.v1) return false;
  const id = /^[a-z0-9]+$/i.test(String(dataId ?? "")) ? String(dataId).toLowerCase() : String(dataId ?? "");
  let firmado = "";
  if (id) firmado += `id:${id};`;
  if (requestId) firmado += `request-id:${requestId};`;
  firmado += `ts:${partes.ts};`;
  const esperada = crypto.createHmac("sha256", secreto).update(firmado).digest();
  const recibida = Buffer.from(partes.v1, "hex");
  return recibida.length === esperada.length && crypto.timingSafeEqual(recibida, esperada);
}
