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
import { crearLinkMercadoPago, HORAS_DE_VALIDEZ } from "../pagos/mercadoPago.js";
import { mensajeDeError } from "../nucleo/errores.js";
import { horariosLibres, problemaConLaFecha, fechaLegible, esHoraValida, instante, limitesDelDia } from "../agenda/horarios.js";

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
// cobros.crearLink: arma el link de pago (Mercado Pago). Se puede reemplazar en las pruebas.
// enlaces: donde se guarda el link para que el procesador se asegure de que llegue al cliente.
// agenda: dónde se guardan los turnos (Google Calendar o en memoria), si la empresa toma turnos.
export function crearHerramientas({ empresa, fuente, pausas, pendientes, cobros = { crearLink: crearLinkMercadoPago }, enlaces = null, agenda = null }) {
  const cobraConMercadoPago = empresa.herramientas.includes("cobrar_mercado_pago");

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

      // El link de pago se arma con los precios validados recién, no con lo que diga la IA.
      // Si Mercado Pago falla, el pedido se anota igual y el negocio cobra por otro lado.
      let link = "";
      if (cobraConMercadoPago) {
        try {
          const lineas = v.lineas.map((l) => ({
            codigo: l.producto.codigo,
            nombre: l.producto.nombre,
            cantidad: l.cantidad,
            precio: l.producto.precio,
          }));
          ({ link } = await cobros.crearLink({ empresa, pedido: { id, lineas } }));
          if (link && ctx.hiloId) enlaces?.guardar(ctx.hiloId, link);
        } catch (error) {
          console.error(`[${empresa.id}] No pude crear el link de Mercado Pago del pedido ${id}: ${mensajeDeError(error)}`);
        }
      }

      await fuente.agregarRegistro("Pedidos", {
        id,
        fecha: fechaArgentina(),
        telefono: ctx.telefono ?? "",
        cliente: nombre_cliente,
        detalle,
        total: v.total,
        modalidad: pendiente.modalidad,
        notas: notas ?? "",
        estado: link ? "esperando pago" : "nuevo (a confirmar)",
        pago: link,
      });
      pendientes.borrar(ctx.hiloId);

      let instruccion = "Pedido anotado. Pasale el número de pedido al cliente y aclarale que el negocio lo va a confirmar.";
      if (link) {
        instruccion = `Pedido anotado. Pasale al cliente el número de pedido y el link para pagar con Mercado Pago, copiado exacto y completo, solo en su renglón y sin asteriscos. Aclarale que el link vence en ${HORAS_DE_VALIDEZ} horas.`;
      } else if (cobraConMercadoPago) {
        instruccion = "Pedido anotado, pero no se pudo generar el link de pago. Pasale el número de pedido al cliente y decile que el negocio le va a mandar cómo pagar.";
      }
      return JSON.stringify({
        ok: true,
        pedido: id,
        total: formatearPesos(v.total),
        ...(link ? { link_de_pago: link } : {}),
        instruccion,
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

  // ---- Turnos ----
  const reglasAgenda = empresa.agenda;
  const MOTIVOS_FECHA = {
    "fecha-invalida": "La fecha no es válida. Usá el formato AAAA-MM-DD, calculada desde la fecha de hoy.",
    "fecha-pasada": "Esa fecha ya pasó. Preguntale al cliente otro día.",
    "muy-adelante": `Solo se dan turnos hasta ${reglasAgenda?.diasAdelante ?? 30} días adelante. Preguntale al cliente un día más cercano.`,
  };

  async function servicioDe(codigo) {
    if (!codigo) return null;
    const productos = await fuente.listarProductos();
    return productos.find((p) => p.codigo.toLowerCase() === String(codigo).toLowerCase()) ?? null;
  }

  async function libresDelDia(fecha, duracion) {
    const { desde, hasta } = limitesDelDia(fecha);
    const ocupados = await agenda.ocupados(desde, hasta);
    return horariosLibres({ agenda: reglasAgenda, fecha, duracion, ocupados });
  }

  // POR QUÉ una fila: si dos clientes piden el mismo horario a la vez, el segundo
  // espera a que termine el primero y ve ese horario ya ocupado.
  let filaDeReservas = Promise.resolve();
  function enFila(tarea) {
    const r = filaDeReservas.then(tarea);
    filaDeReservas = r.catch(() => {});
    return r;
  }

  const verTurnosLibres = tool(
    async ({ fecha, codigo_servicio }) => {
      const problema = problemaConLaFecha(reglasAgenda, fecha);
      if (problema) return JSON.stringify({ ok: false, instruccion: MOTIVOS_FECHA[problema] });
      const servicio = await servicioDe(codigo_servicio);
      const duracion = servicio?.duracion ?? reglasAgenda.duracionMinutos;
      const libres = await libresDelDia(fecha, duracion);
      const dia = fechaLegible(fecha);
      if (libres.length === 0) {
        return JSON.stringify({ fecha, dia, horarios_libres: [], instruccion: "Ese día no hay turnos libres (o está cerrado). Ofrecé buscar otro día." });
      }
      return JSON.stringify({
        fecha,
        dia,
        servicio: servicio?.nombre ?? "turno",
        duracion_minutos: duracion,
        horarios_libres: libres,
        instruccion: "Ofrecele al cliente 2 o 3 de estos horarios (o el que pidió, si está). No ofrezcas horarios que no estén en la lista.",
      });
    },
    {
      name: "ver_turnos_libres",
      description:
        "Devuelve los horarios libres de un día para sacar turno. Usala SIEMPRE antes de ofrecer o confirmar un horario: no sabés qué está libre sin ella.",
      schema: z.object({
        fecha: z.string().describe("Día del turno en formato AAAA-MM-DD. Calculalo desde la fecha de hoy (ej: si hoy es viernes y pide 'el sábado', es mañana)."),
        codigo_servicio: z.string().optional().describe("Código del servicio (de buscar_productos), para saber cuánto dura."),
      }),
    }
  );

  const reservarTurno = tool(
    async ({ fecha, hora, codigo_servicio, nombre_cliente }, runtime) => {
      const ctx = runtime?.context ?? {};
      const problema = problemaConLaFecha(reglasAgenda, fecha);
      if (problema) return JSON.stringify({ ok: false, instruccion: MOTIVOS_FECHA[problema] });
      if (!esHoraValida(hora)) return JSON.stringify({ ok: false, instruccion: "La hora va en formato HH:MM de 24 horas, por ejemplo 15:30." });
      const servicio = await servicioDe(codigo_servicio);
      if (!servicio) return JSON.stringify({ ok: false, instruccion: "No encontré ese servicio. Buscalo con buscar_productos y usá su código." });
      const duracion = servicio.duracion ?? reglasAgenda.duracionMinutos;

      const reserva = await enFila(async () => {
        // Se vuelve a mirar justo antes de anotar: el horario pudo ocuparse mientras el cliente decidía.
        const libres = await libresDelDia(fecha, duracion);
        if (!libres.includes(hora)) return { libre: false, libres };
        const inicio = instante(fecha, hora);
        const fin = new Date(inicio.getTime() + duracion * 60_000);
        const { id } = await agenda.reservar({
          inicio,
          fin,
          titulo: `${servicio.nombre} — ${nombre_cliente}`,
          descripcion: `Turno sacado por WhatsApp con el asistente.\nCliente: ${nombre_cliente}\nTeléfono: ${ctx.telefono ?? "?"}\nServicio: ${servicio.nombre} (${formatearPesos(servicio.precio)})`,
        });
        return { libre: true, id };
      });

      if (!reserva.libre) {
        return JSON.stringify({
          ok: false,
          horarios_libres: reserva.libres.slice(0, 6),
          instruccion: "Ese horario ya no está libre. Ofrecele al cliente alguno de los horarios libres de la lista.",
        });
      }

      const turno = "T-" + Date.now().toString(36).toUpperCase().slice(-6);
      let link = "";
      if (cobraConMercadoPago && servicio.precio) {
        try {
          ({ link } = await cobros.crearLink({
            empresa,
            pedido: { id: turno, lineas: [{ codigo: servicio.codigo, nombre: `Turno: ${servicio.nombre}`, cantidad: 1, precio: servicio.precio }] },
          }));
          if (link && ctx.hiloId) enlaces?.guardar(ctx.hiloId, link);
        } catch (error) {
          console.error(`[${empresa.id}] No pude crear el link de Mercado Pago del turno ${turno}: ${mensajeDeError(error)}`);
        }
      }
      return JSON.stringify({
        ok: true,
        turno,
        dia: fechaLegible(fecha),
        hora,
        servicio: servicio.nombre,
        precio: formatearPesos(servicio.precio),
        ...(link ? { link_de_pago: link } : {}),
        instruccion: link
          ? `Turno reservado. Confirmale al cliente el día, la hora y el servicio, y pasale el link para dejarlo pago, copiado exacto y completo, solo en su renglón y sin asteriscos. Aclarale que el link vence en ${HORAS_DE_VALIDEZ} horas y que también puede pagar en el local.`
          : "Turno reservado. Confirmale al cliente el día, la hora y el servicio.",
      });
    },
    {
      name: "reservar_turno",
      description:
        "Reserva el turno en la agenda del negocio. Usala SOLO cuando el cliente eligió un horario que te devolvió ver_turnos_libres y ya sabés su nombre.",
      schema: z.object({
        fecha: z.string().describe("Día del turno en formato AAAA-MM-DD."),
        hora: z.string().describe("Hora de inicio en formato HH:MM de 24 horas, tal como vino en horarios_libres."),
        codigo_servicio: z.string().describe("Código del servicio, tal como lo devolvió buscar_productos."),
        nombre_cliente: z.string().min(1).describe("Nombre de la persona que saca el turno."),
      }),
    }
  );

  // Lo que se activa en el JSON de la empresa son "capacidades"; cada una trae
  // una o más herramientas. Cada empresa activa solo las de su paquete.
  const porCapacidad = {
    buscar_productos: [buscarProductos],
    tomar_pedidos: [cotizarPedido, confirmarPedido],
    derivar_a_humano: [derivarAHumano],
    cobrar_mercado_pago: [], // no es una herramienta aparte: cambia lo que hacen confirmar_pedido y reservar_turno
    agendar_turnos: agenda ? [verTurnosLibres, reservarTurno] : [],
  };
  return empresa.herramientas.flatMap((capacidad) => porCapacidad[capacidad]);
}
