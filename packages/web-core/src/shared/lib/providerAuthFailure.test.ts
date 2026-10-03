import { describe, expect, it } from 'vitest';
import { isProviderAuthFailure } from './providerAuthFailure';

describe('isProviderAuthFailure', () => {
  it('flags the start gate and auth errors only', () => {
    expect(
      isProviderAuthFailure(
        'El proveedor Codex no está conectado. Conéctalo en Configuración o elige otro modelo para el worker.'
      )
    ).toBe(true);
    expect(
      isProviderAuthFailure(
        'Error de API (401): Failed to authenticate. OAuth access token has been revoked.'
      )
    ).toBe(true);
    expect(isProviderAuthFailure('Invalid API key · Please run /login')).toBe(
      true
    );
    expect(isProviderAuthFailure('El agente terminó con error')).toBe(false);
    expect(isProviderAuthFailure('Error de API (429): rate limit')).toBe(false);
    expect(isProviderAuthFailure(null)).toBe(false);
  });
});
