// DEMO WEB: un chat con forma de celular, en el navegador, para mostrarle el
// bot a un dueño de negocio (o grabar un video).
//
// POR QUÉ: la terminal sirve para probar, pero un comerciante necesita ver lo
// que vería su cliente. Esta página NO es un chat aparte: cada mensaje pasa
// por el simulador de Meta y entra al webhook real del bot, igual que un
// mensaje de WhatsApp. Lo que contesta acá es lo mismo que contestaría allá.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { LIMITE_AUDIO_BYTES } from "./whatsapp.js";

const PAGINA = path.join(path.dirname(fileURLToPath(import.meta.url)), "demoWeb.html");
const LARGO_MAXIMO = 1000;

export function crearAppDemo({ empresa, sim, reanudar = () => {} }) {
  const app = express();
  app.use(express.json({ limit: "10kb" }));

  // POR QUÉ una fila: el simulador espera la respuesta de un mensaje por vez.
  // Si llegan dos juntos, el segundo espera a que termine el primero.
  let fila = Promise.resolve();
  const enFila = (tarea) => {
    const resultado = fila.then(tarea);
    fila = resultado.catch(() => {});
    return resultado;
  };

  app.get("/", (_req, res) => res.type("html").send(fs.readFileSync(PAGINA, "utf8")));

  app.get("/api/info", (_req, res) => {
    res.json({ nombre: empresa.nombre, rubro: empresa.rubro, telefono: sim.telefonoActual() });
  });

  // Lo que vuelve a la página: la respuesta del bot y, si fue un audio, lo que entendió.
  async function responder(res, mensaje) {
    try {
      const r = await enFila(() => sim.mandar(mensaje));
      const extra = r.transcripcion ? { transcripcion: r.transcripcion } : {};
      if (r.tipo === "respuesta") return res.json({ tipo: "respuesta", texto: r.texto, ...extra });
      return res.json({ tipo: r.tipo === "error" ? "error" : r.tipo, ...extra });
    } catch (error) {
      console.error("[demo] Error:", error);
      return res.status(500).json({ tipo: "error" });
    }
  }

  app.post("/api/mensaje", (req, res) => {
    const texto = typeof req.body?.texto === "string" ? req.body.texto.trim() : "";
    if (!texto) return res.status(400).json({ error: "Falta el texto" });
    if (texto.length > LARGO_MAXIMO) return res.status(400).json({ error: "Mensaje demasiado largo" });
    return responder(res, { texto });
  });

  // La nota de voz grabada con el micrófono llega tal cual (por ejemplo audio/webm).
  app.post(
    "/api/audio",
    express.raw({ type: ["audio/*", "video/webm", "application/octet-stream"], limit: LIMITE_AUDIO_BYTES + 1024 }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "Falta el audio" });
      const tipo = String(req.get("content-type") || "audio/webm").replace(/^video\//, "audio/");
      return responder(res, { tipo: "audio", audio: { datos: req.body, mimeType: tipo } });
    },
  );

  app.post("/api/nuevo", (_req, res) => res.json({ telefono: sim.nuevaConversacion() }));

  app.post("/api/reanudar", (_req, res) => {
    reanudar(sim.telefonoActual());
    res.json({ ok: true });
  });

  // Si el audio supera el límite, la página recibe un aviso claro en vez de un error.
  app.use((error, _req, res, siguiente) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ tipo: "audio-largo" });
    return siguiente(error);
  });

  return app;
}
