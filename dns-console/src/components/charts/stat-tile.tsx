import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';

/** label · value · optional note. Proportional figures (not tabular) because the value is a standalone display number. */
export function StatTile({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  note?: string;
  icon: LucideIcon;
}) {
  return (
    <Card className="flex flex-col gap-1 p-5">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{label}</span>
        <Icon className="h-4 w-4" aria-hidden />
      </div>
      <p className="font-display text-3xl font-semibold tracking-tight">
        {value}
      </p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </Card>
  );
}
