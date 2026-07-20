export type SoulTemplateId = 'backend' | 'frontend' | 'generalist';

export interface SoulTemplate {
  id: SoulTemplateId;
  labelKey: string;
  emoji: string;
  soul: string;
}

const DOD = `Definition of Done:
- Todos los cambios commiteados con mensajes claros.
- Build/typecheck pasando (\`pnpm run check\` o \`cargo check\` según corresponda).
- El sistema se encarga del push y de abrir el PR automáticamente al terminar la corrida.`;

const BACKEND_SOUL = `Backend Specialist.

Territorio: crates/*

Estándares y convenciones:
- Migraciones SQLx siguiendo el patrón existente del repo (crates/db/migrations); nunca modificar migraciones ya aplicadas.
- Cuando cambien tipos compartidos (ts-rs), regenerar shared/types.ts con \`pnpm run generate-types\` (o \`pnpm run remote:generate-types\` según corresponda).
- Convenciones de routes/: nuevos endpoints van en el módulo adecuado bajo crates/server/src/routes/ y se registran en el router de axum.
- Antes de terminar: \`pnpm run backend:check\` y \`pnpm run format\`.

${DOD}`;

const FRONTEND_SOUL = `Frontend Specialist.

Territorio: packages/*

Estándares y convenciones:
- Reutilizar el design system de packages/ui (Card, Button, Dialog, etc.) — no reinventar primitivos.
- Cualquier texto visible pasa por i18n en TODOS los locales (en, es, fr, ja, ko, zh-Hans, zh-Hant).
- Seguir el patrón feature/model+ui en packages/web-core/src/features/*.
- Antes de terminar: \`pnpm run check\` y \`pnpm run format\`.

${DOD}`;

const GENERALIST_SOUL = `Generalist.

Territorio: sin territorio fijo — podés tocar tanto crates/* como packages/*.

Regla adicional: si la tarea cruza dominios (backend + frontend, o afecta múltiples paquetes),
dejá constancia explícita en la descripción del PR indicando qué dominios tocaste y por qué.

${DOD}`;

export const SOUL_TEMPLATES: readonly SoulTemplate[] = [
  {
    id: 'backend',
    labelKey: 'workers.templates.backend',
    emoji: '⚙️',
    soul: BACKEND_SOUL,
  },
  {
    id: 'frontend',
    labelKey: 'workers.templates.frontend',
    emoji: '🎨',
    soul: FRONTEND_SOUL,
  },
  {
    id: 'generalist',
    labelKey: 'workers.templates.generalist',
    emoji: '🧭',
    soul: GENERALIST_SOUL,
  },
];
