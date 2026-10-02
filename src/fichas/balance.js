// El BALANCE de cada noche para el dueño del autolavado.
//
// POR QUÉ lo arma el código y no la IA: son cuentas (plata, autos, porcentajes,
// cuándo se termina la reserva). La IA puede equivocarse sumando; el código no.
//
// Lo que usa:
// - ventas: las ventas pagadas del día (las anota el sistema solo).
// - gastos: los gastos del día (facturas leídas por foto o cargadas a mano).
// - historial: cómo vino el negocio los días anteriores ([{ fecha, autos, ingresos, gastosVariables }]).
// - empresa.fichas.gastosFijosMensuales y empresa.fichas.reserva (los carga el dueño una vez).

import { formatearPesos } from "../datos/productos.js";
import { contarAutos, minutos } from "./ventas.js";

const FRANJAS = [
  { nombre: "8 a 12 h", desde: 8, hasta: 12 },
  { nombre: "12 a 14 h", desde: 12, hasta: 14 },
  { nombre: "14 a 17 h", desde: 14, hasta: 17 },
  { nombre: "17 a 19 h", desde: 17, hasta: 19 },
  { nombre: "19 a 22 h", desde: 19, hasta: 24 },
];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

const suma = (lista, campo) => lista.reduce((t, x) => t + (Number(x[campo]) || 0), 0);
const promedio = (lista) => (lista.length ? lista.reduce((a, b) => a + b, 0) / lista.length : 0);
const semanas = (n) => `${n} ${n === 1 ? "semana" : "semanas"}`;

function barra(porcentaje) {
  const llenos = Math.round(porcentaje / 10);
  return "▰".repeat(llenos) + "▱".repeat(10 - llenos);
}

function diaDeLaSemana(fecha) {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
}

export function franjasDelDia(ventas) {
  const total = ventas.length || 1;
  return FRANJAS.map((f) => {
    const cuantas = ventas.filter((v) => {
      const h = minutos(v.hora) / 60;
      return h >= f.desde && h < f.hasta;
    }).length;
    return { nombre: f.nombre, porcentaje: Math.round((cuantas * 100) / total) };
  });
}

// Proyección: si los autos por día siguen bajando al mismo ritmo, ¿cuándo se
// empieza a perder plata y cuándo se termina la reserva? Semana a semana.
export function proyectar({ autosHoy, cambioPorSemana, ticket, costoDiario, reserva, semanasMaximas = 26 }) {
  let acumulado = 0;
  let empiezaAPerder = null;
  let seTerminaLaReserva = null;
  for (let k = 1; k <= semanasMaximas; k++) {
    const autos = Math.max(0, autosHoy + cambioPorSemana * k);
    const resultado = 7 * (autos * ticket - costoDiario);
    acumulado += resultado;
    if (resultado < 0 && empiezaAPerder === null) empiezaAPerder = k;
    if (reserva + acumulado < 0 && seTerminaLaReserva === null) seTerminaLaReserva = k;
  }
  return { empiezaAPerder, seTerminaLaReserva };
}

