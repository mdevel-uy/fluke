/** Avatar of a profile: initials on its role color. */
const INITIALS: Record<string, string> = {
  fullstack: 'FS',
  frontend: 'FE',
  backend: 'BE',
  analyst: 'AN',
  reviewer: 'RV',
  designer: 'DS',
  qa: 'QA',
  devops: 'DO',
  docs: 'DC',
  security: 'SC',
};

export const ROLE_COLOR: Record<string, string> = {
  developer: 'bg-md-primary text-md-on-primary',
  analyst: 'bg-warning text-warning-foreground',
  reviewer: 'bg-violet-500 text-white',
  designer: 'bg-pink-400 text-white',
  qa: 'bg-success text-success-foreground',
  devops: 'bg-sky-600 text-white',
  architect: 'bg-indigo-500 text-white',
  docs: 'bg-teal-600 text-white',
  quality: 'bg-amber-600 text-white',
  security: 'bg-red-600 text-white',
};

export function initials(name: string) {
  const key = name.trim().toLowerCase();
  if (INITIALS[key]) return INITIALS[key];
  const words = key.split(/\s+/).filter(Boolean);
  return (
    words.length > 1 ? words[0][0] + words[1][0] : key.slice(0, 2)
  ).toUpperCase();
}
