/** The app's mark (the fluke "V"). Shared by the status bar and the Director. */
export function FlukeMark({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden>
      <path
        d="M50,86 C26,77 6,53 4,21 C3,12 11,10 19,18 C36,36 47,57 50,70 C53,57 64,36 81,18 C89,10 97,12 96,21 C94,53 74,77 50,86 Z"
        fill="currentColor"
      />
    </svg>
  );
}
