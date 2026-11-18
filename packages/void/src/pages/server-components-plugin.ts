import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import MagicString from 'magic-string';
import { dirname, isAbsolute, join, relative } from 'pathslash';
import { normalizePath, parseSync, transformWithOxc, type Plugin } from 'vite';
import { staticModuleReferences } from '../shared/module-references.ts';
import { findIslandImports } from './island-imports.ts';
import { createIslandManifest, generateIslandClientEntry } from './islands-plugin.ts';
import { resolveEffectiveLayoutChain, scanPages } from './scan.ts';
import type { PageScanResult } from './types.ts';

/** The client entry that hydrates the islands of server views with hono/jsx/dom. */
export const SERVER_ISLANDS_CLIENT_ENTRY_ID = 'virtual:void-server-islands-client';
const ISLAND_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

// On the client, server JSX names resolve to hono/jsx/dom.
const CLIENT_JSX: Record<string, string> = {
  'void/jsx': 'hono/jsx/dom',
  'void/jsx/jsx-runtime': 'hono/jsx/dom/jsx-runtime',
  'void/jsx/jsx-dev-runtime': 'hono/jsx/dom/jsx-dev-runtime',
};

const HYDRATE_ISLAND = `
async function hydrateIsland(el, mod, props) {
  const { hydrateRoot } = await import("hono/jsx/dom/client");
  const { jsx } = await import("hono/jsx/dom/jsx-runtime");
  hydrateRoot(el, jsx(mod.default || mod, props));
  el.setAttribute("data-hydrated", "true");
}`;

function serverViewFiles(scan: PageScanResult): Array<string> {
  return [
    ...scan.pages.filter((page) => page.serverView).map((page) => page.componentPath),
    ...[...scan.layouts, ...scan.namedLayouts]
      .filter((layout) => layout.serverView)
      .map((layout) => layout.filePath),
  ];
}

function hasIslands(file: string): boolean {
  return findIslandImports(readFileSync(file, 'utf8'), file).length > 0;
}

/** Server pages whose page or layouts import an island. They load the islands client entry. */
export function serverIslandPages(scan: PageScanResult, pagesDir: string): Array<string> {
  const layouts = scan.layouts.filter((layout) => layout.serverView);
  const namedLayouts = scan.namedLayouts.filter((layout) => layout.serverView);
  return scan.pages
    .filter(
      (page) =>
        page.serverView &&
        [
          page.componentPath,
          ...resolveEffectiveLayoutChain(page, layouts, namedLayouts).map((l) => l.filePath),
        ].some((file) => hasIslands(join(pagesDir, file))),
    )
    .map((page) => page.componentId);
}

export const SERVER_VIEW_QUERY = '?void-server-view';
const STYLE_QUERY = '?void-server-view-styles';
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const STYLE = /\.(?:css|pcss|postcss|less|sass|scss|styl|stylus|sss)(?:$|\?)/;
const GUARD = 'virtual:void-server-hook:';
const STYLE_ENTRY = 'virtual:void-server-view-styles';
const PROJECTED_CSS = '?void-projected-css';

export function serverViewStyleId(file: string): string {
  return normalizePath(file) + STYLE_QUERY;
}

const frameworkHooks: Record<string, Array<string>> = {
  react: [
    'use',
    'useActionState',
    'useCallback',
    'useContext',
    'useDebugValue',
    'useDeferredValue',
    'useEffect',
    'useEffectEvent',
    'useId',
    'useImperativeHandle',
    'useInsertionEffect',
    'useLayoutEffect',
    'useMemo',
    'useOptimistic',
    'useReducer',
    'useRef',
    'useState',
    'useSyncExternalStore',
    'useTransition',
  ],
  'react-dom': ['useFormState', 'useFormStatus'],
  'solid-js': [
    'createComputed',
    'createDeferred',
    'createEffect',
    'createMemo',
    'createReaction',
    'createRenderEffect',
    'createResource',
    'createSelector',
    'createSignal',
    'onCleanup',
    'onMount',
    'useContext',
    'useTransition',
  ],
  'solid-js/store': ['createMutable', 'createStore'],
  vue: [
    'computed',
    'inject',
    'onMounted',
    'onUnmounted',
    'provide',
    'reactive',
    'ref',
    'shallowRef',
    'watch',
    'watchEffect',
  ],
  svelte: ['afterUpdate', 'beforeUpdate', 'getContext', 'onDestroy', 'onMount', 'setContext'],
};

