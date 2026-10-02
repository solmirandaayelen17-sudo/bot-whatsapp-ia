// Dónde se guardan los TURNOS de cada negocio.
//
// - "google-calendar": el calendario de Google del negocio. El dueño ve los
//   turnos en su celular y puede cargar a mano los que toma por teléfono: el bot
//   los respeta (para el bot, cualquier evento del calendario es un horario ocupado).
// - "memoria": una agenda de mentira que vive mientras el programa está prendido.
//   Sirve para las pruebas y para la demo pública (nadie toca un calendario real).
//
// Las dos hacen lo mismo: ocupados(desde, hasta) y reservar(turno).

import { google } from "googleapis";
import { opcionesDeAutenticacion } from "../datos/fuenteGoogleSheets.js";

const ZONA = "America/Argentina/Buenos_Aires";

export function crearAgenda(empresa) {
  const { agenda } = empresa;
  if (!agenda) return null;
  if (agenda.tipo === "google-calendar") return crearAgendaGoogleCalendar(agenda.calendarId);
  return crearAgendaEnMemoria();
}

export function crearAgendaEnMemoria() {
  const turnos = []; // { id, inicio, fin, titulo, descripcion }
  return {
    descripcion: "agenda de prueba (en memoria)",
    async ocupados(desde, hasta) {
      return turnos.filter((t) => t.inicio < hasta && t.fin > desde).map(({ inicio, fin }) => ({ inicio, fin }));
    },
    async reservar(turno) {
      const id = `mem-${turnos.length + 1}`;
      turnos.push({ id, ...turno });
      return { id };
    },
    turnos, // para las pruebas
  };
}

export function crearAgendaGoogleCalendar(calendarId) {
  const auth = new google.auth.GoogleAuth(opcionesDeAutenticacion(process.env, ["https://www.googleapis.com/auth/calendar"]));
  const calendar = google.calendar({ version: "v3", auth });
  return {
    descripcion: `Google Calendar ${calendarId}`,
    async ocupados(desde, hasta) {
      const res = await calendar.freebusy.query({
        requestBody: { timeMin: desde.toISOString(), timeMax: hasta.toISOString(), timeZone: ZONA, items: [{ id: calendarId }] },
      });
      const cal = res.data.calendars?.[calendarId];
      if (cal?.errors?.length) {
        throw new Error(`Google Calendar no deja ver el calendario (${cal.errors[0].reason}). ¿Está compartido con la cuenta de servicio?`);
      }
      return (cal?.busy ?? []).map((b) => ({ inicio: new Date(b.start), fin: new Date(b.end) }));
    },
    async reservar({ inicio, fin, titulo, descripcion }) {
      const res = await calendar.events.insert({
        calendarId,
        requestBody: {
          summary: titulo,
          description: descripcion,
          start: { dateTime: inicio.toISOString(), timeZone: ZONA },
          end: { dateTime: fin.toISOString(), timeZone: ZONA },
        },
      });
      return { id: res.data.id };
    },
  };
}
