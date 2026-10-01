// Arma el AGENTE de una empresa: modelo + instrucciones + herramientas + memoria.
//
// POR QUÉ un "agente" y no un bot de menú: el agente lee lo que escribe el
// cliente, decide si necesita una herramienta (buscar precio, cotizar, derivar),
// la usa, mira el resultado y recién ahí responde. Ese ciclo
// "pensar -> usar herramienta -> responder" lo maneja LangGraph por nosotros.

import { createAgent, dynamicSystemPromptMiddleware, modelCallLimitMiddleware, modelFallbackMiddleware } from "langchain";
import * as z from "zod";
import { armarPrompt } from "./prompt.js";
import { crearHerramientas } from "./herramientas.js";

// Datos de la conversación que viajan con cada mensaje (no los inventa la IA).
// "turno" cuenta los mensajes del cliente en esta charla: sirve para que
// confirmar_pedido solo funcione DESPUÉS de que el cliente vio la cotización.
const esquemaContexto = z.object({
  telefono: z.string(),
  nombre: z.string().optional(),
  hiloId: z.string(),
  turno: z.number(),
});

export function crearAgente({ empresa, modelo, respaldos = [], fuente, pausas, pendientes, memoria, cobros, enlaces }) {
  return createAgent({
    model: modelo,
    tools: crearHerramientas({ empresa, fuente, pausas, pendientes, cobros, enlaces }),
    contextSchema: esquemaContexto,
    // La memoria (checkpointer) guarda el historial de cada conversación.
    // Cada cliente de cada empresa tiene su propio "hilo" (thread_id).
    checkpointer: memoria,
    middleware: [
      // Instrucciones con la fecha/hora actual, recalculadas en cada mensaje.
      dynamicSystemPromptMiddleware(() => armarPrompt(empresa)),
      // Freno de seguridad: como máximo 5 llamadas a la IA por mensaje del
      // cliente. Evita loops que te consumen la cuota o te generan costos.
      modelCallLimitMiddleware({ runLimit: 5, exitBehavior: "end" }),
      // Si el modelo principal falla (saturado, sin cuota), prueba con los de
      // respaldo en orden. Solo se activa si configuraste GEMINI_MODEL_RESPALDO.
      ...(respaldos.length > 0 ? [modelFallbackMiddleware(...respaldos)] : []),
    ],
  });
}
