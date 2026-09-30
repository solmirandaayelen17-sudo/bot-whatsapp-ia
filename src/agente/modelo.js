// El modelo de IA (Gemini).
//
// POR QUÉ está aislado en un archivo: si mañana querés probar otro modelo
// (OpenAI, Claude, uno local con Ollama), cambiás SOLO este archivo.

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export const MODELO_POR_DEFECTO = "gemini-3.8-flash";

// Se llama al arrancar, para avisar enseguida si falta la clave (y no recién
// cuando llega el primer mensaje de un cliente).
export function verificarClaveGemini() {
  if (!process.env.GOOGLE_API_KEY) {
    console.error("Falta GOOGLE_API_KEY en el archivo .env. La sacás gratis en https://aistudio.google.com/apikey");
    process.exit(1);
  }
}

export function nombreModeloPrincipal() {
  return (process.env.GEMINI_MODEL || MODELO_POR_DEFECTO).trim();
}

// GEMINI_MODEL_RESPALDO puede tener uno o varios modelos separados por coma.
export function nombresModelosRespaldo() {
  return (process.env.GEMINI_MODEL_RESPALDO || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

export function crearModeloGemini(nombre = nombreModeloPrincipal()) {
  const apiKey = process.env.GOOGLE_API_KEY?.trim();
  if (!apiKey) throw new Error("Falta GOOGLE_API_KEY en el archivo .env.");
  return new ChatGoogleGenerativeAI({
    model: nombre,
    apiKey,
    // Temperatura baja: queremos respuestas precisas y parecidas entre sí,
    // no creatividad. Un bot de ventas que "improvisa" inventa precios.
    temperature: 0.2,
    maxRetries: 1,
  });
}

// POR QUÉ un respaldo: si el modelo principal está saturado (error 503) o se
// quedó sin cuota, el agente prueba con el siguiente sin que el cliente se entere.
export function crearModelosRespaldoGemini() {
  return nombresModelosRespaldo().map((nombre) => crearModeloGemini(nombre));
}
