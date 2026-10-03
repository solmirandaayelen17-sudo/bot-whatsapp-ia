// Fuente de SOLO LECTURA: lee la planilla de verdad, pero no escribe nada.
//
// POR QUÉ: en la demo pública cualquiera puede "hacer un pedido". Así ve los
// precios y el stock reales, pero los pedidos y derivaciones de prueba no
// llenan la planilla del negocio.

export function soloLectura(fuente) {
  return {
    ...fuente,
    descripcion: `${fuente.descripcion} (solo lectura: los pedidos de prueba no se anotan)`,
    listarProductos: () => fuente.listarProductos(),
    listarRegistros: (hoja) => fuente.listarRegistros?.(hoja) ?? [],
    async agregarRegistro(hoja) {
      console.log(`[demo pública] Un registro de prueba en "${hoja}" no se guardó en la planilla.`);
    },
  };
}
