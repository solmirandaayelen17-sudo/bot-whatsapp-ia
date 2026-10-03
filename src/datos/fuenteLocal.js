// Fuente de datos LOCAL: archivos .csv en datos/<empresa>/.
//
// POR QUÉ: para probar sin configurar nada de Google. Tiene exactamente las
// mismas funciones que la fuente de Google Sheets, así el bot no sabe (ni le
// importa) de dónde vienen los datos. Esto se llama "programar contra una
// interfaz": cambiás la pieza sin tocar el resto.

import fs from "node:fs";
import path from "node:path";
import { parsearCsv, filasAObjetos, aLineaCsv } from "./csv.js";
import { ENCABEZADOS, normalizarProducto } from "./productos.js";

export function crearFuenteLocal(carpeta) {
  const archivoDe = (hoja) => path.join(carpeta, `${hoja.toLowerCase()}.csv`);

  return {
    descripcion: `archivos CSV en ${carpeta}`,

    async listarProductos() {
      const texto = fs.readFileSync(archivoDe("Productos"), "utf8");
      return filasAObjetos(parsearCsv(texto)).map(normalizarProducto).filter(Boolean);
    },

    // Lee una pestaña entera (por ejemplo Ventas, para el balance). Si no existe, está vacía.
    async listarRegistros(hoja) {
      const archivo = archivoDe(hoja);
      if (!fs.existsSync(archivo)) return [];
      return filasAObjetos(parsearCsv(fs.readFileSync(archivo, "utf8")));
    },

    async agregarRegistro(hoja, registro) {
      const columnas = ENCABEZADOS[hoja];
      if (!columnas) throw new Error(`Hoja desconocida: ${hoja}`);
      const archivo = archivoDe(hoja);
      if (!fs.existsSync(archivo)) fs.writeFileSync(archivo, aLineaCsv(columnas) + "\n");
      fs.appendFileSync(archivo, aLineaCsv(columnas.map((c) => registro[c] ?? "")) + "\n");
    },
  };
}
