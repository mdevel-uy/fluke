import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PUBLISH_VISIBILITY,
  buildGithubChoice,
  canConfirmGithubPublish,
  classifyGithubPublishError,
  defaultPublishOwner,
  initialGithubPublishForm,
  registerAndPublish,
  resolvePublishOwner,
  type GithubOwner,
  type GithubPublishForm,
} from './githubPublish';

// Contrato de `githubPublish.ts` (issue #775, parte de usuario del checkbox
// "Crear tambien en GitHub"). Es logica pura, sin React ni red, para que la
// usen por igual el picker de repos, el dialogo de inicializar y los settings
// de repos. Las rutas y shapes de la API son las de #774:
//   GET  /api/github/owners          -> GithubOwner[]  ({ login, kind })
//   POST /api/repos/{id}/github      -> { url, owner, name, branch }
// y los mensajes de error son los de crates/server/src/error.rs.

const OWNERS: GithubOwner[] = [
  { login: 'acme-org', kind: 'organization' },
  { login: 'dani', kind: 'user' },
  { login: 'other-org', kind: 'organization' },
];

function form(over: Partial<GithubPublishForm> = {}): GithubPublishForm {
  return { enabled: true, owner: null, visibility: 'private', ...over };
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe('estado inicial del formulario', () => {
  it('arranca desactivado, privado y sin owner elegido', () => {
    expect(initialGithubPublishForm()).toEqual({
      enabled: false,
      owner: null,
      visibility: 'private',
    });
    expect(DEFAULT_PUBLISH_VISIBILITY).toBe('private');
  });

  it('devuelve un objeto nuevo en cada llamada', () => {
    expect(initialGithubPublishForm()).not.toBe(initialGithubPublishForm());
  });
});

describe('owner por defecto', () => {
  it('prefiere al usuario aunque una organizacion venga primero', () => {
    expect(defaultPublishOwner(OWNERS)).toBe('dani');
  });

  it('sin usuario en la lista usa el primer owner', () => {
    expect(defaultPublishOwner([OWNERS[0], OWNERS[2]])).toBe('acme-org');
  });

  it('lista vacia: null', () => {
    expect(defaultPublishOwner([])).toBeNull();
  });

  it('resolvePublishOwner respeta una eleccion valida (sin distinguir mayusculas)', () => {
    expect(resolvePublishOwner(form({ owner: 'acme-org' }), OWNERS)).toBe(
      'acme-org'
    );
    expect(resolvePublishOwner(form({ owner: 'ACME-ORG' }), OWNERS)).toBe(
      'acme-org'
    );
  });

  it('resolvePublishOwner cae al default si no hay eleccion o ya no existe', () => {
    expect(resolvePublishOwner(form({ owner: null }), OWNERS)).toBe('dani');
    expect(resolvePublishOwner(form({ owner: 'gone-org' }), OWNERS)).toBe(
      'dani'
    );
    expect(resolvePublishOwner(form({ owner: 'x' }), [])).toBeNull();
  });
});

describe('eleccion que se manda a GitHub', () => {
  it('opcion desactivada: nada que publicar', () => {
    expect(
      buildGithubChoice(form({ enabled: false, owner: 'acme-org' }), OWNERS)
    ).toBeNull();
  });

  it('activada sin tocar nada: usuario + privado', () => {
    expect(buildGithubChoice(form(), OWNERS)).toEqual({
      owner: 'dani',
      visibility: 'private',
    });
  });

  it('respeta owner y visibilidad elegidos', () => {
    expect(
      buildGithubChoice(
        form({ owner: 'other-org', visibility: 'public' }),
        OWNERS
      )
    ).toEqual({ owner: 'other-org', visibility: 'public' });
  });

  it('activada pero sin owners disponibles: null (no se inventa un owner)', () => {
    expect(buildGithubChoice(form(), [])).toBeNull();
  });
});

describe('habilitado del boton de confirmar', () => {
  const ready = { status: 'ready', owners: OWNERS } as const;
  const failure = classifyGithubPublishError(
    httpError(400, 'No GitHub session: log in to GitHub in Settings > GitHub')
  );

  it('con la opcion desactivada el estado de los owners no importa', () => {
    const off = form({ enabled: false });
    expect(canConfirmGithubPublish(off, { status: 'loading' })).toBe(true);
    expect(canConfirmGithubPublish(off, { status: 'error', failure })).toBe(
      true
    );
    expect(canConfirmGithubPublish(off, ready)).toBe(true);
  });

  it('activada y cargando owners: deshabilitado', () => {
    expect(canConfirmGithubPublish(form(), { status: 'loading' })).toBe(false);
  });

  it('activada y sin sesion (error al listar owners): deshabilitado', () => {
    expect(canConfirmGithubPublish(form(), { status: 'error', failure })).toBe(
      false
    );
  });

  it('activada con owners listos: habilitado, aunque no haya elegido owner', () => {
    expect(canConfirmGithubPublish(form({ owner: null }), ready)).toBe(true);
    expect(canConfirmGithubPublish(form({ owner: 'acme-org' }), ready)).toBe(
      true
    );
  });

  it('activada con lista de owners vacia: deshabilitado', () => {
    expect(
      canConfirmGithubPublish(form(), { status: 'ready', owners: [] })
    ).toBe(false);
  });
});

describe('mapeo de errores de la API (mensajes de #774)', () => {
  it('sin sesion de GitHub: pide iniciar sesion y se puede reintentar', () => {
    const f = classifyGithubPublishError(
      httpError(
        400,
        'No GitHub session: log in to GitHub in Settings > GitHub (device login or token) and try again.'
      )
    );
    expect(f.kind).toBe('no_session');
    expect(f.needsLogin).toBe(true);
    expect(f.retryable).toBe(true);
  });

  it('nombre ya tomado en GitHub', () => {
    const f = classifyGithubPublishError(
      httpError(
        409,
        'A repository named dani/my-proj already exists on GitHub. Choose another name.'
      )
    );
    expect(f.kind).toBe('name_taken');
    expect(f.needsLogin).toBe(false);
    expect(f.retryable).toBe(false);
    expect(f.message).toContain('dani/my-proj');
  });

  it('owner sin permisos', () => {
    const f = classifyGithubPublishError(
      httpError(
        403,
        'Your GitHub session is not allowed to create repositories under acme-org: Forbidden'
      )
    );
    expect(f.kind).toBe('owner_forbidden');
    expect(f.needsLogin).toBe(false);
  });

  it('owner no disponible, nombre invalido, sin commits y origin existente', () => {
    expect(
      classifyGithubPublishError(
        httpError(
          400,
          "GitHub owner 'x' is not available for this session; use your user or one of your organizations."
        )
      ).kind
    ).toBe('owner_unavailable');
    expect(
      classifyGithubPublishError(
        httpError(
          400,
          "Invalid GitHub repository name 'a b': use only letters, digits, '.', '_' or '-' (max 100 characters)."
        )
      ).kind
    ).toBe('invalid_name');
    expect(
      classifyGithubPublishError(
        httpError(
          400,
          'The local repository has no commits yet; make a first commit before creating it on GitHub.'
        )
      ).kind
    ).toBe('no_commits');
    const origin = classifyGithubPublishError(
      httpError(
        409,
        'The local repository already has an origin remote (git@github.com:a/b.git).'
      )
    );
    expect(origin.kind).toBe('origin_configured');
    expect(origin.retryable).toBe(false);
  });

  it('publicacion incompleta: informa la URL ya creada y se puede reintentar', () => {
    const f = classifyGithubPublishError(
      httpError(
        502,
        'The repository was created on GitHub (https://github.com/dani/my-proj) but publishing did not finish: push rejected'
      )
    );
    expect(f.kind).toBe('incomplete');
    expect(f.createdUrl).toBe('https://github.com/dani/my-proj');
    expect(f.retryable).toBe(true);
    expect(f.message).toContain('push rejected');
  });

  it('falla de GitHub (502): reintentable, conserva el mensaje', () => {
    const f = classifyGithubPublishError(
      httpError(502, 'GitHub request failed: connection reset')
    );
    expect(f.kind).toBe('github_request_failed');
    expect(f.retryable).toBe(true);
    expect(f.needsLogin).toBe(false);
    expect(f.message).toContain('connection reset');
  });

  it('error desconocido: kind other con el mensaje original', () => {
    const f = classifyGithubPublishError(new Error('socket hang up'));
    expect(f.kind).toBe('other');
    expect(f.message).toBe('socket hang up');
    expect(f.needsLogin).toBe(false);
  });

  it('valor que no es Error: usa el mensaje de respaldo', () => {
    const f = classifyGithubPublishError('boom', 'Fallo al crear en GitHub');
    expect(f.kind).toBe('other');
    expect(f.message).toBe('Fallo al crear en GitHub');
  });
});

describe('registrar/inicializar y publicar (camino feliz y sad path)', () => {
  const repo = { id: 'repo-1', name: 'my-proj' };
  const choice = { owner: 'acme-org', visibility: 'public' as const };

  it('sin eleccion de GitHub: solo registra y nunca llama a publish', async () => {
    const register = vi.fn().mockResolvedValue(repo);
    const publish = vi.fn();

    const result = await registerAndPublish({
      register,
      choice: null,
      publish,
    });

    expect(result).toEqual({ repo, github: { status: 'skipped' } });
    expect(register).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('con eleccion: publica el repo registrado con owner, nombre y visibilidad', async () => {
    const register = vi.fn().mockResolvedValue(repo);
    const publish = vi.fn().mockResolvedValue({
      url: 'https://github.com/acme-org/my-proj',
      owner: 'acme-org',
      name: 'my-proj',
      branch: 'main',
    });

    const result = await registerAndPublish({ register, choice, publish });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('repo-1', {
      owner: 'acme-org',
      name: 'my-proj',
      visibility: 'public',
    });
    expect(result).toEqual({
      repo,
      github: {
        status: 'published',
        url: 'https://github.com/acme-org/my-proj',
      },
    });
  });

  it('si falla el registro local no se intenta GitHub y el error se propaga', async () => {
    const register = vi.fn().mockRejectedValue(new Error('not a git repo'));
    const publish = vi.fn();

    await expect(
      registerAndPublish({ register, choice, publish })
    ).rejects.toThrow('not a git repo');
    expect(publish).not.toHaveBeenCalled();
  });

  it('si falla GitHub el repo local queda registrado y NO se reporta exito', async () => {
    const register = vi.fn().mockResolvedValue(repo);
    const publish = vi
      .fn()
      .mockRejectedValue(
        httpError(
          400,
          'No GitHub session: log in to GitHub in Settings > GitHub (device login or token) and try again.'
        )
      );

    const result = await registerAndPublish({ register, choice, publish });

    expect(result.repo).toEqual(repo);
    expect(result.github.status).toBe('failed');
    if (result.github.status !== 'failed') throw new Error('unreachable');
    expect(result.github.failure.kind).toBe('no_session');
    expect(result.github.failure.needsLogin).toBe(true);
  });

  it('reintentar la creacion en GitHub no vuelve a registrar el repo', async () => {
    const register = vi.fn().mockResolvedValue(repo);
    const publish = vi
      .fn()
      .mockRejectedValueOnce(httpError(502, 'GitHub request failed: timeout'))
      .mockResolvedValueOnce({
        url: 'https://github.com/acme-org/my-proj',
        owner: 'acme-org',
        name: 'my-proj',
        branch: 'main',
      });

    const first = await registerAndPublish({ register, choice, publish });
    if (first.github.status !== 'failed') throw new Error('expected failure');

    const retried = await first.github.retry();

    expect(retried).toEqual({
      status: 'published',
      url: 'https://github.com/acme-org/my-proj',
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenNthCalledWith(2, 'repo-1', {
      owner: 'acme-org',
      name: 'my-proj',
      visibility: 'public',
    });
  });

  it('un reintento que vuelve a fallar sigue siendo reintentable', async () => {
    const register = vi.fn().mockResolvedValue(repo);
    const publish = vi
      .fn()
      .mockRejectedValue(httpError(502, 'GitHub request failed: timeout'));

    const first = await registerAndPublish({ register, choice, publish });
    if (first.github.status !== 'failed') throw new Error('expected failure');
    const second = await first.github.retry();

    expect(second.status).toBe('failed');
    if (second.status !== 'failed') throw new Error('unreachable');
    expect(typeof second.retry).toBe('function');
    expect(register).toHaveBeenCalledTimes(1);
  });
});
