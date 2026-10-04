import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyGithubPublishError,
  initialGithubPublishForm,
  type GithubOwnersState,
  type GithubPublishForm,
} from '@/shared/lib/githubPublish';
import { GithubPublishOptions } from './GithubPublishOptions';

// Bloque reutilizable «Crear tambien en GitHub» + owner + visibilidad (issue
// #775). Lo usan el picker de repos, el dialogo de inicializar y los settings
// de repos, y lo va a reusar «Conectar a GitHub» (wave 2), asi que es un
// componente controlado y sin acceso directo a la red ni a dialogos: recibe el
// estado del formulario, el estado de la lista de owners y un callback para
// abrir Settings -> GitHub. Se renderiza a markup estatico en node (sin DOM),
// con `t` devolviendo la clave. Claves (namespace `common`):
//   githubPublish.checkbox, githubPublish.owner.label,
//   githubPublish.visibility.label|public|private,
//   githubPublish.owners.loading,
//   githubPublish.noSession.message|openSettings
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const READY: GithubOwnersState = {
  status: 'ready',
  owners: [
    { login: 'dani', kind: 'user' },
    { login: 'acme-org', kind: 'organization' },
  ],
};

function render(
  value: GithubPublishForm,
  owners: GithubOwnersState,
  extra: { disabled?: boolean } = {}
): string {
  return renderToStaticMarkup(
    <GithubPublishOptions
      value={value}
      onChange={() => {}}
      owners={owners}
      onOpenGithubSettings={() => {}}
      {...extra}
    />
  );
}

const on = (over: Partial<GithubPublishForm> = {}): GithubPublishForm => ({
  ...initialGithubPublishForm(),
  enabled: true,
  ...over,
});

describe('GithubPublishOptions', () => {
  it('desactivado: solo el checkbox, sin owner ni visibilidad', () => {
    const html = render(initialGithubPublishForm(), READY);

    expect(html).toContain('githubPublish.checkbox');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('githubPublish.owner.label');
    expect(html).not.toContain('githubPublish.visibility.label');
  });

  it('activado con owners listos: muestra selector de owner y de visibilidad', () => {
    const html = render(on(), READY);

    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('githubPublish.owner.label');
    expect(html).toContain('githubPublish.visibility.label');
    expect(html).not.toContain('githubPublish.noSession.openSettings');
  });

  it('activado mientras cargan los owners: indica la carga', () => {
    const html = render(on(), { status: 'loading' });

    expect(html).toContain('githubPublish.owners.loading');
    expect(html).not.toContain('githubPublish.noSession.openSettings');
  });

  it('activado sin sesion de GitHub: mensaje claro y camino a Settings -> GitHub', () => {
    const failure = classifyGithubPublishError(
      Object.assign(
        new Error(
          'No GitHub session: log in to GitHub in Settings > GitHub (device login or token) and try again.'
        ),
        { status: 400 }
      )
    );
    const html = render(on(), { status: 'error', failure });

    expect(html).toContain('githubPublish.noSession.message');
    expect(html).toContain('githubPublish.noSession.openSettings');
  });

  it('activado con otro error al listar owners: muestra el mensaje sin pedir login', () => {
    const failure = classifyGithubPublishError(
      Object.assign(new Error('GitHub request failed: connection reset'), {
        status: 502,
      })
    );
    const html = render(on(), { status: 'error', failure });

    expect(html).toContain('GitHub request failed: connection reset');
    expect(html).not.toContain('githubPublish.noSession.openSettings');
  });

  it('desactivado ignora el error de owners (no se avisa de algo que no se pidio)', () => {
    const failure = classifyGithubPublishError(
      Object.assign(new Error('No GitHub session: log in'), { status: 400 })
    );
    const html = render(initialGithubPublishForm(), {
      status: 'error',
      failure,
    });

    expect(html).not.toContain('githubPublish.noSession.message');
    expect(html).not.toContain('githubPublish.noSession.openSettings');
  });

  it('disabled deshabilita el checkbox (mientras se confirma)', () => {
    const html = render(initialGithubPublishForm(), READY, { disabled: true });

    expect(html).toMatch(/role="checkbox"[^>]*disabled|disabled=""[^>]*role="checkbox"/);
  });
});
