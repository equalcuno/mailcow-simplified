/** Parse the actual preview CSS; catch missing font declarations without sockets. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPreviewAssets } from './preview.mjs';

const { Window } = await import(process.env.HAPPY_DOM_MODULE ? pathToFileURL(process.env.HAPPY_DOM_MODULE).href : 'happy-dom');
const window = new Window();
try {
  const { css } = await buildPreviewAssets();
  const style = window.document.createElement('style');
  style.textContent = css;
  window.document.head.append(style);
  const fontRules = [...style.sheet.cssRules].filter(rule => rule.constructor.name === 'CSSFontFaceRule');
  const icons = fontRules.find(rule => rule.style.getPropertyValue('font-family').replaceAll('"', '').trim() === 'bootstrap-icons');
  assert.ok(icons, 'Bundled CSS retains the Bootstrap Icons @font-face rule');
  const urls = [...icons.style.getPropertyValue('src').matchAll(/url\(["']?([^"')]+)["']?\)/g)];
  assert.equal(urls.length, 2, 'Both icon font formats are declared');
  for (const [, url] of urls) {
    const path = new URL(url, 'http://localhost').pathname;
    const font = await readFile(fileURLToPath(new URL('../../data/web' + path, import.meta.url)));
    assert.ok(['wOF2', 'wOFF'].includes(font.subarray(0, 4).toString()), `${path} is a valid webfont asset`);
  }
  console.log('Plates: preview icon declaration and both font assets passed.');
} finally { await window.happyDOM.close(); }
