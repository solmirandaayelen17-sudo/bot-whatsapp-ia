// DEMO DEL AUTOLAVADO: las rutas extra de la página con 3 celulares
// (cliente, encargado y dueño).
//
// El chat del cliente es el bot real (pasa por el webhook, como siempre).
// Lo que se simula es lo que en un negocio real llega de afuera:
// - el pago: en vez de Mercado Pago avisando "pago aprobado", lo aprueba un
//   botón de la página (así nadie paga de verdad);
// - el balance de la noche: se pide con un botón en vez de esperar a las 22 h.
// La lectura de facturas sí es real: Gemini lee la foto que suba el visitante.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { avisosDePagoAprobado, horaArgentina } from "../fichas/ventas.js";
import { armarBalance } from "../fichas/balance.js";
import { mensajeDeFacturaLeida, TIPOS_DE_IMAGEN } from "../fichas/factura.js";
import { mensajeDeError } from "../nucleo/errores.js";

const CARPETA = path.dirname(fileURLToPath(import.meta.url));
export const PAGINA_AUTOLAVADO = path.join(CARPETA, "demoAutolavado.html");
const FACTURA_DE_EJEMPLO = path.join(CARPETA, "factura-ejemplo.png");
const LIMITE_IMAGEN = 5 * 1024 * 1024;

// En la demo el link de pago no va a Mercado Pago: lleva el número de pedido y
// la página muestra una pantalla de pago de prueba.
export const cobrosDeDemo = {
  crearLink: async ({ pedido }) => ({ link: `https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=DEMO-${pedido.id}`, id: `DEMO-${pedido.id}` }),
};

// La caja como la ve la página: lo último primero, las compras del visitante marcadas.
function resumenDeCaja(caja) {
  const ventas = [...caja.ventas].sort((a, b) => (b.propia ? 1 : 0) - (a.propia ? 1 : 0) || b.hora.localeCompare(a.hora));
  return {
    total: caja.ventas.reduce((t, v) => t + v.total, 0),
    fichas: caja.ventas.reduce((t, v) => t + v.fichas, 0),
    cantidad: caja.ventas.length,
    ventas: ventas.slice(0, 8).map(({ id, hora, bahia, fichas, total, propia }) => ({ id, hora, bahia, fichas, total, propia: !!propia })),
  };
}

export function rutasDeAutolavado({ empresa, libro, leerFactura }) {
  return (app, { sesionDe, controlarLimites }) => {
    const json = express.json({ limit: "2kb" });

    // Para la pantalla de pago de prueba: qué se está pagando.
    app.post("/api/pedido", json, (req, res) => {
      const sesion = sesionDe(req);
      if (!sesion) return res.status(401).json({ tipo: "sin-sesion" });
      const venta = libro.pendiente(sesion.telefono, String(req.body?.pedido ?? ""));
      if (!venta) return res.status(404).json({ tipo: "no-existe" });
      res.json({ pedido: venta.id, bahia: venta.bahia, fichas: venta.fichas, total: venta.total, detalle: venta.detalle, pagado: venta.estado === "pagado" });
    });

    // Lo que en un negocio real dispara Mercado Pago al aprobarse el pago.
    app.post("/api/pagar", json, (req, res) => {
      const sesion = sesionDe(req);
      if (!sesion) return res.status(401).json({ tipo: "sin-sesion" });
      const r = libro.aprobar(sesion.telefono, String(req.body?.pedido ?? ""));
      if (!r) return res.status(404).json({ tipo: "no-existe" });
      const avisos = avisosDePagoAprobado(r.venta);
      res.json({
        tipo: r.repetido ? "ya-pagado" : "aprobado",
        cliente: avisos.cliente,
        encargado: { ...avisos.encargado, hora: r.venta.hora },
        caja: resumenDeCaja(libro.caja(sesion.telefono)),
      });
    });

    app.post("/api/caja", (req, res) => {
      const sesion = sesionDe(req);
      if (!sesion) return res.status(401).json({ tipo: "sin-sesion" });
      res.json(resumenDeCaja(libro.caja(sesion.telefono)));
    });

    // El balance que le llega al dueño a la noche.
    app.post("/api/balance", (req, res) => {
      const sesion = sesionDe(req);
      if (!sesion) return res.status(401).json({ tipo: "sin-sesion" });
      const caja = libro.caja(sesion.telefono);
      const b = armarBalance({ empresa, ventas: caja.ventas, gastos: caja.gastos, historial: caja.historial });
      res.json({ texto: b.texto, alerta: b.alerta?.texto ?? null });
    });

    // Factura por foto: la lee Gemini y se carga como gasto.
    async function cargarFactura(req, res, datos, mimeType) {
      const sesion = sesionDe(req);
      if (!sesion) return res.status(401).json({ tipo: "sin-sesion" });
      const limite = controlarLimites(req, sesion);
      if (limite) return res.status(429).json({ tipo: "limite", motivo: limite });
      try {
        const factura = await leerFactura({ datos, mimeType });
        if (!factura.esFactura) {
          return res.json({ tipo: "no-factura", texto: "No me parece una factura, o no se lee el total 🤔 Probá con otra foto, bien derecha y con buena luz." });
        }
        const caja = libro.caja(sesion.telefono);
        libro.agregarGasto(sesion.telefono, { ...factura, hora: horaArgentina(new Date()) });
        const deHoy = caja.gastos.reduce((t, g) => t + g.total, 0);
        res.json({ tipo: "factura", texto: mensajeDeFacturaLeida(factura, deHoy) });
      } catch (error) {
        console.error("[demo] No pude leer la factura:", mensajeDeError(error));
        res.status(500).json({ tipo: "error" });
      }
    }

    app.post("/api/factura", express.raw({ type: TIPOS_DE_IMAGEN, limit: LIMITE_IMAGEN }), (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ tipo: "sin-imagen" });
      return cargarFactura(req, res, req.body, req.get("content-type"));
    });

    app.post("/api/factura-ejemplo", (req, res) => cargarFactura(req, res, fs.readFileSync(FACTURA_DE_EJEMPLO), "image/png"));
    app.get("/factura-ejemplo.png", (_req, res) => res.sendFile(FACTURA_DE_EJEMPLO, { maxAge: "1d" }));
  };
}
