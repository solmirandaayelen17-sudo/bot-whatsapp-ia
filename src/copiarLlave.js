// Copia la llave de la cuenta de servicio de Google al portapapeles, en una
// sola línea, para pegarla en el servidor (Railway) como GOOGLE_CREDENTIALS_JSON.
//
// Uso: npm run copiar-llave
//
// POR QUÉ: en el servidor no hay archivos privados; la llave va en una
// variable. Copiarla así evita errores al seleccionar el texto a mano, y la
// llave no queda escrita en la pantalla.

import "dotenv/config";
import fs from "node:fs";
import { spawn } from "node:child_process";

const ruta = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!ruta) {
  console.error("Falta GOOGLE_APPLICATION_CREDENTIALS en el .env (la ruta al archivo de la cuenta de servicio).");
  process.exit(1);
}

let llave;
try {
  llave = JSON.parse(fs.readFileSync(ruta, "utf8"));
} catch {
  console.error(`No pude leer la llave en ${ruta}. Revisá que el archivo exista.`);
  process.exit(1);
}
if (!llave.client_email || !llave.private_key) {
  console.error("Ese archivo no parece la llave de una cuenta de servicio.");
  process.exit(1);
}

const enUnaLinea = JSON.stringify(llave);
if (process.platform !== "win32") {
  console.log(enUnaLinea);
  process.exit(0);
}
const portapapeles = spawn("clip");
portapapeles.on("error", () => {
  console.error("No pude usar el portapapeles de Windows.");
  process.exit(1);
});
portapapeles.on("close", () => {
  console.log(`Listo: la llave de ${llave.client_email} quedó copiada.`);
  console.log("Pegala en Railway como valor de la variable GOOGLE_CREDENTIALS_JSON (Ctrl + V).");
});
portapapeles.stdin.end(enUnaLinea);
