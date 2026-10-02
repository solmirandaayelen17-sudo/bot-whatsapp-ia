// Pruebas de la AGENDA de turnos, sin Google Calendar ni IA.

import test from "node:test";
import assert from "node:assert/strict";
import { validarEmpresa } from "../src/config/empresas.js";
import { horariosLibres, problemaConLaFecha, instante, diaDeLaSemana, fechaLegible, hoyEnArgentina } from "../src/agenda/horarios.js";
import { crearAgendaEnMemoria } from "../src/agenda/crearAgenda.js";
import { crearHerramientas } from "../src/agente/herramientas.js";

const empresa = validarEmpresa({
  id: "pelu",
  nombre: "Pelu Test",
  rubro: "peluquería",
  negocio: { horarios: "martes a sábado" },
  datos: { tipo: "local", carpeta: "datos/x" },
  herramientas: ["buscar_productos", "agendar_turnos"],
  agenda: { tipo: "memoria", horario: { martes: ["09:00-12:00", "14:00-15:00"], sabado: ["09:00-10:00"] }, anticipacionMinutos: 0 },
});
const agendaReglas = empresa.agenda;

// El martes 6 de octubre de 2026, mirado desde el lunes 5 a la noche.
const MARTES = "2026-10-06";
const LUNES_NOCHE = instante("2026-10-05", "21:00");

test("los días y las fechas se calculan en hora de Argentina", () => {
  assert.equal(diaDeLaSemana(MARTES), "martes");
  assert.equal(diaDeLaSemana("2026-10-10"), "sabado");
  assert.match(fechaLegible(MARTES), /martes.*6.*octubre/);
  assert.equal(hoyEnArgentina(instante("2026-10-05", "23:30")), "2026-10-05"); // en UTC ya es día 6
});

test("los horarios libres respetan las franjas, la duración y los turnos tomados", () => {
  const libres = horariosLibres({ agenda: agendaReglas, fecha: MARTES, duracion: 30, ocupados: [], ahora: LUNES_NOCHE });
  assert.deepEqual(libres, ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "14:00", "14:30"]);

  // Un servicio de 90 minutos no entra en la franja de la tarde (14 a 15).
  const largos = horariosLibres({ agenda: agendaReglas, fecha: MARTES, duracion: 90, ocupados: [], ahora: LUNES_NOCHE });
  assert.deepEqual(largos, ["09:00", "09:30", "10:00", "10:30"]);

  // Un turno de 10:00 a 10:45 ocupa los horarios que se superponen.
  const ocupados = [{ inicio: instante(MARTES, "10:00"), fin: instante(MARTES, "10:45") }];
  const conTurno = horariosLibres({ agenda: agendaReglas, fecha: MARTES, duracion: 30, ocupados, ahora: LUNES_NOCHE });
  assert.deepEqual(conTurno, ["09:00", "09:30", "11:00", "11:30", "14:00", "14:30"]);

  // Cerrado los lunes.
  assert.deepEqual(horariosLibres({ agenda: agendaReglas, fecha: "2026-10-05", duracion: 30, ocupados: [], ahora: instante("2026-10-04", "10:00") }), []);

  // El mismo día, no ofrece horarios que ya pasaron (ni dentro de la anticipación).
  const conAnticipacion = { ...agendaReglas, anticipacionMinutos: 60 };
  const mismoDia = horariosLibres({ agenda: conAnticipacion, fecha: MARTES, duracion: 30, ocupados: [], ahora: instante(MARTES, "10:10") });
  assert.deepEqual(mismoDia, ["11:30", "14:00", "14:30"]);
});

test("las fechas pasadas, inválidas o muy lejanas se rechazan", () => {
  assert.equal(problemaConLaFecha(agendaReglas, MARTES, LUNES_NOCHE), null);
  assert.equal(problemaConLaFecha(agendaReglas, "2026-10-01", LUNES_NOCHE), "fecha-pasada");
  assert.equal(problemaConLaFecha(agendaReglas, "6/10", LUNES_NOCHE), "fecha-invalida");
  assert.equal(problemaConLaFecha(agendaReglas, "2026-12-30", LUNES_NOCHE), "muy-adelante");
});

