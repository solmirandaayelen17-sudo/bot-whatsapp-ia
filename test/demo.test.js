// Pruebas de la demo web: la página habla con el bot a través del simulador.

import test from "node:test";
import assert from "node:assert/strict";
import { crearSimulador } from "../src/canales/simuladorWhatsApp.js";
import { crearAppDemo } from "../src/canales/demoWeb.js";

const empresa = { id: "demo", nombre: "Gomería Test", rubro: "gomería", whatsapp: { phoneNumberId: "PNID" } };

async function levantar(procesar, transcribir = null) {
  const sim = await crearSimulador({ empresa, procesar, transcribir });
  const reanudados = [];
  const app = crearAppDemo({ empresa, sim, reanudar: (t) => reanudados.push(t) });
  const servidor = await new Promise((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const post = (ruta, cuerpo) =>
    fetch(base + ruta, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo ?? {}) });
  const cerrar = async () => {
    await new Promise((ok) => {
      servidor.close(ok);
      servidor.closeAllConnections();
    });
    await sim.cerrar();
  };
  return { base, post, cerrar, reanudados };
}

test("la página carga y el chat responde pasando por el webhook", async () => {
  const d = await levantar(async ({ texto }) => `*Sí*, tenemos ${texto}`);
  try {
    const pagina = await fetch(d.base + "/");
    assert.equal(pagina.status, 200);
    assert.match(await pagina.text(), /Siren IA/);
    const info = await (await fetch(d.base + "/api/info")).json();
    assert.equal(info.nombre, "Gomería Test");
    const r = await (await d.post("/api/mensaje", { texto: "cubiertas" })).json();
    assert.deepEqual(r, { tipo: "respuesta", texto: "*Sí*, tenemos cubiertas" });
  } finally {
    await d.cerrar();
  }
});

test("dos mensajes juntos se contestan en orden y sin mezclarse", async () => {
  const d = await levantar(async ({ texto }) => {
    await new Promise((ok) => setTimeout(ok, texto === "uno" ? 80 : 5));
    return `respuesta a ${texto}`;
  });
  try {
    const [a, b] = await Promise.all([d.post("/api/mensaje", { texto: "uno" }), d.post("/api/mensaje", { texto: "dos" })]);
    assert.equal((await a.json()).texto, "respuesta a uno");
    assert.equal((await b.json()).texto, "respuesta a dos");
  } finally {
    await d.cerrar();
  }
});

test("mensaje vacío se rechaza; nuevo cliente y reactivar funcionan", async () => {
  const d = await levantar(async () => null);
  try {
    assert.equal((await d.post("/api/mensaje", { texto: "  " })).status, 400);
    assert.equal((await d.post("/api/mensaje", { texto: "x".repeat(1001) })).status, 400);
    assert.equal((await (await d.post("/api/mensaje", { texto: "hola" })).json()).tipo, "pausa");
    const { telefono } = await (await d.post("/api/nuevo")).json();
    assert.equal(telefono, "5492974000001");
    await d.post("/api/reanudar");
    assert.deepEqual(d.reanudados, ["5492974000001"]);
  } finally {
    await d.cerrar();
  }
});

test("la nota de voz del micrófono llega al bot y vuelve con lo que entendió", async () => {
  const d = await levantar(
    async ({ texto }) => (texto.includes("sábado") ? "Sí, los sábados abrimos de 9 a 13." : "?"),
    async ({ datos, mimeType }) => {
      assert.equal(datos.toString(), "audio-webm-falso");
      assert.equal(mimeType, "audio/webm;codecs=opus");
      return "¿Abren el sábado?";
    },
  );
  try {
    const r = await fetch(d.base + "/api/audio", {
      method: "POST",
      headers: { "Content-Type": "audio/webm;codecs=opus" },
      body: Buffer.from("audio-webm-falso"),
    });
    assert.deepEqual(await r.json(), {
      tipo: "respuesta",
      texto: "Sí, los sábados abrimos de 9 a 13.",
      transcripcion: "¿Abren el sábado?",
    });
    assert.equal((await fetch(d.base + "/api/audio", { method: "POST", headers: { "Content-Type": "audio/webm" } })).status, 400);
  } finally {
    await d.cerrar();
  }
});
