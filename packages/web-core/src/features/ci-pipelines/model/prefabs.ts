/**
 * Prefab job definitions — curated multi-step compositions that expand into
 * plain Actions steps at compile time. The inspector renders each prefab's
 * form generically from its `params` definitions; adding a prefab is a
 * data-only change (no per-prefab UI code).
 */

/** A single Actions step, ready for YAML serialization. */
export interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, string | boolean | number>;
  run?: string;
  env?: Record<string, string>;
}

export type PrefabParamDef =
  | {
      key: string;
      label: string;
      type: 'string';
      default: string;
      hint?: string;
    }
  | {
      key: string;
      label: string;
      type: 'boolean';
      default: boolean;
      hint?: string;
    }
  | {
      key: string;
      label: string;
      type: 'select';
      default: string;
      options: string[];
      hint?: string;
    };

export type PrefabParams = Record<string, string | boolean>;

export interface PrefabDef {
  id: string;
  /** Palette/node title (product copy, not i18n — mirrors action names). */
  name: string;
  /** Palette subtitle. */
  subtitle: string;
  defaultJobId: string;
  params: PrefabParamDef[];
  compile: (params: PrefabParams) => WorkflowStep[];
}

function str(params: PrefabParams, key: string, fallback = ''): string {
  const value = params[key];
  return typeof value === 'string' ? value : fallback;
}

function bool(params: PrefabParams, key: string, fallback = false): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

const CHECKOUT_STEP: WorkflowStep = {
  name: 'Checkout',
  uses: 'actions/checkout@v4',
};

