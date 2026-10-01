// Todo lo relacionado a "entender" la planilla de productos.
//
// POR QUÉ: los dueños escriben los precios como quieren ("$ 89.000", "89000",
// "89.000,50"). Acá lo pasamos a números reales una sola vez, así el resto del
// sistema (y la IA) trabaja con datos limpios y no inventa cuentas.

// Qué columnas tiene cada pestaña donde el bot ESCRIBE. Fijas a propósito:
// si el orden cambiara en cada empresa, los pedidos quedarían desordenados.
export const ENCABEZADOS = {
  // "pago" (al final, para no mover las columnas que ya existen): el link de Mercado Pago.
  Pedidos: ["id", "fecha", "telefono", "cliente", "detalle", "total", "modalidad", "notas", "estado", "pago"],
  Derivaciones: ["fecha", "telefono", "cliente", "motivo", "estado"],
};

// Entiende los precios escritos a la argentina ("89.000,50") y a la
// estadounidense ("89,000.50"), porque una planilla de Google puede estar
// configurada en cualquiera de los dos formatos.
export function parsearNumero(valor) {
  if (typeof valor === "number") return valor;
  const s = String(valor ?? "").replace(/[$\s]/g, "").replace(/ARS/i, "");
  if (s === "") return NaN;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", ".")); // 89.000,50
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, "")); // 89,000.50
  if (/^-?\d+,\d+$/.test(s)) return Number(s.replace(",", ".")); // 12,5
  return Number(s);
}

export function normalizarProducto(fila) {
  const nombre = fila.nombre?.trim();
  if (!nombre) return null; // fila vacía o incompleta: se ignora
  const precio = parsearNumero(fila.precio);
  const stock = parsearNumero(fila.stock);
  return {
    codigo: (fila.codigo || nombre).trim(),
    nombre,
    categoria: fila.categoria?.trim() ?? "",
    precio: Number.isFinite(precio) ? precio : null,
    stock: Number.isFinite(stock) ? Math.max(0, Math.floor(stock)) : null,
    descripcion: fila.descripcion?.trim() ?? "",
  };
}

export function formatearPesos(n) {
  if (n === null || !Number.isFinite(n)) return "consultar";
  return "$" + n.toLocaleString("es-AR", { maximumFractionDigits: 2 });
}

// Saca tildes y mayúsculas para que "neumático" encuentre "NEUMATICO".
export function normalizarTexto(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const PALABRAS_VACIAS = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "que", "con", "para", "por",
  "tienen", "tenes", "hay", "precio", "precios", "cuanto", "sale", "salen", "cuesta", "busco", "quiero",
  "y", "o", "en", "me", "mi", "tu", "su", "al", "es", "son",
]);

// Búsqueda simple por palabras: suma puntos por cada palabra de la consulta que
// aparece en el producto (el nombre vale doble). No usa IA a propósito: es
// rápida, gratis y predecible. La IA decide QUÉ buscar; la búsqueda es exacta.
export function buscarEnCatalogo(productos, consulta, limite = 5) {
  const palabras = normalizarTexto(consulta)
    .split(/[\s,;]+/)
    .map((p) => p.replace(/^[¿?¡!."']+|[¿?¡!."']+$/g, ""))
    .filter((p) => p.length > 1 && !PALABRAS_VACIAS.has(p));

  if (palabras.length === 0) return productos.slice(0, limite);

  return productos
    .map((p) => {
      const enNombre = normalizarTexto(`${p.codigo} ${p.nombre}`);
      const enResto = normalizarTexto(`${p.categoria} ${p.descripcion}`);
      let puntos = 0;
      for (const palabra of palabras) {
        if (enNombre.includes(palabra)) puntos += 2;
        else if (enResto.includes(palabra)) puntos += 1;
      }
      return { p, puntos };
    })
    .filter((x) => x.puntos > 0)
    .sort((a, b) => b.puntos - a.puntos)
    .slice(0, limite)
    .map((x) => x.p);
}

// Revisa un pedido contra el catálogo real ANTES de anotarlo: que el producto
// exista y que haya stock. Así la IA no puede registrar algo imposible.
export function validarPedido(productos, items) {
  const errores = [];
  const lineas = [];
  for (const item of items) {
    const buscado = normalizarTexto(item.codigo);
    const producto = productos.find((p) => normalizarTexto(p.codigo) === buscado);
    if (!producto) {
      errores.push(`No existe un producto con código "${item.codigo}".`);
      continue;
    }
    if (producto.precio === null) {
      errores.push(`"${producto.nombre}" no tiene precio cargado.`);
      continue;
    }
    if (producto.stock !== null && item.cantidad > producto.stock) {
      errores.push(`Solo hay ${producto.stock} de "${producto.nombre}" (pidieron ${item.cantidad}).`);
      continue;
    }
    lineas.push({ producto, cantidad: item.cantidad, subtotal: producto.precio * item.cantidad });
  }
  const total = lineas.reduce((s, l) => s + l.subtotal, 0);
  return { ok: errores.length === 0, errores, lineas, total };
}
