// Test support: lets a node test import a component that imports a stylesheet (the app's bundler handles CSS; node cannot).
// Call `stubCss()` before the dynamic `import()` of the component. Not used by the app. (Named *.test.ts so tsconfig leaves it
// out: it needs Node's types, like every file here that runs under node:test; it holds no tests.)
import { register } from 'node:module';

const HOOK = `
export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return next(url, context);
}
`;

let done = false;

export function stubCss(): void {
  if (done) return;
  done = true;
  register(`data:text/javascript,${encodeURIComponent(HOOK)}`, import.meta.url);
}
