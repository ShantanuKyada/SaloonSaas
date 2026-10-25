import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { Providers } from '@/app/providers';
import { router } from '@/app/router';
import '@/styles/index.css';

// Apply the saved theme before first paint to avoid a flash.
try {
  const stored = localStorage.getItem('salonos:theme');
  const theme = stored === 'dark' || stored === 'light' ? stored : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
} catch {
  /* storage unavailable: default light theme */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
