import Image from 'next/image';
import { BRAND } from '@/lib/brand';
import { cn } from '@/lib/utils';

/** The mark alone: three swooshes in the brand gradient. Works on any background. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <Image
      src="/patchvia-icon.svg"
      alt=""
      width={410}
      height={455}
      unoptimized
      aria-hidden="true"
      className={cn('h-8 w-auto shrink-0', className)}
    />
  );
}

/**
 * The full logo. The wordmark is ink on light and mist on dark, so both files are rendered and the theme picks one
 * (`dark:` follows [data-theme] on <html>). Height is set by the caller's class; width follows.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex', className)}
      role="img"
      aria-label={BRAND.product}
    >
      <Image
        src="/patchvia-logo-light.svg"
        alt=""
        width={1250}
        height={395}
        unoptimized
        aria-hidden="true"
        className="h-8 w-auto dark:hidden"
      />
      <Image
        src="/patchvia-logo-dark.svg"
        alt=""
        width={1250}
        height={395}
        unoptimized
        aria-hidden="true"
        className="hidden h-8 w-auto dark:block"
      />
    </span>
  );
}