/** Keep adapter transforms and styles-only client entries separate from the server import graph. */
export function serverComponentsPlugin(root: string, pagesDir: string): Array<Plugin> {
  async function styleEntries() {
    if (!existsSync(pagesDir)) {
      return [];
    }
    const scan = await scanPages(root, { pagesDir, environment: 'prod' });
    return [
      ...scan.pages.filter((page) => page.serverView).map((page) => page.componentPath),
      ...[...scan.layouts, ...scan.namedLayouts, ...(scan.boundaries ?? [])]
        .filter((view) => view.serverView)
        .map((view) => view.filePath),
    ].map((file) => serverViewStyleId(join(pagesDir, file)));
  }

  const islandManifest = createIslandManifest(root, ISLAND_EXTENSIONS);
  let isDev = false;
  async function registerIslands(): Promise<boolean> {
    if (!existsSync(pagesDir)) {
      return false;
    }
    const scan = await scanPages(root, { pagesDir, environment: isDev ? 'dev' : 'prod' });
    for (const file of serverViewFiles(scan)) {
      const filePath = join(pagesDir, file);
      for (const item of findIslandImports(readFileSync(filePath, 'utf8'), filePath)) {
        islandManifest.register(item.specifier, dirname(filePath), item.hydrate);
      }
    }
    return islandManifest.entries.size > 0;
  }
  const voidFile = fileURLToPath(import.meta.url);

  return [
    {
      name: 'void:server-components',
      enforce: 'pre',

      configEnvironment: {
        order: 'post',
        async handler(name, config, env) {
          isDev = env.command === 'serve';
          if (env.command === 'serve' && name !== 'client') {
            // Keep hono/jsx, its automatic runtimes and hono/html on the same
            // module graph as the renderer. Optimizing a bare JSX subpath
            // separately creates incompatible JSX nodes and context stores.
            return { optimizeDeps: { exclude: ['hono'] } };
          }
          if (
            name !== 'client' ||
            env.command !== 'build' ||
            config.build?.rollupOptions?.input ||
            existsSync(join(root, 'index.html')) ||
            !(await styleEntries()).length
          ) {
            return;
          }
          return { build: { rollupOptions: { input: STYLE_ENTRY } } };
        },
      },

      async options(options) {
        if (this.environment.name !== 'client') {
          return;
        }
        const styles = await styleEntries();
        if (await registerIslands()) {
          styles.push(SERVER_ISLANDS_CLIENT_ENTRY_ID);
        }
        if (!styles.length) {
          return;
        }
        const input = options.input;
        if (
          !input ||
          input === STYLE_ENTRY ||
          (input === join(root, 'index.html') && !existsSync(input))
        ) {
          return { ...options, input: styles };
        }
        return {
          ...options,
          input:
            typeof input === 'string' || Array.isArray(input)
              ? [...(typeof input === 'string' ? [input] : input), ...styles]
              : { ...input, ...Object.fromEntries(styles.map((id) => [relative(root, id), id])) },
        };
      },

      async resolveId(source, importer) {
        if (source === SERVER_ISLANDS_CLIENT_ENTRY_ID) {
          return '\0' + source;
        }
        if (this.environment.name === 'client' && Object.hasOwn(CLIENT_JSX, source)) {
          return this.resolve(CLIENT_JSX[source], voidFile, { skipSelf: true });
        }
        if (this.environment.name === 'client' && source.startsWith('hono/jsx/dom')) {
          // The islands client entry imports hono through Void, which depends on it.
          return this.resolve(source, voidFile, { skipSelf: true });
        }
        if (source.startsWith(GUARD)) {
          if (this.environment.name === 'client') {
            this.error('Void server hook guards cannot be imported by client code.');
          }
          return '\0' + source;
        }
        const styles = source.endsWith(STYLE_QUERY) || importer?.endsWith(STYLE_QUERY);
        const server = source.endsWith(SERVER_VIEW_QUERY) || importer?.endsWith(SERVER_VIEW_QUERY);
        if (!styles && !server) {
          return;
        }
        if (server && this.environment.name === 'client') {
          this.error('Void server components cannot be imported by client code.');
        }
        const query = styles ? STYLE_QUERY : SERVER_VIEW_QUERY;
        const request = source.endsWith(query) ? source.slice(0, -query.length) : source;
        const from = importer?.endsWith(query) ? importer.slice(0, -query.length) : importer;
        const resolved = await this.resolve(request, from, { skipSelf: true });
        if (
          !resolved ||
          !isAbsolute(resolved.id) ||
          resolved.external ||
          !SCRIPT.test(resolved.id) ||
          resolved.id.includes('/node_modules/')
        ) {
          if (styles && !STYLE.test(resolved?.id ?? request)) {
            return '\0void:empty-server-view-style';
          }
          if (
            styles &&
            this.environment.mode === 'build' &&
            resolved &&
            /\.module\.[^?]+$/.test(resolved.id)
          ) {
            return { ...resolved, id: resolved.id + PROJECTED_CSS };
          }
          return resolved;
        }
        return { ...resolved, id: normalizePath(resolved.id) + query };
      },

      async load(id) {
        if (id === '\0' + SERVER_ISLANDS_CLIENT_ENTRY_ID) {
          await registerIslands();
          return generateIslandClientEntry({
            manifest: islandManifest,
            cssFiles: new Set(),
            styles: [],
            needsRuntime: true,
            isDev,
            hydrateIsland: HYDRATE_ISLAND,
          });
        }
        if (id === '\0void:empty-server-view-style') {
          return '';
        }
        if (id.startsWith('\0' + GUARD)) {
          const [framework, importer] = JSON.parse(
            decodeURIComponent(id.slice(GUARD.length + 1)),
          ) as [string, string];
          const resolved = await this.resolve(framework, importer);
          const source = JSON.stringify(resolved && !resolved.external ? resolved.id : framework);
          const hooks = frameworkHooks[framework];
          return `
          import * as original from ${source};
          export * from ${source};
          ${hooks
            .map(
              (hook) => `export function ${hook}() {
            throw new Error(${JSON.stringify(`Void server component ${relative(root, importer)} cannot call ${framework}.${hook}(). Use void/jsx for server JSX or move the hook into a client page.`)});
          }`,
            )
            .join('\n')}
          const hooks = { ${hooks.join(', ')} };
          export default new Proxy(original.default ?? original, {
            get(target, name) { return Object.hasOwn(hooks, name) ? hooks[name] : Reflect.get(target, name); }
          });
        `;
        }
        if (id.endsWith(SERVER_VIEW_QUERY) && this.environment.name === 'client') {
          this.error('Void server components cannot be loaded by client code.');
        }
        if (!id.endsWith(STYLE_QUERY)) {
          return;
        }
        const filename = id.slice(0, -STYLE_QUERY.length);
        this.addWatchFile(filename);
        const code = await readFile(filename, 'utf8');
        const parsed = parseSync(filename, code);
        const imports = [
          ...staticModuleReferences(parsed, code),
          ...parsed.module.dynamicImports.flatMap(({ start, moduleRequest }) =>
            moduleRequest && 'value' in moduleRequest && typeof moduleRequest.value === 'string'
              ? [{ start, source: moduleRequest.value }]
              : [],
          ),
        ].sort((a, b) => a.start - b.start);
        return [...new Set(imports.map((item) => item.source))]
          .map((value) => `import ${JSON.stringify(value)};`)
          .join('\n');
      },

      async transform(code, id) {
        if (!id.endsWith(SERVER_VIEW_QUERY)) {
          return;
        }
        const filename = id.slice(0, -SERVER_VIEW_QUERY.length);
        const { module } = parseSync(filename, code);
        const guard = new MagicString(code);
        const redirect = (request: { start: number; end: number; value: string }) => {
          if (Object.hasOwn(frameworkHooks, request.value)) {
            guard.overwrite(
              request.start,
              request.end,
              JSON.stringify(GUARD + encodeURIComponent(JSON.stringify([request.value, filename]))),
            );
          }
        };
        // SSR can externalize a bare package before resolveId sees it. Redirect
        // these imports in source, while leaving adapter imports untouched.
        for (const item of module.staticImports) {
          if (!item.entries.length || item.entries.some((entry) => !entry.isType)) {
            redirect(item.moduleRequest);
          }
        }
        for (const item of module.staticExports) {
          const request = item.entries.find(
            (entry) => !entry.isType && entry.moduleRequest,
          )?.moduleRequest;
          if (request) {
            redirect(request);
          }
        }
        for (const { moduleRequest } of module.dynamicImports) {
          if (
            moduleRequest &&
            'value' in moduleRequest &&
            typeof moduleRequest.value === 'string'
          ) {
            redirect({ ...moduleRequest, value: moduleRequest.value });
          }
        }
        // Islands: render the component here and mark it for the islands client entry.
        const islands = findIslandImports(code, filename);
        islands.forEach((item, index) => {
          const raw = `__void_island_${index}`;
          const { islandId } = islandManifest.register(
            item.specifier,
            dirname(filename),
            item.hydrate,
          );
          guard.overwrite(item.start, item.end, `import ${raw} from ${item.specifierRaw};`);
          guard.append(
            `\nfunction ${item.importName}(props) { return __void_island_jsx("div", { "data-island": ${JSON.stringify(islandId)}, "data-props": __void_island_props(props), "data-hydrate": ${JSON.stringify(item.hydrate)}, children: __void_island_jsx(${raw}, props) }); }`,
          );
        });
        if (islands.length) {
          guard.prepend(
            'import { jsx as __void_island_jsx } from "void/jsx/jsx-runtime";\nimport { serializePageData as __void_island_props } from "void/pages-server";\n',
          );
        }
        return transformWithOxc(
          guard.toString(),
          filename,
          {
            jsx: { runtime: 'automatic', importSource: 'void/jsx' },
          },
          guard.hasChanged() ? guard.generateMap({ hires: true, source: filename }) : undefined,
        );
      },
    },
    {
      name: 'void:server-component-css',
      enforce: 'post',
      transform(_code, id) {
        if (id.endsWith(PROJECTED_CSS)) {
          // Vite normally drops unused CSS module exports and their stylesheet.
          return { moduleSideEffects: 'no-treeshake' };
        }
      },
    },
  ];
}
