// DEMO WEB: un chat con forma de celular, en el navegador, para mostrarle el
// bot a un dueño de negocio (o grabar un video).
//
// POR QUÉ: la terminal sirve para probar, pero un comerciante necesita ver lo
// que vería su cliente. Esta página NO es un chat aparte: cada mensaje pasa
// por el simulador de Meta y entra al webhook real del bot, igual que un
// mensaje de WhatsApp. Lo que contesta acá es lo mismo que contestaría allá.
//
// Puede correr en tu compu o publicada en internet. Publicada, cada visitante
// tiene su propia charla y hay límites de mensajes (ver crearAppDemo).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { LIMITE_AUDIO_BYTES } from "./whatsapp.js";

const PAGINA = path.join(path.dirname(fileURLToPath(import.meta.url)), "demoWeb.html");
const LARGO_MAXIMO = 1000;
const SESION_VALIDA = /^[A-Za-z0-9_-]{16,64}$/;
const VIDA_DE_SESION_MS = 3 * 60 * 60_000; // una charla sin uso se olvida a las 3 horas
const UN_MINUTO = 60_000;

// Un número inventado por visitante (formato argentino, como llega de Meta).
// POR QUÉ: el bot recuerda cada charla por número; así nadie ve la de otro.
function telefonoInventado() {
  return "549297" + String(crypto.randomInt(0, 1e7)).padStart(7, "0");
}

const hoy = () => new Date().toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

