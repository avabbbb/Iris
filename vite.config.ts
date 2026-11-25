import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { configDefaults } from 'vitest/config';
import { llmProxyPlugin } from './server/viteLlmProxyPlugin';

// Tauri 期望固定端口；CLI source bootstrap 通过 IRIS_DYNAMIC_WEB_PORT
// 显式启用动态端口，避免把用户带到无关的 localhost 服务。
const host = process.env.TAURI_DEV_HOST;
const dynamicPort = process.env.IRIS_DYNAMIC_WEB_PORT === '1';
const configuredPort = Number(process.env.IRIS_WEB_PORT);

export default defineConfig(() => {
    return {
      // Cloudflare Pages / GitHub Pages 用绝对路径，Tauri 用相对路径。
      // 允许 VITE_BASE_PATH / CF_PAGES_BASEPATH / CLI --base 覆盖，
      // 不再把 base 写死成 "./"——否则部署到 /Iris/ 子路径会白屏。
      base:
        process.env.VITE_BASE_PATH ||
        process.env.CF_PAGES_BASEPATH ||
        (process.env.CF_PAGES ? '/' : './'),
      server: {
        port: configuredPort > 0 ? configuredPort : 37522,
        host: host || '127.0.0.1',
        strictPort: !dynamicPort,
        headers: {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cache-Control': 'no-store',
        },
        // Iris Link 本地联调：IRIS_LINK_DEV_RELAY=http://127.0.0.1:8787（wrangler dev）时把 /api/link（含 WebSocket）转给中继，
        // 页面和 CLI 都用 vite 的地址，与线上同源部署一致。不设时没有这个代理。
        ...(process.env.IRIS_LINK_DEV_RELAY ? { proxy: { '/api/link': { target: process.env.IRIS_LINK_DEV_RELAY, ws: true, changeOrigin: false } } } : {}),
        // 冷启动时浏览器首次请求才触发整张模块图编译（实测 26–48s），启动即预热入口，
        // 避免 iris start --open 打开的页面在绑定等待内挂载不完。
        warmup: { clientFiles: ['./index.tsx', './appMain.tsx', './RouterHost.tsx'] },
        // src-tauri/target is Rust build output; cargo locks iris.exe while
        // compiling and chokidar crashes on EBUSY watching it. Exclude build dirs.
        watch: {
          ignored: (p: string) => p.replaceAll(path.sep, '/').split('/').some((s) => s === 'target' || s === '.git' || s === '.tmp'),
        },
      },
      plugins: [tailwindcss(), react(), llmProxyPlugin()],
      // 排除独立 HTML 文件，避免 esbuild 扫描其内联脚本报错
      optimizeDeps: {
        entries: ['index.html'],
        // @ffmpeg/ffmpeg 必须在依赖预打包之外运行。它的类内部用
        // `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`
        // 拉起自己的消息 worker；一旦被预打包到 node_modules/.vite/deps/，
        // import.meta.url 就指向该目录，worker 被解析成
        // /node_modules/.vite/deps/worker.js —— 这个 chunk 不会生成（404），
        // 于是 worker 起不来、ffmpeg.load() 永不 settle，所有视频/音频工具
        // 都会静默卡死。排除后直接加载包内真实 ESM 文件，路径才成立。
        // @huggingface/transformers（点选主体，只在分割 worker 里懒加载）同理：它和 onnxruntime-web
        // 按 import.meta.url 定位 wasm / 子模块，预打包后路径会错。
        exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@huggingface/transformers'],
        esbuildOptions: {
          target: 'es2022',
          treeShaking: true,
        },
      },
      // 分割 worker 里要动态 import transformers.js（代码分割），IIFE 格式不支持，用 ES module worker。
      worker: { format: 'es' as const },
      resolve: {
        // 优先加载 .tsx/.ts 源文件，避免陈旧未跟踪 .js 副本遮蔽源码
        extensions: ['.tsx', '.ts', '.jsx', '.js', '.json', '.mjs'],
        // Keep a single React dispatcher across linked packages.
        dedupe: ['react', 'react-dom'],
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        rollupOptions: {
          output: {
            manualChunks: {
              'vendor-react': ['react', 'react-dom'],
              'vendor-genai': ['@google/genai'],
              'vendor-tiptap': ['@tiptap/core', '@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-mention', '@tiptap/suggestion'],
              'vendor-ffmpeg': ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
            },
          },
        },
      },
      test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
        // Tests that shell out to `node` pay a full child-process start plus the
        // spawned work. On Windows hosts that alone measures in seconds, and
        // four parallel workers push single-spawn tests past Vitest's 5s/10s
        // defaults, which showed up as intermittent "timed out" failures.
        // These budgets still fail a genuinely hung child process.
        testTimeout: 20000,
        hookTimeout: 20000,
        // Windows hosts can exhaust fork/handle resources at Vitest's
        // auto-detected worker count; four workers keep the full suite
        // deterministic without changing test isolation.
        maxWorkers: 4,
        // Stale worktrees, backups and build output carry their own React copies;
        // collecting tests from them fails with invalid hook calls.
        exclude: [...configDefaults.exclude, '**/.tmp/**', '**/.temp/**', '**/.claude/**', '**/dist-*/**', '_ref/**', 'dsh-plugin/test/**'],
      },
    };
});
