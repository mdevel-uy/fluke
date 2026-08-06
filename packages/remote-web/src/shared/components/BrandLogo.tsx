interface BrandLogoProps {
  className?: string;
  alt?: string;
}

export function BrandLogo({
  className = "h-8 w-auto",
  alt = "mkanban",
}: BrandLogoProps) {
  return (
    <picture>
      <source
        srcSet="/mkanban-logo-dark.svg"
        media="(prefers-color-scheme: dark)"
      />
      <img src="/mkanban-logo.svg" alt={alt} className={className} />
    </picture>
  );
}
