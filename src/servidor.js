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
import { crearRouterWhatsApp } from "./canales/whatsapp.js";

verificarClaveGemini();
const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
const appSecret = process.env.WHATSAPP_APP_SECRET;
if (!verifyToken || !appSecret) {
  console.error("Faltan WHATSAPP_VERIFY_TOKEN y/o WHATSAPP_APP_SECRET en el .env (ver .env.example).");
  process.exit(1);
}

const { porNumero } = cargarEmpresas();
if (porNumero.size === 0) {
  console.warn("Ninguna empresa tiene whatsapp.phoneNumberId configurado: el webhook no va a saber a quién responder.");
}

const { procesar } = crearProcesador({
  crearModelo: () => crearModeloGemini(),
  crearRespaldos: () => crearModelosRespaldoGemini(),
  crearFuente,
});

const app = express();
app.get("/", (_req, res) => res.send("Bot funcionando"));
app.use(crearRouterWhatsApp({ empresasPorNumero: porNumero, procesar, verifyToken, appSecret }));

const puerto = Number(process.env.PORT) || 3000;
app.listen(puerto, () => {
  console.log(`Servidor escuchando en http://localhost:${puerto}`);
  console.log(`Empresas con WhatsApp: ${[...porNumero.values()].map((e) => e.id).join(", ") || "(ninguna)"}`);
});