// Opciones:
// - contacto: tu número de WhatsApp (solo números, ej. 5492975551234) para el
//   botón "Agendar demostración". Si está vacío, el botón no aparece.
// - publica: true cuando está en internet (cambia el aviso del chat).
// - limites: { porSesion, porIpPorMinuto, porIpPorDia, porDia } mensajes. Sin límites si no se pasan.
// - limiteAudioBytes: tamaño máximo de una nota de voz.
export function crearAppDemo({
  empresa,
  sim,
  reanudar = () => {},
  contacto = "",
  publica = false,
  limites = {},
  limiteAudioBytes = LIMITE_AUDIO_BYTES,
}) {
  const contactoLimpio = String(contacto ?? "").replace(/\D/g, "");
  const tope = { porSesion: Infinity, porIpPorMinuto: Infinity, porIpPorDia: Infinity, porDia: Infinity, ...limites };

  const app = express();
  app.disable("x-powered-by");
  // Publicada, la demo está detrás del "proxy" del hosting: así se ve la IP real del visitante.
  if (publica) app.set("trust proxy", true);
  app.use(express.json({ limit: "10kb" }));

  // ---- Sesiones: una charla por visitante ----
  const sesiones = new Map(); // id -> { telefono, mensajes, cola, usado }

  function limpiarSesionesViejas() {
    const ahora = Date.now();
    for (const [id, s] of sesiones) if (ahora - s.usado > VIDA_DE_SESION_MS) sesiones.delete(id);
  }

  function nuevaSesion() {
    if (sesiones.size > 500) limpiarSesionesViejas();
    const id = crypto.randomBytes(18).toString("base64url");
    const sesion = { telefono: telefonoInventado(), mensajes: 0, cola: Promise.resolve(), usado: Date.now() };
    sesiones.set(id, sesion);
    return { id, sesion };
  }

  function sesionDe(req) {
    const id = String(req.get("x-demo-sesion") ?? "");
    if (!SESION_VALIDA.test(id)) return null;
    const sesion = sesiones.get(id);
    if (sesion) sesion.usado = Date.now();
    return sesion ?? null;
  }

  // ---- Límites: protegen la cuota de la IA si la demo está en internet ----
  let dia = { fecha: hoy(), mensajes: 0, porIp: new Map() }; // porIp: ip -> mensajes de hoy
  const porIp = new Map(); // ip -> horarios de sus mensajes del último minuto

  function controlarLimites(req, sesion) {
    if (dia.fecha !== hoy()) dia = { fecha: hoy(), mensajes: 0, porIp: new Map() };
    const ip = req.ip ?? "?";
    if (dia.mensajes >= tope.porDia) return "dia";
    // POR QUÉ también por IP y por día: "Nuevo cliente" abre otra charla, así que
    // el límite por charla solo no alcanza para que una persona no gaste todo.
    if ((dia.porIp.get(ip) ?? 0) >= tope.porIpPorDia) return "dia";
    if (sesion.mensajes >= tope.porSesion) return "sesion";
    const ahora = Date.now();
    const recientes = (porIp.get(ip) ?? []).filter((t) => ahora - t < UN_MINUTO);
    if (recientes.length >= tope.porIpPorMinuto) {
      porIp.set(ip, recientes);
      return "ip";
    }
    recientes.push(ahora);
    porIp.set(ip, recientes);
    if (porIp.size > 5000) {
      for (const [k, v] of porIp) if (!v.some((t) => ahora - t < UN_MINUTO)) porIp.delete(k);
    }
    dia.mensajes++;
    dia.porIp.set(ip, (dia.porIp.get(ip) ?? 0) + 1);
    sesion.mensajes++;
    return null;
  }

  // POR QUÉ una fila por sesión: el simulador espera la respuesta de un mensaje
  // por charla. Si un visitante manda dos juntos, el segundo espera al primero;
  // las charlas de distintos visitantes avanzan en paralelo.
  function enFila(sesion, tarea) {
    const resultado = sesion.cola.then(tarea);
    sesion.cola = resultado.catch(() => {});
    return resultado;
  }

  // Lo que vuelve a la página: la respuesta del bot y, si fue un audio, lo que entendió.
  async function responder(req, res, mensaje) {
    const sesion = sesionDe(req);
    if (!sesion) return res.status(401).json({ tipo: "sin-sesion" });
    const limite = controlarLimites(req, sesion);
    if (limite) return res.status(429).json({ tipo: "limite", motivo: limite });
    try {
      const r = await enFila(sesion, () => sim.mandar({ ...mensaje, de: sesion.telefono }));
      const extra = r.transcripcion ? { transcripcion: r.transcripcion } : {};
      if (r.tipo === "respuesta") return res.json({ tipo: "respuesta", texto: r.texto, ...extra });
      return res.json({ tipo: r.tipo === "error" ? "error" : r.tipo, ...extra });
    } catch (error) {
      console.error("[demo] Error:", error);
      return res.status(500).json({ tipo: "error" });
    }
  }

  app.get("/", (_req, res) => res.type("html").send(fs.readFileSync(PAGINA, "utf8")));

  // Para que el hosting sepa que la demo está viva.
  app.get("/salud", (_req, res) => res.type("text").send("ok"));

  app.get("/api/info", (_req, res) => {
    res.json({ nombre: empresa.nombre, rubro: empresa.rubro, contacto: contactoLimpio, publica });
  });

  // Cada carga de la página (o "Nuevo cliente") es una charla nueva.
  app.post(["/api/sesion", "/api/nuevo"], (_req, res) => {
    const { id, sesion } = nuevaSesion();
    res.json({ sesion: id, telefono: sesion.telefono });
  });

  app.post("/api/mensaje", (req, res) => {
    const texto = typeof req.body?.texto === "string" ? req.body.texto.trim() : "";
    if (!texto) return res.status(400).json({ error: "Falta el texto" });
    if (texto.length > LARGO_MAXIMO) return res.status(400).json({ error: "Mensaje demasiado largo" });
    return responder(req, res, { texto });
  });

  // La nota de voz grabada con el micrófono llega tal cual (por ejemplo audio/webm).
  app.post(
    "/api/audio",
    express.raw({ type: ["audio/*", "video/webm", "application/octet-stream"], limit: limiteAudioBytes + 1024 }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "Falta el audio" });
      const tipo = String(req.get("content-type") || "audio/webm").replace(/^video\//, "audio/");
      return responder(req, res, { tipo: "audio", audio: { datos: req.body, mimeType: tipo } });
    },
  );

  app.post("/api/reanudar", (req, res) => {
    const sesion = sesionDe(req);
    if (!sesion) return res.status(401).json({ tipo: "sin-sesion" });
    reanudar(sesion.telefono);
    res.json({ ok: true });
  });

  // Si el audio supera el límite, la página recibe un aviso claro en vez de un error.
  app.use((error, _req, res, siguiente) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ tipo: "audio-largo" });
    return siguiente(error);
  });

  return app;
}
