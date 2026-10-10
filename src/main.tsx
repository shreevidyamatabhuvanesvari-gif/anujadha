import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles.css';

/**
 * श्रुति — वैदिक वीडियो वाचन स्टूडियो
 *
 * यह ऐप का मुख्य React entry point है।
 * index.html में मौजूद #root तत्व के अंदर
 * पूरा React application render किया जाता है।
 */

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error(
    'श्रुति ऐप शुरू नहीं हो सका: index.html में #root तत्व नहीं मिला।'
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
