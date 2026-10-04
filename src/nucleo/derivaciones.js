// La CENTRAL DE DERIVACIONES: cuando el bot pasa una charla a una persona, esa
// persona la atiende desde su propio WhatsApp, a través del bot.
//
// POR QUÉ: la dueña no tiene que abrir otra app ni darle su número personal al
// cliente. Le llega un aviso al celular con el resumen y le contesta al bot; el
// bot le pasa la respuesta al cliente desde el número del negocio. Mientras la
// charla está derivada, lo que escribe el cliente también le llega a ella.
//
// Cómo contesta la dueña (por WhatsApp, al número del bot):
//   - Deslizando el aviso para responderlo y escribiendo el mensaje, o
//   - "#4567 tu mensaje" (4567 = últimos 4 números del cliente, viene en el aviso).
//   - "#4567 listo": termina, y el bot vuelve a atender a ese cliente.
//   - Cualquier otra cosa: le muestra las charlas abiertas y cómo contestar.
//
// Las charlas abiertas viven en memoria: si el servidor se reinicia, se pierden
// (las pausas también). Para ese caso, "#5492971234567 mensaje" con el número
// completo del cliente sigue funcionando.

import { mismoNumero } from "../fichas/sistema.js";
import { mensajeDeError } from "./errores.js";

const PALABRAS_DE_CIERRE = /^(listo|fin|termin[eé]|cerrar|ya est[aá])[.!]*$/i;