export const PREFABS: PrefabDef[] = [
  {
    id: 'node-build',
    name: 'Node.js build',
    subtitle: 'checkout · setup · cache',
    defaultJobId: 'build',
    params: [
      {
        key: 'nodeVersion',
        label: 'Node version',
        type: 'string',
        default: '20',
      },
      {
        key: 'packageManager',
        label: 'Package manager',
        type: 'select',
        default: 'pnpm',
        options: ['pnpm', 'npm', 'yarn'],
      },
      {
        key: 'buildCommand',
        label: 'Build command',
        type: 'string',
        default: 'pnpm build',
      },
    ],
    compile: (params) => {
      const pm = str(params, 'packageManager', 'pnpm');
      const install =
        pm === 'npm'
          ? 'npm ci'
          : pm === 'yarn'
            ? 'yarn install --frozen-lockfile'
            : 'pnpm install --frozen-lockfile';
      const steps: WorkflowStep[] = [CHECKOUT_STEP];
      if (pm === 'pnpm') {
        steps.push({ name: 'Setup pnpm', uses: 'pnpm/action-setup@v4' });
      }
      steps.push(
        {
          name: 'Setup Node.js',
          uses: 'actions/setup-node@v4',
          with: {
            'node-version': str(params, 'nodeVersion', '20'),
            cache: pm,
          },
        },
        { name: 'Install dependencies', run: install }
      );
      const buildCommand = str(params, 'buildCommand');
      if (buildCommand) {
        steps.push({ name: 'Build', run: buildCommand });
      }
      return steps;
    },
  },
  {
    id: 'rust-build',
    name: 'Rust build',
    subtitle: 'toolchain · cache',
    defaultJobId: 'build',
    params: [
      {
        key: 'toolchain',
        label: 'Toolchain',
        type: 'string',
        default: 'stable',
      },
      {
        key: 'command',
        label: 'Command',
        type: 'string',
        default: 'cargo build --release',
      },
      {
        key: 'useCache',
        label: 'Cache (Swatinem)',
        type: 'boolean',
        default: true,
      },
    ],
    compile: (params) => {
      const steps: WorkflowStep[] = [
        CHECKOUT_STEP,
        {
          name: 'Setup Rust',
          uses: 'dtolnay/rust-toolchain@master',
          with: { toolchain: str(params, 'toolchain', 'stable') },
        },
      ];
      if (bool(params, 'useCache', true)) {
        steps.push({ name: 'Cache cargo', uses: 'Swatinem/rust-cache@v2' });
      }
      steps.push({
        name: 'Build',
        run: str(params, 'command', 'cargo build --release'),
      });
      return steps;
    },
  },
  {
    id: 'test-suite',
    name: 'Test suite',
    subtitle: 'unit · coverage',
    defaultJobId: 'test',
    params: [
      {
        key: 'command',
        label: 'Test command',
        type: 'string',
        default: 'npm test',
      },
      {
        key: 'uploadCoverage',
        label: 'Upload coverage artifact',
        type: 'boolean',
        default: false,
        hint: 'Uploads ./coverage with actions/upload-artifact',
      },
    ],
    compile: (params) => {
      const steps: WorkflowStep[] = [
        CHECKOUT_STEP,
        { name: 'Run tests', run: str(params, 'command', 'npm test') },
      ];
      if (bool(params, 'uploadCoverage')) {
        steps.push({
          name: 'Upload coverage',
          uses: 'actions/upload-artifact@v4',
          with: { name: 'coverage', path: 'coverage' },
        });
      }
      return steps;
    },
  },
  {
    id: 'docker-build-push',
    name: 'Docker build & push',
    subtitle: 'buildx · registry',
    defaultJobId: 'docker',
    params: [
      { key: 'context', label: 'Context', type: 'string', default: '.' },
      {
        key: 'file',
        label: 'Dockerfile',
        type: 'string',
        default: 'Dockerfile',
      },
      {
        key: 'tags',
        label: 'Tags',
        type: 'string',
        default: 'ghcr.io/${{ github.repository }}:latest',
        hint: 'Comma-separated image tags',
      },
      {
        key: 'push',
        label: 'Push to registry',
        type: 'boolean',
        default: true,
      },
    ],
    compile: (params) => [
      CHECKOUT_STEP,
      { name: 'Set up Buildx', uses: 'docker/setup-buildx-action@v3' },
      {
        name: 'Login to registry',
        uses: 'docker/login-action@v3',
        with: {
          registry: 'ghcr.io',
          username: '${{ github.actor }}',
          password: '${{ secrets.GITHUB_TOKEN }}',
        },
      },
      {
        name: 'Build and push',
        uses: 'docker/build-push-action@v6',
        with: {
          context: str(params, 'context', '.'),
          file: str(params, 'file', 'Dockerfile'),
          push: bool(params, 'push', true),
          tags: str(params, 'tags'),
          'cache-from': 'type=gha',
          'cache-to': 'type=gha,mode=max',
        },
      },
    ],
  },
  {
    id: 'deploy',
    name: 'Deploy',
    subtitle: 'ssh · script',
    defaultJobId: 'deploy',
    params: [
      { key: 'host', label: 'Host', type: 'string', default: '' },
      { key: 'user', label: 'User', type: 'string', default: 'root' },
      {
        key: 'script',
        label: 'Script',
        type: 'string',
        default: 'cd /srv/app && docker compose pull && docker compose up -d',
      },
    ],
    compile: (params) => [
      {
        name: 'Deploy over SSH',
        uses: 'appleboy/ssh-action@v1',
        with: {
          host: str(params, 'host'),
          username: str(params, 'user', 'root'),
          key: '${{ secrets.SSH_KEY }}',
          script: str(params, 'script'),
        },
      },
    ],
  },
];

const PREFABS_BY_ID = new Map(PREFABS.map((p) => [p.id, p]));

export function getPrefab(prefabId: string): PrefabDef | undefined {
  return PREFABS_BY_ID.get(prefabId);
}

export function defaultParamsFor(prefab: PrefabDef): PrefabParams {
  const params: PrefabParams = {};
  for (const def of prefab.params) {
    params[def.key] = def.default;
  }
  return params;
}
