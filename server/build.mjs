/**
 * 本地版构建脚本。
 *
 * 用 esbuild 打包 server/index.ts，把 cloudflare:sockets 映射到本地 shim，
 * 输出单文件 ESM，再由 node 直接运行。
 * 之所以不用 tsx 直跑：tsx 不读取 tsconfig 的 paths 映射，
 * 无法把 Workers 专有模块替换成本地实现。
 */
import * as esbuild from "esbuild"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = path.dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes("--watch")

/** 把 cloudflare:sockets 指向本地 shim */
const cloudflareSocketsShim = {
  name: "cf-sockets-shim",
  setup(build) {
    build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
      path: path.resolve(root, "shims/cloudflare-sockets.ts"),
    }))
  },
}

const options = {
  entryPoints: [path.resolve(root, "index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.resolve(root, "../dist-server/index.mjs"),
  plugins: [cloudflareSocketsShim],
  // 这些包在 node_modules 里，保持外部依赖不打进 bundle
  external: ["hono", "@hono/node-server", "node:*"],
  logLevel: "info",
  banner: {
    js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
  },
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log("esbuild watching...")
} else {
  await esbuild.build(options)
}