export function crearCentralDeDerivaciones({ enviarTexto, enviarPlantilla = null, pausas }) {
  const casos = new Map(); // "empresa:código" -> { empresa, telefono, nombre, motivo, hiloId, codigo }
  const porMensaje = new Map(); // id de un aviso enviado -> "empresa:código"

  const duenaDe = (empresa) => empresa.derivacion?.avisarA || "";

  // El código es el final del número del cliente: corto, y siempre el mismo para
  // esa persona. Si dos clientes terminan igual, se usan más números.
  function codigoPara(empresa, telefono) {
    const digitos = String(telefono).replace(/\D/g, "");
    for (const largo of [4, 6, 8, digitos.length]) {
      const codigo = digitos.slice(-largo);
      const caso = casos.get(`${empresa.id}:${codigo}`);
      if (!caso || caso.telefono === telefono) return codigo;
    }
    return digitos;
  }

  function recordar(clave, id) {
    if (!id) return;
    if (porMensaje.size > 5000) porMensaje.clear();
    porMensaje.set(id, clave);
  }

  // Manda un mensaje a la dueña. Primero texto común (llega si ella le escribió
  // al bot en las últimas 24 h); si falla y hay plantilla aprobada, la plantilla.
  async function mandarALaDuena(empresa, texto, parametrosPlantilla) {
    const para = duenaDe(empresa);
    try {
      return await enviarTexto({ empresa, para, texto });
    } catch (error) {
      const d = empresa.derivacion;
      if (!d.plantilla || !enviarPlantilla) throw error;
      return enviarPlantilla({ empresa, para, nombre: d.plantilla, idioma: d.idioma ?? "es_AR", parametros: parametrosPlantilla });
    }
  }

  // Lo llama la herramienta derivar_a_humano.
  async function avisar(empresa, { telefono, nombre, motivo, hiloId }) {
    if (!duenaDe(empresa) || !telefono) return;
    const codigo = codigoPara(empresa, telefono);
    const clave = `${empresa.id}:${codigo}`;
    casos.set(clave, { empresa, telefono, nombre: nombre || "", motivo, hiloId, codigo });
    const quien = nombre ? `${nombre} (+${telefono})` : `+${telefono}`;
    const texto = [
      `🙋 *Te necesita un cliente* · #${codigo}`,
      quien,
      `Motivo: ${motivo}`,
      "",
      `Para contestarle, deslizá este mensaje y respondé, o escribí *#${codigo} tu mensaje*.`,
      `Cuando termines, escribí *#${codigo} listo* y el bot lo vuelve a atender.`,
    ].join("\n");
    try {
      recordar(clave, await mandarALaDuena(empresa, texto, [quien, motivo, codigo]));
    } catch (error) {
      console.error(`[derivaciones] No pude avisarle a la dueña de ${empresa.id} (charla con ${telefono}): ${mensajeDeError(error)}`);
    }
  }

  // Lo llama el canal cuando el bot no contestó porque la charla está derivada.
  async function reenviar(empresa, m, texto) {
    if (!duenaDe(empresa) || !texto) return;
    const caso = [...casos.values()].find((c) => c.empresa.id === empresa.id && c.telefono === m.de);
    if (!caso) return;
    const clave = `${empresa.id}:${caso.codigo}`;
    try {
      recordar(clave, await mandarALaDuena(empresa, `💬 #${caso.codigo} ${caso.nombre || "Cliente"}: ${texto}`, [caso.nombre || `+${caso.telefono}`, texto, caso.codigo]));
    } catch (error) {
      console.error(`[derivaciones] No pude pasarle a la dueña el mensaje de ${m.de}: ${mensajeDeError(error)}`);
    }
  }

  function abiertas(empresa) {
    return [...casos.values()].filter((c) => c.empresa.id === empresa.id);
  }

  function ayuda(empresa) {
    const lista = abiertas(empresa);
    if (lista.length === 0) {
      return "No hay charlas derivadas abiertas 👌 El bot está atendiendo solo. Cuando alguien te necesite, te aviso por acá.";
    }
    return [
      "Charlas que te esperan:",
      ...lista.map((c) => `- *#${c.codigo}* ${c.nombre || `+${c.telefono}`}: ${c.motivo}`),
      "",
      "Para contestar: *#código tu mensaje* (o deslizá el aviso y respondé). Para terminar: *#código listo*.",
    ].join("\n");
  }

  // Para el canal de WhatsApp: true si el mensaje era de la dueña (y ya se atendió).
  async function atender(empresa, m, responder) {
    const duena = duenaDe(empresa);
    if (!duena || !mismoNumero(m.de, duena)) return false;
    const texto = (m.texto ?? "").trim();

    let clave = m.respondeA ? porMensaje.get(m.respondeA) : null;
    let mensaje = texto;
    const conCodigo = texto.match(/^#\s*(\d{4,15})\s*([\s\S]*)$/);
    if (conCodigo) {
      clave = `${empresa.id}:${conCodigo[1]}`;
      mensaje = conCodigo[2].trim();
    }
    if (!clave) {
      await responder(ayuda(empresa));
      return true;
    }

    let caso = casos.get(clave);
    // Después de un reinicio no hay charlas en memoria: con el número completo igual se puede.
    if (!caso && conCodigo && conCodigo[1].length >= 10) {
      const telefono = conCodigo[1];
      caso = { empresa, telefono, nombre: "", motivo: "", hiloId: `${empresa.id}:${telefono}`, codigo: telefono };
      casos.set(clave, caso);
    }
    if (!caso) {
      await responder(`No encuentro la charla #${clave.split(":").pop()} (puede que el bot se haya reiniciado). Escribí el número completo del cliente: *#5492971234567 tu mensaje*.\n\n${ayuda(empresa)}`);
      return true;
    }
    if (!mensaje) {
      await responder(`¿Qué le digo a ${caso.nombre || "ese cliente"}? Escribí *#${caso.codigo} tu mensaje*.`);
      return true;
    }
    if (PALABRAS_DE_CIERRE.test(mensaje)) {
      casos.delete(clave);
      pausas.reanudar(caso.hiloId);
      await responder(`Listo ✅ El bot vuelve a atender a ${caso.nombre || `+${caso.telefono}`}.`);
      return true;
    }
    try {
      await enviarTexto({ empresa, para: caso.telefono, texto: mensaje });
      // Mientras la dueña está hablando, el bot sigue callado en esa charla.
      pausas.pausar(caso.hiloId, empresa.derivacion.pausaMinutos);
      await responder(`✅ Enviado a ${caso.nombre || `+${caso.telefono}`}.`);
    } catch (error) {
      console.error(`[derivaciones] No pude mandarle el mensaje a ${caso.telefono}: ${mensajeDeError(error)}`);
      await responder("❌ No se pudo enviar. Si pasaron más de 24 h desde el último mensaje del cliente, WhatsApp no deja escribirle hasta que vuelva a escribir.");
    }
    return true;
  }

  return { avisar, reenviar, atender, abiertas };
}
