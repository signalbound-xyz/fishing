import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import './style.css';
import { initBackdrop } from './backdrop';
import { initDaytime, onTimeChange } from './daytime';
import { emit } from './store';
import { initTooltips } from './ui/tooltip';

initDaytime();
onTimeChange(emit);
initBackdrop();
initTooltips();
void import('./play/app');
