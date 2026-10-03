-- Agents no longer run checks in their worktrees (no node_modules nor build
-- cache there; a cold `pnpm run check` took 15+ min and saturated the
-- machine). CI validates every PR. Only the exact seeded phrases are
-- replaced, so customised souls are left alone.
UPDATE workers SET soul = replace(soul,
    'Build/typecheck pasando (`pnpm run check` o `cargo check` según corresponda).',
    'Sin correr checks locales (typecheck, build, tests): los valida el CI del PR.')
WHERE soul LIKE '%Build/typecheck pasando (`pnpm run check`%';

UPDATE workers SET soul = replace(soul,
    'Validás el PR del issue: corrés los checks del repo (tests, typecheck, lint) y hacés un smoke de lo que el issue promete.',
    'Validás el PR del issue contra lo que promete, leyendo el diff y el resultado del CI (`gh pr checks`); no corrés checks locales.')
WHERE role = 'qa' AND soul LIKE '%corrés los checks del repo (tests, typecheck, lint)%';
