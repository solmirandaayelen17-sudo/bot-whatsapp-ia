// Fuente de datos GOOGLE SHEETS: la planilla del negocio.
//
// POR QUÉ: el dueño actualiza precios y stock desde el celular, sin saber
// programar, y el bot lo ve al instante. Los pedidos y derivaciones que anota el
// bot aparecen como filas nuevas en la misma planilla.
//
// Cómo se conecta: con una "cuenta de servicio" de Google (un usuario robot).
// El dueño comparte su planilla con el mail de esa cuenta y listo.

import { google } from "googleapis";
import { filasAObjetos } from "./csv.js";
import { ENCABEZADOS, normalizarProducto } from "./productos.js";

const SEGUNDOS_CACHE = 60;

// La llave de la cuenta de servicio (nunca se sube a GitHub) puede venir:
// - En tu compu: como archivo, con su ruta en GOOGLE_APPLICATION_CREDENTIALS.
// - En un servidor (Railway): pegada entera en la variable GOOGLE_CREDENTIALS_JSON,
//   porque ahí no hay archivos privados.
export function opcionesDeAutenticacion(entorno = process.env) {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  const json = entorno.GOOGLE_CREDENTIALS_JSON?.trim();
  if (!json) return { scopes };
  let credentials;
  try {
    credentials = JSON.parse(json);
  } catch {
    throw new Error("GOOGLE_CREDENTIALS_JSON no es un JSON válido: pegá el contenido completo del archivo de la cuenta de servicio.");
  }
  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("GOOGLE_CREDENTIALS_JSON no parece la llave de una cuenta de servicio (falta client_email o private_key).");
  }
  return { scopes, credentials };
}

export function crearFuenteGoogleSheets(spreadsheetId) {
  const auth = new google.auth.GoogleAuth(opcionesDeAutenticacion());
  const sheets = google.sheets({ version: "v4", auth });

  // POR QUÉ el caché: si entran 20 mensajes en un minuto no hace falta leer la
  // planilla 20 veces. Google tiene límites de lecturas por minuto.
  let cache = { hasta: 0, productos: [] };

  return {
    descripcion: `Google Sheets ${spreadsheetId}`,

    async listarProductos() {
      if (Date.now() < cache.hasta) return cache.productos;
      // UNFORMATTED_VALUE: los precios llegan como números (95000) y no como el
      // texto que se ve en pantalla ("$95.000" o "$95,000" según el país de la
      // planilla). Así el bot no depende de la configuración regional.
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Productos",
        valueRenderOption: "UNFORMATTED_VALUE",
      });
      const productos = filasAObjetos(res.data.values ?? []).map(normalizarProducto).filter(Boolean);
      cache = { hasta: Date.now() + SEGUNDOS_CACHE * 1000, productos };
      return productos;
    },

    async agregarRegistro(hoja, registro) {
      const columnas = ENCABEZADOS[hoja];
      if (!columnas) throw new Error(`Hoja desconocida: ${hoja}`);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${hoja}!A1`,
        // RAW (y no USER_ENTERED) por seguridad: si un cliente escribe algo como
        // "=IMPORTXML(...)", queda guardado como texto y no como una fórmula.
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        // Los números se guardan como números (el dueño puede sumar la columna
        // total); todo lo demás, como texto.
        requestBody: {
          values: [columnas.map((c) => (typeof registro[c] === "number" ? registro[c] : String(registro[c] ?? "")))],
        },
      });
    },
  };
}
