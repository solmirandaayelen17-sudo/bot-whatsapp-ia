// SIMULADOR de WhatsApp: hace de "Meta" para probar el webhook sin Meta.
//
// POR QUÉ: Meta no deja mandar mensajes hasta verificar el negocio. Con esto
// probamos el camino completo igual:
//   aviso con formato de Meta → firma → webhook real del bot → IA → planilla → respuesta
// Lo único que cambia es el final: en vez de mandar la respuesta a la API de
// Meta, la devolvemos acá para mostrarla en pantalla.

import crypto from "node:crypto";
import express from "express";
import { crearRouterWhatsApp, normalizarDestino } from "./whatsapp.js";
import { armarAvisoDeMeta, firmarCuerpo } from "./avisoMeta.js";

export async function crearSimulador({
  empresa,
  procesar,
  telefonoBase = "5492974000000", // número inventado, formato argentino como llega de Meta (549...)
  nombre = "Cliente de prueba",
  esperaMaximaMs = 120_000,
  alLlegarTarde = () => {},
}) {
  // Claves inventadas para esta corrida: no hace falta tocar el .env.
  const appSecret = crypto.randomBytes(16).toString("hex");
  const verifyToken = crypto.randomBytes(8).toString("hex");
  const phoneNumberId = empresa.whatsapp?.phoneNumberId || `SIMULADO-${empresa.id}`;

  let conversacion = 0;
  let pendiente = null; // lo que está esperando la respuesta del mensaje actual
  let ultimoCuerpo = null;

  const telefonoActual = () => String(BigInt(telefonoBase) + BigInt(conversacion));

  function entregar(resultado) {
    const p = pendiente;
    pendiente = null;
    if (p) p(resultado);
    else alLlegarTarde(resultado);
  }

  // Reemplaza al envío real a Meta: guarda lo que el bot iba a mandar.
  async function enviarTexto({ para, texto }) {
    entregar({ tipo: "respuesta", para: normalizarDestino(para), texto });
  }

  // Envuelve al procesador para enterarnos si el bot decidió no contestar
  // (por ejemplo, porque derivó la charla a una persona).
  async function procesarEspiado(datos) {
    try {
      const respuesta = await procesar(datos);
      if (respuesta === null) entregar({ tipo: "pausa" });
      else if (!respuesta) entregar({ tipo: "sin-respuesta" });
      return respuesta;
    } catch (error) {
      entregar({ tipo: "error", error });
      throw error;
    }
  }

  const app = express();
  app.use(
    crearRouterWhatsApp({
      empresasPorNumero: new Map([[phoneNumberId, empresa]]),
      procesar: procesarEspiado,
      enviarTexto,
      verifyToken,
      appSecret,
    }),
  );
  const servidor = await new Promise((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  const url = `http://127.0.0.1:${servidor.address().port}/webhook`;

  async function postear(cuerpo, firma) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": firma },
      body: cuerpo,
    });
    return r.status;
  }

  // Manda el cuerpo y espera la respuesta del bot (o se rinde a los esperaMs).
  async function mandarYEsperar(cuerpo, firma, esperaMs) {
    const respuesta = new Promise((ok) => {
      pendiente = ok;
    });
    const estado = await postear(cuerpo, firma);
    if (estado !== 200) {
      pendiente = null;
      return { estado, tipo: "rechazado" };
    }
    let reloj;
    const tiempoAgotado = new Promise((ok) => {
      reloj = setTimeout(() => ok({ tipo: "sin-respuesta" }), esperaMs);
    });
    const resultado = await Promise.race([respuesta, tiempoAgotado]);
    clearTimeout(reloj); // si no, el programa queda esperando aunque ya haya respuesta
    if (resultado.tipo === "sin-respuesta") pendiente = null;
    return { estado, ...resultado };
  }

  return {
    url,
    phoneNumberId,
    telefonoActual,

    // Paso que Meta hace una sola vez al cargar la URL del webhook.
    async verificarWebhook() {
      const desafio = String(Math.floor(Math.random() * 1e9));
      const q = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": verifyToken, "hub.challenge": desafio });
      const r = await fetch(`${url}?${q}`);
      return r.status === 200 && (await r.text()) === desafio;
    },

    // Un cliente escribe (texto) o manda una nota de voz (tipo "audio").
    async mandar({ texto, tipo = "text" }) {
      const aviso = armarAvisoDeMeta({ phoneNumberId, de: telefonoActual(), nombre, texto, tipo });
      const cuerpo = JSON.stringify(aviso);
      ultimoCuerpo = cuerpo;
      return mandarYEsperar(cuerpo, firmarCuerpo(cuerpo, appSecret), esperaMaximaMs);
    },

    // Meta a veces reenvía el mismo aviso. El bot no tiene que contestar dos veces.
    async repetirUltimo(esperaMs = 2000) {
      if (!ultimoCuerpo) return null;
      return mandarYEsperar(ultimoCuerpo, firmarCuerpo(ultimoCuerpo, appSecret), esperaMs);
    },

    // Alguien que NO es Meta intenta mandarle un mensaje al bot (firma falsa).
    async mandarTrucho(texto, esperaMs = 2000) {
      const aviso = armarAvisoDeMeta({ phoneNumberId, de: telefonoActual(), nombre, texto });
      const cuerpo = JSON.stringify(aviso);
      return mandarYEsperar(cuerpo, firmarCuerpo(cuerpo, "una-clave-que-no-es-la-de-meta"), esperaMs);
    },

    nuevaConversacion() {
      conversacion++;
      ultimoCuerpo = null;
      return telefonoActual();
    },

    cerrar: () =>
      new Promise((ok) => {
        servidor.close(ok);
        servidor.closeAllConnections(); // si no, las conexiones abiertas lo dejan colgado
      }),
  };
}
