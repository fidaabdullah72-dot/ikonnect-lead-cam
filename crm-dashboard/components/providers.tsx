'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from 'next-themes';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/menu';
import { ConfirmProvider } from '@/components/ui/feedback';

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={(resolvedTheme as 'light' | 'dark') ?? 'dark'}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: '!rounded-xl !border-border !bg-surface !text-foreground !shadow-lg !font-sans',
          description: '!text-muted',
        },
      }}
    />
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: 1 },
          mutations: { retry: 0 },
        },
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>
        <TooltipProvider delayDuration={250}>
          <ConfirmProvider>
            {children}
            <ThemedToaster />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
