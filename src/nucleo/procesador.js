// El PROCESADOR: recibe "un mensaje de un cliente de tal empresa" y devuelve la
// respuesta. No sabe nada de WhatsApp ni de la consola.
//
// POR QUÉ separarlo de los canales: el mismo cerebro sirve para WhatsApp, para
// la consola de pruebas y mañana para Instagram o un chat web. Cada canal solo
// traduce "su" formato a { empresa, telefono, nombre, texto } y manda la respuesta.

import { MemorySaver } from "@langchain/langgraph";
import { crearAgente } from "../agente/crearAgente.js";
import { crearPausas } from "./pausas.js";
import { crearPedidosPendientes } from "./pedidosPendientes.js";
import { mensajeDeError, pistaDeError } from "./errores.js";

export const MENSAJE_ERROR =
  "Perdón, tuve un problema técnico y no pude responderte. ¿Me lo escribís de nuevo en un ratito?";

// Si la IA termina su turno sin texto, se lo pedimos una vez más con esto.
const RECORDATORIO_RESPUESTA_VACIA =
  "(Mensaje automático del sistema, no lo escribió el cliente: tu respuesta anterior quedó vacía. " +
  "Respondé ahora el último mensaje del cliente con la información que ya obtuviste.)";

// La IA a veces devuelve el texto partido en bloques; lo juntamos.
export function textoDeMensaje(mensaje) {
  const c = mensaje?.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((parte) => (typeof parte === "string" ? parte : parte?.type === "text" ? parte.text : ""))
      .join("")
      .trim();
  }
  return "";
}

const tipoDe = (m) => (typeof m.getType === "function" ? m.getType() : m.type);

// POR QUÉ solo el turno actual: el historial tiene TODAS las respuestas de la
// charla. Si en este turno la IA no escribió nada, NO hay que devolver una
// respuesta vieja (eso fue lo que hizo que el bot repitiera un mensaje).
export function respuestaDelTurno(mensajes) {
  let ultimoDelCliente = mensajes.length - 1;
  while (ultimoDelCliente >= 0 && tipoDe(mensajes[ultimoDelCliente]) !== "human") ultimoDelCliente--;
  for (let i = mensajes.length - 1; i > ultimoDelCliente; i--) {
    if (tipoDe(mensajes[i]) === "ai") {
      const texto = textoDeMensaje(mensajes[i]);
      if (texto) return texto;
    }
  }
  return "";
}

export function crearProcesador({
  crearModelo,
  crearRespaldos = () => [],
  crearFuente,
  pausas = crearPausas(),
  pendientes = crearPedidosPendientes(),
  memoria = new MemorySaver(),
  cobros, // para reemplazar Mercado Pago en las pruebas
}) {
  // Links de pago creados en el turno actual de cada charla. POR QUÉ: la IA a
  // veces resume o corta un link largo. Si en su respuesta no está el link
  // exacto, el código lo agrega al final. Así el cliente siempre lo recibe.
  const enlacesPorHilo = new Map();
  const enlaces = {
    guardar: (hiloId, link) => enlacesPorHilo.set(hiloId, link),
    tomar: (hiloId) => {
      const link = enlacesPorHilo.get(hiloId);
      enlacesPorHilo.delete(hiloId);
      return link ?? null;
    },
  };

  const agentes = new Map(); // un agente por empresa, se arma la primera vez que hace falta
  const colas = new Map(); // una fila de espera por conversación
  const turnos = new Map(); // cuántos mensajes mandó cada cliente en su charla

  function agenteDe(empresa) {
    if (!agentes.has(empresa.id)) {
      agentes.set(
        empresa.id,
        crearAgente({
          empresa,
          modelo: crearModelo(empresa),
          respaldos: crearRespaldos(empresa),
          fuente: crearFuente(empresa),
          pausas,
          pendientes,
          memoria,
          cobros,
          enlaces,
        })
      );
    }
    return agentes.get(empresa.id);
  }

  // POR QUÉ la cola: en WhatsApp la gente manda 3 mensajes seguidos ("hola",
  // "tienen cubiertas?", "para un gol"). Si los procesáramos a la vez, las
  // respuestas se pisarían. Así se atienden de a uno por conversación, en orden,
  // mientras distintas conversaciones siguen en paralelo.
  function enCola(clave, tarea) {
    const anterior = colas.get(clave) ?? Promise.resolve();
    const actual = anterior.then(tarea, tarea);
    const cola = actual.catch(() => {});
    colas.set(clave, cola);
    cola.then(() => {
      if (colas.get(clave) === cola) colas.delete(clave);
    });
    return actual;
  }

  // Devuelve el texto a enviar, o null si no hay que responder (bot en pausa).
  async function procesar({ empresa, telefono, nombre, texto }) {
    // POR QUÉ el id incluye la empresa: si una misma persona es cliente de dos
    // negocios tuyos, sus conversaciones nunca se mezclan.
    const hiloId = `${empresa.id}:${telefono}`;
    return enCola(hiloId, async () => {
      if (pausas.estaPausado(hiloId)) return null;
      const turno = (turnos.get(hiloId) ?? 0) + 1;
      turnos.set(hiloId, turno);
      const config = { configurable: { thread_id: hiloId }, context: { telefono, nombre, hiloId, turno } };
      enlaces.tomar(hiloId); // por si quedó alguno de un turno anterior que terminó con error
      try {
        const agente = agenteDe(empresa);
        let resultado = await agente.invoke({ messages: [{ role: "user", content: texto }] }, config);
        let respuesta = respuestaDelTurno(resultado.messages);
        if (!respuesta) {
          console.warn(`[${empresa.id}] La IA terminó sin texto con ${telefono}; se le pide la respuesta de nuevo.`);
          resultado = await agente.invoke({ messages: [{ role: "user", content: RECORDATORIO_RESPUESTA_VACIA }] }, config);
          respuesta = respuestaDelTurno(resultado.messages);
        }
        const link = enlaces.tomar(hiloId);
        if (respuesta && link && !respuesta.includes(link)) {
          respuesta = `${respuesta}\n\nLink para pagar con Mercado Pago:\n${link}`;
        }
        return respuesta || MENSAJE_ERROR;
      } catch (error) {
        // Una línea clara con el motivo y qué hacer. El detalle completo solo
        // si ponés DEBUG=1 en el .env.
        console.error(`\n[${empresa.id}] Error con ${telefono}: ${mensajeDeError(error)}`);
        const pista = pistaDeError(error);
        if (pista) console.error(`  -> ${pista}`);
        if (process.env.DEBUG) console.error(error);
        return MENSAJE_ERROR;
      }
    });
  }

  return { procesar, pausas };
}
