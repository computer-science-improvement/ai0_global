// The global stylesheet goes first: the route modules imported through './router' bring their area stylesheets, and an
// area rule must come after the shared rule it refines (same specificity, later wins).
import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient, router } from './router';
import { Toaster } from './components/ui/Toast';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
