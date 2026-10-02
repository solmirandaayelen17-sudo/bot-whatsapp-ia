// Pruebas de la demo web: la página habla con el bot a través del simulador.
// Cada visitante tiene su sesión (su propia charla) y hay límites opcionales.

import test from "node:test";
import assert from "node:assert/strict";
import { crearSimulador } from "../src/canales/simuladorWhatsApp.js";
import { crearAppDemo } from "../src/canales/demoWeb.js";
import { soloLectura } from "../src/datos/soloLectura.js";
import { opcionesDeAutenticacion } from "../src/datos/fuenteGoogleSheets.js";

const empresa = { id: "demo", nombre: "Gomería Test", rubro: "gomería", whatsapp: { phoneNumberId: "PNID" } };

async function levantar(procesar, { transcribir = null, ...opciones } = {}) {
  const sim = await crearSimulador({ empresa, procesar, transcribir });
  const reanudados = [];
  const app = crearAppDemo({ empresa, sim, reanudar: (t) => reanudados.push(t), ...opciones });
  const servidor = await new Promise((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  // Un "visitante": pide su sesión y la manda en cada mensaje, como la página.
  async function visitante() {
    const { sesion, telefono } = await (await fetch(base + "/api/sesion", { method: "POST" })).json();
    const post = (ruta, cuerpo) =>
      fetch(base + ruta, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Demo-Sesion": sesion },
        body: JSON.stringify(cuerpo ?? {}),
      });
    return { sesion, telefono, post };
  }
  const cerrar = async () => {
    await new Promise((ok) => {
      servidor.close(ok);
      servidor.closeAllConnections();
    });
    await sim.cerrar();
  };
  return { base, visitante, cerrar, reanudados };
}

test("la página carga y el chat responde pasando por el webhook", async () => {
  const d = await levantar(async ({ texto }) => `*Sí*, tenemos ${texto}`);
  try {
    const pagina = await fetch(d.base + "/");
    assert.equal(pagina.status, 200);
    assert.match(await pagina.text(), /Zaivum IA/);
    assert.equal((await fetch(d.base + "/zaivum-marca.png")).headers.get("content-type"), "image/png");
    assert.equal(await (await fetch(d.base + "/salud")).text(), "ok");
    const info = await (await fetch(d.base + "/api/info")).json();
    assert.equal(info.nombre, "Gomería Test");
    assert.equal(info.contacto, "");
    assert.equal(info.publica, false);
    const v = await d.visitante();
    const r = await (await v.post("/api/mensaje", { texto: "cubiertas" })).json();
    assert.deepEqual(r, { tipo: "respuesta", texto: "*Sí*, tenemos cubiertas" });
  } finally {
    await d.cerrar();
  }
});

test("sin sesión no se puede chatear", async () => {
  const d = await levantar(async () => "hola");
  try {
    const r = await fetch(d.base + "/api/mensaje", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"texto":"hola"}' });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).tipo, "sin-sesion");
  } finally {
    await d.cerrar();
  }
});

test("dos mensajes juntos del mismo visitante se contestan en orden", async () => {
  const d = await levantar(async ({ texto }) => {
    await new Promise((ok) => setTimeout(ok, texto === "uno" ? 80 : 5));
    return `respuesta a ${texto}`;
  });
  try {
    const v = await d.visitante();
    const [a, b] = await Promise.all([v.post("/api/mensaje", { texto: "uno" }), v.post("/api/mensaje", { texto: "dos" })]);
    assert.equal((await a.json()).texto, "respuesta a uno");
    assert.equal((await b.json()).texto, "respuesta a dos");
  } finally {
    await d.cerrar();
  }
});

test("dos visitantes a la vez tienen charlas separadas y no esperan uno al otro", async () => {
  const vistos = [];
  const d = await levantar(async ({ telefono, texto }) => {
    vistos.push(telefono);
    await new Promise((ok) => setTimeout(ok, texto === "lento" ? 150 : 5));
    return `${texto} para ${telefono}`;
  });
  try {
    const ana = await d.visitante();
    const beto = await d.visitante();
    assert.notEqual(ana.telefono, beto.telefono);
    const inicio = Date.now();
    const pedidoAna = ana.post("/api/mensaje", { texto: "lento" });
    const rBeto = await (await beto.post("/api/mensaje", { texto: "rápido" })).json();
    assert.ok(Date.now() - inicio < 140, "Beto no tuvo que esperar a Ana");
    const rAna = await (await pedidoAna).json();
    assert.equal(rAna.texto, `lento para ${ana.telefono}`);
    assert.equal(rBeto.texto, `rápido para ${beto.telefono}`);
    assert.deepEqual(new Set(vistos), new Set([ana.telefono, beto.telefono]));
  } finally {
    await d.cerrar();
  }
});

test("mensaje vacío se rechaza; nuevo cliente y reactivar funcionan por visitante", async () => {
  const d = await levantar(async () => null);
  try {
    const v = await d.visitante();
    assert.equal((await v.post("/api/mensaje", { texto: "  " })).status, 400);
    assert.equal((await v.post("/api/mensaje", { texto: "x".repeat(1001) })).status, 400);
    assert.equal((await (await v.post("/api/mensaje", { texto: "hola" })).json()).tipo, "pausa");
    await v.post("/api/reanudar");
    assert.deepEqual(d.reanudados, [v.telefono]);
    const otro = await (await fetch(d.base + "/api/nuevo", { method: "POST" })).json();
    assert.notEqual(otro.telefono, v.telefono);
  } finally {
    await d.cerrar();
  }
});

test("los límites cortan por charla, por minuto y por día, con un aviso claro", async () => {
  const d = await levantar(async () => "ok", { publica: true, limites: { porSesion: 2, porIpPorMinuto: 3, porDia: 5 } });
  try {
    assert.equal((await (await fetch(d.base + "/api/info")).json()).publica, true);
    const a = await d.visitante();
    assert.equal((await a.post("/api/mensaje", { texto: "1" })).status, 200);
    assert.equal((await a.post("/api/mensaje", { texto: "2" })).status, 200);
    const corte = await a.post("/api/mensaje", { texto: "3" });
    assert.equal(corte.status, 429);
    assert.deepEqual(await corte.json(), { tipo: "limite", motivo: "sesion" });

    const b = await d.visitante(); // misma IP: ya mandó 2 en este minuto
    assert.equal((await b.post("/api/mensaje", { texto: "4" })).status, 200);
    const rapido = await b.post("/api/mensaje", { texto: "5" });
    assert.deepEqual(await rapido.json(), { tipo: "limite", motivo: "ip" });
  } finally {
    await d.cerrar();
  }

  const e = await levantar(async () => "ok", { limites: { porIpPorDia: 1 } });
  try {
    const v = await e.visitante();
    assert.equal((await v.post("/api/mensaje", { texto: "1" })).status, 200);
    const otra = await e.visitante(); // abrir otra charla no saltea el límite diario por persona
    assert.deepEqual(await (await otra.post("/api/mensaje", { texto: "2" })).json(), { tipo: "limite", motivo: "dia" });
  } finally {
    await e.cerrar();
  }
});

test("la nota de voz del micrófono llega al bot y vuelve con lo que entendió", async () => {
  const d = await levantar(async ({ texto }) => (texto.includes("sábado") ? "Sí, los sábados abrimos de 9 a 13." : "?"), {
    transcribir: async ({ datos, mimeType }) => {
      assert.equal(datos.toString(), "audio-webm-falso");
      assert.equal(mimeType, "audio/webm;codecs=opus");
      return "¿Abren el sábado?";
    },
  });
  try {
    const v = await d.visitante();
    const r = await fetch(d.base + "/api/audio", {
      method: "POST",
      headers: { "Content-Type": "audio/webm;codecs=opus", "X-Demo-Sesion": v.sesion },
      body: Buffer.from("audio-webm-falso"),
    });
    assert.deepEqual(await r.json(), {
      tipo: "respuesta",
      texto: "Sí, los sábados abrimos de 9 a 13.",
      transcripcion: "¿Abren el sábado?",
    });
    const vacio = await fetch(d.base + "/api/audio", { method: "POST", headers: { "Content-Type": "audio/webm", "X-Demo-Sesion": v.sesion } });
    assert.equal(vacio.status, 400);
  } finally {
    await d.cerrar();
  }
});

test("en la demo pública la planilla se lee pero los pedidos no se escriben", async () => {
  const escritos = [];
  const fuente = soloLectura({
    descripcion: "planilla",
    listarProductos: async () => [{ codigo: "A" }],
    agregarRegistro: async (hoja, r) => escritos.push([hoja, r]),
  });
  const log = console.log;
  console.log = () => {};
  try {
    assert.deepEqual(await fuente.listarProductos(), [{ codigo: "A" }]);
    await fuente.agregarRegistro("Pedidos", { id: "P-1" });
  } finally {
    console.log = log;
  }
  assert.deepEqual(escritos, []);
  assert.match(fuente.descripcion, /solo lectura/);
});

test("la llave de Google se puede pasar como variable (para el servidor)", () => {
  assert.deepEqual(opcionesDeAutenticacion({}), { scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const llave = { client_email: "bot@proyecto.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n" };
  const o = opcionesDeAutenticacion({ GOOGLE_CREDENTIALS_JSON: JSON.stringify(llave) });
  assert.equal(o.credentials.client_email, llave.client_email);
  assert.equal(o.credentials.private_key, llave.private_key);
  assert.throws(() => opcionesDeAutenticacion({ GOOGLE_CREDENTIALS_JSON: "{no es json" }), /no es un JSON válido/);
  assert.throws(() => opcionesDeAutenticacion({ GOOGLE_CREDENTIALS_JSON: '{"a":1}' }), /cuenta de servicio/);
});
