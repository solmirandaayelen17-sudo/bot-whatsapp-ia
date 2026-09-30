// Lectura y escritura de CSV, sin librerías.
//
// POR QUÉ: para el modo local usamos archivos .csv que imitan las pestañas de la
// planilla de Google. Así podés probar todo sin configurar Google, y cuando
// pases a Sheets los datos tienen exactamente la misma forma.

export function parsearCsv(texto) {
  const limpio = texto.replace(/^﻿/, ""); // saca el BOM que agregan algunos editores
  const filas = [];
  let fila = [];
  let campo = "";
  let enComillas = false;

  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (enComillas) {
      if (c === '"') {
        if (limpio[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        campo += c;
      }
    } else if (c === '"') {
      enComillas = true;
    } else if (c === ",") {
      fila.push(campo);
      campo = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && limpio[i + 1] === "\n") i++;
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = "";
    } else {
      campo += c;
    }
  }
  if (campo !== "" || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas.filter((f) => f.some((v) => v.trim() !== ""));
}

// Convierte [[encabezados], [valores], ...] en [{ encabezado: valor }, ...].
// Sirve igual para el CSV local y para lo que devuelve Google Sheets.
export function filasAObjetos(filas) {
  if (!filas || filas.length === 0) return [];
  const [encabezados, ...resto] = filas;
  const claves = encabezados.map((h) => String(h).trim().toLowerCase());
  return resto.map((f) => Object.fromEntries(claves.map((k, i) => [k, String(f[i] ?? "").trim()])));
}

export function aLineaCsv(valores) {
  return valores
    .map((v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}
