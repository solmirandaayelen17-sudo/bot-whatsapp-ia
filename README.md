# Bot de WhatsApp con IA para negocios

Un asistente que atiende el WhatsApp de **varios negocios a la vez**. Contesta con los precios y el stock reales de la planilla de cada uno, toma pedidos y le pasa la charla a una persona cuando hace falta.

![Node.js](https://img.shields.io/badge/Node.js-20%2B-5FA04E?logo=nodedotjs&logoColor=white)
![LangChain](https://img.shields.io/badge/LangChain-LangGraph-1C3C3C?logo=langchain&logoColor=white)
![Gemini](https://img.shields.io/badge/IA-Gemini-8E75B2?logo=googlegemini&logoColor=white)
![Google Sheets](https://img.shields.io/badge/Datos-Google%20Sheets-34A853?logo=googlesheets&logoColor=white)
![WhatsApp](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=white)
![Pruebas](https://img.shields.io/badge/pruebas-26%20OK-brightgreen)

## Demo

![Chat de prueba: el cliente pregunta cuánto sale la cubierta para su auto y el bot responde con la medida, el precio y el stock de la planilla](docs/demo-consulta.png)

El cliente pregunta por **su auto**, no por la medida, y el bot encuentra la cubierta en la planilla. A mitad de la charla cambié el precio en Google Sheets (de $95.000 a $99.000) y el bot ya respondió con el precio nuevo.

![Chat de prueba: el bot cotiza 2 cubiertas y anota el pedido recién cuando el cliente confirma](docs/demo-pedido.png)

El pedido se hace en dos pasos: primero el bot muestra el total y, **recién cuando el cliente confirma en otro mensaje**, lo anota como una fila nueva en la planilla, con su código de pedido.

> Las capturas son del chat de prueba en la terminal, que usa el mismo "cerebro" que la versión de WhatsApp. Los asteriscos son la negrita de WhatsApp. La gomería y sus productos son de ejemplo.

## Lo más importante

- **Agente de IA con herramientas.** No es un menú de "marcá 1, 2 o 3": entiende lenguaje natural y *hace cosas*, como buscar productos, cotizar, anotar pedidos o derivar a una persona.
- **La IA decide, el código valida.** El código controla que el producto exista y que haya stock, y calcula el total. La IA no puede inventar precios, vender lo que no hay ni anotar un pedido sin que el cliente confirme.
- **Multi-empresa.** Sumar un negocio es agregar un archivo JSON y una planilla, sin tocar el código.
- **El dueño maneja todo desde una planilla.** Cambia un precio en Google Sheets desde el celular y el bot lo usa al instante.
- **Seguridad desde el principio.** Verifica la firma de cada aviso de WhatsApp, guarda las claves fuera del código y no deja que un cliente meta fórmulas en la planilla.
- **Tolerante a fallas.** Si Gemini está saturado, responde un modelo de respaldo. Si todo falla, el cliente recibe un mensaje amable y `npm run diagnostico` dice qué pasó.
- **26 pruebas automáticas** con una IA simulada, así no se gasta cuota.

## Tecnologías

| Parte | Tecnología |
|---|---|
| Lenguaje | JavaScript con Node.js |
| Agente de IA | LangChain v1 (`createAgent`, sobre LangGraph) |
| Modelo | Google Gemini, con modelo de respaldo |
| Datos del negocio | Google Sheets API (o archivos CSV para probar) |
| WhatsApp | WhatsApp Cloud API oficial de Meta, con webhook en Express |
| Validación de datos | Zod |
| Pruebas | `node:test` |

## Estado

- **Funciona de punta a punta** en el chat de prueba, leyendo y escribiendo en Google Sheets.
- **En curso:** la conexión al número de prueba de WhatsApp. El código del webhook ya está hecho y tiene pruebas.
- Lo que sigue está más abajo, en *Qué NO hace todavía*.

## Autora

**Sol Ayelen Miranda**, estudiante de Ingeniería en Inteligencia Artificial en la Universidad de Palermo (Argentina).

<details>
<summary><b>English summary</b></summary>

A multi-tenant WhatsApp AI assistant for small businesses. A LangChain agent (built on LangGraph) running on Google Gemini answers customers using each business's live Google Sheet (prices, stock), takes orders through a two-step quote → confirm flow that is enforced in code, and hands the conversation off to a human when needed. Adding a new business takes one JSON config file and one spreadsheet, with no code changes.

Stack: Node.js, LangChain v1, Google Gemini (with fallback model), Google Sheets API, WhatsApp Cloud API (signed webhooks), Express, Zod and `node:test` (26 tests using a fake LLM). The rest of the documentation is in Spanish.
</details>

---

## Cómo funciona

```mermaid
flowchart LR
    C[Cliente en WhatsApp] --> M[Meta<br/>Cloud API]
    M -->|webhook| W[canales/whatsapp.js<br/>verifica firma y<br/>detecta la empresa]
    T[canales/consola.js<br/>chat de prueba] --> P
    W --> P[nucleo/procesador.js<br/>cola, pausas y memoria]
    P --> A[agente<br/>LangGraph + Gemini]
    A <--> H[herramientas<br/>buscar, pedir, derivar]
    H <--> D[(Planilla del negocio<br/>Google Sheets o CSV)]
    A --> P --> W --> M --> C
```

1. Un cliente escribe al WhatsApp del negocio.
2. Meta le avisa a nuestro servidor (eso es el **webhook**).
3. Verificamos que el aviso venga de verdad de Meta y buscamos **de qué empresa** es el número.
4. El **agente** lee el mensaje y decide: ¿respondo directo o necesito una herramienta? Por ejemplo, si le preguntan por una cubierta, usa `buscar_productos`, que lee la planilla.
5. Con el resultado arma la respuesta y la mandamos por la API de Meta.

---

## Por qué está armado así

Cada decisión resuelve un problema concreto.

**1. Un código, muchas empresas.** Lo que cambia de un negocio a otro (nombre, horarios, tono, planilla, número de WhatsApp, herramientas activas) vive en `empresas/<id>.json`. Sumar un cliente te lleva minutos, y cuando arreglás un error o agregás una función, lo tienen todos.

**2. El cerebro no sabe de WhatsApp.** El procesador recibe `{ empresa, teléfono, texto }` y devuelve una respuesta. WhatsApp y la consola son "canales" que traducen su formato. El día de mañana sumás Instagram o un chat web sin tocar el cerebro.

**3. Un agente con herramientas, no un menú de botones.** Un bot de "marcá 1, 2 o 3" se pierde cuando el cliente escribe distinto. El agente entiende lenguaje natural y **hace cosas**: consulta stock, anota pedidos, deriva. Es justo lo que el agente gratis de Meta no puede hacer, porque no está conectado a los datos del negocio.

**4. La IA decide, el código valida.** La IA nunca toca la planilla directamente. Pide usar una herramienta y la herramienta, que es código nuestro, controla que el producto exista, que haya stock y calcula el total. Si la IA intenta anotar algo imposible, el pedido no se registra. Así no puede inventar precios ni vender lo que no hay.

Lo mismo con la confirmación: un pedido se toma en dos pasos, `cotizar_pedido` (el cliente ve el detalle y el total) y `confirmar_pedido`. El código solo deja confirmar en un mensaje **posterior** del cliente. Si la IA se apura e intenta anotarlo en el mismo mensaje en que cotizó, se lo rechaza. No depende de que la IA "haga caso".

**5. Una planilla como base de datos.** El dueño actualiza precios y stock desde el celular sin saber programar, y el bot lo ve al instante. Los pedidos y derivaciones aparecen como filas nuevas.

**6. Memoria por conversación.** Cada charla tiene su propio hilo: `empresa:teléfono`. El bot recuerda lo que se habló con esa persona, pero nunca mezcla clientes ni empresas, aunque la misma persona sea cliente de dos negocios tuyos.

**7. Una cola por conversación.** En WhatsApp la gente manda tres mensajes seguidos. Se procesan de a uno y en orden, para que las respuestas no se pisen. Mientras tanto, las distintas conversaciones siguen en paralelo.

**8. Derivación a una persona.** Cuando hay un reclamo o algo que el bot no puede resolver, anota la derivación en la planilla y **se queda callado en esa charla** por un rato (configurable). Con la coexistencia de WhatsApp, el dueño contesta desde su celular sin que el bot se meta.

**9. Seguridad desde el principio:**
- Se verifica la **firma** de cada aviso de Meta, así nadie puede mandarle mensajes falsos al servidor.
- Las claves van en `.env`, que **nunca** se sube a GitHub.
- Lo que escribe el cliente se guarda en la planilla como texto (`RAW`), no como fórmula. Así, si alguien escribe `=IMPORTXML(...)`, no se ejecuta.
- El bot no pide datos sensibles (tarjetas, DNI, claves).

**10. Cumple las reglas de WhatsApp.** Desde 2026 Meta prohíbe en la API los bots "de uso general", tipo ChatGPT. Por eso las instrucciones le dicen que hable **solo del negocio** y que, si le preguntan si es una persona, diga la verdad.

**11. Freno de costos.** Como máximo hay 5 llamadas a la IA por mensaje del cliente. Si algo entra en loop, se corta ahí y no te consume la cuota.

**12. Pruebas con IA simulada.** Las pruebas usan una IA "de mentira" que sigue un guion. Así se verifican las herramientas, la memoria, las pausas y la separación entre empresas sin gastar cuota y con resultados siempre iguales.

---

## Estructura

```
bot-whatsapp-ia/
├── empresas/                  ← un .json por cliente (acá se "adapta" a cada negocio)
│   └── gomeria-demo.json
├── datos/                     ← planillas locales (CSV) para probar sin Google
│   └── gomeria-demo/productos.csv
├── docs/                      ← capturas de la demo
├── src/
│   ├── config/empresas.js     ← lee y valida la configuración de cada empresa
│   ├── datos/                 ← de dónde salen los datos (CSV local o Google Sheets)
│   ├── agente/
│   │   ├── prompt.js          ← las instrucciones y reglas de la IA
│   │   ├── herramientas.js    ← lo que el bot puede HACER
│   │   ├── modelo.js          ← Gemini (cambiar de IA = cambiar este archivo)
│   │   └── crearAgente.js     ← junta todo con LangGraph
│   ├── nucleo/                ← procesador, colas y pausas
│   ├── canales/
│   │   ├── consola.js         ← chat de prueba en la terminal
│   │   └── whatsapp.js        ← webhook y envío por la API oficial
│   ├── servidor.js            ← servidor para WhatsApp
│   └── diagnostico.js         ← prueba Gemini y las planillas y dice qué falla
└── test/                      ← pruebas automáticas (npm test)
```

---

## Puesta en marcha

Necesitás **Node.js 20 o más nuevo** (con `node -v` ves la versión) y **Git**.

### Paso 1: chatear con el bot en la terminal (10 minutos, gratis)

1. Descargá el proyecto, entrá a la carpeta e instalá las dependencias:
   ```bash
   git clone https://github.com/solmirandaayelen17-sudo/bot-whatsapp-ia.git
   cd bot-whatsapp-ia
   npm install
   ```
2. Copiá el archivo de ejemplo de variables:
   ```bash
   cp .env.example .env
   ```
3. Sacá una clave gratis de Gemini en <https://aistudio.google.com/apikey> y pegala en `.env`, en `GOOGLE_API_KEY=`.
4. Corré las pruebas para verificar que todo está bien:
   ```bash
   npm test
   ```
5. El ejemplo viene conectado a mi planilla de Google, que no es pública. Para probar sin Google, abrí `empresas/gomeria-demo.json` y cambiá la parte de `datos` por esta, que usa el CSV de ejemplo:
   ```json
   "datos": { "tipo": "local", "carpeta": "datos/gomeria-demo" }
   ```
6. Chateá con la gomería de ejemplo:
   ```bash
   npm run consola -- gomeria-demo
   ```
   Probá cosas como: *"tienen cubiertas para un Gol Trend?"*, *"quiero 4 con colocación, retiro mañana"*, *"quiero hacer un reclamo"* o *"haceme la tarea de matemática"* (tiene que decirte que no).
   Los pedidos quedan en `datos/gomeria-demo/pedidos.csv`.

> **Si el bot contesta "tuve un problema técnico"**, corré `npm run diagnostico`. Prueba la clave, el modelo y las herramientas por separado y te dice qué falla y qué hacer.
>
> Si Gemini está saturado (error 503), configurá `GEMINI_MODEL_RESPALDO` en el `.env`: cuando el modelo principal falla, el bot usa el de respaldo sin que el cliente se entere. La lista de modelos está en <https://ai.google.dev/gemini-api/docs/models>.

### Paso 2: conectar una planilla de Google (20 minutos, gratis)

1. En <https://console.cloud.google.com> creá un proyecto y **habilitá la Google Sheets API**.
2. Andá a **IAM y administración → Cuentas de servicio → Crear cuenta de servicio**. Después, en **Claves → Agregar clave → JSON**, bajá el archivo.
3. Guardalo en `credenciales/cuenta-servicio.json` dentro del proyecto. Esa carpeta no se sube a GitHub.
4. Creá una planilla con tres pestañas y estos encabezados en la fila 1:
   - **Productos**: `codigo, nombre, categoria, precio, stock, descripcion` (podés importar `datos/gomeria-demo/productos.csv`)
   - **Pedidos**: `id, fecha, telefono, cliente, detalle, total, modalidad, notas, estado`
   - **Derivaciones**: `fecha, telefono, cliente, motivo, estado`
5. **Compartí la planilla** con el mail de la cuenta de servicio (termina en `iam.gserviceaccount.com`) como **Editor**.
6. Copiá el ID de la planilla, que es lo que está entre `/d/` y `/edit` en la dirección. En `empresas/gomeria-demo.json` cambiá la parte de datos por esto:
   ```json
   "datos": { "tipo": "google-sheets", "spreadsheetId": "EL_ID_DE_TU_PLANILLA" }
   ```
7. Volvé a correr `npm run consola -- gomeria-demo`. Cambiá un precio en la planilla y, al minuto, el bot ya lo sabe.

> Un stock vacío significa "no se controla stock", que sirve para servicios como la alineación. Un stock en 0 significa que no hay.

### Paso 3: conectarlo a WhatsApp con el número de prueba de Meta (30 minutos, gratis)

1. En <https://developers.facebook.com> creá una app y agregale el producto/caso de uso **WhatsApp**. Meta te da un **número de prueba gratis**.
2. En **WhatsApp → Configuración de la API** vas a encontrar:
   - el **Phone number ID**: copialo en `empresas/gomeria-demo.json`, en `whatsapp.phoneNumberId`;
   - un **token de acceso temporal**: va en `WHATSAPP_TOKEN` del `.env` y dura 24 horas;
   - la lista de **destinatarios de prueba**: agregá tu celular **sin el 9** (+54 297 …). Con el 9, Meta no te deja responder en modo de prueba. El código ya lo resuelve del lado del envío.
3. En **Configuración de la app → Básica**, copiá la **Clave secreta de la app** en `WHATSAPP_APP_SECRET`.
4. Inventá una palabra secreta y ponela en `WHATSAPP_VERIFY_TOKEN`.
5. Levantá el servidor:
   ```bash
   npm run servidor
   ```
6. En otra terminal, abrí un túnel para que Meta llegue a tu compu. Instalá [cloudflared](https://github.com/cloudflare/cloudflared/releases) y corré:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
   Te va a dar una dirección tipo `https://algo.trycloudflare.com`, que cambia cada vez que lo corrés.
7. En Meta, en **WhatsApp → Configuración → Webhook**:
   - URL de devolución de llamada: `https://algo.trycloudflare.com/webhook`
   - Token de verificación: la palabra del paso 4
   - Suscribite al campo **messages**
8. Escribile desde tu celular al número de prueba. El bot te contesta.

> El token temporal vence a las 24 horas. Para algo estable, se crea un **usuario del sistema** con token permanente en el administrador comercial de Meta. Eso se configura al pasar a un cliente real.

---

## Cómo adaptarlo a una empresa nueva

1. Copiá `empresas/gomeria-demo.json` a `empresas/<id-del-cliente>.json`.
2. Cambiá `id` (en minúsculas y sin espacios), `nombre`, `rubro`, `tono` y todo lo de `negocio` (horarios, dirección, formas de pago, preguntas frecuentes).
3. Armá su planilla (paso 2) y poné su `spreadsheetId`.
4. Poné su `whatsapp.phoneNumberId` y en `tokenEnv` el **nombre** de la variable del `.env` con su token. Por ejemplo: `"tokenEnv": "WHATSAPP_TOKEN_TALLER_JUAN"`. El token en sí va en el `.env`, nunca en el JSON.
5. Elegí qué herramientas tiene según el paquete que contrató:

   | Paquete | `herramientas` |
   |---|---|
   | Atención 24/7 | `["buscar_productos", "derivar_a_humano"]` |
   | Vende y agenda / Todo conectado | `["buscar_productos", "tomar_pedidos", "derivar_a_humano"]` + las que se sumen (turnos, cobros) |

6. Probalo con `npm run consola -- <id-del-cliente>` antes de conectarlo a su WhatsApp.

Si falta algún dato obligatorio en el JSON, el programa no arranca y te dice exactamente qué falta.

---

## Qué NO hace todavía (y en qué orden sumarlo)

| Próximo paso | Por qué |
|---|---|
| **Memoria en base de datos** (SQLite o Postgres) | Hoy la memoria y las pausas viven en la RAM: si reiniciás, el bot se olvida de las charlas. |
| **Recortar el historial largo** | Las conversaciones muy largas gastan más cuota de IA. |
| **Audios** (Whisper) | Acá casi todos mandan audios. Hoy el bot pide que le escriban. |
| **Turnos** (Google Calendar) | Es el paquete "Vende y agenda". |
| **Reactivar el bot cuando el dueño responde** | Con la coexistencia, Meta avisa cuando el dueño escribe desde su celular. Se puede usar para pausar o reanudar solo. |
| **Cobros** (Mercado Pago) | Es el paquete "Todo conectado". |
| **Servidor en la nube** | Hoy corre en una compu: si se apaga, el bot se apaga. |
| **Alta de clientes con Embedded Signup** | Registrándose como Tech Provider, cada negocio conecta su número con un botón. |

---

## Costos

- **Probar:** $0. Se usa Gemini gratis con datos inventados, el número de prueba de Meta y una compu común.
- **Con clientes reales:**
  - Gemini pago, que es barato y no usa los datos de tus clientes para entrenar.
  - Un servidor.
  - Los mensajes de WhatsApp, que paga cada negocio directo a Meta: las primeras 1.000 respuestas por mes son gratis y después se cobra por mensaje.

---

## Comandos

| Comando | Qué hace |
|---|---|
| `npm install` | Instala las dependencias |
| `npm test` | Corre las pruebas automáticas |
| `npm run diagnostico` | Prueba Gemini y las planillas paso a paso y dice qué falla |
| `npm run consola -- <id>` | Chat de prueba en la terminal (`/nuevo`, `/reanudar`, `/salir`) |
| `npm run servidor` | Levanta el servidor para WhatsApp |
