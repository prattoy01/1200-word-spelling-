import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const reg of registrations) {
        void reg.update();
      }
    })
    .catch(() => {});
}

createRoot(document.getElementById('root')!).render(<App />);
