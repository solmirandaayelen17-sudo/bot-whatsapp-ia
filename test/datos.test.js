// Pruebas de la parte de datos: CSV, precios, búsqueda y validación de pedidos.
// Correr con: npm test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsearCsv, filasAObjetos, aLineaCsv } from "../src/datos/csv.js";
import { parsearNumero, normalizarProducto, buscarEnCatalogo, validarPedido, formatearPesos } from "../src/datos/productos.js";
import { crearFuenteLocal } from "../src/datos/fuenteLocal.js";
import { RAIZ } from "../src/config/empresas.js";

test("el CSV respeta comas y comillas dentro de un campo", () => {
  const filas = parsearCsv('a,b\n"hola, que tal","dijo ""si"""\n');
  assert.deepEqual(filas, [["a", "b"], ["hola, que tal", 'dijo "si"']]);
  assert.equal(aLineaCsv(["x,y", 'z"w', "ok"]), '"x,y","z""w",ok');
});

test("los precios en formato argentino se convierten bien", () => {
  assert.equal(parsearNumero("$ 95.000"), 95000);
  assert.equal(parsearNumero("89.000,50"), 89000.5);
  assert.equal(parsearNumero("1500"), 1500);
  // Planillas configuradas en formato de Estados Unidos
  assert.equal(parsearNumero("$95,000"), 95000);
  assert.equal(parsearNumero("1,234.50"), 1234.5);
  assert.equal(parsearNumero("12,5"), 12.5);
  assert.equal(parsearNumero(95000), 95000);
  assert.ok(Number.isNaN(parsearNumero("")));
  assert.equal(formatearPesos(95000), "$95.000");
});

test("una fila sin nombre se ignora y el stock vacío queda sin control", () => {
  assert.equal(normalizarProducto({ nombre: "" }), null);
  const p = normalizarProducto({ codigo: "ALI", nombre: "Alineación", precio: "$ 22.000", stock: "" });
  assert.equal(p.precio, 22000);
  assert.equal(p.stock, null);
});

const catalogo = () =>
  filasAObjetos(parsearCsv(fs.readFileSync(path.join(RAIZ, "datos/gomeria-demo/productos.csv"), "utf8")))
    .map(normalizarProducto)
    .filter(Boolean);

test("el catálogo de ejemplo se lee completo", () => {
  const productos = catalogo();
  assert.equal(productos.length, 8);
  assert.equal(productos[0].descripcion, "Para autos chicos (Gol Trend, Corsa, Fiesta). Marca de ejemplo.");
});

test("la búsqueda encuentra por medida y sin importar tildes", () => {
  const productos = catalogo();
  assert.equal(buscarEnCatalogo(productos, "¿tienen cubiertas 175/65?")[0].codigo, "CUB-17565R14");
  assert.equal(buscarEnCatalogo(productos, "alineacion")[0].codigo, "ALI");
  assert.equal(buscarEnCatalogo(productos, "Hilux")[0].codigo, "CUB-26570R16");
  assert.deepEqual(buscarEnCatalogo(productos, "helado de chocolate"), []);
});

test("un pedido sin stock o con código inventado no pasa la validación", () => {
  const productos = catalogo();
  const sinStock = validarPedido(productos, [{ codigo: "CUB-19555R16", cantidad: 1 }]);
  assert.equal(sinStock.ok, false);
  const inventado = validarPedido(productos, [{ codigo: "NO-EXISTE", cantidad: 1 }]);
  assert.equal(inventado.ok, false);
  const mucho = validarPedido(productos, [{ codigo: "CUB-17565R14", cantidad: 5 }]);
  assert.match(mucho.errores[0], /Solo hay 4/);
});

test("un pedido válido calcula el total (los servicios no controlan stock)", () => {
  const v = validarPedido(catalogo(), [
    { codigo: "cub-17565r14", cantidad: 4 },
    { codigo: "COL-BAL", cantidad: 4 },
  ]);
  assert.equal(v.ok, true);
  assert.equal(v.total, 4 * 95000 + 4 * 9000);
});

test("la fecha de los pedidos sale en formato de 24 horas y hora argentina", async () => {
  const { fechaArgentina } = await import("../src/agente/herramientas.js");
  // 17:58 UTC = 14:58 en Argentina: tiene que decir 14:58, no 02:58
  assert.equal(fechaArgentina(new Date("2026-09-29T17:58:00Z")), "29/09/2026, 14:58");
});

test("la fuente local escribe pedidos con encabezados en una planilla nueva", async () => {
  const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "bot-"));
  fs.copyFileSync(path.join(RAIZ, "datos/gomeria-demo/productos.csv"), path.join(carpeta, "productos.csv"));
  const fuente = crearFuenteLocal(carpeta);
  await fuente.agregarRegistro("Pedidos", { id: "P-1", cliente: "Ana, la del taller", total: 1000 });
  await fuente.agregarRegistro("Pedidos", { id: "P-2", cliente: "Beto", total: 2000 });
  const filas = filasAObjetos(parsearCsv(fs.readFileSync(path.join(carpeta, "pedidos.csv"), "utf8")));
  assert.equal(filas.length, 2);
  assert.equal(filas[0].cliente, "Ana, la del taller");
  assert.equal(filas[1].total, "2000");
});
