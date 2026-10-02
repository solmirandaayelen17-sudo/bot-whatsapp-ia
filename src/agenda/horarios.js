// La cuenta de los HORARIOS LIBRES de la agenda de turnos.
//
// POR QUÉ es código y no IA: qué horario está libre es una cuenta exacta
// (horario de atención, duración del servicio y turnos ya tomados). La IA solo
// le ofrece al cliente lo que devuelve esta cuenta; no puede inventar un hueco.
//
// Todo en hora de Argentina (UTC-3, sin cambio de horario en el año).

import { DIAS_DE_LA_SEMANA } from "../config/empresas.js";

const ZONA = "-03:00";
const UN_MINUTO = 60_000;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

// "2026-10-04" + "15:30" -> el instante exacto en Argentina.
export function instante(fecha, hora) {
  return new Date(`${fecha}T${hora}:00${ZONA}`);
}

// La fecha de hoy en Argentina, como "2026-10-02".
export function hoyEnArgentina(ahora = new Date()) {
  return ahora.toLocaleDateString("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" });
}

export function horaDe(fecha) {
  return fecha.toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false });
}

// "2026-10-04" -> "sábado 4 de octubre"
export function fechaLegible(fecha) {
  return instante(fecha, "12:00").toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

export function diaDeLaSemana(fecha) {
  const [a, m, d] = fecha.split("-").map(Number);
  return DIAS_DE_LA_SEMANA[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
}

export function sumarDias(fecha, dias) {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

// ¿Esta fecha se puede pedir? Devuelve null si sí, o el motivo si no.
export function problemaConLaFecha(agenda, fecha, ahora = new Date()) {
  if (!FECHA.test(fecha) || Number.isNaN(instante(fecha, "12:00").getTime())) return "fecha-invalida";
  const hoy = hoyEnArgentina(ahora);
  if (fecha < hoy) return "fecha-pasada";
  if (fecha > sumarDias(hoy, agenda.diasAdelante)) return "muy-adelante";
  return null;
}

export function esHoraValida(hora) {
  return HORA.test(hora);
}

// Las franjas de atención de ese día, como instantes: [{ desde, hasta }].
export function franjasDelDia(agenda, fecha) {
  return (agenda.horario[diaDeLaSemana(fecha)] ?? []).map((franja) => {
    const [desde, hasta] = franja.split("-");
    return { desde: instante(fecha, desde), hasta: instante(fecha, hasta) };
  });
}

// Los horarios de inicio libres de un día para un servicio de `duracion` minutos.
// ocupados: [{ inicio: Date, fin: Date }] (los turnos ya tomados y otros eventos).
export function horariosLibres({ agenda, fecha, duracion, ocupados, ahora = new Date() }) {
  const primero = ahora.getTime() + agenda.anticipacionMinutos * UN_MINUTO;
  const libres = [];
  for (const { desde, hasta } of franjasDelDia(agenda, fecha)) {
    for (let t = desde.getTime(); t + duracion * UN_MINUTO <= hasta.getTime(); t += agenda.intervaloMinutos * UN_MINUTO) {
      const fin = t + duracion * UN_MINUTO;
      if (t < primero) continue;
      const choca = ocupados.some((o) => t < o.fin.getTime() && fin > o.inicio.getTime());
      if (!choca) libres.push(horaDe(new Date(t)));
    }
  }
  return libres;
}

// Para buscar los turnos tomados: desde el primer horario del día hasta el último.
export function limitesDelDia(fecha) {
  return { desde: instante(fecha, "00:00"), hasta: instante(sumarDias(fecha, 1), "00:00") };
}
