// Elige la fuente de datos según lo que diga la configuración de la empresa.

import path from "node:path";
import { RAIZ } from "../config/empresas.js";
import { crearFuenteLocal } from "./fuenteLocal.js";
import { crearFuenteGoogleSheets } from "./fuenteGoogleSheets.js";

export function crearFuente(empresa) {
  const { datos } = empresa;
  if (datos.tipo === "local") return crearFuenteLocal(path.resolve(RAIZ, datos.carpeta));
  if (datos.tipo === "google-sheets") return crearFuenteGoogleSheets(datos.spreadsheetId);
  throw new Error(`Tipo de datos no soportado: ${datos.tipo}`);
}
