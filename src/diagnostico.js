// DIAGNÓSTICO: prueba Gemini y las planillas paso por paso y dice qué falla.
//
// Uso: npm run diagnostico
//
// POR QUÉ: cuando el bot contesta "tuve un problema técnico", el motivo puede
// ser la clave, el modelo, la cuota, el formato de las herramientas o la
// planilla. Este script prueba cada cosa por separado, así sabés cuál es.

import "dotenv/config";
import { cargarEmpresas } from "./config/empresas.js";
import { crearHerramientas } from "./agente/herramientas.js";
import { crearModeloGemini, nombreModeloPrincipal, nombresModelosRespaldo } from "./agente/modelo.js";
import { crearFuente } from "./datos/crearFuente.js";
import { crearTranscriptor } from "./agente/audio.js";
import { verificarCuentaMercadoPago } from "./pagos/mercadoPago.js";
import { crearPausas } from "./nucleo/pausas.js";
import { crearPedidosPendientes } from "./nucleo/pedidosPendientes.js";
import { mensajeDeError, pistaDeError } from "./nucleo/errores.js";

const ok = (t) => console.log(`   OK  ${t}`);
const mal = (t) => console.log(`   MAL ${t}`);
const aviso = (t) => console.log(`   !   ${t}`);

function mostrarError(error) {
  mal(mensajeDeError(error));
  const pista = pistaDeError(error);
  if (pista) console.log(`       -> ${pista}`);
}

console.log("\n1) Archivo .env");
const clave = process.env.GOOGLE_API_KEY ?? "";
if (!clave) {
  mal("GOOGLE_API_KEY está vacía. Pegá tu clave después del = y guardá con Ctrl+S.");
  process.exit(1);
}
// Nunca mostramos la clave: solo cómo empieza y cuánto mide, para detectar errores al pegarla.
ok(`GOOGLE_API_KEY cargada (empieza con "${clave.slice(0, 4)}...", ${clave.length} caracteres)`);
if (clave !== clave.trim()) aviso("La clave tiene espacios al principio o al final: borralos.");
if (/["']/.test(clave)) aviso("La clave tiene comillas: borralas.");
const modelo = nombreModeloPrincipal();
ok(`Modelo principal: ${modelo}`);
const respaldos = nombresModelosRespaldo();
if (respaldos.length) ok(`Modelos de respaldo: ${respaldos.join(", ")}`);

console.log(`\n2) Pregunta simple a Gemini (${modelo}), sin herramientas`);
let simpleOk = false;
try {
  const r = await crearModeloGemini(modelo).invoke("Respondé solamente con la palabra: funciona");
  ok(`Gemini respondió: "${String(r.content).trim().slice(0, 80)}"`);
  simpleOk = true;
} catch (error) {
  mostrarError(error);
}

console.log("\n3) Pregunta con las herramientas del bot");
if (!simpleOk) {
  aviso("Me salteo este paso: primero hay que resolver el paso 2.");
} else {
  try {
    const empresa = [...cargarEmpresas().porId.values()][0];
    const herramientas = crearHerramientas({
      empresa,
      fuente: crearFuente(empresa),
      pausas: crearPausas(),
      pendientes: crearPedidosPendientes(),
    });
    const r = await crearModeloGemini(modelo)
      .bindTools(herramientas)
      .invoke("¿Tienen cubiertas 175/65 R14? Buscalo con la herramienta.");
    if (r.tool_calls?.length) ok(`Gemini eligió usar: ${r.tool_calls.map((t) => t.name).join(", ")}`);
    else aviso("Gemini respondió sin usar herramientas (no es un error, pero conviene revisarlo).");
  } catch (error) {
    mostrarError(error);
  }
}

console.log("\n4) Audios: Gemini escucha un audio de prueba");
if (!simpleOk) {
  aviso("Me salteo este paso: primero hay que resolver el paso 2.");
} else {
  try {
    const transcribir = crearTranscriptor({ crearModelos: () => [crearModeloGemini(modelo)] });
    const texto = await transcribir({ datos: audioDePrueba(), mimeType: "audio/wav" });
    ok(`Gemini recibió el audio (un pitido de 1 segundo, sin voz). Entendió: ${texto ? `"${texto.slice(0, 60)}"` : "nada, como corresponde"}.`);
  } catch (error) {
    mostrarError(error);
  }
}

console.log("\n5) Datos de cada empresa (planilla o CSV)");
for (const empresa of cargarEmpresas().porId.values()) {
  try {
    const fuente = crearFuente(empresa);
    const productos = await fuente.listarProductos();
    const ejemplo = productos[0] ? ` Ejemplo: ${productos[0].nombre} a $${productos[0].precio}.` : "";
    ok(`${empresa.id}: leí ${productos.length} productos de ${fuente.descripcion}.${ejemplo}`);
    if (productos.length === 0) aviso(`${empresa.id}: la pestaña Productos está vacía o sin encabezados.`);
  } catch (error) {
    mal(`${empresa.id}: ${mensajeDeError(error)}`);
    const pista = pistaDeError(error);
    if (pista) console.log(`       -> ${pista}`);
  }
}

const conCobros = [...cargarEmpresas().porId.values()].filter((e) => e.herramientas.includes("cobrar_mercado_pago"));
if (conCobros.length) {
  console.log("\n6) Mercado Pago (empresas que cobran con link)");
  for (const empresa of conCobros) {
    try {
      const cuenta = await verificarCuentaMercadoPago(empresa);
      ok(`${empresa.id}: el token funciona. Cuenta de Mercado Pago: ${cuenta.usuario} (${cuenta.pais}).`);
      if (/^TEST/i.test(cuenta.usuario)) aviso(`${empresa.id}: es una cuenta de PRUEBA. Los pagos no son reales (ideal para la demo).`);
    } catch (error) {
      mal(`${empresa.id}: ${mensajeDeError(error)}`);
      if (/Falta/.test(String(error?.message))) console.log("       -> Pegá el Access Token en el .env (ver README, \"Cobrar con Mercado Pago\").");
      else if (/401|403/.test(String(error?.message))) console.log("       -> El token no es válido: copialo de nuevo completo, sin espacios ni comillas.");
    }
  }
}

console.log("\nSi todo dio OK, probá el chat: npm run consola -- gomeria-demo (o la demo con micrófono: npm run demo -- gomeria-demo)\n");

// Un audio WAV armado en el momento: 1 segundo de un pitido suave. Sirve para
// comprobar que Gemini acepta audios con tu clave, sin necesitar un archivo.
function audioDePrueba() {
  const frecuencia = 16000;
  const bytes = frecuencia * 2;
  const wav = Buffer.alloc(44 + bytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + bytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); // tamaño del bloque de formato
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(frecuencia, 24);
  wav.writeUInt32LE(frecuencia * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frecuencia; i++) wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / frecuencia) * 3000), 44 + i * 2);
  return wav;
}
