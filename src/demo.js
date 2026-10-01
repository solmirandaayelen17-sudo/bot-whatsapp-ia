// DEMO: abre en el navegador un chat con forma de celular conectado al bot.
//
// Cada mensaje pasa por el simulador de Meta y entra al webhook real, así que
// el bot responde igual que por WhatsApp (con la planilla real del negocio).
// Sirve para mostrárselo a un cliente o grabar un video.
//
// Uso:  npm run demo -- gomeria-demo
// Después abrí http://localhost:3001 (en Windows se abre solo).

import "dotenv/config";
import { exec } from "node:child_process";
import { cargarEmpresas } from "./config/empresas.js";
import { crearProcesador } from "./nucleo/procesador.js";
import { crearModeloGemini, crearModelosRespaldoGemini, verificarClaveGemini } from "./agente/modelo.js";
import { crearFuente } from "./datos/crearFuente.js";
import { crearSimulador } from "./canales/simuladorWhatsApp.js";
import { crearAppDemo } from "./canales/demoWeb.js";
import { crearTranscriptor } from "./agente/audio.js";

verificarClaveGemini();
const { porId } = cargarEmpresas();
const idPedido = process.argv[2];
const empresa = idPedido ? porId.get(idPedido) : porId.size === 1 ? [...porId.values()][0] : null;
if (!empresa) {
  console.log(`Decime qué empresa querés mostrar: npm run demo -- <id>`);
  console.log(`Empresas cargadas: ${[...porId.keys()].join(", ")}`);
  process.exit(1);
}

const { procesar, pausas } = crearProcesador({
  crearModelo: () => crearModeloGemini(),
  crearRespaldos: () => crearModelosRespaldoGemini(),
  crearFuente,
});

const sim = await crearSimulador({
  empresa,
  procesar,
  transcribir: crearTranscriptor(), // para la nota de voz del micrófono
  alLlegarTarde: (r) => console.log("(llegó tarde una respuesta)", r.texto ?? r.tipo),
});
const app = crearAppDemo({ empresa, sim, reanudar: (telefono) => pausas.reanudar(`${empresa.id}:${telefono}`) });

const puerto = Number(process.env.PORT_DEMO) || 3001;
const url = `http://localhost:${puerto}`;
// Solo en esta compu (127.0.0.1): nadie de afuera puede entrar a la demo.
const servidor = app.listen(puerto, "127.0.0.1", () => {
  console.log(`\nDemo de ${empresa.nombre} lista en ${url}`);
  console.log(`Datos: ${crearFuente(empresa).descripcion}`);
  console.log("Cada mensaje pasa por el webhook del bot, igual que por WhatsApp.");
  console.log("Para cerrarla: Ctrl + C\n");
  if (process.platform === "win32") exec(`start "" "${url}"`);
  else if (process.platform === "darwin") exec(`open "${url}"`);
});
servidor.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`El puerto ${puerto} ya está en uso. ¿Tenés otra demo abierta? Cerrala o poné PORT_DEMO=3002 en el .env.`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

process.on("SIGINT", async () => {
  servidor.close();
  servidor.closeAllConnections();
  await sim.cerrar();
  process.exit(0);
});
