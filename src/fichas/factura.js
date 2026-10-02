// FACTURAS POR FOTO: el dueño manda la foto de una factura y Gemini la lee.
//
// POR QUÉ con IA: cada proveedor arma sus facturas distinto. Una app común no
// las entiende; Gemini lee la imagen y saca proveedor, fecha, qué se compró y el
// total. El código revisa que lo que devolvió tenga sentido antes de anotarlo.

import { HumanMessage } from "@langchain/core/messages";
import * as z from "zod";
import { crearModeloGemini, nombreModeloPrincipal, nombresModelosRespaldo } from "../agente/modelo.js";
import { textoDeMensaje } from "../nucleo/procesador.js";
import { mensajeDeError } from "../nucleo/errores.js";
import { parsearNumero, formatearPesos } from "../datos/productos.js";

export const TIPOS_DE_IMAGEN = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

const INSTRUCCION = `Mirá esta imagen. Si es una factura, ticket o remito de compra (de Argentina), devolvé SOLO un JSON con esta forma, sin texto alrededor:
{"es_factura": true, "proveedor": "nombre del comercio que vende", "fecha": "AAAA-MM-DD o vacío si no se ve", "concepto": "qué se compró, en pocas palabras", "total": número final a pagar sin signo $ (ej. 48000.5)}
Si NO es una factura o no se lee el total, devolvé exactamente: {"es_factura": false}`;

const esquema = z.object({
  es_factura: z.boolean(),
  proveedor: z.string().optional(),
  fecha: z.string().optional(),
  concepto: z.string().optional(),
  total: z.union([z.number(), z.string()]).optional(),
});

// Saca el JSON de la respuesta de la IA (a veces viene entre ```json ... ```).
export function interpretarRespuesta(texto) {
  const crudo = String(texto ?? "").match(/\{[\s\S]*\}/)?.[0];
  if (!crudo) return null;
  let datos;
  try {
    datos = esquema.parse(JSON.parse(crudo));
  } catch {
    return null;
  }
  if (!datos.es_factura) return { esFactura: false };
  const total = parsearNumero(datos.total);
  if (!Number.isFinite(total) || total <= 0) return { esFactura: false };
  return {
    esFactura: true,
    proveedor: (datos.proveedor ?? "").trim().slice(0, 80) || "Proveedor",
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(datos.fecha ?? "") ? datos.fecha : "",
    concepto: (datos.concepto ?? "").trim().slice(0, 120) || "Compra",
    total: Math.round(total * 100) / 100,
  };
}

// Devuelve leerFactura({ datos, mimeType }) -> { esFactura, proveedor, fecha, concepto, total }.
export function crearLectorDeFacturas({
  crearModelos = () => [nombreModeloPrincipal(), ...nombresModelosRespaldo()].map((n) => crearModeloGemini(n)),
} = {}) {
  let modelos = null;
  return async function leerFactura({ datos, mimeType }) {
    if (!Buffer.isBuffer(datos) || datos.length === 0) throw new Error("La imagen llegó vacía.");
    modelos ??= crearModelos();
    const mensaje = new HumanMessage({
      content: [
        { type: "text", text: INSTRUCCION },
        { type: "media", mimeType: String(mimeType || "image/jpeg").split(";")[0], data: datos.toString("base64") },
      ],
    });
    let ultimoError;
    for (const [i, modelo] of modelos.entries()) {
      try {
        const respuesta = await modelo.invoke([mensaje]);
        return interpretarRespuesta(textoDeMensaje(respuesta)) ?? { esFactura: false };
      } catch (error) {
        ultimoError = error;
        if (i < modelos.length - 1) console.warn(`[factura] Falló la lectura (${mensajeDeError(error)}); pruebo con el modelo de respaldo.`);
      }
    }
    throw ultimoError;
  };
}

// Lo que le contesta el bot al dueño después de leer la factura.
export function mensajeDeFacturaLeida(factura, comprasDeHoy) {
  return [
    "Leí la factura ✅",
    `*${factura.proveedor}* · ${factura.concepto}`,
    `*${formatearPesos(factura.total)}*, cargado en los gastos de hoy.`,
    comprasDeHoy ? `Hoy llevás ${formatearPesos(comprasDeHoy)} en compras.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
