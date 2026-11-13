# Proveedores, autenticación, cuotas y costos

Investigación de código realizada el 13 de octubre de 2026. Este documento describe la referencia y propone contratos para Fluke; no afirma que estas integraciones estén implementadas en Fluke Next.

## Versiones y alcance verificado

- Gentle Shell: commit `bedba1f12b4f5626e05129f7e4bc3693ce9cd829`, paquete `gentle-pi` **4.2.0**. El README guardado habla de 4.1, por lo que no se usó como autoridad de versión. [package.json, líneas 1–5](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/package.json#L1).
- Pi: paquetes `@earendil-works/pi-ai`, `pi-coding-agent` y `pi-tui` **1.2.0**, resolución del lockfile de Gentle. Tag `v1.2.0`, commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`, comprobado mediante GitHub API. Los peers de Gentle admiten versiones posteriores; esta investigación queda fijada a la resolución leída. [pnpm-lock.yaml, líneas 18–26](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/pnpm-lock.yaml#L18), [Pi v1.2.0](https://github.com/earendil-works/pi/tree/06a466935536f8c9bcacb2d5efc0fc021be1bdff).
- Se descargaron archivos públicos a una carpeta temporal separada. No se leyeron credenciales del usuario, no se iniciaron sesiones reales y no se hicieron llamadas pagas. No se instalaron dependencias ni se ejecutaron builds, tests o lints.

## Qué hace Gentle y qué delega a Pi

Gentle es una extensión del runtime Pi. Pi resuelve autenticación, catálogo, adaptadores y streaming; Gentle agrega experiencia de trabajo, perfiles y visualización de cuotas. `ModelRegistry` delega autenticación y streaming al runtime; el método de compatibilidad `getApiKeyForProvider` puede devolver también el access token derivado de OAuth, aunque se llame “API key”. No debe suponerse que el valor sirve para cualquier endpoint. [Pi model-registry.ts, líneas 89–207](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/model-registry.ts#L89).

Un proveedor agregado por Gentle es NaN. `extensions/nan-provider.ts` registra un proveedor nativo y `lib/nan-provider.ts` implementa login secreto, resolución desde credencial guardada o `NAN_API_KEY`, catálogo y adaptador OpenAI completions. El código evita importar un SDK privado por subpath y usa la fábrica pública y diferida de Pi. [Registro](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/nan-provider.ts#L1), [implementación, líneas 177–223](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/nan-provider.ts#L177).

**Recomendación:** reutilizar Pi para el transporte y autenticación. Fluke debe poseer el brief, el plan, las tareas, la asignación, el historial y la política de gasto. Reescribir OAuth y los protocolos de cada proveedor dentro del orquestador multiplicaría el mantenimiento sin mejorar esas funciones.

## Conexiones: rutas diferentes, no un login universal

### OpenAI actual y OpenAI Codex legacy

Pi 1.2.0 registra `openai` con API key o **Sign in with ChatGPT**, sobre `https://api.openai.com/v1`. El login de suscripción usa un cliente público dinámico, PKCE, `state`, callback local y el scope `chatgpt.tokens.use.direct`; el access token se usa directamente con la API Responses. No hay client secret incorporado. La implementación valida el scope otorgado y el client ID devuelto, y renueva tokens. [Proveedor, líneas 9–34](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/providers/openai.ts#L9), [OAuth, líneas 1–31 y 50–188](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/auth/oauth/openai-chatgpt.ts#L1).

Este proveedor filtra los modelos classifier cuando la credencial es OAuth: la propia implementación dice que el grant llega a Responses y no a Decisions. Tener un nombre de modelo en el catálogo no demuestra que la cuenta lo pueda usar. La interfaz debe separar “modelo conocido”, “autenticación configurada” y “solicitud aceptada por el servicio”. [Filtro de modelos](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/providers/openai.ts#L27).

Pi mantiene otro proveedor, `openai-codex`, llamado explícitamente **OpenAI Codex (legacy)** y dirigido a `chatgpt.com/backend-api`. Su login es diferente: cliente fijo, callback localhost:1455 y opción browser/device code. La vista de cuotas Codex de Gentle está conectada a esta ruta. No se verificó compatibilidad de esa consulta de cuotas con el nuevo grant `openai`. [Proveedor legacy](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/providers/openai-codex.ts#L7), [login legacy, líneas 22–34 y 413–430](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/auth/oauth/openai-codex.ts#L22).

### Anthropic

Pi implementa API key, bearer configurado por ambiente, OAuth Claude Pro/Max y alternativas de identidad de servicio. La credencial guardada gana sobre las variables de entorno. El código OAuth tiene autorización, callback/manual y refresh propios; eso prueba soporte técnico en esta versión de Pi, no disponibilidad contractual para cualquier producto o cuenta. [Proveedor, líneas 24–92](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/providers/anthropic.ts#L24), [OAuth, líneas 14–27 y 280–305](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/auth/oauth/anthropic.ts#L14).

### NaN y catálogos personalizados

NaN usa API key. Tiene un subconjunto conocido de modelos de chat y consulta `/models` con timeout de tres segundos, cancelación, `redirect: error` y `cache: no-store`. Una lista vacía válida del servicio es autoritativa; un fallo no borra el último catálogo útil. Cambiar de credencial invalida el catálogo de la anterior. Una generación impide que respuestas viejas sobrescriban la nueva cuenta. El catálogo frío representa capacidades documentadas, no derecho de acceso. [Catálogo y fetch, líneas 95–168](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/nan-provider.ts#L95), [refresh, líneas 228–266](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/nan-provider.ts#L228).

## Credenciales y errores

Pi almacena credenciales en `auth.json` del directorio del agente y permite proporcionar otra ruta. `AuthStorage` usa locks; los archivos se crean con modo `0600`. Eso es almacenamiento en archivo, no evidencia de cifrado o integración con Windows Credential Manager. En Windows debe verificarse la protección efectiva de ACL al empaquetar. Fluke necesita un directorio explícito separado y no debe importar cuentas silenciosamente. [auth-storage.ts, líneas 37–107 y 328–350](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/src/core/auth-storage.ts#L37).

La resolución OAuth tiene una propiedad importante para subagentes paralelos: revisa la expiración bajo lock, renueva una sola vez y persiste el refresh token antes de liberar el lock. El refresh tiene timeout de quince segundos. Cancelar un consumidor cancela su espera, pero no descarta una rotación ya iniciada. Si una credencial guardada falla, **no pasa silenciosamente a una API key de ambiente**. Esa conducta evita cambiar sin aviso de una suscripción a consumo de API. [auth/resolve.ts, líneas 28–33, 99–197](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/auth/resolve.ts#L28).

Pi tiene utilidades de retry con estados HTTP transitorios, `Retry-After`, backoff cancelable y un máximo de espera predeterminado de sesenta segundos. El helper de request no reintenta por defecto: necesita `maxRetries`; el nivel agente tiene otra política. Por eso no corresponde agregar un retry genérico encima de todo sin conocer los intentos ya hechos. [provider-retry.ts, líneas 24–68 y 100–126](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/utils/provider-retry.ts#L24), [retry.ts, líneas 111–145](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/utils/retry.ts#L111).

## Tres números que Fluke debe mantener separados

### Tokens y costo calculado de ejecución

Pi calcula costo desde tarifas del modelo por millón de tokens y los contadores de entrada, salida y caché, incluyendo niveles de precio y cache writes. Este cálculo no consulta una factura. Gentle suma `message.usage.cost.total` de mensajes assistant en las entradas de la sesión para su cabecera. Esa función no recorre sesiones hijas: no prueba un total consolidado de todo el árbol de agentes. [Pi calculateCost, líneas 1206–1225](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/models.ts#L1206), [Gentle sessionCost, líneas 265–272](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-shell.ts#L265).

NaN fija tarifas numéricas en cero porque el servicio usa cuotas y Pi exige números. El comentario lo explica expresamente. Presentar ese cero como “gratis” sería una interpretación incorrecta: la tarifa no representa el precio de la suscripción. [nan-provider.ts, líneas 15–16](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/nan-provider.ts#L15).

### Cuotas de cuenta o suscripción

- **Codex legacy:** Gentle consulta `https://chatgpt.com/backend-api/wham/usage` con bearer y account ID extraído del token; también interpreta headers de respuesta. Lee ventanas principal/secundaria, límites adicionales, plan y reset. Es una integración con ese endpoint, no una API universal de facturación. [Fetch, líneas 1464–1480](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-shell.ts#L1464), [parser, líneas 270–311](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/shell-usage.ts#L270).
- **Anthropic:** en la implementación revisada, Gentle obtiene utilización y reset de headers recibidos con respuestas. No tiene un fetch de cuotas Anthropic separado; antes de una respuesta puede no disponer de información. Esto no demuestra que no exista ningún endpoint externo. [Parser, líneas 314–330](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/shell-usage.ts#L314).
- **NaN:** consulta `https://cloud-api.nan.builders/api/usage/quota`, con API key sólo en headers y rechazo de redirects. Muestra ventanas y allowances por modelo/familia. [Fetch, líneas 1481–1499](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-shell.ts#L1481), [parser y agrupación, líneas 338–502](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/shell-usage.ts#L338).

Los proveedores de cuotas son extensibles mediante un registro. Se consultan en paralelo, con ventana predeterminada de diez segundos que cubre autenticación y request, intervalo mínimo normal de cinco minutos y refresh manual. La versión/generación descarta resultados tardíos. El último snapshot puede seguir visible tras un fallo, con antigüedad y estado de error; no se convierte en cero. [Registro y contrato](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/lib/shell-usage.ts#L139), [timeout](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-shell.ts#L1313), [refresh, líneas 1616–1719](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/extensions/gentle-shell.ts#L1616).

### Cargo real y administración comercial

En los módulos de proveedores, sesión y uso revisados no hay lectura de facturas, alta/baja de planes, precio mensual ni conciliación de cargos. “Gestionar suscripciones” en esta experiencia significa conectar y observar uso; no administrar la compra del plan. Un total de costo de API calculado tampoco indica cuánto queda de una ventana de suscripción. **No se verificaron precios comerciales vigentes ni se propone prometer ahorro concreto.**

## Contrato recomendado para Fluke Next

1. **Conexión:** proveedor, método (`api_key`/`oauth`), ruta, estado de autenticación y fuente de cuota; nunca el secreto. Mostrar modelo configurado y modelo efectivo por tarea. Pedir login explícito sólo cuando se use ejecución real.
2. **Ejecución:** registrar `sessionId`, `taskId`, `agentId`, `requestId` y resultado de cada intento. La suma debe incluir coordinador, workers, reviewer y reintentos sin contar dos veces eventos repetidos o respuestas recuperadas.
3. **Uso:** conservar tokens reportados y costo calculado con moneda, origen de tarifa y estado de disponibilidad. `null` significa desconocido; cero sólo cuando realmente se conoce. Para suscripciones, etiquetar como estimación equivalente cuando corresponda, nunca como factura.
4. **Cuota:** snapshot separado por cuenta/proveedor/ventana, fuente, `fetchedAt`, reset y estado `unavailable`, `fresh`, `stale` o `failed`. No multiplicar cuotas de la misma cuenta por cantidad de agentes.
5. **Presupuesto:** limitar concurrencia y estimaciones antes de despachar, y parar nuevos despachos cuando se exceda la política. Un presupuesto de tokens/costo observado no puede garantizar por sí solo un tope exacto de cargos: hay solicitudes en vuelo y cargos externos a Fluke.
6. **Fallos:** distinguir credencial ausente, sesión expirada, modelo no habilitado, límite temporal, saldo insuficiente y red. No cambiar automáticamente a otra cuenta/proveedor de pago sin una regla explícita del usuario.
7. **Primera entrega:** brief → desglose validable → workers con eventos estructurados → revisión y ledger agregado. Las cuotas reales y OAuth se habilitan por capacidad probada; no simular cuentas conectadas en la demo.

## Diferencia respecto a la consola anterior

La consola local actual usa `portable_pty`, lanza procesos y lee su salida de terminal. Eso da compatibilidad con CLIs, pero no ofrece por sí mismo un contrato de mensajes, tools, tokens ni costos. La nueva base propuesta mantiene el terminal como una vista/herramienta y usa eventos del runtime para coordinar agentes. Se trata de una recomendación arquitectónica, no de una descalificación de los otros adaptadores que ya existen en el repositorio. [Referencia local: tools/fluke-console/src/session.rs, líneas 11–64](../../tools/fluke-console/src/session.rs).

## Reutilización y límites

Los archivos LICENSE de ambos pins declaran MIT y requieren conservar el aviso al reutilizar copias o porciones sustanciales. Esta observación se limita a esos archivos: assets, sonidos, marcas, proveedores remotos y dependencias pueden tener condiciones independientes. Es preferible depender de Pi y escribir la capa Fluke con identidad propia; si se copia código de Gentle, registrar origen, commit y aviso correspondiente. [Gentle LICENSE](https://github.com/Gentleman-Programming/gentle-shell/blob/bedba1f12b4f5626e05129f7e4bc3693ce9cd829/LICENSE#L1), [Pi LICENSE](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/LICENSE#L1).

Pendientes de integración real: elegibilidad de cada cuenta y grant, permisos del almacenamiento en Windows, cuotas del nuevo Sign in with ChatGPT, disponibilidad de modelos y conciliación de uso entre procesos. No se ejecutaron autenticaciones para resolverlos en esta investigación.

## Primer ledger implementado

`tools/fluke-next/src/usage.ts` implementa un registro puro y serializable de uso para el prototipo. Consume únicamente eventos finales `message_end` de assistant. En Pi 1.2.0 el ID disponible es `responseId`, no un supuesto `message.id`. El tipo `Usage` ya incluye tokens de razonamiento dentro de output; el registro no vuelve a sumarlos. [AgentEvent, líneas 519–527](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/agent/src/types.ts#L519), [Usage y AssistantMessage](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/ai/src/types.ts#L446).

La identidad combina run, tarea, origen parent/worker, proveedor y responseId; sin ese ID usa timestamp y hash del contenido final. No almacena el texto en el ledger. Repetir un final reemplaza su snapshot, no suma otra vez. Sin ID, dos respuestas idénticas iniciadas en el mismo milisegundo dentro del mismo scope podrían confundirse; incorporar un ID de request durable elimina esa limitación cuando el runtime lo exponga.

El resumen agrupa por proveedor, modelo efectivo y tarea. Un contador ausente o no finito queda `null`; si falta una estimación, el total de esa agrupación permanece desconocido. Un cero explícito de Pi se conserva como costo nominal reportado, mientras facturación y cuota siguen `unknown`. No se infiere una factura ni un plan comercial. Hay siete tests de regresión escritos para agregación, replay, correcciones, entradas inválidas y datos desconocidos; no se ejecutaron por la instrucción del repositorio. El intento de formato con `npx --no-install prettier` falló porque Prettier no está disponible; no se instalaron dependencias.
