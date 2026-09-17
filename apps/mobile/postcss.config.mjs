/*
  PostCSS for the DOM bundle.

  The DOM component imports the web app's `src/index.css`, which is Tailwind
  source — `@tailwind base; @tailwind components; @tailwind utilities;` and
  1,400 lines of layers on top. Metro runs PostCSS when a config sits in the
  project root, so this is what turns those directives into real CSS inside the
  webview. Without it the webview loads three unknown at-rules and the app
  renders unstyled.

  `.mjs` because the app's package.json has no `"type": "module"`, while the
  root Tailwind config this borrows is ESM.
*/
export default {
  plugins: {
    tailwindcss: { config: './tailwind.config.mjs' },
    autoprefixer: {},
  },
}
