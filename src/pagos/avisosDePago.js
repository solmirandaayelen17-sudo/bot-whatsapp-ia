// AVISOS DE PAGO de Mercado Pago (webhook).
//
// Cuando un cliente paga, Mercado Pago avisa a
//   https://<tu servidor>/webhooks/mercadopago/<id de la empresa>
// El aviso solo trae el número de pago. Con ese número le preguntamos a Mercado
// Pago cómo está el pago (con el token del negocio): solo si dice "aprobado" se
// anota y se avisa. Así un aviso falso no puede inventar un pago.
//
// - Fichas de autolavado: se anota en Ventas y les llega un WhatsApp al cliente y al encargado.
// - Pedidos y turnos: se anota en Pagos y le llega un WhatsApp al cliente.

import express from "express";
import { consultarPagoMercadoPago, firmaMercadoPagoValida } from "./mercadoPago.js";
import { registrarVentaPagada, registrarPagoDePedido } from "../fichas/sistema.js";
import { mensajeDeError } from "../nucleo/errores.js";

export function crearRouterMercadoPago({
  empresasPorId,
  crearFuente,
  enviarTexto,
  avisos, // crearAvisosDelNegocio(...): para el aviso al encargado
  consultarPago = consultarPagoMercadoPago,
  entorno = process.env,
}) {
  const router = express.Router();
  // POR QUÉ: Mercado Pago avisa varias veces por el mismo pago (creado, actualizado...).
  // Mientras uno se está anotando, los otros esperan su turno y ven que ya está.
  const enCurso = new Map(); // id de pago -> promesa
  const avisados = new Set(); // ventas de fichas ya avisadas (por si la planilla falla)

  router.post("/webhooks/mercadopago/:empresa", express.json({ limit: "100kb" }), (req, res) => {
    const empresa = empresasPorId.get(req.params.empresa);
    if (!empresa) return res.sendStatus(404);
    const tipo = req.query.type ?? req.query.topic ?? req.body?.type;
    const dataId = req.query["data.id"] ?? req.body?.data?.id ?? req.query.id;
    if (tipo !== "payment" || !dataId) return res.sendStatus(200); // otros avisos no nos interesan

    // Si el aviso viene firmado y la firma no coincide, se descarta. (Igual, lo
    // que vale es lo que responde Mercado Pago al consultar el pago.)
    const secreto = entorno[empresa.mercadoPago.webhookSecretEnv]?.trim();
    const firma = req.get("x-signature");
    if (secreto && firma && !firmaMercadoPagoValida({ dataId, requestId: req.get("x-request-id"), firma, secreto })) {
      console.warn(`[pagos] Aviso de Mercado Pago con firma inválida para ${empresa.id}: se descarta.`);
      return res.sendStatus(401);
    }
    res.sendStatus(200); // Mercado Pago espera respuesta rápida; el resto se hace después
    procesar(empresa, String(dataId)).catch((error) => console.error(`[pagos] Error con el pago ${dataId}: ${mensajeDeError(error)}`));
  });

  async function procesar(empresa, idPago) {
    const anterior = enCurso.get(idPago) ?? Promise.resolve();
    const tarea = anterior.catch(() => {}).then(() => anotar(empresa, idPago));
    enCurso.set(idPago, tarea);
    try {
      return await tarea;
    } finally {
      if (enCurso.get(idPago) === tarea) enCurso.delete(idPago);
    }
  }

  async function anotar(empresa, idPago) {
    const pago = await consultarPago({ empresa, id: idPago });
    if (pago.estado !== "approved") return { anotado: false, motivo: pago.estado };
    if (pago.datos?.empresa && pago.datos.empresa !== empresa.id) return { anotado: false, motivo: "otra-empresa" };
    const fuente = crearFuente(empresa);
    if (pago.datos?.tipo === "fichas") {
      const r = await registrarVentaPagada({ empresa, fuente, pago, enviarTexto, avisos, avisados });
      if (!r.repetido) console.log(`[pagos] ${empresa.id}: fichas pagadas ${pago.pedido} (bahía ${r.venta.bahia}).`);
      return { anotado: !r.repetido };
    }
    const r = await registrarPagoDePedido({ empresa, fuente, pago, enviarTexto });
    if (!r.repetido) console.log(`[pagos] ${empresa.id}: pago aprobado del pedido ${pago.pedido}.`);
    return { anotado: !r.repetido };
  }

  router.procesarPago = procesar; // para las pruebas
  return router;
}
