// El SERVIDOR: queda prendido esperando los avisos de WhatsApp.
//
// Uso: npm run servidor
// Después exponés el puerto a internet con un túnel (ver README) y cargás
// https://<tu-tunel>/webhook en la configuración de WhatsApp de tu app de Meta.

import "dotenv/config";
import express from "express";
import { cargarEmpresas } from "./config/empresas.js";
import { crearProcesador } from "./nucleo/procesador.js";
import { crearModeloGemini, crearModelosRespaldoGemini, verificarClaveGemini } from "./agente/modelo.js";
import { crearFuente } from "./datos/crearFuente.js";
import { crearRouterWhatsApp, enviarTextoWhatsApp, enviarPlantillaWhatsApp, descargarMediaWhatsApp } from "./canales/whatsapp.js";
import { crearTranscriptor } from "./agente/audio.js";
import { crearRouterMercadoPago } from "./pagos/avisosDePago.js";
import { crearAvisosDelNegocio, crearAtencionDelNegocio, programarBalanceDiario } from "./fichas/sistema.js";
import { crearLectorDeFacturas } from "./fichas/factura.js";

verificarClaveGemini();
const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
const appSecret = process.env.WHATSAPP_APP_SECRET;
if (!verifyToken || !appSecret) {
  console.error("Faltan WHATSAPP_VERIFY_TOKEN y/o WHATSAPP_APP_SECRET en el .env (ver .env.example).");
  process.exit(1);
}

const { porNumero, porId } = cargarEmpresas();
if (porNumero.size === 0) {
  console.warn("Ninguna empresa tiene whatsapp.phoneNumberId configurado: el webhook no va a saber a quién responder.");
}

const { procesar } = crearProcesador({
  crearModelo: () => crearModeloGemini(),
  crearRespaldos: () => crearModelosRespaldoGemini(),
  crearFuente,
});

// Avisos al encargado y al dueño (texto común o plantillas de Meta).
const avisos = crearAvisosDelNegocio({ enviarTexto: enviarTextoWhatsApp, enviarPlantilla: enviarPlantillaWhatsApp });

const app = express();
app.get("/", (_req, res) => res.send("Bot funcionando"));
app.use(
  crearRouterWhatsApp({
    empresasPorNumero: porNumero,
    procesar,
    transcribir: crearTranscriptor(), // los audios se pasan a texto con Gemini
    // Autolavados: el dueño manda facturas por foto o pide el balance; el encargado recibe avisos.
    atender: crearAtencionDelNegocio({ crearFuente, leerFactura: crearLectorDeFacturas(), descargarMedia: descargarMediaWhatsApp }),
    verifyToken,
    appSecret,
  }),
);
// Mercado Pago avisa acá cuando se aprueba un pago (ver README, "Avisos de pago").
app.use(crearRouterMercadoPago({ empresasPorId: porId, crearFuente, enviarTexto: enviarTextoWhatsApp, avisos }));

// Autolavados: el balance del día al WhatsApp del dueño (22 h por defecto).
const conBalance = [...porId.values()].filter((e) => e.fichas?.dueno);
if (conBalance.length) programarBalanceDiario({ empresas: conBalance, crearFuente, avisos });

const puerto = Number(process.env.PORT) || 3000;
app.listen(puerto, () => {
  console.log(`Servidor escuchando en http://localhost:${puerto}`);
  console.log(`Empresas con WhatsApp: ${[...porNumero.values()].map((e) => e.id).join(", ") || "(ninguna)"}`);
  if (!process.env.URL_PUBLICA) console.log("Sin URL_PUBLICA: Mercado Pago no va a avisar los pagos aprobados (ver README).");
  for (const e of conBalance) console.log(`Balance diario de ${e.id}: a las ${e.fichas.horaBalance}.`);
});
