import { Buffer } from 'buffer';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './global.styles.tsx';
import App from './App.tsx';

// The buffer-json package reads Buffer as a global, which a browser does not define.
globalThis.Buffer = Buffer;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