export function armarBalance({ empresa, ventas, gastos, historial = [], ahora = new Date() }) {
  const cfg = empresa.fichas ?? {};
  const ingresos = suma(ventas, "total");
  const fichas = suma(ventas, "fichas");
  const autos = contarAutos(ventas);

  const fijosDia = Math.round(suma(cfg.gastosFijosMensuales ?? [], "monto") / 30);
  const comprasHoy = suma(gastos, "total");
  const gastosDia = fijosDia + comprasHoy;
  const resultado = ingresos - gastosDia;

  // Con cuántos autos por día se cubren los gastos (punto de equilibrio).
  const ticketHistorico = suma(historial, "autos") ? suma(historial, "ingresos") / suma(historial, "autos") : 0;
  const ticket = autos ? ingresos / autos : ticketHistorico;
  const comprasPromedio = historial.length ? suma(historial, "gastosVariables") / historial.length : comprasHoy;
  const costoDiario = fijosDia + comprasPromedio;
  const equilibrio = ticket > 0 ? Math.ceil(costoDiario / ticket) : null;

  const franjas = franjasDelDia(ventas)
    .filter((f) => f.porcentaje > 0)
    .sort((a, b) => b.porcentaje - a.porcentaje)
    .slice(0, 3);

  const zona = { timeZone: "America/Argentina/Buenos_Aires" };
  const fecha = `${ahora.toLocaleDateString("es-AR", { ...zona, weekday: "long" })} ${ahora.toLocaleDateString("es-AR", { ...zona, day: "numeric" })}/${ahora.toLocaleDateString("es-AR", { ...zona, month: "numeric" })}`;
  const lineas = [
    `📊 *Balance de hoy* (${fecha})`,
    `💰 Entró: *${formatearPesos(ingresos)}* (${fichas} fichas)`,
    `🚗 Autos: *${autos}*`,
  ];
  if (franjas.length) {
    lineas.push("⏰ Horarios con más gente:");
    for (const f of franjas) lineas.push(`${f.nombre}  ${barra(f.porcentaje)}  ${f.porcentaje}%`);
  }
  lineas.push(`📉 Gastos del día: *${formatearPesos(gastosDia)}*`);
  lineas.push(`(fijos ${formatearPesos(fijosDia)} + compras ${formatearPesos(comprasHoy)})`);
  lineas.push(resultado >= 0 ? `✅ *Ganancia del día: ${formatearPesos(resultado)}*` : `🔻 *Pérdida del día: ${formatearPesos(-resultado)}*`);
  if (equilibrio !== null) {
    lineas.push(
      autos >= equilibrio
        ? `Para no perder plata necesitás *${equilibrio} autos por día*. Hoy tuviste ${autos} 👍`
        : `Para no perder plata necesitás *${equilibrio} autos por día*. Hoy tuviste ${autos}: te faltaron ${equilibrio - autos}.`,
    );
  }

  // ---- La tendencia de las últimas 3 semanas ----
  let alerta = null;
  if (historial.length >= 14) {
    const ordenado = [...historial].sort((a, b) => a.fecha.localeCompare(b.fecha)).slice(-21);
    const porSemana = [];
    for (let i = ordenado.length; i > 0; i -= 7) porSemana.unshift(promedio(ordenado.slice(Math.max(0, i - 7), i).map((d) => d.autos)));
    const primera = Math.round(porSemana[0]);
    const ultima = Math.round(porSemana[porSemana.length - 1]);
    const cambioPorSemana = (porSemana[porSemana.length - 1] - porSemana[0]) / Math.max(1, porSemana.length - 1);

    // El día de la semana más flojo, para sugerir una promo.
    const porDia = new Map();
    for (const d of ordenado) {
      const k = diaDeLaSemana(d.fecha);
      porDia.set(k, [...(porDia.get(k) ?? []), d.autos]);
    }
    const masFlojo = [...porDia].map(([k, v]) => [k, promedio(v)]).sort((a, b) => a[1] - b[1])[0];
    const idea = masFlojo ? `💡 Idea: los ${DIAS[masFlojo[0]]} son tus días más flojos. ¿Mandamos una promo ese día a tus clientes frecuentes?` : "";

    if (cambioPorSemana < -0.5 && equilibrio !== null) {
      const { empiezaAPerder, seTerminaLaReserva } = proyectar({
        autosHoy: porSemana[porSemana.length - 1],
        cambioPorSemana,
        ticket,
        costoDiario,
        reserva: cfg.reserva ?? 0,
      });
      const partes = [`⚠️ *Atención*`, `En ${semanas(porSemana.length)} bajaste de ${primera} a ${ultima} autos por día (promedio), y necesitás ${equilibrio} para cubrir los gastos.`];
      if (ultima < equilibrio) partes.push("Ya estás vendiendo menos de lo que gastás.");
      if (seTerminaLaReserva) {
        partes.push(
          `Si sigue así, ${empiezaAPerder && ultima >= equilibrio ? `en unas *${semanas(empiezaAPerder)}* empezás a perder plata y ` : ""}en unas *${semanas(seTerminaLaReserva)}* se termina tu reserva de ${formatearPesos(cfg.reserva ?? 0)}.`,
        );
      } else if (empiezaAPerder) {
        partes.push(`Si sigue así, en unas *${semanas(empiezaAPerder)}* empezás a perder plata.`);
      }
      if (idea) partes.push(idea);
      alerta = { nivel: "atencion", texto: partes.join("\n") };
    } else {
      const partes = [`✅ *El negocio viene bien*`, `En ${semanas(porSemana.length)} pasaste de ${primera} a ${ultima} autos por día (promedio).`];
      if (equilibrio !== null) partes.push(`Cubrís los gastos con ${equilibrio} autos por día.`);
      if (idea) partes.push(idea);
      alerta = { nivel: "bien", texto: partes.join("\n") };
    }
  }

  return {
    texto: lineas.join("\n"),
    alerta,
    numeros: { ingresos, fichas, autos, gastosDia, fijosDia, comprasHoy, resultado, equilibrio, franjas },
  };
}
