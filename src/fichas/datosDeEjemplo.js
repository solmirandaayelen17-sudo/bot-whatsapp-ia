// DATOS DE EJEMPLO para la demo del autolavado.
//
// POR QUÉ: un visitante de la demo compra 1 o 2 veces. Con eso solo, el balance
// mostraría "1 auto, $11.000" y no se entiende para qué sirve. Cada caja de la
// demo arranca con un día de ventas de ejemplo y 3 semanas de historia, y las
// compras del visitante se suman encima. En la página se aclara que son de ejemplo.
//
// Los números salen siempre iguales (no son al azar de verdad), así la demo es predecible.

import { mejorPrecio } from "./ventas.js";

// Un generador de números "al azar" que siempre da la misma secuencia.
function secuencia(semilla) {
  let s = semilla >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOMBRES = ["Juan", "Marcela", "Diego", "Caro", "Pablo", "Sofi", "Nico", "Laura", "Martín", "Vane", "Hernán", "Flor", "Gustavo", "Ana", "Leo"];
// En qué horarios viene la gente (más a la tarde, a la salida del trabajo).
const HORAS = [8, 9, 10, 11, 12, 12, 13, 13, 14, 15, 16, 17, 17, 17, 18, 18, 18, 18, 19, 19, 20, 21];
// Cuántas fichas compra cada auto.
const CANTIDADES = [1, 1, 2, 3, 3, 3, 3, 4, 5, 5];
// Cómo cambia la cantidad de autos según el día (0 = domingo).
const FACTOR_DEL_DIA = [1.25, 0.9, 0.7, 0.85, 0.95, 1.1, 1.35];

function fechaMenos(ahora, dias) {
  const hoy = ahora.toLocaleDateString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" });
  const [a, m, d] = hoy.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d - dias)).toISOString().slice(0, 10);
}

export function datosDeEjemplo(empresa, ahora = new Date()) {
  const precios = empresa.fichas.precios;
  const azar = secuencia(20261002);

  // Las ventas de hoy: 21 autos repartidos en el día.
  const ventas = [];
  for (let i = 0; i < 21; i++) {
    const h = HORAS[Math.floor(azar() * HORAS.length)];
    const m = Math.floor(azar() * 60);
    const fichas = CANTIDADES[Math.floor(azar() * CANTIDADES.length)];
    const nombre = NOMBRES[Math.floor(azar() * NOMBRES.length)];
    ventas.push({
      id: `F-${1800 + i}`,
      hora: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
      bahia: 1 + Math.floor(azar() * empresa.fichas.bahias),
      fichas,
      total: mejorPrecio(precios, fichas).total,
      cliente: nombre,
      telefono: `549297${String(4000000 + i * 7919).slice(0, 7)}`,
      estado: "pagado",
      ejemplo: true,
    });
  }
  ventas.sort((a, b) => a.hora.localeCompare(b.hora));

  const gastos = [{ hora: "09:10", proveedor: "Distribuidora Patagonia", concepto: "Trapos de microfibra y repuesto de fichas", total: 22000, ejemplo: true }];

  // Las 3 semanas anteriores: el negocio viene bajando (28 → 24 → 20 autos por día).
  const historial = [];
  const promedioPorSemana = [28, 24, 20];
  for (let dias = 21; dias >= 1; dias--) {
    const fecha = fechaMenos(ahora, dias);
    const semana = dias > 14 ? 0 : dias > 7 ? 1 : 2;
    const [a, m, d] = fecha.split("-").map(Number);
    const factor = FACTOR_DEL_DIA[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
    const autos = Math.round(promedioPorSemana[semana] * factor);
    const ingresos = autos * 9300;
    historial.push({ fecha, autos, ingresos, gastosVariables: Math.round(ingresos * 0.12) });
  }
  return { ventas, gastos, historial };
}
