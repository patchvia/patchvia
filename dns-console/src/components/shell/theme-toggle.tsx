'use client';

import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  THEME_STORAGE_KEY,
  isThemeChoice,
  resolveTheme,
  type ThemeChoice,
} from '@/lib/theme';

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice) {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute(
    'data-theme',
    resolveTheme(choice, dark),
  );
}

/** Light, dark, or follow the system. The choice is remembered per browser. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  const sync = useCallback((c: ThemeChoice) => {
    apply(c);
    setResolved(
      document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'dark'
        : 'light',
    );
  }, []);

  useEffect(() => {
    const c = read();
    setChoice(c);
    sync(c);
    // While on "system", follow the operating system if it flips (sunset, a keyboard shortcut)
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (read() === 'system') sync('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [sync]);

  function choose(next: ThemeChoice) {
    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // storage unavailable: the choice applies until the page is reloaded
    }
    setChoice(next);
    sync(next);
  }

  const Icon = resolved === 'dark' ? Moon : Sun;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Change theme">
          <Icon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => choose(o.value)}>
            <o.icon className="h-4 w-4" /> {o.label}
            {choice === o.value && <Check className="ml-auto h-4 w-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
