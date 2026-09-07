import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import { Toaster } from '@/components/ui/sonner';
import '@/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('NimTurf could not find its mount point.');

createRoot(container).render(
  <StrictMode>
    <App />
    <Toaster />
  </StrictMode>,
);
