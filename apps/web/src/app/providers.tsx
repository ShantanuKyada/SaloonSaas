import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster, toast } from 'sonner';
import { ConfirmProvider } from '@/components/ui/overlay';
import { ApiError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

/** Shows a plain-language error as a toast (what happened and what to try). */
export function toastError(error: unknown, fallbackTitle?: unknown): void {
  // The app is already moving this person to the two-step set-up screen (see onUserStale); an error toast would only be noise.
  if (error instanceof ApiError && error.errorCode === 'MFA_SETUP_REQUIRED') return;
  const e = friendlyError(error);
  toast.error(typeof fallbackTitle === 'string' ? fallbackTitle : e.title, { description: [e.message, e.hints.length ? e.hints.join(' · ') : null].filter(Boolean).join(' '), duration: 8000 });
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          // Background refreshes should not nag: only surface errors for data the user is looking at.
          onError: (error, query) => {
            if (query.state.data !== undefined && !(error instanceof ApiError && error.status === 0)) toastError(error, 'Could not refresh');
          },
        }),
        mutationCache: new MutationCache(),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: true,
            retry: (count, error) => !(error instanceof ApiError && error.status > 0 && error.status < 500) && count < 2,
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <ConfirmProvider>
          {children}
          <Toaster position="bottom-right" richColors closeButton toastOptions={{ classNames: { toast: 'font-sans' } }} />
        </ConfirmProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
