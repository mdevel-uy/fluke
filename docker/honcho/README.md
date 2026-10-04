# Honcho local (memoria de Fluke)

Fluke usa [Honcho](https://github.com/plastic-labs/honcho) para recordar entre conversaciones (J3, spec F2). Por ahora corre en Docker en la misma PC; más adelante se muda al control plane.

Honcho no publica imagen: se compila desde su repo, fijado a una versión.

## Levantar

Desde esta carpeta (`docker/honcho`), en Git Bash:

```bash
git clone --depth 1 --branch v3.2.2 https://github.com/plastic-labs/honcho.git src
cp .env.example src/.env        # y completar la key (ver abajo)
cd src
cp docker-compose.yml.example docker-compose.yml
docker compose up -d --build
curl -s http://127.0.0.1:8000/health
```

`src/` está en `.gitignore`.

## La key de LLM

Honcho razona con un LLM y usa embeddings. Por defecto todo va por **OpenAI** (modelo `gpt-5.4-mini` y `text-embedding-3-small`): Anthropic no tiene embeddings, así que hace falta una key de OpenAI (o configurar Gemini). Va **solo** en `src/.env` (`LLM_OPENAI_API_KEY`); fluke no la ve ni la guarda.

## Cómo la usa fluke

- `FLUKE_HONCHO_URL` (por defecto `http://127.0.0.1:8000`). `FLUKE_HONCHO_URL=off` apaga la memoria.
- `FLUKE_HONCHO_TOKEN` solo si Honcho corre con `AUTH_USE_AUTH=true`.
- Si Honcho no está, está lento o falla, Fluke funciona igual sin memoria (reintenta al minuto).

Datos en Honcho: workspace `fluke`, peers `user` y `fluke`, sesión `fluke-main`. Se guarda el diálogo usuario ↔ Fluke; no los lotes de eventos de la app ni las respuestas `SILENT`.

## Apagar / borrar

```bash
cd src && docker compose down        # apagar
docker compose down -v               # apagar y borrar la memoria
```
