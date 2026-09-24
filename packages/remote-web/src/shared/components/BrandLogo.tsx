interface BrandLogoProps {
  className?: string;
  alt?: string;
}

export function BrandLogo({
  className = "h-8 w-auto",
  alt = "fluke",
}: BrandLogoProps) {
  return (
    <picture>
      <source
        srcSet="/fluke-logo-dark.svg"
        media="(prefers-color-scheme: dark)"
      />
      <img src="/fluke-logo.svg" alt={alt} className={className} />
    </picture>
  );
}