test("la configuración pide la agenda si la empresa da turnos", () => {
  assert.throws(
    () => validarEmpresa({ id: "x", nombre: "x", rubro: "x", negocio: { horarios: "h" }, datos: { tipo: "local", carpeta: "d" }, herramientas: ["agendar_turnos"] }),
    /hace falta la sección "agenda"/,
  );
  assert.throws(
    () => validarEmpresa({ id: "x", nombre: "x", rubro: "x", negocio: { horarios: "h" }, datos: { tipo: "local", carpeta: "d" }, agenda: { tipo: "google-calendar", horario: {} } }),
    /calendarId/,
  );
});

// Para probar las herramientas con una fecha que siempre esté en el futuro.
function proximoMartes() {
  const hoy = hoyEnArgentina();
  for (let i = 1; i <= 7; i++) {
    const [a, m, d] = hoy.split("-").map(Number);
    const f = new Date(Date.UTC(a, m - 1, d + i)).toISOString().slice(0, 10);
    if (diaDeLaSemana(f) === "martes") return f;
  }
}

test("ver_turnos_libres y reservar_turno: reserva, no deja pisar un turno y arma el link de pago", async () => {
  const agenda = crearAgendaEnMemoria();
  const fuente = {
    listarProductos: async () => [
      { codigo: "COR", nombre: "Corte", precio: 12000, stock: null, duracion: 60, descripcion: "" },
    ],
    agregarRegistro: async () => {},
  };
  const links = [];
  const conCobro = { ...empresa, herramientas: [...empresa.herramientas, "cobrar_mercado_pago"] };
  const cobros = { crearLink: async ({ pedido }) => (links.push(pedido), { link: "https://mp/turno", id: "1" }) };
  const herramientas = crearHerramientas({ empresa: conCobro, fuente, pausas: {}, pendientes: {}, agenda, cobros });
  const ver = herramientas.find((h) => h.name === "ver_turnos_libres");
  const reservar = herramientas.find((h) => h.name === "reservar_turno");
  const fecha = proximoMartes();

  const antes = JSON.parse(await ver.invoke({ fecha, codigo_servicio: "COR" }));
  assert.equal(antes.duracion_minutos, 60);
  assert.deepEqual(antes.horarios_libres, ["09:00", "09:30", "10:00", "10:30", "11:00", "14:00"]);

  const ok = JSON.parse(await reservar.invoke({ fecha, hora: "10:00", codigo_servicio: "COR", nombre_cliente: "Ana" }));
  assert.equal(ok.ok, true);
  assert.equal(ok.link_de_pago, "https://mp/turno");
  assert.equal(links[0].lineas[0].precio, 12000);
  assert.equal(agenda.turnos.length, 1);
  assert.match(agenda.turnos[0].titulo, /Corte — Ana/);

  // El mismo horario (o uno que se superpone) ya no se puede reservar.
  const pisado = JSON.parse(await reservar.invoke({ fecha, hora: "10:30", codigo_servicio: "COR", nombre_cliente: "Beto" }));
  assert.equal(pisado.ok, false);
  assert.ok(!pisado.horarios_libres.includes("10:30"));
  assert.equal(agenda.turnos.length, 1);

  const despues = JSON.parse(await ver.invoke({ fecha, codigo_servicio: "COR" }));
  assert.deepEqual(despues.horarios_libres, ["09:00", "11:00", "14:00"]);

  // Dos clientes a la vez por el mismo horario: solo uno se lo queda.
  const [x, y] = await Promise.all([
    reservar.invoke({ fecha, hora: "14:00", codigo_servicio: "COR", nombre_cliente: "Caro" }),
    reservar.invoke({ fecha, hora: "14:00", codigo_servicio: "COR", nombre_cliente: "Dani" }),
  ]);
  assert.deepEqual([JSON.parse(x).ok, JSON.parse(y).ok].sort(), [false, true]);
  assert.equal(agenda.turnos.length, 2);

  // Un servicio que no existe o una hora mal escrita no se reservan.
  assert.equal(JSON.parse(await reservar.invoke({ fecha, hora: "09:00", codigo_servicio: "NADA", nombre_cliente: "Eva" })).ok, false);
  assert.equal(JSON.parse(await reservar.invoke({ fecha, hora: "9", codigo_servicio: "COR", nombre_cliente: "Eva" })).ok, false);
});

test("sin agenda configurada, la empresa no recibe las herramientas de turnos", () => {
  const herramientas = crearHerramientas({ empresa, fuente: {}, pausas: {}, pendientes: {}, agenda: null });
  assert.equal(herramientas.some((h) => h.name === "reservar_turno"), false);
});
