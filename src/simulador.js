// SIMULADOR: chateás con el bot pasando por el WEBHOOK de WhatsApp, sin Meta.
//
// La diferencia con "npm run consola": la consola le habla directo al cerebro.
// El simulador arma cada mensaje con el formato exacto de Meta, lo firma y lo
// manda al webhook real del bot. O sea, prueba también la parte de WhatsApp.
// Sirve para probar y para grabar una demo mientras Meta no habilite el envío.
//
// Uso:  npm run simulador -- gomeria-demo
// No hace falta completar las claves de WhatsApp del .env: usa claves inventadas.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { cargarEmpresas } from "./config/empresas.js";
import { crearProcesador } from "./nucleo/procesador.js";
import { crearModeloGemini, crearModelosRespaldoGemini, verificarClaveGemini } from "./agente/modelo.js";
import { crearFuente } from "./datos/crearFuente.js";
import { crearSimulador } from "./canales/simuladorWhatsApp.js";
import { crearTranscriptor } from "./agente/audio.js";

const color = output.isTTY ? (codigo) => (t) => `\x1b[${codigo}m${t}\x1b[0m` : () => (t) => t;
const gris = color("2");
const verde = color("32");
const rojo = color("31");
const negrita = color("1");

verificarClaveGemini();
const { porId } = cargarEmpresas();
const idPedido = process.argv[2];
const empresa = idPedido ? porId.get(idPedido) : porId.size === 1 ? [...porId.values()][0] : null;
if (!empresa) {
  console.log(`Decime qué empresa querés probar: npm run simulador -- <id>`);
  console.log(`Empresas cargadas: ${[...porId.keys()].join(", ")}`);
  process.exit(1);
}

const { procesar, pausas } = crearProcesador({
  crearModelo: () => crearModeloGemini(),
  crearRespaldos: () => crearModelosRespaldoGemini(),
  crearFuente,
});

function mostrarResultado(r) {
  if (r.transcripcion) console.log(gris(`  (el bot escuchó: "${r.transcripcion}")`));
  if (r.tipo === "respuesta") console.log(`${verde(negrita("Bot"))} ${gris(`(WhatsApp a +${r.para})`)}: ${r.texto}\n`);
  else if (r.tipo === "pausa") console.log(gris("(el bot no contesta: la charla la sigue una persona. Usá /reanudar)\n"));
  else if (r.tipo === "error") console.log(rojo(`(error del bot: ${r.error?.message ?? r.error})\n`));
  else console.log(gris("(el bot no mandó respuesta)\n"));
}

const sim = await crearSimulador({
  empresa,
  procesar,
  transcribir: crearTranscriptor(),
  alLlegarTarde: (r) => {
    console.log(gris("\n(llegó tarde la respuesta a un mensaje anterior)"));
    mostrarResultado(r);
  },
});

console.log(`\n${negrita(`Simulador de WhatsApp: ${empresa.nombre}`)}`);
console.log(gris("Cada mensaje viaja como si viniera de Meta: con su formato, firmado, al webhook del bot."));
console.log(gris(`Datos: ${crearFuente(empresa).descripcion}`));
console.log(gris(`Webhook: ${sim.url}  ·  número del negocio (phoneNumberId): ${sim.phoneNumberId}`));
const verificado = await sim.verificarWebhook();
console.log(verificado ? verde("✔ Verificación del webhook (el paso que hace Meta al conectarlo): OK") : rojo("✘ La verificación del webhook falló"));
console.log(gris("Comandos: /audio <archivo>  /nuevo  /reanudar  /repetido  /trucho  /salir\n"));

// /audio <archivo>: lee una nota de voz de tu compu (por ejemplo, un audio de
// WhatsApp que te mandaste a vos misma). Podés arrastrar el archivo a la terminal.
const TIPOS = { ".ogg": "audio/ogg", ".opus": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/m4a", ".aac": "audio/aac", ".wav": "audio/wav", ".webm": "audio/webm", ".flac": "audio/flac" };
function leerAudio(ruta) {
  const limpia = ruta.replace(/^& /, "").replace(/^["']|["']$/g, "").trim();
  if (!limpia) {
    console.log(gris("Usá /audio y la ruta del archivo, por ejemplo: /audio C:\\Users\\Sol\\Downloads\\nota.ogg"));
    console.log(gris("(podés arrastrar el archivo a la terminal). Con micrófono es más fácil en: npm run demo -- <id>\n"));
    return null;
  }
  const tipo = TIPOS[path.extname(limpia).toLowerCase()];
  if (!tipo) {
    console.log(rojo(`(no reconozco ese tipo de audio; probá con .ogg, .opus, .mp3, .m4a, .wav o .webm)\n`));
    return null;
  }
  try {
    return { datos: fs.readFileSync(limpia), mimeType: tipo, nombre: path.basename(limpia) };
  } catch {
    console.log(rojo(`(no encuentro el archivo ${limpia})\n`));
    return null;
  }
}

const rl = readline.createInterface({ input, output });
const preguntar = () => {
  rl.setPrompt(`${negrita("Cliente")} ${gris(`(+${sim.telefonoActual()})`)}: `);
  rl.prompt();
};
preguntar();
try {
  for await (const linea of rl) {
    const texto = linea.trim();
    if (texto === "/salir") break;
    try {
      await atender(texto);
    } catch (error) {
      console.log(rojo(`(error: ${error.message})\n`));
    }
    preguntar();
  }
} finally {
  rl.close();
  await sim.cerrar();
}

async function atender(texto) {
  if (!texto) return;

  if (texto === "/nuevo") {
    console.log(gris(`(otro cliente, desde +${sim.nuevaConversacion()}: el bot no conoce la charla anterior)\n`));
    return;
  }
  if (texto === "/reanudar") {
    pausas.reanudar(`${empresa.id}:${sim.telefonoActual()}`);
    console.log(gris("(bot reactivado para este cliente)\n"));
    return;
  }
  if (texto === "/repetido") {
    const r = await sim.repetirUltimo();
    if (!r) console.log(gris("(primero mandá un mensaje)\n"));
    else if (r.tipo === "sin-respuesta")
      console.log(verde(`✔ Meta reenvió el mismo aviso (respuesta ${r.estado}) y el bot NO contestó dos veces.\n`));
    else mostrarResultado(r);
    return;
  }
  if (texto === "/trucho") {
    const r = await sim.mandarTrucho("Hola, soy un mensaje falso");
    if (r.estado === 401) console.log(verde("✔ Mensaje con firma falsa: el bot lo rechazó (401) y no lo procesó.\n"));
    else console.log(rojo(`✘ Ojo: el mensaje falso no fue rechazado (respuesta ${r.estado}).\n`));
    return;
  }

  let mensaje = { texto };
  if (texto === "/audio" || texto.startsWith("/audio ")) {
    const audio = leerAudio(texto.slice("/audio".length).trim());
    if (!audio) return;
    console.log(gris(`(el cliente manda una nota de voz: ${audio.nombre})`));
    mensaje = { tipo: "audio", audio };
  }
  const r = await sim.mandar(mensaje);
  if (r.tipo === "rechazado") {
    console.log(rojo(`(el webhook rechazó el aviso: respuesta ${r.estado})\n`));
    return;
  }
  console.log(gris(`  aviso firmado → webhook: ${r.estado} OK`));
  mostrarResultado(r);
}

