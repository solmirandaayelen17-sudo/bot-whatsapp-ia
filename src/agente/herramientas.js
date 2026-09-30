// Las HERRAMIENTAS: lo que el agente puede HACER, no solo decir.
//
// POR QUÉ: esto es lo que el agente gratis de Meta no tiene. La IA decide cuándo
// usar cada herramienta, pero la herramienta es código nuestro: busca en la
// planilla real, valida stock y escribe el pedido. La IA nunca toca los datos
// directamente; solo "pide" que se ejecute una herramienta con ciertos datos.
//
// Cada herramienta tiene:
//   - name: el nombre que ve la IA
//   - description: CUÁNDO usarla (la IA se guía por esto, escribilo bien)
//   - schema: qué datos necesita (zod valida que vengan bien)

import { tool } from "langchain";
import * as z from "zod";
import { buscarEnCatalogo, validarPedido, formatearPesos } from "../datos/productos.js";

// Formato fijo de 24 horas ("29/09/2026, 14:58"). Sin esto, algunas compus
// (por ejemplo Windows) escriben "02:58" para las 14:58, sin el "p. m.".
export function fechaArgentina(fecha = new Date()) {
  return fecha.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function nuevoIdPedido() {
  return "P-" + Date.now().toString(36).toUpperCase().slice(-6);
}

// runtime.context trae los datos de ESTA conversación (teléfono del cliente,
// nombre, id del hilo y número de turno). Se los pasa el procesador en cada mensaje.
export function crearHerramientas({ empresa, fuente, pausas, pendientes }) {
  const buscarProductos = tool(
    async ({ consulta }) => {
      const productos = await fuente.listarProductos();
      const encontrados = buscarEnCatalogo(productos, consulta);
      if (encontrados.length === 0) {
        return JSON.stringify({
          resultados: [],
          nota: "No encontré productos con esa búsqueda. Probá con otras palabras o decile al cliente que no lo tenés cargado.",
        });
      }
      return JSON.stringify({
        resultados: encontrados.map((p) => ({
          codigo: p.codigo,
          nombre: p.nombre,
          precio: formatearPesos(p.precio),
          // stock vacío en la planilla = no se controla stock (ej: servicios)
          stock: p.stock ?? "sin control de stock",
          disponible: p.stock === null || p.stock > 0,
          descripcion: p.descripcion,
        })),
      });
    },
    {
      name: "buscar_productos",
      description:
        "Busca productos o servicios del negocio y devuelve precio y stock actualizados. Usala siempre que el cliente pregunte por un producto, un precio, stock o qué opciones hay.",
      schema: z.object({
        consulta: z
          .string()
          .describe("Palabras clave de lo que busca el cliente, por ejemplo: 'cubierta 175/65 R14' o 'alineación'."),
      }),
    }
  );

  // TOMAR UN PEDIDO = DOS HERRAMIENTAS.
  // 1) cotizar_pedido: valida, calcula el total y lo deja "pendiente".
  // 2) confirmar_pedido: lo anota, pero SOLO si el cliente ya vio la cotización
  //    en un mensaje anterior (lo controla el código con el número de turno).
  const cotizarPedido = tool(
    async ({ items, modalidad }, runtime) => {
      const ctx = runtime?.context ?? {};
      const productos = await fuente.listarProductos();
      const v = validarPedido(productos, items);
      if (!v.ok) {
        return JSON.stringify({
          ok: false,
          errores: v.errores,
          instruccion: "No se puede armar este pedido. Explicale el problema al cliente y ofrecé una alternativa.",
        });
      }
      const detalle = v.lineas
        .map((l) => `${l.cantidad} x ${l.producto.nombre} (${formatearPesos(l.producto.precio)} c/u)`)
        .join("; ");
      pendientes.guardar(ctx.hiloId, { items, modalidad, turno: ctx.turno });
      return JSON.stringify({
        ok: true,
        detalle,
        total: formatearPesos(v.total),
        modalidad,
        instruccion:
          "Mostrale al cliente el detalle, el total y la modalidad, y preguntale si confirma. Todavía NO está anotado: esperá su respuesta.",
      });
    },
    {
      name: "cotizar_pedido",
      description:
        "Arma un pedido y calcula el total para mostrárselo al cliente ANTES de anotarlo. Usala cuando el cliente quiere comprar o encargar algo. Los códigos salen de buscar_productos.",
      schema: z.object({
        items: z
          .array(
            z.object({
              codigo: z.string().describe("Código del producto, tal como lo devolvió buscar_productos."),
              // min/max (y no .positive()) porque el formato de funciones de
              // Gemini acepta "minimum" y "maximum" pero no "exclusiveMinimum".
              cantidad: z.number().int().min(1).max(100),
            })
          )
          .min(1),
        modalidad: z.enum(["retira en el local", "envio"]),
      }),
    }
  );

  const confirmarPedido = tool(
    async ({ nombre_cliente, notas }, runtime) => {
      const ctx = runtime?.context ?? {};
      const pendiente = pendientes.obtener(ctx.hiloId);
      if (!pendiente) {
        return JSON.stringify({
          ok: false,
          instruccion: "No hay ningún pedido cotizado. Primero usá cotizar_pedido y mostrale el total al cliente.",
        });
      }
      if (!(pendiente.turno < ctx.turno)) {
        return JSON.stringify({
          ok: false,
          instruccion:
            "El cliente todavía no vio el total. Mostrale el detalle y el total, preguntale si confirma y esperá su respuesta. NO digas que el pedido está anotado.",
        });
      }
      // Se valida de nuevo: el stock o los precios pudieron cambiar desde la cotización.
      const productos = await fuente.listarProductos();
      const v = validarPedido(productos, pendiente.items);
      if (!v.ok) {
        pendientes.borrar(ctx.hiloId);
        return JSON.stringify({
          ok: false,
          errores: v.errores,
          instruccion: "Algo cambió desde la cotización y no se pudo anotar. Explicale al cliente y ofrecé cotizar de nuevo.",
        });
      }
      const id = nuevoIdPedido();
      const detalle = v.lineas
        .map((l) => `${l.cantidad} x ${l.producto.nombre} (${formatearPesos(l.producto.precio)} c/u)`)
        .join("; ");
      await fuente.agregarRegistro("Pedidos", {
        id,
        fecha: fechaArgentina(),
        telefono: ctx.telefono ?? "",
        cliente: nombre_cliente,
        detalle,
        total: v.total,
        modalidad: pendiente.modalidad,
        notas: notas ?? "",
        estado: "nuevo (a confirmar)",
      });
      pendientes.borrar(ctx.hiloId);
      return JSON.stringify({
        ok: true,
        pedido: id,
        total: formatearPesos(v.total),
        instruccion: "Pedido anotado. Pasale el número de pedido al cliente y aclarale que el negocio lo va a confirmar.",
      });
    },
    {
      name: "confirmar_pedido",
      description:
        "Anota en la planilla el pedido que ya se cotizó. Usala SOLO cuando el cliente respondió que confirma el total que le mostraste.",
      schema: z.object({
        nombre_cliente: z.string().min(1).describe("Nombre de la persona que hace el pedido."),
        notas: z.string().optional().describe("Aclaraciones del cliente, por ejemplo día de retiro o dirección."),
      }),
    }
  );

  const derivarAHumano = tool(
    async ({ motivo }, runtime) => {
      const ctx = runtime?.context ?? {};
      await fuente.agregarRegistro("Derivaciones", {
        fecha: fechaArgentina(),
        telefono: ctx.telefono ?? "",
        cliente: ctx.nombre ?? "",
        motivo,
        estado: "pendiente",
      });
      // El bot deja de contestar en ESTA conversación por un rato, para que la
      // persona del negocio responda sin que el bot se meta en el medio.
      if (ctx.hiloId) pausas.pausar(ctx.hiloId, empresa.derivacion.pausaMinutos);
      return JSON.stringify({
        ok: true,
        instruccion: "Listo. Avisale al cliente, en una oración, que una persona del equipo le va a responder por este mismo chat.",
      });
    },
    {
      name: "derivar_a_humano",
      description:
        "Pasa la conversación a una persona del negocio. Usala si el cliente lo pide, tiene un reclamo, está molesto o la consulta no se puede resolver con los datos disponibles.",
      schema: z.object({
        motivo: z.string().describe("Resumen breve de por qué se deriva y qué necesita el cliente."),
      }),
    }
  );

  // Lo que se activa en el JSON de la empresa son "capacidades"; cada una trae
  // una o más herramientas. Cada empresa activa solo las de su paquete.
  const porCapacidad = {
    buscar_productos: [buscarProductos],
    tomar_pedidos: [cotizarPedido, confirmarPedido],
    derivar_a_humano: [derivarAHumano],
  };
  return empresa.herramientas.flatMap((capacidad) => porCapacidad[capacidad]);
}
