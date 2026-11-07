import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-start gap-2">
      <h2 className="text-lg font-semibold">Not found</h2>
      <p className="text-sm text-muted-foreground">
        That zone or page does not exist, or you do not have access to it.
      </p>
      <Link href="/zones" className="text-sm underline">
        Back to zones
      </Link>
    </div>
  );
}
