// DEMO: un chat con forma de celular conectado al bot, en el navegador.
//
// Cada mensaje pasa por el simulador de Meta y entra al webhook real, así que
// el bot responde igual que por WhatsApp (con la planilla real del negocio).
//
// Dos formas de usarla:
// - En tu compu:  npm run demo -- gomeria-demo   (se abre http://localhost:3001)
// - En internet (Railway): npm start, con DEMO_PUBLICA=1. Ahí cada visitante
//   tiene su propia charla, hay límites de mensajes y los pedidos de prueba no
//   se anotan en la planilla.

import "dotenv/config";
import { exec } from "node:child_process";
import { cargarEmpresas } from "./config/empresas.js";
import { crearProcesador } from "./nucleo/procesador.js";
import { crearModeloGemini, crearModelosRespaldoGemini, verificarClaveGemini } from "./agente/modelo.js";
import { crearFuente } from "./datos/crearFuente.js";
import { soloLectura } from "./datos/soloLectura.js";
import { crearSimulador } from "./canales/simuladorWhatsApp.js";
import { crearAppDemo } from "./canales/demoWeb.js";
import { crearTranscriptor } from "./agente/audio.js";

const publica = /^(1|true|si|sí)$/i.test(process.env.DEMO_PUBLICA?.trim() ?? "");
const numeroDe = (nombre, porDefecto) => {
  const n = Number(process.env[nombre]);
  return Number.isFinite(n) && n > 0 ? n : porDefecto;
};

verificarClaveGemini();
const { porId } = cargarEmpresas();
const idPedido = process.argv[2] || process.env.DEMO_EMPRESA;
const empresa = idPedido ? porId.get(idPedido) : porId.size === 1 ? [...porId.values()][0] : null;
if (!empresa) {
  console.log(`Decime qué empresa querés mostrar: npm run demo -- <id> (o DEMO_EMPRESA en las variables)`);
  console.log(`Empresas cargadas: ${[...porId.keys()].join(", ")}`);
  process.exit(1);
}

// Publicada: lee la planilla real, pero los pedidos de prueba no se escriben.
const fuenteDeLaDemo = publica ? (e) => soloLectura(crearFuente(e)) : crearFuente;

const { procesar, pausas } = crearProcesador({
  crearModelo: () => crearModeloGemini(),
  crearRespaldos: () => crearModelosRespaldoGemini(),
  crearFuente: fuenteDeLaDemo,
});

const sim = await crearSimulador({
  empresa,
  procesar,
  transcribir: crearTranscriptor(), // para la nota de voz del micrófono
  alLlegarTarde: (r) => console.log("(llegó tarde una respuesta)", r.texto ?? r.tipo),
});

// POR QUÉ límites solo en la pública: en tu compu no hacen falta, y en internet
// protegen tu cuota gratis de Gemini. Se pueden cambiar con variables.
const limites = publica
  ? {
      porSesion: numeroDe("DEMO_LIMITE_POR_CHARLA", 25),
      porIpPorMinuto: numeroDe("DEMO_LIMITE_POR_MINUTO", 10),
      porIpPorDia: numeroDe("DEMO_LIMITE_POR_PERSONA_POR_DIA", 60),
      porDia: numeroDe("DEMO_LIMITE_POR_DIA", 400),
    }
  : {};

const app = crearAppDemo({
  empresa,
  sim,
  reanudar: (telefono) => pausas.reanudar(`${empresa.id}:${telefono}`),
  contacto: process.env.SIREN_CONTACTO_WHATSAPP, // para el botón "Agendar demostración"
  publica,
  limites,
  limiteAudioBytes: publica ? 3 * 1024 * 1024 : undefined, // en internet, notas de voz de hasta ~3 MB
});

// En tu compu: solo localhost (nadie de afuera entra). En internet: el puerto
// que da el hosting (PORT) y abierta a todos (0.0.0.0).
const puerto = publica ? numeroDe("PORT", 3001) : numeroDe("PORT_DEMO", 3001);
const host = publica ? "0.0.0.0" : "127.0.0.1";
const url = `http://localhost:${puerto}`;

const servidor = app.listen(puerto, host, (error) => {
  if (error) return; // lo maneja servidor.on("error")
  console.log(`\nDemo de ${empresa.nombre} lista ${publica ? `(pública) en el puerto ${puerto}` : `en ${url}`}`);
  console.log(`Datos: ${fuenteDeLaDemo(empresa).descripcion}`);
  if (publica) console.log(`Límites: ${JSON.stringify(limites)}`);
  console.log("Cada mensaje pasa por el webhook del bot, igual que por WhatsApp.");
  if (!publica) {
    console.log("Para cerrarla: Ctrl + C\n");
    if (process.platform === "win32") exec(`start "" "${url}"`);
    else if (process.platform === "darwin") exec(`open "${url}"`);
  }
});
servidor.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`El puerto ${puerto} ya está en uso. ¿Tenés otra demo abierta? Cerrala o poné PORT_DEMO=3002 en el .env.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

// Ctrl + C en tu compu, o el hosting apagando la demo para actualizarla.
async function cerrar() {
  servidor.close();
  servidor.closeAllConnections();
  await sim.cerrar();
  process.exit(0);
}
process.on("SIGINT", cerrar);
process.on("SIGTERM", cerrar);
