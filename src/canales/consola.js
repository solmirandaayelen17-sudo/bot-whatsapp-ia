// Canal CONSOLA: chateás con el bot desde la terminal, sin WhatsApp.
//
// POR QUÉ: para probar el cerebro, las herramientas y la planilla antes de
// configurar Meta. También sirve para mostrarle una demo a un cliente en tu
// compu, o para probar cambios sin gastar mensajes.
//
// Uso:  npm run consola -- gomeria-demo
// Comandos: /nuevo (arranca otra conversación), /reanudar (saca la pausa), /salir

import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { cargarEmpresas } from "../config/empresas.js";
import { crearProcesador } from "../nucleo/procesador.js";
import { crearModeloGemini, crearModelosRespaldoGemini, verificarClaveGemini } from "../agente/modelo.js";
import { crearFuente } from "../datos/crearFuente.js";

verificarClaveGemini();
const { porId } = cargarEmpresas();
const idPedido = process.argv[2];
const empresa = idPedido ? porId.get(idPedido) : porId.size === 1 ? [...porId.values()][0] : null;

if (!empresa) {
  console.log(`Decime qué empresa querés probar: npm run consola -- <id>`);
  console.log(`Empresas cargadas: ${[...porId.keys()].join(", ")}`);
  process.exit(1);
}

const { procesar, pausas } = crearProcesador({
  crearModelo: () => crearModeloGemini(),
  crearRespaldos: () => crearModelosRespaldoGemini(),
  crearFuente,
});
let conversacion = 1;
const telefonoDe = () => `consola-${conversacion}`;

console.log(`\nChat de prueba con el bot de ${empresa.nombre}.`);
console.log(`Datos: ${crearFuente(empresa).descripcion}`);
console.log(`Comandos: /nuevo, /reanudar, /salir\n`);

const rl = readline.createInterface({ input, output });
while (true) {
  const texto = (await rl.question("Vos: ")).trim();
  if (!texto) continue;
  if (texto === "/salir") break;
  if (texto === "/nuevo") {
    conversacion++;
    console.log("(conversación nueva, el bot no recuerda la anterior)\n");
    continue;
  }
  if (texto === "/reanudar") {
    pausas.reanudar(`${empresa.id}:${telefonoDe()}`);
    console.log("(bot reactivado en esta conversación)\n");
    continue;
  }
  const respuesta = await procesar({ empresa, telefono: telefonoDe(), nombre: "Cliente de prueba", texto });
  console.log(respuesta === null ? "(el bot está en pausa: la charla la sigue una persona. Usá /reanudar)\n" : `Bot: ${respuesta}\n`);
}
rl.close();
