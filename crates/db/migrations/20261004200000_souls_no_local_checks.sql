-- Agents no longer run checks in their worktrees (no node_modules nor build
-- cache there; a cold `pnpm run check` took 15+ min and saturated the
-- machine). Checks are the user's call: CI and/or the repo post script. Only the exact seeded phrases are
-- replaced, so customised souls are left alone.
UPDATE workers SET soul = replace(soul,
    'Build/typecheck pasando (`pnpm run check` o `cargo check` según corresponda).',
    'Sin correr checks locales (typecheck, build, tests): corren fuera de tu sesión (CI o post script del repo).')
WHERE soul LIKE '%Build/typecheck pasando (`pnpm run check`%';

UPDATE workers SET soul = replace(soul,
    'Validás el PR del issue: corrés los checks del repo (tests, typecheck, lint) y hacés un smoke de lo que el issue promete.',
    'Validás el PR del issue contra lo que promete, leyendo el diff y el resultado del CI (`gh pr checks`); no corrés checks locales.')
WHERE role = 'qa' AND soul LIKE '%corrés los checks del repo (tests, typecheck, lint)%';
