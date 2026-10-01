// Carga la configuración de cada empresa desde la carpeta /empresas.
//
// POR QUÉ: el código es uno solo para todos los clientes. Lo que cambia de un
// negocio a otro (nombre, horarios, planilla, número de WhatsApp, herramientas
// activas) vive en un archivo JSON por empresa. Sumar un cliente nuevo = copiar
// un JSON y completar sus datos, sin tocar el código.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// "tomar_pedidos" activa dos herramientas: cotizar_pedido y confirmar_pedido.
// "cobrar_mercado_pago" hace que, al confirmar un pedido, el cliente reciba el
// link para pagar (necesita "tomar_pedidos" y el token de Mercado Pago en el .env).
export const HERRAMIENTAS_DISPONIBLES = ["buscar_productos", "tomar_pedidos", "derivar_a_humano", "cobrar_mercado_pago"];
// Las que tiene una empresa si su JSON no dice nada (cobrar necesita configurarse).
const HERRAMIENTAS_POR_DEFECTO = ["buscar_productos", "tomar_pedidos", "derivar_a_humano"];

// El "molde" que tiene que cumplir cada archivo de empresa. Si falta algo
// importante, el bot no arranca y te dice qué falta (mejor que fallar con un cliente).
const esquemaEmpresa = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "el id va en minúsculas, sin espacios (ej: gomeria-centro)"),
  nombre: z.string().min(1),
  rubro: z.string().min(1),
  tono: z.string().optional(),
  negocio: z.object({
    direccion: z.string().optional(),
    horarios: z.string().min(1),
    formasDePago: z.array(z.string()).optional(),
    envios: z.string().optional(),
    preguntasFrecuentes: z
      .array(z.object({ pregunta: z.string(), respuesta: z.string() }))
      .optional(),
  }),
  whatsapp: z
    .object({
      phoneNumberId: z.string().optional(),
      tokenEnv: z.string().optional(),
    })
    .optional(),
  datos: z.discriminatedUnion("tipo", [
    z.object({ tipo: z.literal("local"), carpeta: z.string() }),
    z.object({ tipo: z.literal("google-sheets"), spreadsheetId: z.string().min(10) }),
  ]),
  herramientas: z
    .array(z.enum(HERRAMIENTAS_DISPONIBLES))
    .optional()
    .refine((h) => !h?.includes("cobrar_mercado_pago") || h.includes("tomar_pedidos"), {
      message: 'para "cobrar_mercado_pago" también hace falta "tomar_pedidos"',
    }),
  mercadoPago: z.object({ tokenEnv: z.string().optional() }).optional(),
  derivacion: z.object({ pausaMinutos: z.number().int().positive() }).optional(),
});

// Completa los valores por defecto para que el resto del código no tenga que
// preguntar "¿y si no vino este dato?" en cada lugar.
function conValoresPorDefecto(e) {
  return {
    ...e,
    tono: e.tono ?? "cercano y claro, en español rioplatense (voseo)",
    negocio: {
      ...e.negocio,
      formasDePago: e.negocio.formasDePago ?? [],
      preguntasFrecuentes: e.negocio.preguntasFrecuentes ?? [],
    },
    whatsapp: {
      phoneNumberId: e.whatsapp?.phoneNumberId ?? "",
      tokenEnv: e.whatsapp?.tokenEnv ?? "WHATSAPP_TOKEN",
    },
    herramientas: e.herramientas ?? [...HERRAMIENTAS_POR_DEFECTO],
    mercadoPago: { tokenEnv: e.mercadoPago?.tokenEnv ?? "MERCADOPAGO_ACCESS_TOKEN" },
    derivacion: { pausaMinutos: e.derivacion?.pausaMinutos ?? 120 },
  };
}

export function validarEmpresa(datos, origen = "empresa") {
  const r = esquemaEmpresa.safeParse(datos);
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `  - ${i.path.join(".") || "(raíz)"}: ${i.message}`).join("\n");
    throw new Error(`La configuración de ${origen} tiene errores:\n${detalle}`);
  }
  return conValoresPorDefecto(r.data);
}

// Lee todos los .json de la carpeta y arma dos índices:
// - por id (para el modo consola: "npm run consola -- gomeria-demo")
// - por phoneNumberId (para WhatsApp: cada mensaje llega a un número y así
//   sabemos de qué empresa es)
export function cargarEmpresas(carpeta = path.join(RAIZ, "empresas")) {
  const archivos = fs.readdirSync(carpeta).filter((f) => f.endsWith(".json"));
  const porId = new Map();
  const porNumero = new Map();
  for (const archivo of archivos) {
    const crudo = JSON.parse(fs.readFileSync(path.join(carpeta, archivo), "utf8"));
    const empresa = validarEmpresa(crudo, archivo);
    if (porId.has(empresa.id)) throw new Error(`El id "${empresa.id}" está repetido (${archivo}).`);
    porId.set(empresa.id, empresa);
    if (empresa.whatsapp.phoneNumberId) {
      if (porNumero.has(empresa.whatsapp.phoneNumberId)) {
        throw new Error(`El phoneNumberId de ${archivo} ya lo usa otra empresa.`);
      }
      porNumero.set(empresa.whatsapp.phoneNumberId, empresa);
    }
  }
  return { porId, porNumero };
}
