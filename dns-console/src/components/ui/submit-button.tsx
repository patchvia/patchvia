'use client';

import { Loader2 } from 'lucide-react';
import { useFormStatus } from 'react-dom';
import { Button, type ButtonProps } from './button';

/** Disables itself and shows a spinner while its parent <form> action is pending. */
export function SubmitButton({ children, disabled, ...props }: ButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </Button>
  );
}
