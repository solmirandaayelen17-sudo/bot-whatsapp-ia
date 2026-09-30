// Traduce los errores técnicos a una explicación corta y en castellano.
//
// POR QUÉ: los errores de las librerías traen 50 líneas de detalle y el motivo
// real queda perdido en el medio. Esto saca la parte útil y dice qué hacer.

export function mensajeDeError(error) {
  const texto = String(error?.message ?? error ?? "error desconocido");
  // Sacamos el prefijo largo de la librería y dejamos el motivo.
  return texto.replace(/^\[GoogleGenerativeAI Error\]:\s*/, "").replace(/\s+/g, " ").slice(0, 400);
}

// El orden importa: se usa la primera pista que coincide. Las de Google Sheets
// van primero porque también pueden traer un 403 o un 404.
const PISTAS = [
  [/Could not load the default credentials|Unable to read the credential file|GOOGLE_APPLICATION_CREDENTIALS/i, "No encuentro la llave de la cuenta de servicio: revisá que exista credenciales/cuenta-servicio.json y la línea GOOGLE_APPLICATION_CREDENTIALS del .env."],
  [/caller does not have permission/i, "La planilla no está compartida con la cuenta de servicio: compartila como Editor con el mail que termina en iam.gserviceaccount.com."],
  [/Sheets API has not been used|sheets\.googleapis\.com.*(disabled|not been used)|SERVICE_DISABLED/i, "La Google Sheets API no está habilitada en tu proyecto de Google Cloud: habilitala en https://console.cloud.google.com/apis/library/sheets.googleapis.com"],
  [/Unable to parse range/i, "No encuentro una pestaña de la planilla: tienen que llamarse exactamente Productos, Pedidos y Derivaciones."],
  [/Requested entity was not found/i, "No encuentro la planilla: revisá el spreadsheetId en el archivo de la empresa."],
  [/API key not valid|API_KEY_INVALID|invalid api key/i, "La clave de Gemini no es válida: copiala de nuevo completa, sin espacios ni comillas, en GOOGLE_API_KEY del .env."],
  [/is not found|not found for API version|NOT_FOUND|\[404/i, "El modelo no existe o no está disponible para tu clave: cambiá GEMINI_MODEL en el .env (lista: https://ai.google.dev/gemini-api/docs/models)."],
  [/quota|RESOURCE_EXHAUSTED|\[429|rate limit/i, "Se terminó la cuota gratis por ahora (por minuto o por día): esperá un rato o probá otro modelo."],
  [/overloaded|UNAVAILABLE|\[503|high demand/i, "Gemini está saturado en este momento: probá de nuevo en un rato o configurá un modelo de respaldo (GEMINI_MODEL_RESPALDO)."],
  [/PERMISSION_DENIED|\[403/i, "La clave no tiene permiso para usar Gemini: creá una clave nueva en https://aistudio.google.com/apikey (en un proyecto con la API de Gemini habilitada)."],
  [/location is not supported|User location/i, "Gemini no está disponible desde tu ubicación con esta cuenta."],
  [/thought.?signature/i, "Problema de compatibilidad con el \"pensamiento\" de los modelos Gemini 3 al usar herramientas: probá con otro modelo o avisame."],
  [/Invalid JSON payload|function_declarations|Unknown name|schema/i, "Gemini no aceptó el formato de las herramientas del bot: pasame este mensaje para ajustarlo."],
  [/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i, "No hay conexión con Google: revisá tu internet."],
];

export function pistaDeError(error) {
  const texto = mensajeDeError(error);
  for (const [patron, pista] of PISTAS) if (patron.test(texto)) return pista;
  return null;
}
