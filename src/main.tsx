import { createRoot } from 'react-dom/client';
import App from './App';
import VmSmokeHarness from './VmSmokeHarness';
import './styles.css';

const Root = new URLSearchParams(window.location.search).has('vm-smoke')
  ? VmSmokeHarness
  : App;

createRoot(document.getElementById('root')!).render(
  <Root />,
);
